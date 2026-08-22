#!/usr/bin/env bash
#
# Deploy code updates to an existing RFDeck server.
#
# The fast path. install-ubuntu.sh is a provisioner: it reruns apt, reinstalls
# Node, and rebuilds the AES67 kernel module every time, which takes minutes and
# is waste when all that changed is application code. This does only what a code
# update needs — stage, build, migrate, restart — in well under a minute.
#
# Safe to run during a show week: the previous build is snapshotted first, and a
# failed build or a service that does not come back is rolled back automatically.
#
#   sudo ./scripts/update-server.sh                 update from this checkout
#   sudo ./scripts/update-server.sh --pull          git pull first, then update
#   sudo ./scripts/update-server.sh --rollback      undo the last update
#   sudo ./scripts/update-server.sh --no-restart    build without restarting
#
# Use install-ubuntu.sh instead when changing configuration — port, TLS, AES67 —
# since those live in the systemd unit this script deliberately leaves alone.
#
set -euo pipefail

SERVICE_NAME=rfdeck
INSTALL_DIR=/opt/rfdeck
SNAPSHOT_DIR=/var/backups/rfdeck
DO_PULL=0
DO_ROLLBACK=0
RESTART=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)        DO_PULL=1; shift ;;
    --rollback)    DO_ROLLBACK=1; shift ;;
    --no-restart)  RESTART=0; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help)     awk 'NR>2 && /^#/ { sub(/^# ?/,""); print; next } NR>2 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; CYA=$'\033[36m'; OFF=$'\033[0m'

step() { printf '\n%s==>%s %s%s%s\n' "$CYA" "$OFF" "$BOLD" "$1" "$OFF"; }
ok()   { printf '  %s+%s %s\n' "$GRN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$1"; }
die()  { printf '\n  %sx%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

# Confirm the service account can actually OPEN a capture device.
#
# Worth checking the capability rather than the configuration: enumeration reads
# world-readable /proc/asound and succeeds even with no audio access at all, so
# a device list proves nothing. Only opening a node does.
verify_audio_access() {
  local node
  node="$(find /dev/snd -maxdepth 1 -name 'pcm*c' 2>/dev/null | head -1)"
  # No capture hardware on this machine — nothing to verify, and not a fault.
  [[ -n "$node" ]] || return 0

  # Without runuser we cannot ask what another account can see; staying quiet
  # beats warning about something we did not actually test.
  command -v runuser >/dev/null 2>&1 || return 0

  if runuser -u "$SERVICE_USER" -- test -r "$node" 2>/dev/null; then
    ok "Service account can open capture devices"
  else
    warn "'$SERVICE_USER' still cannot open $node."
    warn "Audio devices will be listed but report wrong channel counts and will"
    warn "not stream. Try:"
    warn "    usermod -aG audio $SERVICE_USER && systemctl restart $SERVICE_NAME"
  fi
}

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0 $*"

UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
[[ -f "$UNIT" ]] || die "RFDeck is not installed here. Run scripts/install-ubuntu.sh first."

# ── Read the live configuration ──────────────────────────────────────────────
#
# From the unit rather than from defaults, so this can never build against one
# database and then restart a service pointed at another.

unit_env() { sed -n "s/^Environment=$1=\(.*\)$/\1/p" "$UNIT" | head -1; }

DB_URL="$(unit_env DATABASE_URL)"
PORT="$(unit_env PORT)"
TLS_CERT="$(unit_env TLS_CERT)"
SERVICE_USER="$(sed -n 's/^User=\(.*\)$/\1/p' "$UNIT" | head -1)"
WORKDIR="$(sed -n 's/^WorkingDirectory=\(.*\)$/\1/p' "$UNIT" | head -1)"

[[ -n "$DB_URL" ]] || die "Could not read DATABASE_URL from $UNIT"
# WorkingDirectory is <install>/apps/server; walk back to the install root.
[[ -n "$WORKDIR" ]] && INSTALL_DIR="$(dirname "$(dirname "$WORKDIR")")"
[[ -d "$INSTALL_DIR" ]] || die "Install directory $INSTALL_DIR does not exist"

SCHEME="http"
[[ -n "$TLS_CERT" ]] && SCHEME="https"
if [[ -z "$PORT" ]]; then
  if [[ "$SCHEME" == "https" ]]; then PORT=443; else PORT=80; fi
fi

# Build output is what actually runs, so snapshotting it is enough to roll back.
BUILD_PATHS=(
  "apps/server/dist"
  "apps/web/dist"
  "packages/shared-types/dist"
  "packages/shared-utils/dist"
)

restore_snapshot() {
  local restored=0
  local rel snap
  for rel in "${BUILD_PATHS[@]}"; do
    snap="$SNAPSHOT_DIR/previous/$rel"
    [[ -d "$snap" ]] || continue
    rm -rf "${INSTALL_DIR:?}/$rel"
    mkdir -p "$(dirname "$INSTALL_DIR/$rel")"
    cp -a "$snap" "$INSTALL_DIR/$rel"
    restored=1
  done
  [[ "$restored" == "1" ]]
}

if [[ "$DO_ROLLBACK" == "1" ]]; then
  step "Rolling back to the previous build"
  [[ -d "$SNAPSHOT_DIR/previous" ]] || die "No previous build to roll back to."
  restore_snapshot || die "Snapshot is empty - nothing restored."
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  systemctl restart "$SERVICE_NAME"
  ok "Previous build restored and service restarted"
  exit 0
fi

# ── Stage new code ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

step "Staging"

if [[ "$SOURCE_DIR" == "$INSTALL_DIR" ]]; then
  # Running from inside the install. Only useful with --pull, and only if the
  # install happens to be a git checkout.
  if [[ "$DO_PULL" == "1" && -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only || die "git pull failed"
    ok "Pulled into $INSTALL_DIR"
  else
    warn "Running from the install directory - rebuilding the code already there"
  fi
else
  [[ -f "$SOURCE_DIR/pnpm-workspace.yaml" ]] || die "Not an RFDeck checkout: $SOURCE_DIR"

  if [[ "$DO_PULL" == "1" ]]; then
    [[ -d "$SOURCE_DIR/.git" ]] || die "--pull needs $SOURCE_DIR to be a git checkout"
    git -C "$SOURCE_DIR" pull --ff-only || die "git pull failed"
    ok "Pulled $(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
  fi

  # Same exclusions as the installer: never carry a dirty working tree's build
  # output, local database or .env into the deployment.
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'release' \
    --exclude '*.db' \
    --exclude '.env' \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/
  ok "Code staged into $INSTALL_DIR"
fi

# Shell scripts are committed from a Windows checkout, where git may not have
# recorded the executable bit. Restore it on the deployed copy so the next
# upgrade can always be run straight from the install directory.
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true

# ── Snapshot the running build ───────────────────────────────────────────────

step "Snapshotting the current build"
rm -rf "$SNAPSHOT_DIR/previous"
mkdir -p "$SNAPSHOT_DIR/previous"
SNAPPED=0
for rel in "${BUILD_PATHS[@]}"; do
  [[ -d "$INSTALL_DIR/$rel" ]] || continue
  mkdir -p "$SNAPSHOT_DIR/previous/$(dirname "$rel")"
  cp -a "$INSTALL_DIR/$rel" "$SNAPSHOT_DIR/previous/$rel"
  SNAPPED=1
done
if [[ "$SNAPPED" == "1" ]]; then
  ok "Previous build saved to $SNAPSHOT_DIR/previous"
else
  warn "No existing build found to snapshot - rollback will not be available"
fi

# ── Build ────────────────────────────────────────────────────────────────────

cd "$INSTALL_DIR"
export DATABASE_URL="$DB_URL"

build_failed() {
  warn "Restoring the previous build"
  if restore_snapshot; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
    systemctl restart "$SERVICE_NAME" 2>/dev/null || true
  fi
  die "$1"
}

step "Building"

# Dependencies may have changed; --prefer-offline keeps this quick when they have not.
pnpm install --silent --prefer-offline || build_failed "pnpm install failed"
ok "Dependencies up to date"

pnpm --filter @rfdeck/server exec prisma generate >/dev/null || build_failed "prisma generate failed"
pnpm --filter @rfdeck/shared-types build >/dev/null || build_failed "shared-types build failed"
pnpm --filter @rfdeck/web build >/dev/null || build_failed "web build failed"
pnpm --filter @rfdeck/server build >/dev/null || build_failed "server build failed"
ok "Application built"

step "Applying schema changes"
# Additive - adds tables and columns without dropping data.
pnpm --filter @rfdeck/server exec prisma db push --skip-generate >/dev/null \
  || build_failed "Applying the database schema failed"
ok "Schema up to date"

# Refresh the admin CLI alongside the code it launches. Omitting this left
# `rfdeck` missing on servers that had only ever been updated — exactly when
# it is needed, since it is the recovery path for a lost PIN.
if [[ -f "$INSTALL_DIR/scripts/rfdeck" ]]; then
  install -m 755 "$INSTALL_DIR/scripts/rfdeck" /usr/local/bin/rfdeck
  ok "rfdeck command up to date"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Audio device permissions ─────────────────────────────────────────────────
#
# /dev/snd is group-owned by 'audio'. A service account without that membership
# enumerates no capture devices, so the UI reports none while the same commands
# under sudo list every card. Repaired here because this script does not rewrite
# the unit, so installs predating the fix would never otherwise pick it up.
# `usermod -aG` is a no-op when the account is already a member, so it runs
# unconditionally. An earlier version gated it on a membership test, the grant
# was silently skipped, and the symptom — devices listed but every width wrong —
# read as a hardware quirk rather than a permissions fault. The test saved
# nothing but a log line.
if getent group audio >/dev/null 2>&1; then
  usermod -aG audio "$SERVICE_USER" \
    || warn "Could not add '$SERVICE_USER' to the audio group"

  # The account-level group only takes effect on a fresh login, which a nologin
  # system account never gets; the unit setting is what reaches the process.
  if ! grep -q '^SupplementaryGroups=.*audio' "$UNIT"; then
    sed -i "/^Group=/a SupplementaryGroups=audio" "$UNIT"
    systemctl daemon-reload
  fi
  ok "Service account granted access to audio devices"
else
  warn "No 'audio' group on this system; capture devices may be unreadable"
fi

# ── Restart and verify ───────────────────────────────────────────────────────

if [[ "$RESTART" == "0" ]]; then
  step "Built, not restarted"
  warn "Run: systemctl restart $SERVICE_NAME"
  exit 0
fi

step "Restarting"
systemctl restart "$SERVICE_NAME"

HEALTHY=0
for _ in $(seq 1 20); do
  # -k because a self-signed certificate is expected here.
  if curl -fsSk --max-time 2 "${SCHEME}://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" != "1" ]]; then
  printf '\n  %sx%s The updated service did not come up. Recent log:\n\n' "$RED" "$OFF"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager | sed 's/^/    /'
  echo
  warn "Rolling back to the previous build"
  if restore_snapshot; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
    systemctl restart "$SERVICE_NAME"
    sleep 3
    if curl -fsSk --max-time 3 "${SCHEME}://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      ok "Rolled back - the previous version is running again"
    else
      warn "Rollback restarted the service but it is still not responding."
      warn "Investigate with: journalctl -u $SERVICE_NAME -n 50"
    fi
  else
    warn "No snapshot available to roll back to."
  fi
  exit 1
fi

ok "Service is running and responding"

verify_audio_access

printf '\n%s%s  Update complete%s\n\n' "$BOLD" "$GRN" "$OFF"
for ADDR in $(hostname -I 2>/dev/null); do
  case "$ADDR" in *:*) continue ;; esac
  if [[ ( "$SCHEME" == "https" && "$PORT" == "443" ) || ( "$SCHEME" == "http" && "$PORT" == "80" ) ]]; then
    printf '      %s%s://%s%s\n' "$BOLD" "$SCHEME" "$ADDR" "$OFF"
  else
    printf '      %s%s://%s:%s%s\n' "$BOLD" "$SCHEME" "$ADDR" "$PORT" "$OFF"
  fi
done
echo
echo "  ${DIM}Undo with: sudo $0 --rollback${OFF}"
echo
