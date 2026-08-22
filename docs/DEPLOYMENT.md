# RFDeck Deployment

RFDeck ships in two shapes from one codebase. **Both are network services with
multiple concurrent clients** — the desktop build is the same server with a local
window attached, not a single-operator application.

| | Headless server | Desktop |
|---|---|---|
| Runs as | `node dist/server.js` | Electron shell wrapping the same server |
| Database | SQLite beside the server | SQLite in the app directory |
| Clients | Any browser on the network | The local window, plus any browser on the network |
| Best for | A rack machine or venue server that stays put | A laptop an operator carries to the gig |

Target scale is **2–128 channels and 1–10 concurrent clients**. SQLite is
comfortable at that size; PostgreSQL is only needed for a hosted multi-venue
deployment.

---

## Headless server

### Requirements

- Node.js 24 LTS
- pnpm 10+
- A network interface on the same subnet as the wireless receivers

### Install and run

On a clean Ubuntu 22.04 or 24.04 machine, one command takes it from bare OS to a
running service:

```bash
git clone <your-repo> rfdeck && cd rfdeck
sudo ./scripts/install-ubuntu.sh
```

It installs Node, builds the application, creates a service account, provisions
the database in `/var/lib/rfdeck`, registers a hardened systemd unit, opens the
firewall, and verifies the service responds before reporting success. Re-running
it upgrades in place and preserves the database.

Full options, upgrade and backup procedure, and log-level control are in
[`../scripts/README.md`](../scripts/README.md).

The server listens on **port 80** and serves the web interface itself, so anyone
on the network just opens `http://<server-ip>` in a browser. No separate web
server or reverse proxy is needed.

Binding port 80 does not mean running as root: the unit grants the service
account `CAP_NET_BIND_SERVICE` and nothing more. Use `--port` if something else
on the machine already owns 80.

### Environment

The installer writes these into the systemd unit. Set them yourself only for a
manual run.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Absolute `file:` path to the SQLite database |
| `PORT` | HTTP port (default 80 for the installer, 3000 otherwise) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `LOG_LEVEL` | `error`, `warn`, `info`, or `debug` |
| `NODE_ENV` | `production` defaults logging to `warn` |
| `WEB_ROOT` | Override where the built UI is served from |

**Always use an absolute `DATABASE_URL`.** A relative path is resolved against
the working directory, so starting the server from a different directory
silently creates a second, empty database rather than failing — the application
comes up looking like a fresh install with all data apparently gone. The
installer always writes an absolute path for this reason.

To confirm which database is in use, run with `LOG_LEVEL=debug` and look for:

```
[Prisma] Using database file:/var/lib/rfdeck/rfdeck.db
```

Check that first whenever data appears to be missing.

### Ports and firewall

Discovery and telemetry use several UDP ports beyond the HTTP port. **All of them
must be open inbound on the server**, or devices will be discovered but never
report data — a failure that looks like broken hardware.

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Web interface, API, and Socket.io |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS / Bonjour — EW-DX discovery |

EW-DX SSCv1 telemetry arrives on an ephemeral source port rather than a fixed
one, so it needs no rule of its own on Linux — connection tracking handles the
replies. On Windows it may need an application-level rule; see
`scripts/open-firewall.ps1`.

The Ubuntu installer opens these automatically when `ufw` is active. On Linux
otherwise:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 53212/udp
sudo ufw allow 5353/udp
```

On Windows, run `scripts\open-firewall.ps1` as Administrator. The desktop build
also adds its own rules at startup.

The service runs as an unprivileged account. Port 80 is the only privileged
bind, and the systemd unit grants exactly `CAP_NET_BIND_SERVICE` for it — the
UDP discovery ports are all above 1024 and need nothing.

### Audio monitoring over the network

Browsers only expose audio capture to pages in a **secure context** — served
over HTTPS, or from `localhost`. A headless server reached at
`http://192.168.1.50` is neither, so `navigator.mediaDevices` is absent and
audio monitoring cannot work there. This is a browser rule, not a limitation of
RFDeck or of the server's hardware; a machine with no soundcard behaves exactly
the same as one with a rack of interfaces.

Everything else — telemetry, inventory, shows, mic check, alerts — is
unaffected, and the Settings page explains the situation rather than reporting
missing hardware.

To monitor audio from a browser, either open RFDeck from the machine running it
(`http://localhost`), or put it behind HTTPS. A self-signed certificate is
enough for a closed show network, though every client will have to accept the
warning once.

### Multiple network interfaces

A machine with both a house network and an isolated show network will broadcast
discovery on all of them by default. Set **Settings → Network Config → Bind
Interface** to the show network address to keep probes off the house LAN.

### Running as a service

`install-ubuntu.sh` registers a hardened systemd unit for you — it runs as an
unprivileged `rfdeck` account, restricts filesystem access to the data directory,
and starts on boot.

```bash
systemctl status rfdeck
systemctl restart rfdeck
journalctl -u rfdeck -f
```

### Logging

The service is quiet by default: warnings and errors only. Per-device protocol
detail is `debug` and off, because at 128 channels it would fill the journal.

To troubleshoot a device that will not connect, `sudo systemctl edit rfdeck` and
add:

```ini
[Service]
Environment=LOG_LEVEL=debug
```

Levels are `error`, `warn`, `info`, `debug`. Set it back to `warn` afterwards.

---

## Desktop

```bash
pnpm install
pnpm --filter @rfdeck/desktop dev      # builds server + web, then opens the window
```

