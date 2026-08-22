#!/usr/bin/env bash
#
# Install RFDeck as a system service on a clean Ubuntu server.
#
# Takes a fresh Ubuntu 22.04 or 24.04 box to a running RFDeck that people on the
# venue network reach in a browser. Installs Node, builds the application,
# creates a service account, provisions the database, generates a self-signed
# certificate, installs the AES67 audio daemon, opens the firewall, and registers
# a systemd unit that starts on boot.
#
# Serves HTTPS on 443 by default. That is not about secrecy on a closed network:
# browsers only expose audio capture to pages in a secure context, so without it
# audio monitoring cannot work for anyone but someone sitting at the server.
#
# Run as root, from anywhere:
#
#   sudo ./scripts/install-ubuntu.sh
#   sudo ./scripts/install-ubuntu.sh --port 8080
#   sudo ./scripts/install-ubuntu.sh --repo https://github.com/you/rfdeck.git
#   sudo ./scripts/install-ubuntu.sh --no-tls          plain HTTP on port 80
#   sudo ./scripts/install-ubuntu.sh --regenerate-cert  new cert (address changed)
#   sudo ./scripts/install-ubuntu.sh --no-aes67         skip the AES67 daemon
#   sudo ./scripts/install-ubuntu.sh --uninstall
#
# Re-running upgrades in place: the database and settings are preserved.
#
set -euo pipefail

INSTALL_DIR=/opt/rfdeck
DATA_DIR=/var/lib/rfdeck
SERVICE_USER=rfdeck
SERVICE_NAME=rfdeck
NODE_MAJOR=24
REPO_URL=""
BRANCH="main"
SKIP_FIREWALL=0
UNINSTALL=0
USE_TLS=1
FORCE_CERT=0
WITH_AES67=1
# Port is chosen after argument parsing, so it can follow the TLS decision.
PORT=""
HTTP_REDIRECT_PORT=80

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2"; shift 2 ;;
    --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
    --data-dir)      DATA_DIR="$2"; shift 2 ;;
    --repo)          REPO_URL="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --no-tls)          USE_TLS=0; shift ;;
    --regenerate-cert) FORCE_CERT=1; shift ;;
    --no-aes67)        WITH_AES67=0; shift ;;
    --uninstall)     UNINSTALL=1; shift ;;
    # Print the header comment, stopping at the first line of actual script.
    -h|--help)       awk 'NR>2 && /^#/ { sub(/^# ?/,""); print; next } NR>2 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# 443 for HTTPS, 80 for plain HTTP — whichever scheme is in use, the address
# is then just the server's IP with no port to remember.
if [[ -z "$PORT" ]]; then
  if [[ "$USE_TLS" == "1" ]]; then PORT=443; else PORT=80; fi
fi

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
  rm -f /usr/local/bin/rfdeck
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  ok "Service and application removed"

  # The AES67 daemon and its kernel module were installed by this script, so
  # take them with us. Its own data is left alone.
  if systemctl list-unit-files 2>/dev/null | grep -q '^aes67-daemon'; then
    systemctl stop    aes67-daemon 2>/dev/null || true
    systemctl disable aes67-daemon 2>/dev/null || true
    rm -f /etc/systemd/system/aes67-daemon.service
    rm -f /etc/modules-load.d/aes67.conf
    rm -f "/lib/modules/$(uname -r)/extra/MergingRavennaALSA.ko"
    depmod -a 2>/dev/null || true
    systemctl daemon-reload
    ok "AES67 daemon removed"
  fi

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

# Shell scripts are committed from a Windows checkout, where git may not have
# recorded the executable bit. Restore it on the deployed copy so the next
# upgrade can always be run straight from the install directory.
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true

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

# ── TLS certificate ───────────────────────────────────────────────────────────
#
# HTTPS is not about secrecy on a closed show network. Browsers only expose
# audio capture — navigator.mediaDevices — to pages in a *secure context*, so
# without it audio monitoring can never work for anyone except someone sitting
# at the server. A self-signed certificate is enough to earn that status.
#
# The certificate must carry Subject Alternative Names for every address people
# will type. Modern browsers ignore the Common Name entirely, so a cert without
# matching SANs is rejected outright rather than merely warned about.

CERT_DIR="$DATA_DIR/certs"
CERT_FILE="$CERT_DIR/rfdeck.crt"
KEY_FILE="$CERT_DIR/rfdeck.key"

