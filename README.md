# RFDeck

> Professional wireless audio device management for live sound, theater, and broadcast.

RFDeck is a cross-platform application for managing wireless microphone and in-ear monitor (IEM) systems in demanding live production environments. It consolidates real-time RF telemetry, battery monitoring, audio monitoring, automatic fault detection with recorded evidence, hardware inventory, and show workflow tools into a single, unified interface — available as a desktop application and a hosted web application from one shared codebase.

---

## Why RFDeck?

Existing tools in this space are fragmented, limited, or platform-locked:

- **MicBoard** — read-only, Shure-only, no audio, no control
- **WaveTool** — macOS only, no web version, no frequency visualization, no performer management
- **Shure Wireless Workbench / Sennheiser WSM** — manufacturer-specific, not unified

RFDeck is designed for the A2 / RF tech who manages multi-brand wireless systems across different show types, and needs one tool that works everywhere — at the rack, at FOH, backstage, or on their phone walking the stage.

---

## Core Features

> **Status legend.** This section describes the full product vision. Items are
> marked with their current implementation state so the document stays usable as
> a specification without overstating what ships today.
>
> | Mark | Meaning |
> |---|---|
> | *(no mark)* | Implemented and working against real hardware |
> | 🚧 | Partially implemented — see the note |
> | 📋 | Planned, not yet built |
>
> See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for sequencing.

### Live Monitoring Dashboard
Real-time telemetry for all active wireless channels:
- Dual-antenna RF signal meters (A/B, 10-segment with glow indicators)
- Audio level (AF) meters
- Battery percentage 🚧 *— the runtime estimate is on the Battery page and in the
  show report, but not yet on the channel card itself*
- Status indicators: ON AIR, MUTED, TX OFF, LOW BATT, DROPOUT
- Color-coded channel cards (cyan = healthy, orange = warning, red = critical)
- Per-channel quick actions: Mute, Listen, Identify Hardware
- Drag-to-reorder card layout with A–Z or custom ordering, persisted per client
- Double-click a channel to open its device details