To produce a Windows installer:

```bash
pnpm --filter @rfdeck/shared-types build
pnpm --filter @rfdeck/web build
pnpm --filter @rfdeck/server build
pnpm --filter @rfdeck/desktop package
```

The installer lands in `apps/desktop/release/`.

The desktop build opens the required firewall ports on first run and always
trusts its own window, so a PIN can never lock an operator out of the machine in
front of them.

---

## Remote access

RFDeck is **open by default**: any device that can reach the server connects
freely. That is the right default on an isolated show network, where a login
prompt between an operator and a failing channel is a liability.

If the show network is shared with house or guest traffic, require a PIN — from
any browser under **Settings → Remote Access**, or from a shell on the server
with `rfdeck set-pin 4821`.

There are no user accounts. Access is decided by three rules:

| | Can connect | Can change access settings |
|---|---|---|
| A browser on the server, or the desktop app | Always | Always |
| Any client, while no PIN is set | Yes | Yes — this is how the first PIN gets set |
| Any client, once a PIN is set | After entering the PIN | Only after entering the PIN |
| A shell on the server | — | Always, including resetting a forgotten PIN |

Three choices worth stating plainly:

- **Loopback is always exempt.** Physical access to the host already implies
  control, and the desktop window must never be locked out of its own server.
- **Knowing the PIN is the credential for changing it.** A second admin
  credential to lose is worse than useless for a crew sharing one rack.
- **Setting the first PIN is unauthenticated.** Until one exists the server is
  open to everyone anyway, so this grants nothing that was not already
  available — and it is what allows a PIN to be set from a laptop rather than
  requiring a screen on the server. A "loopback only" rule would make the PIN
  unreachable on the deployment it exists for.

A forgotten PIN is recovered from a shell, which is the one thing a headless
server always has:

```bash
sudo rfdeck set-pin 1234     # replace it
sudo rfdeck disable-pin      # or turn it off entirely
```

Changing or disabling a PIN applies to new connections immediately; use **Sign
out all devices**, or restart the service, to drop sessions already established.

Both the REST API and the realtime socket are gated. Control commands travel over
the socket, so gating only REST would leave the real surface open.

---

## Administering from the shell

A headless server has no browser on it, so `rfdeck` is how it is administered
over SSH — and the recovery path when a PIN is lost. Installed on `PATH` by
`install-ubuntu.sh`.

```bash
rfdeck status              # access and audio configuration at a glance
rfdeck set-pin 4821        # require a PIN from remote devices
rfdeck disable-pin         # network becomes open again
rfdeck audio-devices       # capture devices and the current channel patch
```

`rfdeck status` is the first command to reach for when something looks wrong:

```
Remote access
  PIN required   : yes
  PIN configured : yes
  Re-ask after   : 24h

Audio
  Channels patched : 8
```

It reads the database path from the running systemd unit rather than assuming
one, so it always acts on the same data as the service — the same failure mode
that made an earlier hardcoded path silently open the wrong database.

`rfdeck audio-devices` also confirms whether the AES67 kernel module loaded: its
virtual capture device appears in the list once it has.

Installed by `install-ubuntu.sh`, not by `update-server.sh`, which touches only
application code. Run the installer once after upgrading from a version that
predates the CLI.

---

## Data and backup

| What | Where |
|---|---|
| Database | `/var/lib/rfdeck/rfdeck.db` (per `DATABASE_URL`) |
| Encryption key | `/var/lib/rfdeck/.rfdeck-key`, beside the database |

The database holds inventory, shows, roster, mic-check history, event log, and
settings. Device passwords inside it are encrypted with AES-256-GCM.

**Back up both files.** The key is stored beside the database rather than inside
it precisely so that copying the database alone does not carry the credentials
with it — which also means a backup without the key leaves device passwords
unrecoverable. Everything else in the backup still restores; those devices simply
need their passwords re-entered.

Retention: the event log is pruned on startup to 90 days or 50,000 rows,
whichever comes first.

---

## Verifying a deployment

Run these before trusting an install with a show. Details in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md#verification-protocol).

1. **Cold start** — receivers off, start RFDeck, power receivers on; all reach online unaided
2. **DHCP shuffle** — power-cycle the network; all devices recover at new addresses
3. **Dual-interface** — an EW-DX on control and Dante appears exactly once
4. **Intentional power-down** — an inactive device raises no alerts
5. **Cable pull** — stale data is unmistakable; reconnect resumes without a restart
6. **Two-client agreement** — a mic-check tick on one client appears on another within a second
7. **Show persistence** — create a show, tick channels, restart; everything intact
8. **Long run** — leave running for a full show; no memory growth or event flooding

---

## Troubleshooting

**Devices discovered but never report telemetry.** Almost always a UDP port
blocked inbound. Check 53212 and 5353 specifically — TCP 80 being open is not
enough, and this failure looks exactly like broken hardware.

**No devices discovered at all.** Check the bind interface is on the receivers'
subnet, and that UDP 5353 is open for mDNS.

**A device shows twice.** An EW-DX with control and Dante on the same VLAN. The
server suppresses the Dante address once the device connects; if it persists, the
device is probably not yet reachable on its control interface.

**Remote clients get a PIN prompt unexpectedly.** The re-auth interval elapsed.
Set it to "never" for resident displays.

**`prisma generate` fails with EPERM on Windows.** The running app holds the query
engine DLL. Close RFDeck and re-run.