if [[ "$USE_TLS" == "1" ]]; then
  step "Setting up HTTPS"

  command -v openssl >/dev/null || apt-get install -y -qq openssl >/dev/null

  mkdir -p "$CERT_DIR"
  chmod 750 "$CERT_DIR"

  if [[ -f "$CERT_FILE" && -f "$KEY_FILE" && "$FORCE_CERT" == "0" ]]; then
    CERT_EXPIRY="$(openssl x509 -enddate -noout -in "$CERT_FILE" 2>/dev/null | cut -d= -f2)"
    ok "Existing certificate kept (expires ${CERT_EXPIRY:-unknown})"
    warn "Regenerate with --regenerate-cert if the machine's addresses changed"
  else
    # Every address a browser might use, or the certificate will not match.
    SAN="DNS:localhost,DNS:$(hostname),DNS:$(hostname).local,IP:127.0.0.1"
    for ADDR in $(hostname -I 2>/dev/null); do
      case "$ADDR" in *:*) continue ;; esac   # IPv4 only
      SAN="$SAN,IP:$ADDR"
    done

    openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
      -keyout "$KEY_FILE" -out "$CERT_FILE" \
      -days 3650 \
      -subj "/CN=RFDeck/O=RFDeck" \
      -addext "subjectAltName=$SAN" \
      -addext "basicConstraints=critical,CA:FALSE" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
      -addext "extendedKeyUsage=serverAuth" \
      >/dev/null 2>&1 \
      || die "Could not generate the TLS certificate"

    ok "Self-signed certificate generated (valid 10 years)"
    printf '      %s\n' "$SAN" | sed 's/,/, /g'
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$CERT_DIR"
  chmod 640 "$KEY_FILE" "$CERT_FILE"
fi

# ── Service ──────────────────────────────────────────────────────────────────

step "Registering the service"

# Note the port currently in service before the unit is rewritten, so the
# firewall step below can retire its rule if the port is changing.
PREVIOUS_PORT=""
if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  PREVIOUS_PORT="$(sed -n 's/^Environment=PORT=\([0-9]\+\)$/\1/p' \
    "/etc/systemd/system/${SERVICE_NAME}.service" | head -1)"
fi

TLS_ENV=""
if [[ "$USE_TLS" == "1" ]]; then
  TLS_ENV="Environment=TLS_CERT=${CERT_FILE}
Environment=TLS_KEY=${KEY_FILE}
Environment=HTTP_REDIRECT_PORT=${HTTP_REDIRECT_PORT}"
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
${TLS_ENV}
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

# ── AES67 audio daemon ────────────────────────────────────────────────────────
#
# bondagit/aes67-linux-daemon turns this machine into an AES67 endpoint, giving
# RFDeck a network audio source to monitor. It builds the Merging Technologies
# RAVENNA ALSA kernel module, so it needs headers matching the running kernel
# and takes several minutes.
#
# Deliberately non-fatal. RF monitoring is the core function and must not become
# undeployable because an out-of-tree kernel module failed to compile — which it
# will on an unsupported kernel, and after any kernel upgrade until it is
# rebuilt. Failures are reported loudly and the RFDeck install continues.

AES67_SRC="/opt/aes67-linux-daemon"
AES67_REPO="https://github.com/bondagit/aes67-linux-daemon.git"

install_aes67() {
  step "Installing the AES67 audio daemon"

  local headers="linux-headers-$(uname -r)"
  if ! apt-get install -y -qq "$headers" >/dev/null 2>&1; then
    warn "No $headers available — the kernel module cannot be built."
    warn "Skipping AES67. RFDeck itself is unaffected."
    return 1
  fi

  # Package list from the project's own debian-packages.sh.
  apt-get install -y -qq \
    psmisc clang cmake libboost-all-dev \
    linux-sound-base alsa-base alsa-utils libasound2-dev \
    linuxptp libavahi-client-dev libsystemd-dev libfaac-dev \
    wget >/dev/null 2>&1 \
    || { warn "Could not install AES67 build dependencies — skipping."; return 1; }
  ok "Build dependencies installed"

  if [[ -d "$AES67_SRC/.git" ]]; then
    git -C "$AES67_SRC" fetch --depth 1 origin master >/dev/null 2>&1 || true
    git -C "$AES67_SRC" reset --hard origin/master >/dev/null 2>&1 || true
    ok "Source updated"
  else
    rm -rf "$AES67_SRC"
    git clone --depth 1 "$AES67_REPO" "$AES67_SRC" >/dev/null 2>&1 \
      || { warn "Could not clone the AES67 daemon — skipping."; return 1; }
    ok "Source cloned"
  fi

  # build.sh fetches submodules, builds the kernel module, downloads the
  # prebuilt WebUI, then cmake-builds the daemon.
  ( cd "$AES67_SRC" && ./build.sh ) >/tmp/aes67-build.log 2>&1 \
    || { warn "AES67 build failed — see /tmp/aes67-build.log"; return 1; }
  ok "Daemon and kernel module built"

  # Install the module where the kernel will find it, so it survives a reboot.
  # It will NOT survive a kernel upgrade; that needs a rebuild.
  local ko
  ko="$(find "$AES67_SRC/3rdparty/ravenna-alsa-lkm" -name 'MergingRavennaALSA.ko' | head -1)"
  if [[ -n "$ko" ]]; then
    install -D -m 644 "$ko" "/lib/modules/$(uname -r)/extra/MergingRavennaALSA.ko"
    depmod -a
    echo "MergingRavennaALSA" > /etc/modules-load.d/aes67.conf
    modprobe MergingRavennaALSA 2>/dev/null \
      || warn "Module installed but not loaded — a reboot may be required"
    ok "RAVENNA ALSA module installed and set to load at boot"
  else
    warn "Kernel module not found after build — audio devices will not appear"
  fi

  # The project's systemd/install.sh assumes it runs from its own directory.
  ( cd "$AES67_SRC/systemd" && ./install.sh ) >>/tmp/aes67-build.log 2>&1 \
    || { warn "AES67 service install failed — see /tmp/aes67-build.log"; return 1; }

  # Point the daemon at the same interface RFDeck uses for discovery.
  local iface
  iface="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [[ -n "$iface" && -f /etc/daemon.conf ]]; then
    sed -i "s/\"interface_name\".*:.*\"[^\"]*\"/\"interface_name\": \"$iface\"/" \
      /etc/daemon.conf 2>/dev/null || true
    ok "Daemon bound to interface $iface"
  fi

  systemctl enable aes67-daemon >/dev/null 2>&1 || true
  systemctl restart aes67-daemon >/dev/null 2>&1 || true

  if systemctl is-active --quiet aes67-daemon; then
    ok "AES67 daemon running — web UI on port 8080"
  else
    warn "AES67 daemon did not start. Check: journalctl -u aes67-daemon -n 50"
    return 1
  fi
}

