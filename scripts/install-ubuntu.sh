#!/usr/bin/env bash
#
# Install RFDeck as a system service on a clean Ubuntu server.
#
# Takes a fresh Ubuntu 22.04 or 24.04 box to a running RFDeck that people on the
# venue network reach in a browser. Installs Node, builds the application,
# creates a service account, provisions the database, opens the firewall, and
# registers a systemd unit that starts on boot.
#
# Run as root, from anywhere:
#
#   sudo ./scripts/install-ubuntu.sh
#   sudo ./scripts/install-ubuntu.sh --port 8080
#   sudo ./scripts/install-ubuntu.sh --repo https://github.com/you/rfdeck.git
#   sudo ./scripts/install-ubuntu.sh --uninstall
#
# Re-running upgrades in place: the database and settings are preserved.
#
set -euo pipefail

PORT=80
INSTALL_DIR=/opt/rfdeck
DATA_DIR=/var/lib/rfdeck
SERVICE_USER=rfdeck
SERVICE_NAME=rfdeck
NODE_MAJOR=24
REPO_URL=""
BRANCH="main"
SKIP_FIREWALL=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2"; shift 2 ;;
    --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
    --data-dir)      DATA_DIR="$2"; shift 2 ;;
    --repo)          REPO_URL="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --uninstall)     UNINSTALL=1; shift ;;
    # Print the header comment, stopping at the first line of actual script.
    -h|--help)       awk 'NR>2 && /^#/ { sub(/^# ?/,""); print; next } NR>2 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; CYA=$'\033[36m'; OFF=$'\033[0m'

step() { printf '\n%s==>%s %s%s%s\n' "$CYA" "$OFF" "$BOLD" "$1" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$1"; }
die()  { printf '\n  %s✗%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0 $*"

# ── Uninstall ────────────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == "1" ]]; then
  step "Removing RFDeck"
  systemctl stop    "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  ok "Service and application removed"
  warn "Database kept at $DATA_DIR — delete it manually if you want it gone"
  warn "Service account '$SERVICE_USER' kept — remove with: userdel $SERVICE_USER"
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────

step "Checking the system"

[[ -f /etc/os-release ]] || die "Cannot identify this OS — Ubuntu 22.04 or 24.04 expected."
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "This is ${PRETTY_NAME:-unknown}, not Ubuntu. Continuing, but untested."
else
  ok "${PRETTY_NAME}"
fi

ARCH="$(dpkg --print-architecture)"
[[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]] \
  || die "Unsupported architecture: $ARCH"
ok "Architecture $ARCH"

# The source has to come from somewhere: either this checkout, or a clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"
if [[ -z "$REPO_URL" && ! -f "$SOURCE_DIR/pnpm-workspace.yaml" ]]; then
  die "Not inside an RFDeck checkout. Either run this from one, or pass --repo <url>."
fi

# ── Packages ─────────────────────────────────────────────────────────────────

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# build-essential and python3 are needed to compile the native WebRTC module.
apt-get install -y -qq \
  curl ca-certificates gnupg git rsync \
  build-essential python3 >/dev/null
ok "Base packages installed"

# ── Node.js ──────────────────────────────────────────────────────────────────

step "Installing Node.js ${NODE_MAJOR}"

CURRENT_NODE=""
command -v node >/dev/null && CURRENT_NODE="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '')"

if [[ "$CURRENT_NODE" == "$NODE_MAJOR" ]]; then
  ok "Node $(node -v) already installed"
else
  # Ubuntu's own Node packages lag well behind; use NodeSource.
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod a+r /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) installed"
fi

# corepack ships with Node and pins pnpm without a global npm install.
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm install -g pnpm >/dev/null
ok "pnpm $(pnpm -v)"

# ── Service account ──────────────────────────────────────────────────────────

step "Creating the service account"
if id "$SERVICE_USER" &>/dev/null; then
  ok "User '$SERVICE_USER' already exists"
else
  # System account with no login shell — it only ever runs the service.
  useradd --system --create-home --home-dir /var/lib/"$SERVICE_USER" \
          --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "User '$SERVICE_USER' created"
fi

# ── Source ───────────────────────────────────────────────────────────────────

step "Staging the application"
UPGRADE=0
[[ -d "$INSTALL_DIR" ]] && UPGRADE=1

mkdir -p "$INSTALL_DIR"

if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
    ok "Updated from $REPO_URL ($BRANCH)"
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    ok "Cloned $REPO_URL ($BRANCH)"
  fi
elif [[ "$SOURCE_DIR" == "$INSTALL_DIR" ]]; then
  # Running the script from inside the install itself. There is nothing to
  # copy — and rsync'ing a directory onto itself with --delete is asking for
  # trouble. This still rebuilds and rewrites the service, which is what a
  # config change such as a new port needs; it just cannot fetch newer code.
  ok "Running from the install directory — rebuilding in place"
  warn "This does not pull new code. For that, re-run from a fresh checkout"
  warn "or pass --repo <url>."
else
  # Copy this checkout, leaving build output and local state behind so a dirty
  # working tree cannot contaminate the install — in particular the developer's
  # own database and .env.
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'release' \
    --exclude '*.db' \
    --exclude '.env' \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/
  ok "Copied from $SOURCE_DIR"
fi

# ── Build ────────────────────────────────────────────────────────────────────
#
# The application is TypeScript, so it has to be compiled once at install time.
# This is the only place a build happens; the service just runs the output.

step "Building (this takes a few minutes)"
cd "$INSTALL_DIR"

pnpm install --silent
ok "Dependencies installed"

pnpm --filter @rfdeck/server exec prisma generate >/dev/null
ok "Database client generated"

pnpm --filter @rfdeck/shared-types build >/dev/null
pnpm --filter @rfdeck/web build >/dev/null
pnpm --filter @rfdeck/server build >/dev/null
ok "Application built"

# ── Database ─────────────────────────────────────────────────────────────────
#
# Kept outside the install directory so an upgrade — which replaces that
# directory — can never take a venue's show history with it.

step "Provisioning the database"
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

DB_PATH="$DATA_DIR/rfdeck.db"
export DATABASE_URL="file:$DB_PATH"

EXISTED=0
[[ -f "$DB_PATH" ]] && EXISTED=1

# Additive: adds new tables and columns without dropping data, so this doubles
# as the upgrade path.
pnpm --filter @rfdeck/server exec prisma db push --skip-generate >/dev/null
chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH"
[[ "$EXISTED" == "1" ]] && ok "Existing database at $DB_PATH updated" \
                        || ok "Database created at $DB_PATH"

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Service ──────────────────────────────────────────────────────────────────

step "Registering the service"

# Note the port currently in service before the unit is rewritten, so the
# firewall step below can retire its rule if the port is changing.
PREVIOUS_PORT=""
if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  PREVIOUS_PORT="$(sed -n 's/^Environment=PORT=\([0-9]\+\)$/\1/p' \
    "/etc/systemd/system/${SERVICE_NAME}.service" | head -1)"
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=RFDeck wireless monitoring server
Documentation=https://github.com/rfdeck
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/apps/server

Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=DATABASE_URL=file:${DB_PATH}
# Raise to debug when a device will not connect:
#   sudo systemctl edit ${SERVICE_NAME}   →   Environment=LOG_LEVEL=debug
Environment=LOG_LEVEL=warn
# Older Sennheiser firmware negotiates TLS 1.0.
Environment=NODE_OPTIONS=--tls-min-v1.0

ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5

# Ports below 1024 are privileged. Rather than run as root, grant only the
# capability needed to bind one — the service drops nothing else.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

StandardOutput=journal
StandardError=journal
SyslogIdentifier=rfdeck

# Hardening. The service needs the network and its own data directory, and
# nothing else on the filesystem.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
ok "Service registered and enabled at boot"

# ── Firewall ─────────────────────────────────────────────────────────────────
#
# Only the HTTP port is obvious. The UDP ports are where deployments fail: with
# them blocked, receivers are discovered but never report telemetry, which
# presents as broken hardware rather than as a firewall problem.

if [[ "$SKIP_FIREWALL" == "0" ]] && command -v ufw >/dev/null 2>&1; then
  step "Configuring the firewall"
  if ufw status | grep -q "Status: active"; then
    # Close the port we used to serve on, if this run is moving to a different
    # one. Otherwise an upgrade quietly leaves the old port open forever.
    if [[ -n "${PREVIOUS_PORT:-}" && "$PREVIOUS_PORT" != "$PORT" ]]; then
      ufw delete allow "$PREVIOUS_PORT"/tcp >/dev/null 2>&1 \
        && ok "Closed TCP $PREVIOUS_PORT (no longer used)"
    fi
    ufw allow "$PORT"/tcp  >/dev/null && ok "TCP $PORT — web interface and API"
    ufw allow 53212/udp    >/dev/null && ok "UDP 53212 — Sennheiser G3/G4"
    ufw allow 5353/udp     >/dev/null && ok "UDP 5353 — mDNS discovery"
  else
    warn "ufw is installed but inactive; no rules added."
    warn "If you enable it later, allow: ${PORT}/tcp, 53212/udp, 5353/udp"
  fi
fi

# ── Start ────────────────────────────────────────────────────────────────────

step "Starting RFDeck"
systemctl restart "$SERVICE_NAME"

# Give it a moment, then confirm it is actually serving rather than crash-looping.
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1; break
  fi
  sleep 1
done

if [[ "${HEALTHY:-0}" != "1" ]]; then
  printf '\n  %s✗%s RFDeck did not come up. Recent log:\n\n' "$RED" "$OFF"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager | sed 's/^/    /'
  exit 1
fi

ok "Service is running and responding"

# ── Done ─────────────────────────────────────────────────────────────────────

printf '\n%s%s  RFDeck is ready%s\n\n' "$BOLD" "$GRN" "$OFF"
echo "  Open it from any device on this network:"
echo
for ADDR in $(hostname -I 2>/dev/null); do
  case "$ADDR" in *:*) continue ;; esac   # skip IPv6
  # Port 80 is implicit in a URL — printing it makes the address look wrong.
  if [[ "$PORT" == "80" ]]; then
    printf '      %shttp://%s%s\n' "$BOLD" "$ADDR" "$OFF"
  else
    printf '      %shttp://%s:%s%s\n' "$BOLD" "$ADDR" "$PORT" "$OFF"
  fi
done
echo
echo "  ${DIM}Access is open to the network. To require a PIN, open Settings →${OFF}"
echo "  ${DIM}Remote Access in a browser on this machine.${OFF}"
echo
echo "  Manage the service:"
echo "      systemctl status ${SERVICE_NAME}"
echo "      systemctl restart ${SERVICE_NAME}"
echo "      journalctl -u ${SERVICE_NAME} -f"
echo
echo "  Database:  ${DB_PATH}"
echo "  ${DIM}Back this up — it holds inventory, shows, and history.${OFF}"
[[ "$UPGRADE" == "1" ]] && echo && echo "  ${DIM}Upgraded in place; existing data preserved.${OFF}"
echo