### Audio Monitoring
> Browsers only expose audio capture to pages in a **secure context**, so
> monitoring from a browser needs HTTPS or a connection from the machine
> running the server. The Ubuntu installer sets up HTTPS by default for this
> reason — see [Server Setup Guide](#server-setup-guide).

- Route any channel to local audio output for real-time headphone monitoring
- AES-67 network audio support (native Node.js WebRTC bridge — no external dependencies)
- OS audio device support on desktop — any interface the operating system
  exposes, at whatever width it reports, via DirectShow on Windows and
  AVFoundation on macOS. The desktop build ships its own ffmpeg for this; the
  Ubuntu server captures through ALSA directly and needs nothing extra.
  *(Windows verified end to end; macOS built from the same code path but not
  yet tested on hardware 📋)*
- Mobile audio monitoring via WebRTC stream over Wi-Fi (same path as browser)

### Instant Audio Replay
Every channel with an audio patch is recorded continuously while RFDeck is live.
The point is not to review a whole show — it is that when something goes wrong,
the audio from around it already exists.

- Always-on rolling capture on every patched channel, with no per-show setup —
  recording that has to be switched on first is off when it matters
- When a problem is detected, the audio from around it is kept as a clip:
  pre-roll and post-roll are configurable (15s / 10s by default)
- Clips play back in the browser from the Detections log
- Disk budget in MB rather than minutes, with a live estimate of how many clips
  it buys and a warning if it exceeds free space. Clips are pruned oldest-first;
  flagged clips are never pruned automatically
- Recording follows the patch: unpatching a channel stops its tap

  *This deliberately departs from the original specification*, which called for
  a 1–30 minute scrubbable buffer per device, individually enabled. What is
  built is event-triggered rather than continuous-scrub, and the enable is
  global. Scrubbing a whole show's buffer 📋 and per-device enable 📋 remain
  unbuilt — a clip around a detection answers "what happened at 20:41" without
  keeping gigabytes nobody will ever open.

### Detections
The log of problems RFDeck noticed on its own, each with the audio that proves it.

- Every detection carries the channel, the show and act it happened in, RF levels
  at the time, and a playable clip
- **Flag** a detection to keep its clip permanently and exempt it from pruning
- **Dismiss** to clear it from the list while keeping the record
- Filter to flagged only, or include dismissed
- Notes per detection, for what you worked out afterwards

### Diagnostics
- Auto-detection of RF signal dropouts — dropout/recovery with hysteresis and a
  3s confirmation window, server-side and shared across clients
- Auto-detection of **audio** faults from the captured waveform: dropouts
  (sudden silence), noise/"fuzz" (a spectral-flatness proxy via lag-1
  autocorrelation), and clicks/pops (second-difference impulses against a
  rolling MAD-style baseline). RF state gates promotion, so a click while the
  RF link is degrading is reported differently from one that is not.
  See [`docs/AUDIO_DETECTION.md`](docs/AUDIO_DETECTION.md) 🚧 *— clipping and
  low SNR are not yet detected as distinct kinds*
- Alert feed with severity levels (CRITICAL / WARNING / INFO); acknowledgement is
  shared across all connected clients 🚧 *— actionable CTAs not yet implemented*
- Event log: timestamped history of all system events, persisted to the database
  and exportable as CSV. Events also appear in the show report, which has a
  printable page for PDF

### RF Environment Visualization
- Channel frequency and signal-strength map, drawn from what connected receivers
  report
- Frequency history log per device (timestamped record of all changes)
- Frequency list export (CSV)
- _Note: RFDeck does **not** perform spectrum scanning. It displays the frequencies
  of the devices it is connected to and their reported signal strength. Frequency
  coordination (IMD calculation, auto-plan generation) is likewise out of scope —
  manufacturer tools handle that better._

### Hardware Inventory
- Auto-discovery of supported devices via mDNS / Bonjour, passive MCP listening,
  Shure SLP announcements, and active network sweep
- Manual device registration by IP + credentials
- Per-device: make, model, firmware, serial, MAC, IP, location, status
- **Automatic IP recovery** — devices that change address after a power cycle are
  matched by MAC or serial and reconnected without editing inventory
- **Active / inactive flag** — mark a device as intentionally powered off so it is
  untracked, hidden from the dashboard, and raises no alerts
- Sort and filter by name, status, IP, location, or model
- Hardware types: Receivers, IEM Transmitters 🚧 *— Antenna Distributors and Network
  Gear not yet modelled*
- Network configuration (DHCP/Static) manageable from the app
- Firmware status indicators
- **Per-device maintenance log** — element and battery changes, repairs, service
  and firmware, per unit. It answers "has this one been trouble before", which
  is the question when a channel misbehaves and you are deciding whether to swap
  the pack or chase the RF. A season, a rental fleet or a change of A2 all defeat
  memory. Distinct from the event log, which records what the *system* saw; this
  records what a person did with a screwdriver, and is the only record of it
  - The date of the work is separate from the date it was written down, because
    it is routinely logged the next morning
  - Firmware changes log themselves and are marked as observed rather than
    typed, so the automatic entries are never mistaken for someone's account

### Battery Management
- Battery dashboard: all packs sorted by charge level
- Configurable alert thresholds (warning % and critical %)
- **Estimated runtime per pack**, from least-squares regression over a window of
  live readings rather than differencing adjacent samples — many packs report in
  5% or 10% steps, so consecutive readings are identical and then jump, and
  neither is a drain rate. Reports nothing until the history means something,
  because "6 hours remaining" from two samples 20 seconds apart is worse than
  silence when an operator may act on it
- **Show-duration projection** — flags which packs will not last the show, given
  the show's expected length
- Runtime and its confidence appear in the show report as well as the dashboard
- Battery health (cycle count, capacity %) where supported by hardware 📋
- Battery replacement logging with history per device 📋

### Show & Event Management
- **Go Live** — one action for the three things that always belong together and
  are easy to forget separately. Going live enables every device in the
  inventory, starts rolling capture and fault detection, and puts the selected
  show's cast on the Micboard. **Stand down** reverses all three: the lights-off
  switch at the end of a day, which is also what keeps the detection log free of
  dropouts from receivers that were simply switched off. The cast is whichever
  show the operator picked when going live — never inferred
- Named shows/projects grouping roster, channel assignments, and mic-check state
- Multi-show database with archived history — shows may live indefinitely or be
  archived, which is reversible and keeps every record
- Pre-show Mic Check mode: per-channel checklist with timestamped checks, four
  periods (Act / Service / Set / Session / Segment by environment), and Y/N
  keyboard flow with auto-advance
- Mic-check state is server-authoritative and shared live across all connected
  clients — a tick made backstage appears at FOH immediately
- Show notes and run-of-show documentation 🚧 *— per-channel notes exist; run-of-show
  documentation does not*
- Structured report export with device list, events, frequency log and battery
  data 🚧 *— CSV downloads and a printable HTML report are implemented; the
  printable page is the PDF path, so no PDF library is carried*

### Performer & Role Management *(Theater / Broadcast modes)*
- Performer roster with channel assignment, real name, character/role, and notes
- Roster terminology adapts to the show's environment mode
- Optional headshots — stored on disk beside the database, for finding someone
  backstage you have not met
- **Notebook per performer**, split by what the note actually belongs to:
  - *Fit notes* travel with the person — where the element is taped, where the
    pack sits, spare element, comfort and allergy notes. The same next season
  - *Show notes* belong to this production only
  - Which fields appear adapts to the environment mode: quick changes and fit
    notes are theatre business and do not clutter a corporate event
- **Mic and IEM per performer** — the IEM is assigned on the same terms as the
  mic but kept separate, because soundcheck is about mics and an IEM in that
  checklist is noise
- **Quick-change log** — a performer coming off mic and back on within a show,
  with the cues either side and the act it happens in
- Character ↔ Transmitter mapping (theater: mic stays on character, performer changes)
  🚧 *— assignment is to a channel; the character-persistent model is not yet distinct*
- Mic assignment view: performer → transmitter → channel → status — this is the
  **Micboard** (see View Modes)

### View Modes
- **Grid View** — standard card grid, 1–4 columns
- **List / Table View** — high-density, sortable, full data
- **Micboard** — the wall display: one tile per performer with their headshot,
  name, character, RF and battery, and mic/IEM state at a glance. Read-only, so
  it needs no PIN even when one is set — the PIN exists to prevent unauthorised
  *changes*, and a display in a corridor makes none. Shows the cast of whatever
  show is live, and says plainly that nothing is running when nothing is
- **Backstage / Talent View** — read-only, large text; shareable URL or second
  window. Kept separate from the Micboard rather than merged: they are read by
  different people for different reasons
- **Stage Plot View** — spatial layout view *(Concert/Touring mode)* 📋

### Show Environment Modes
The interface and available features adapt to the type of show:

| Mode | Best For |
|---|---|
| **Theater** | Musical theater, opera — performer-centric with notebook, character mapping |
| **Concert / Touring** | Live concerts, festivals — mic-centric, stage plot, shared mics |
| **Corporate / Event** | Conferences, AV — panel mic tracking, speaker list |
| **Broadcast** | TV/radio — strict RF, many IEMs, tightly labeled |
| **House of Worship** | Church environments — volunteer-friendly, simplified views |

### Remote Access
RFDeck is a network service in both deployment shapes: a headless server or the
desktop app, each serving multiple concurrent clients over the network.

- **Open by default** — on a trusted show network, any device that can reach the
  host connects freely
- **Optional PIN** — require a PIN from remote devices, with a configurable
  re-authentication interval (never, 12h, 1 day, 3 days, 1 week)
- **Whoever knows the PIN can change it** — no separate admin account to manage
- **A shell on the server can always take over**, which is what makes a headless
  install administrable and recoverable
- "Sign out all devices" for a crew change mid-run
- Both REST and the realtime socket are gated, since control commands travel over
  the socket

See [Restricting access](#5-restricting-access-optional) for the full model.

#### User Roles (RBAC) 📋
Named user accounts with per-role permissions are planned. The PIN above is a
network access gate, not per-user identity.

| Role | Access |
|---|---|
| `ADMIN` | Full access: all features, settings, device control, user management |
| `TECH` | Monitoring + device configuration, no system/user settings |
| `MONITOR` | Read-only monitoring (suitable for stage manager, talent wrangler) |

### Mobile
- Responsive across every page — the sidebar becomes an off-canvas drawer behind
  a hamburger, and multi-column layouts collapse to one. Covered by end-to-end
  tests that fail if any page scrolls sideways on a phone
- Audio monitoring via WebRTC stream, the same path as any other browser
- Alert feed with action buttons 🚧 *— feed works and is readable on a phone;
  actionable CTAs not yet implemented*
- Progressive Web App — installable on iOS and Android from the browser 📋
- Inventory with QR/barcode scanning (camera via browser) 📋
- Web Push notifications for critical alerts 📋

---

## Hardware Support

### Phase 1 (Initial Launch)
| Manufacturer | Protocol | Capabilities |
|---|---|---|
| **Sennheiser** (EW-DX, EM 6000, EM 9046 — firmware ≥ 4.0) | SSCv2 (HTTPS/JSON REST) | Full: RF, AF, battery, mute, gain, frequency, identify, network config, spectrum scan |
| **Sennheiser Legacy** (G3, G4, EM 3732, etc.) | SSCv1 (TCP/UDP) | Monitoring: RF, battery, status |
| **Shure** (Axient Digital AD4D/AD4Q, ULX-D, QLX-D) | Command strings (TCP 2202) | Monitoring: RF per antenna, audio, battery bars and runtime, name, frequency. Control: mute, frequency 🚧 *— see below* |

> **Shure support has not been run against real hardware.** It is written
> against Shure's published command-strings specifications for Axient Digital
> and ULX-D, cross-checked line by line against two independent open-source
> implementations ([micboard](https://github.com/karlcswanson/micboard) and the
> [Bitfocus Companion](https://github.com/bitfocus/companion-module-shure-wireless)
> module), and tested against a simulated receiver speaking the same wire
> format. That proves the framing, metering and unit conversions — it cannot
> prove the specification was read correctly, since the simulator believes the
> same specification the client does.
>
> Auto-discovery works the same way as for Sennheiser G3/G4: a passive listener
> for Shure's SLP announcements (multicast 239.255.254.253:8427) produces
> candidate addresses, and a probe on port 2202 confirms what they are and how
> many channels they have. Receivers can still be added by IP, in which case the
> model must be chosen from a list — it selects the command vocabulary (Axient
> and ULX-D genuinely use different parameter names) and the channel count.
>
> What was verified, against how many sources, and what remains assumed is
> written up in [`docs/SHURE_PROTOCOL.md`](docs/SHURE_PROTOCOL.md).

### Phase 2+ (Planned)
- Wisycom (MRK series) — Ember+ open protocol
- Lectrosonics — via middleware bridge
- Sony, Sound Devices, Beyerdynamic — HTTP/JSON APIs

---

## Technology Stack

RFDeck runs on a **single Node.js codebase** for both the desktop app and hosted web app. The difference between deployment targets is configuration, not code.

| Layer | Technology | Version |
|---|---|---|
| **Runtime** | Node.js LTS | 24.x (Active LTS) |
| **Package Manager** | pnpm (workspaces) | 10.x |
| **Backend Framework** | Fastify | 5.x |
| **ORM** | Prisma | 5.x |
| **Database (Desktop)** | SQLite | via Prisma |
| **Database (Web)** | PostgreSQL 📋 | 16+ |
| **Frontend** | React + TypeScript | 19 / 5.x |
| **Frontend Build** | Vite | 6.x |
| **Real-time** | Socket.io | 4.x |
| **Desktop Shell** | Electron | 42.x |
| **Desktop Build** | electron-builder | 25.x |
| **Audio / WebRTC** | @roamhq/wrtc (node-webrtc) | 0.10.x |
| **Audio capture** | ALSA `arecord` (Linux) · ffmpeg (Windows/macOS) | ffmpeg 6.x, bundled with the desktop build |
| **Styling** | Vanilla CSS + Custom Properties | — |
| **Testing** | Vitest (unit) + Playwright (end-to-end) | — |

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│               REACT FRONTEND (shared)                   │
│         Same code in browser and Electron WebView       │
└──────────────┬──────────────────────────────────────────┘
               │  REST API + Socket.io WebSockets
   ┌───────────┴──────────────┐
   │                          │
   ▼                          ▼
┌──────────────┐    ┌──────────────────────┐
│  WEB SERVER  │    │   ELECTRON DESKTOP   │
│              │    │                      │
│  Fastify     │    │  Fastify (main proc) │
│  PostgreSQL  │    │  SQLite              │
│  AES-67/UDP  │    │  AES-67/UDP          │
│  WebRTC      │    │  WebRTC + OS audio   │
└──────────────┘    └──────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│                MOBILE (PWA)                             │
│        Same frontend, installed as PWA                  │
│    WebRTC audio · Camera scan · Web Push alerts         │
└─────────────────────────────────────────────────────────┘
```

### Repository Structure

```
rfdeck/
├── apps/
│   ├── server/          # Fastify backend (runs in Electron OR standalone)
│   ├── desktop/         # Electron shell (thin wrapper)
│   └── web/             # React frontend SPA (shared)
├── packages/
│   ├── shared-types/    # TypeScript interfaces (Device, Channel, Alert, etc.)
│   └── shared-utils/    # Pure utility functions (frequency math, battery calc)
├── e2e/                 # Playwright specs, driven against the real stack
├── design/              # Stitch design reference files
├── docs/                # Architecture documentation
├── playwright.config.ts
├── pnpm-workspace.yaml
└── README.md
```

---

## Design System

The RFDeck interface is engineered for **high-stakes live production environments**:

- **Dark-first:** Near-black foundation (`#131314`) for OLED efficiency and minimal light spill in dim FOH/backstage environments
- **Semantic color accents:**
  - **Cyan** — active RF signals, interactive elements, focus states
  - **Green** — healthy signal, full battery, safe status
  - **Orange** — interference warning, low battery, attention needed
  - **Red** — signal dropout, hardware failure, critical state
- **Typography:**
  - **Geist** — structural headings
  - **Inter** — UI labels and body text
  - **JetBrains Mono** — all numeric telemetry (MHz, dBm, %) to prevent layout shift on live updates
- **Components:** Tonal-layered cards with status-coded top borders, segmented RF meters, glassmorphism modals, tactile toggle switches

---

## Server Setup Guide

RFDeck runs as a network service that everyone opens in a browser — FOH on a
laptop, a tech on a phone walking the stage, a display backstage. This section
takes a bare Ubuntu machine to that state.

### 1. Prepare the machine

A small box is plenty: 2 cores and 2 GB of RAM comfortably handles the target of
128 channels and 10 concurrent clients.

- **Ubuntu Server 22.04 or 24.04**, freshly installed
- **Wired** to the same network as the receivers. Discovery uses multicast and
  broadcast, which Wi-Fi networks frequently filter.
- **A fixed address** — static IP or a DHCP reservation. The TLS certificate is
  issued for the addresses the machine has at install time, so a changing IP
  means reissuing it.

### 2. Install

```bash
sudo apt update && sudo apt install -y git
git clone <your-repo-url> rfdeck
cd rfdeck
sudo ./scripts/install-ubuntu.sh
```

The installer prints the address to open when it finishes. It takes a few
minutes, most of it compiling the AES67 kernel module.

<details>
<summary>What it actually does</summary>

1. Installs Node 24 and the toolchain the native modules need
2. Creates an unprivileged `rfdeck` service account with no login shell
3. Builds the application into `/opt/rfdeck`
4. Creates the database in `/var/lib/rfdeck`, outside the install directory
5. Generates a self-signed TLS certificate covering every address the machine answers on
6. Builds and installs the AES67 audio daemon and its kernel module
7. Registers a hardened systemd unit that starts on boot
8. Opens the firewall
9. Starts the service and verifies it responds before reporting success

</details>

| Flag | Purpose |
|---|---|
| `--no-tls` | Serve plain HTTP on port 80 instead |
| `--regenerate-cert` | Reissue the certificate after the machine's addresses change |
| `--no-aes67` | Skip the AES67 daemon |
| `--port <n>` | Serve on a different port |
| `--data-dir <path>` | Keep the database elsewhere |
| `--uninstall` | Remove the service, keep the database |

### 3. Trust the certificate

RFDeck serves **HTTPS** by default using a self-signed certificate, so the first
visit from each device shows a warning.

**This is not cosmetic.** Browsers only expose audio capture —
`navigator.mediaDevices` — to pages in a *secure context*. Over plain HTTP to a
network address that API does not exist at all, so audio monitoring cannot work
for anyone except someone sitting at the server. Accepting the certificate is
what grants the page secure-context status.

Everything else — telemetry, inventory, shows, mic check, alerts — works fine
over plain HTTP, so `--no-tls` is reasonable if you never need audio monitoring
from a browser.

**To accept it, once per device:**

| Browser | Steps |
|---|---|
| Chrome / Edge | **Advanced** then **Proceed to (address) (unsafe)** |
| Firefox | **Advanced** then **Accept the Risk and Continue** |
| Safari | **Show Details** then **visit this website** |
| iOS / Android | Same as above; once per browser |

<details>
<summary>Removing the warning entirely (optional)</summary>

Install the certificate as a trusted root on each client. Read it off the
server:

```bash
sudo cat /var/lib/rfdeck/certs/rfdeck.crt
```

- **Windows** — save as `rfdeck.crt`, double-click, **Install Certificate**,
  **Local Machine**, **Trusted Root Certification Authorities**
- **macOS** — open in Keychain Access, add to **System**, set **Always Trust**
- **iOS** — AirDrop or email it, install the profile, then enable it under
  **Settings, General, About, Certificate Trust Settings**
- **Android** — **Settings, Security, Encryption & credentials, Install a
  certificate, CA certificate**

Worth doing for a permanent install; not worth it for a one-off gig.

</details>

If the server's IP changes the certificate no longer matches and browsers refuse
it. Reissue with:

```bash
sudo /opt/rfdeck/scripts/install-ubuntu.sh --regenerate-cert
```

### 4. Add your receivers

Open the address the installer printed, go to **Inventory**, **Add Device**, and
either pick discovered units or enter an IP directly. EW-DX units with a
password need it entered once; set a default under **Settings**, **Device
Authentication** to avoid repeating it.

If devices are **discovered but never show levels**, that is almost always a
blocked UDP port rather than the hardware. See Ports below.

### 5. Restricting access (optional)

RFDeck is **open to the network by default**. On an isolated show network that is
the right default — a login prompt standing between an operator and a failing
channel is a liability, not a safeguard.

Set a PIN when the network is shared with house or guest traffic.

#### Who can do what

There are no user accounts. Access is decided by three rules:

| | Can connect | Can change access settings |
|---|---|---|
| A browser **on the server**, or the desktop app | Always | Always |
| Any client, **while no PIN is set** | Yes | Yes — this is how the first PIN gets set |
| Any client, **once a PIN is set** | After entering the PIN | Only after entering the PIN |
| A **shell** on the server | — | Always, including resetting a forgotten PIN |

Two consequences worth being explicit about:

- **Knowing the PIN is the credential for changing it.** Anyone who can get in
  can also change the terms of getting in. That is deliberate — a second admin
  credential to lose is worse than useless for a crew sharing one rack.
- **Setting the first PIN is unauthenticated**, because until one exists the
  server is already open to everyone. Allowing it grants nothing that was not
  already available, and it is what lets you set a PIN from a laptop rather than
  needing a screen attached to the server.

#### Setting a PIN

From any browser: **Settings → Remote Access**. Or from a shell on the server:

```bash
sudo rfdeck set-pin 4821
sudo rfdeck set-pin 4821 --reauth-hours 24
```

Choose how often devices must re-enter it. **Never** suits a resident booth
display; a shorter interval suits devices that leave the venue.

Changing or disabling the PIN applies to new connections immediately. Devices
already connected keep their session until you either use **Sign out all
devices** in Settings, or restart the service:

```bash
sudo systemctl restart rfdeck
```

#### If the PIN is forgotten

There is no way back in from a browser — that is what a PIN is for. Reset it from
a shell on the server:

```bash
sudo rfdeck set-pin 1234     # replace it
sudo rfdeck disable-pin      # or turn it off entirely
```

`disable-pin` keeps the stored PIN, so re-enabling later does not need it typed
again.

### 6. Managing from the shell

A headless server has no browser on it, so the `rfdeck` command is how you
administer one over SSH — and the recovery path when the PIN is lost. It is
installed on `PATH` by `install-ubuntu.sh`.

```bash
rfdeck status              # access and audio configuration at a glance
rfdeck set-pin 4821        # require a PIN from remote devices
rfdeck disable-pin         # network becomes open again
rfdeck audio-devices       # capture devices and the current channel patch
rfdeck audio-level hw:2,0  # capture a second and report the level on each
                           # input — is signal reaching this machine at all?
```

`rfdeck status` is the first thing to run when something looks wrong. It shows
whether a PIN is required, whether one is actually set, the re-auth interval, and
how many channels are patched to audio inputs:

```
Remote access
  PIN required   : yes
  PIN configured : yes
  Re-ask after   : 24h

Audio
  Channels patched : 8
```

`rfdeck audio-devices` lists what the machine can capture from, with the input
count each interface reports and the current patch — useful for confirming the
AES67 kernel module loaded, since its virtual device appears here once it has.
It names the capture backend first (ALSA on the server, DirectShow or
AVFoundation elsewhere), which is what distinguishes "nothing is plugged in"
from "the capture tool is missing".

The command reads the database path out of the running systemd unit rather than
assuming one, so it always acts on the same data as the service.

> Installed and kept current by both `install-ubuntu.sh` and
> `update-server.sh`, so a server that has only ever been updated still has it.

### Ports

Only the web port is obvious. **The UDP ports are where deployments fail** —
blocked, receivers are discovered but never report telemetry, which looks
exactly like broken hardware.

| Port | Protocol | Purpose |
|---|---|---|
| 443 | TCP | Web interface, API, realtime socket |
| 80 | TCP | Redirects to HTTPS |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS — EW-DX discovery |
| 8080 | TCP | AES67 daemon web UI |
| 319, 320 | UDP | PTP clock sync for AES67 |

The installer opens these when `ufw` is active.

### AES67 audio

The installer also builds and installs
[aes67-linux-daemon](https://github.com/bondagit/aes67-linux-daemon), turning the
machine into an AES67 endpoint so RFDeck has network audio to monitor. Its own
web UI is on port **8080**.

Two things to know:

- It compiles an **out-of-tree kernel module** (Merging Technologies RAVENNA
  ALSA). That needs headers matching the running kernel, and **a kernel upgrade
  breaks it until it is rebuilt** — re-run the installer after one.
- The install is **non-fatal**: if the module will not build, RF monitoring is
  unaffected and the installer says so. Build log: `/tmp/aes67-build.log`.

Skip it with `--no-aes67` if the machine only ever monitors RF.

### Operating the service

`rfdeck` configures the application; `systemctl` runs the process.

```bash
systemctl status rfdeck          # is it running
systemctl restart rfdeck         # restart
journalctl -u rfdeck -f          # follow the log
```

The service is quiet by default — warnings and errors only. For per-device
protocol detail while chasing a device that will not connect:

```bash
sudo systemctl edit rfdeck       # add: Environment=LOG_LEVEL=debug
sudo systemctl restart rfdeck
```

### Updating

For a code update — the usual case — use the fast path. It stages, builds,
migrates, restarts and verifies in under a minute, and **rolls back
automatically** if the build fails or the service does not come back:

```bash
cd ~/rfdeck
sudo ./scripts/update-server.sh --pull
```

`sudo ./scripts/update-server.sh --rollback` undoes it.

Re-run `install-ubuntu.sh` instead when *configuration* changes — switching to
or from TLS, changing the port, adding or removing AES67 — since those live in
the systemd unit the update script leaves alone. That path also reruns apt and
rebuilds the AES67 kernel module, which is why it takes minutes rather than
seconds.

Neither touches the database, certificate, or encryption key.

### Backup

```bash
sudo systemctl stop rfdeck
sudo tar czf rfdeck-backup.tar.gz -C /var/lib rfdeck
sudo systemctl start rfdeck
```

That covers the database, the TLS certificate, and the key that encrypts device
passwords. **A backup of the database alone will not restore those passwords** —
they are encrypted with `/var/lib/rfdeck/.rfdeck-key`, kept outside the database
deliberately so copying one file does not carry the credentials with it.

Full reference including troubleshooting: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Development

> Prerequisites: Node.js 24 LTS, pnpm 10+

```bash
# 1. Install dependencies
pnpm install

# 2. Generate the Prisma client (first time only)
pnpm --filter @rfdeck/server prisma:generate

# 3. Start the Desktop App (Recommended)
# Builds the server + frontend, then opens the Electron window.
pnpm --filter @rfdeck/desktop dev

# --- Alternative Web-only workflow ---

# Start backend standalone
pnpm --filter @rfdeck/server dev

# Start frontend standalone in browser (with hot reload)
pnpm --filter @rfdeck/web dev
```

### Tests

```bash
# Unit tests — parsers, allocators, detectors, state machines
pnpm --filter @rfdeck/server test

# End-to-end — drives the real server, database and socket in a browser,
# including phone viewports. Builds first, so it takes a minute.
pnpm test:e2e

# Typecheck
pnpm --filter @rfdeck/server exec tsc --noEmit
pnpm --filter @rfdeck/web exec tsc --noEmit
```

CI runs all of the above on every push and pull request
(`.github/workflows/ci.yml`).

### Building for Production (Windows Executable)

To build a standalone `.exe` installer for Windows:

```bash
pnpm --filter @rfdeck/desktop package
```

That one command builds the shared types, the frontend, the server and the
Electron shell, stages the Prisma client and database template, and runs
electron-builder. The resulting installer lands in **`apps/desktop/release/`**
as `RFDeck Setup 1.0.0.exe`.

> On the first desktop build, `scripts/fetch-ffmpeg.mjs` downloads the ffmpeg
> binary the app captures audio with (~80 MB, from the ffmpeg-static GitHub
> release). It is deliberately not fetched by `pnpm install`, so that installing
> on the Ubuntu server — which captures through ALSA and has no use for it —
> does not pull it down or fail without network access to GitHub.

---

## Roadmap

| Phase | Focus | Status |
|---|---|---|
| **Phase 1** | Foundation: monorepo scaffold, Electron shell, Fastify server, Sennheiser SSCv2, monitoring dashboard, alert feed | Complete |
| **Phase 2** | Hardware inventory, battery management, show/event management, mic check mode, RF environment visualization | Mostly complete — battery depth outstanding |
| **Phase 3** | Audio monitoring (AES-67 + OS audio), native WebRTC gateway, instant replay | Audio complete; replay not started |
| **Phase 4** | Mobile PWA, performer/notebook system (Theater mode), backstage/talent view, Web Push | Backstage complete; rest not started |
| **Phase 5** | Additional hardware brands, Docker packaging, E2E tests, auto-update | Not started |

The sequenced plan for the remaining work is in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md), and deployment,
firewall requirements, and verification procedures are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## License

Private / Proprietary — All rights reserved.