AES67_OK=0
if [[ "$WITH_AES67" == "1" ]]; then
  if install_aes67; then
    AES67_OK=1
  else
    warn "AES67 setup did not complete. RFDeck is unaffected and will still run."
  fi
fi

# ── Admin CLI ─────────────────────────────────────────────────────────────────
#
# A headless server has no browser on the host, so shell access has to be a
# first-class way to administer it — and the only way back in if the PIN is
# forgotten. Installed as `rfdeck` on PATH.

step "Installing the rfdeck admin CLI"

# A standalone file rather than a generated one, so the installer and the
# update script cannot drift apart. It reads the install directory and
# database from the systemd unit at run time, so nothing is substituted in.
install -m 755 "$INSTALL_DIR/scripts/rfdeck" /usr/local/bin/rfdeck
ok "rfdeck command installed"

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
    if [[ "$USE_TLS" == "1" && "$HTTP_REDIRECT_PORT" != "$PORT" ]]; then
      ufw allow "$HTTP_REDIRECT_PORT"/tcp >/dev/null \
        && ok "TCP $HTTP_REDIRECT_PORT — redirects to HTTPS"
    fi
    ufw allow 53212/udp    >/dev/null && ok "UDP 53212 — Sennheiser G3/G4"
    ufw allow 5353/udp     >/dev/null && ok "UDP 5353 — mDNS discovery"
    if [[ "${AES67_OK:-0}" == "1" ]]; then
      ufw allow 8080/tcp >/dev/null && ok "TCP 8080 — AES67 daemon web UI"
      ufw allow 319/udp  >/dev/null && ok "UDP 319 — PTP event"
      ufw allow 320/udp  >/dev/null && ok "UDP 320 — PTP general"
    fi
  else
    warn "ufw is installed but inactive; no rules added."
    warn "If you enable it later, allow: ${PORT}/tcp, 53212/udp, 5353/udp"
  fi
fi

# ── Start ────────────────────────────────────────────────────────────────────

SCHEME="http"
[[ "$USE_TLS" == "1" ]] && SCHEME="https"

step "Starting RFDeck"
systemctl restart "$SERVICE_NAME"

# Give it a moment, then confirm it is actually serving rather than crash-looping.
for _ in $(seq 1 20); do
  # -k because the certificate is self-signed; we are checking that the
  # service answers, not validating a chain we just created ourselves.
  if curl -fsSk --max-time 2 "${SCHEME}://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
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
  # The default port for the scheme is implicit in a URL — printing it makes
  # the address look more complicated than it is.
  if [[ ( "$SCHEME" == "https" && "$PORT" == "443" ) || ( "$SCHEME" == "http" && "$PORT" == "80" ) ]]; then
    printf '      %s%s://%s%s\n' "$BOLD" "$SCHEME" "$ADDR" "$OFF"
  else
    printf '      %s%s://%s:%s%s\n' "$BOLD" "$SCHEME" "$ADDR" "$PORT" "$OFF"
  fi
done
echo
if [[ "$USE_TLS" == "1" ]]; then
  echo "  ${DIM}The certificate is self-signed, so each browser shows a warning the${OFF}"
  echo "  ${DIM}first time. Accept it once per device — that is what grants the page${OFF}"
  echo "  ${DIM}the secure context audio monitoring needs.${OFF}"
  echo
fi
if [[ "$WITH_AES67" == "1" ]]; then
  if [[ "${AES67_OK:-0}" == "1" ]]; then
    for ADDR in $(hostname -I 2>/dev/null); do
      case "$ADDR" in *:*) continue ;; esac
      echo "  AES67 daemon:  http://${ADDR}:8080"
      break
    done
    echo
  else
    echo "  ${DIM}AES67 daemon not running — see /tmp/aes67-build.log${OFF}"
    echo
  fi
fi
echo "  ${DIM}Access is open to the network. To require a PIN, open Settings →${OFF}"
echo "  ${DIM}Remote Access in a browser on this machine.${OFF}"
echo
echo "  Administer from this machine:"
echo "      rfdeck status"
echo "      rfdeck set-pin 1234"
echo "      rfdeck audio-devices"
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
