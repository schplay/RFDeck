#!/usr/bin/env bash
#
# Provision an RFDeck server for testing.
#
# Builds the workspace, applies the database schema, and starts the server.
# Safe to re-run: it will not overwrite an existing database.
#
#   ./scripts/deploy-server.sh                 build, migrate, start in foreground
#   ./scripts/deploy-server.sh --no-start      build and migrate only
#   ./scripts/deploy-server.sh --port 8080     serve on a different port
#   ./scripts/deploy-server.sh --data /srv/rf  keep the database elsewhere
#   ./scripts/deploy-server.sh --check         verify prerequisites and exit
#   ./scripts/deploy-server.sh --accept-data-loss   allow a schema change that drops data
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/apps/server"

PORT=3000
DATA_DIR="$SERVER_DIR"
START=1
CHECK_ONLY=0
# Answer yes in advance to a schema change that drops data; interactively the
# schema step asks instead.
ACCEPT_DATA_LOSS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT="$2"; shift 2 ;;
    --data)     DATA_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --check)    CHECK_ONLY=1; shift ;;
    --accept-data-loss) ACCEPT_DATA_LOSS=1; shift ;;
    -h|--help)  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!  \033[0m%s\n' "$1"; }
fail() { printf '\033[31mx  \033[0m%s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32mok \033[0m%s\n' "$1"; }

# ── Prerequisites ────────────────────────────────────────────────────────────

info "Checking prerequisites"

command -v node >/dev/null || fail "Node.js is not installed. RFDeck needs Node 24 LTS."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node $NODE_MAJOR is too old. Install Node 24 LTS."
elif [[ "$NODE_MAJOR" -lt 24 ]]; then
  warn "Node $NODE_MAJOR detected; 24 LTS is what RFDeck is tested against."
else
  ok "Node $(node -v)"
fi

command -v pnpm >/dev/null || fail "pnpm is not installed. Try: npm install -g pnpm"
ok "pnpm $(pnpm -v)"

if [[ "$CHECK_ONLY" == "1" ]]; then
  info "Prerequisites satisfied. Re-run without --check to deploy."
  exit 0
fi

# ── Build ────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

info "Installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Generating the Prisma client"
# Fails with EPERM on Windows if a running instance holds the query engine.
pnpm --filter @rfdeck/server exec prisma generate >/dev/null \
  || fail "prisma generate failed. If RFDeck is running, close it and re-run."

info "Building"
pnpm --filter @rfdeck/shared-types build
pnpm --filter @rfdeck/web build      # the server serves this build
pnpm --filter @rfdeck/server build
ok "Build complete"

# ── Database ─────────────────────────────────────────────────────────────────

mkdir -p "$DATA_DIR"
DB_PATH="$(cd "$DATA_DIR" && pwd)/rfdeck.db"
# Prisma wants a URL, and Windows backslashes are not valid in one.
export DATABASE_URL="file:${DB_PATH//\\//}"

# Usually additive — new tables and columns, nothing touched. A release that
# also REMOVES one makes prisma stop and ask for confirmation on stdin, and with
# stdin attached and the output redirected that reads as the deploy hanging with
# nothing on screen. Its stdin is closed so that can never happen, and the
# question is asked here instead, naming what would be lost.
# The part of prisma's output that says what would actually be lost. Taken as a
# span rather than by matching its bullets, which are a multi-byte "•" that a
# bracket expression cannot match — that silently printed nothing, leaving the
# operator asked to approve a data loss with no idea what it was.
data_loss_details() {
  local span
  span="$(sed -n '/[Dd]ata loss/,/^Error/p' <<<"$1" | sed '/^Error/d')"
  [[ -n "${span//[[:space:]]/}" ]] || span="$1"
  sed 's/^[[:space:]]*/    /' <<<"$span"
}

schema_push() {
  pnpm --filter @rfdeck/server exec prisma db push --skip-generate "$@" </dev/null 2>&1
}

# Recorded before the push, which creates the file either way.
if [[ -f "$DB_PATH" ]]; then
  DB_EXISTED=1
  info "Using existing database at $DB_PATH"
else
  DB_EXISTED=0
  info "Creating database at $DB_PATH"
fi

if ! push_output="$(schema_push)"; then
  if grep -qiE 'accept-data-loss|cannot be executed|data will be lost' <<<"$push_output"; then
    printf '\n\033[33m!  \033[0mThis release needs to remove data from the database.\n\n'
    data_loss_details "$push_output"
    printf '\n'
    accepted=0
    if [[ "$ACCEPT_DATA_LOSS" == "1" ]]; then
      accepted=1
    elif [[ -r /dev/tty ]]; then
      read -r -p "  Apply it? [y/N] " reply </dev/tty || reply=""
      [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]] && accepted=1
    else
      warn "Not running interactively - refusing."
    fi
    [[ "$accepted" == "1" ]] \
      || fail "Schema change declined. Nothing was changed. Re-run with --accept-data-loss to allow it."
    if ! push_output="$(schema_push --accept-data-loss)"; then
      printf '%s\n' "$push_output"
      fail "Applying the database schema failed"
    fi
  else
    printf '%s\n' "$push_output"
    fail "Applying the database schema failed"
  fi
fi
[[ "$DB_EXISTED" == "1" ]] && ok "Schema up to date" || ok "Database created"

# ── Firewall reminder ────────────────────────────────────────────────────────
#
# Discovery and telemetry use UDP ports beyond the HTTP port. If they are
# blocked, devices are discovered but never report data — which looks exactly
# like broken hardware, so it is worth being loud about.

info "Required inbound ports"
cat <<PORTS
    TCP  $PORT    HTTP API, frontend, and realtime socket
    UDP  53212   Sennheiser MCP (G3/G4 discovery and telemetry)
    UDP  5353    mDNS / Bonjour (EW-DX discovery)
    UDP  45      SSCv1 (EW-DX live telemetry)
PORTS

if command -v ufw >/dev/null 2>&1; then
  warn "Open them with: sudo ufw allow $PORT/tcp && sudo ufw allow 53212/udp && sudo ufw allow 5353/udp && sudo ufw allow 45/udp"
elif [[ "${OS:-}" == "Windows_NT" ]]; then
  warn "Open them by running scripts/open-firewall.ps1 as Administrator"
fi

# ── Start ────────────────────────────────────────────────────────────────────

if [[ "$START" == "0" ]]; then
  info "Build and database ready. Start with:"
  echo "    cd $SERVER_DIR && DATABASE_URL=\"$DATABASE_URL\" PORT=$PORT node dist/server.js"
  exit 0
fi

export PORT
info "Starting RFDeck on port $PORT"
echo
for ADDR in $(node -e "
  const os=require('os');
  Object.values(os.networkInterfaces()).flat()
    .filter(i=>i && i.family==='IPv4' && !i.internal)
    .forEach(i=>console.log(i.address));
" 2>/dev/null); do
  echo "    http://$ADDR:$PORT"
done
echo "    http://localhost:$PORT"
echo
info "Access is open to the network by default."
info "To require a PIN: Settings -> Remote Access, on this machine."
echo

cd "$SERVER_DIR"
exec node dist/server.js
