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

```bash
pnpm install
pnpm --filter @rfdeck/shared-types build
pnpm --filter @rfdeck/web build          # builds the frontend the server serves
pnpm --filter @rfdeck/server prisma:push # creates the SQLite schema
pnpm --filter @rfdeck/server build
pnpm --filter @rfdeck/server start
```

The server listens on port 3000 by default. Clients connect at
`http://<server-ip>:3000`.

### Environment

`apps/server/.env`:

```
DATABASE_URL=file:./rfdeck.db
PORT=3000
```

`DATABASE_URL` is relative to `apps/server/`. Use an absolute path if you run the
server from elsewhere — a relative path resolved from the wrong working directory
silently creates a second, empty database rather than failing.

### Ports and firewall

Discovery and telemetry use several UDP ports beyond the HTTP port. **All of them
must be open inbound on the server**, or devices will be discovered but never
report data — a failure that looks like broken hardware.

| Port | Protocol | Purpose |
|---|---|---|
| 3000 | TCP | HTTP API, frontend, and Socket.io |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS / Bonjour — EW-DX discovery |
| 45 | UDP | SSCv1 — EW-DX live telemetry |

On Windows the desktop build opens these automatically at startup. **The headless
server does not** — open them yourself:

```powershell
New-NetFirewallRule -DisplayName "RFDeck HTTP"  -Direction Inbound -Protocol TCP -LocalPort 3000  -Action Allow
New-NetFirewallRule -DisplayName "RFDeck MCP"   -Direction Inbound -Protocol UDP -LocalPort 53212 -Action Allow
New-NetFirewallRule -DisplayName "RFDeck mDNS"  -Direction Inbound -Protocol UDP -LocalPort 5353  -Action Allow
New-NetFirewallRule -DisplayName "RFDeck SSCv1" -Direction Inbound -Protocol UDP -LocalPort 45    -Action Allow
```

On Linux with ufw:

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 53212/udp
sudo ufw allow 5353/udp
sudo ufw allow 45/udp
```

### Multiple network interfaces

A machine with both a house network and an isolated show network will broadcast
discovery on all of them by default. Set **Settings → Network Config → Bind
Interface** to the show network address to keep probes off the house LAN.

### Running as a service

Keep the process alive across reboots with systemd, NSSM on Windows, or pm2.
Minimal systemd unit:

```ini
[Unit]
Description=RFDeck
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/rfdeck/apps/server
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
User=rfdeck

[Install]
WantedBy=multi-user.target
```

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

The installer lands in `apps/desktop/dist/`.

The desktop build opens the required firewall ports on first run and always
trusts its own window, so a PIN can never lock an operator out of the machine in
front of them.

---

## Remote access

RFDeck is **open by default**: any device that can reach the server connects
freely. That is the right default on an isolated show network, where a login
prompt between an operator and a failing channel is a liability.

If the show network is shared with house or guest traffic, require a PIN:

**Settings → Remote Access**, on the machine running RFDeck.

- Set a PIN (4+ digits), then enable the requirement
- Choose how often remote devices must re-enter it — **never** suits a resident
  booth display; shorter intervals suit devices that leave the venue
- **Sign out all devices** forces everyone to re-enter it, for a crew change

Two rules that are deliberate:

- **Loopback is always exempt.** Physical access to the host already implies
  control, and the desktop window must never be locked out of its own server.
- **Access settings can only be changed from the host machine.** Without user
  accounts there is no way to distinguish an admin from any other client, so
  allowing remote changes would make the control worthless.

Both the REST API and the realtime socket are gated. Control commands travel over
the socket, so gating only REST would leave the real surface open.

---

## Data and backup

| What | Where |
|---|---|
| Database | `apps/server/rfdeck.db` (per `DATABASE_URL`) |
| Encryption key | `.rfdeck-key`, beside the database |

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
blocked inbound. Check 53212 and 45 specifically — TCP 3000 being open is not
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
