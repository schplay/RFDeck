# RFDeck

> Professional wireless audio device management for live sound, theater, and broadcast.

RFDeck is a cross-platform application for managing wireless microphone and in-ear monitor (IEM) systems in demanding live production environments. It consolidates real-time RF telemetry, battery monitoring, audio monitoring, hardware inventory, and show workflow tools into a single, unified interface — available as a desktop application and a hosted web application from one shared codebase.

---

## Why RFDeck?

Existing tools in this space are fragmented, limited, or platform-locked:

- **MicBoard** — read-only, Shure-only, no audio, no control
- **WaveTool** — macOS only, no web version, no frequency visualization, no performer management
- **Shure Wireless Workbench / Sennheiser WSM** — manufacturer-specific, not unified

RFDeck is designed for the A2 / RF tech who manages multi-brand wireless systems across different show types, and needs one tool that works everywhere — at the rack, at FOH, backstage, or on their phone walking the stage.

---

## Core Features

### Live Monitoring Dashboard
Real-time telemetry for all active wireless channels:
- Dual-antenna RF signal meters (A/B, 10-segment with glow indicators)
- Audio level (AF) meters
- Battery percentage with estimated runtime countdown
- Status indicators: ON AIR, MUTED, TX OFF, LOW BATT, DROPOUT
- Color-coded channel cards (cyan = healthy, orange = warning, red = critical)
- Per-channel quick actions: Mute, Listen, Identify Hardware

### Audio Monitoring
- Route any channel to local audio output for real-time headphone monitoring
- AES-67 network audio support (via GStreamer → WebRTC bridge)
- OS audio device support on desktop (USB interfaces, WASAPI, CoreAudio)
- Mobile audio monitoring via WebRTC stream over Wi-Fi (same path as browser)

### Instant Audio Replay
- Configurable rolling audio buffer per device (1–30 minutes)
- Per-device enable/disable; configurable duration
- Live storage estimate display
- Click-to-scrub playback for investigating dropouts or anomalies

### Diagnostics
- Auto-detection of: signal dropouts, clipping, sustained silence, sudden level drops, low SNR
- Alert feed with severity levels (CRITICAL / WARNING / INFO) and actionable CTAs
- Event log: timestamped history of all system events, exportable as PDF/CSV

### RF Environment Visualization
- Live spectrum scan visualization (sourced from hardware APIs where supported)
- Active channel frequency overlay on spectrum view
- Frequency history log per device (timestamped record of all changes)
- Frequency list export (CSV)
- _Note: Frequency coordination (IMD calculation, auto-plan generation) is intentionally out of scope — manufacturer tools handle this better. RFDeck visualizes the environment._

### Hardware Inventory
- Auto-discovery of supported devices via mDNS / Bonjour
- Manual device registration by IP + credentials
- Per-device: make, model, firmware, serial, MAC, IP, location, status
- Hardware types: Receivers, IEM Transmitters, Antenna Distributors, Network Gear
- Network configuration (DHCP/Static) manageable from the app
- Firmware status indicators
- Per-device maintenance log

### Battery Management
- Battery dashboard: all packs sorted by charge level
- Estimated runtime per pack (based on live drain rate)
- Configurable alert thresholds (warning % and critical %)
- Battery health (cycle count, capacity %) where supported by hardware
- Battery replacement logging with history per device
- Show-duration runtime projection: flag which packs won't last the show

### Show & Event Management
- Named shows/projects: group all config, devices, channels, performers, logs
- Multi-show database with archived history
- Pre-show Mic Check mode: checklist board per channel, timestamped checks
- Show notes and run-of-show documentation
- Structured report export: PDF/CSV with device list, events, frequency log, battery data

### Performer & Role Management *(Theater / Broadcast modes)*
- Performer roster with optional headshots
- Notebook per performer: rich text notes (vocal quirks, mic preferences, character list)
- Character ↔ Transmitter mapping (theater: mic stays on character, performer changes)
- Mic assignment view: performer → transmitter → channel → status
- Quick-change log during show

### View Modes
- **Grid View** — standard card grid, 1–4 columns
- **List / Table View** — high-density, sortable, full data
- **Backstage / Talent View** — read-only, large text, MicBoard-style; shareable URL or second window
- **Stage Plot View** — spatial layout view *(Concert/Touring mode)*

### Show Environment Modes
The interface and available features adapt to the type of show:

| Mode | Best For |
|---|---|
| **Theater** | Musical theater, opera — performer-centric with notebook, character mapping |
| **Concert / Touring** | Live concerts, festivals — mic-centric, stage plot, shared mics |
| **Corporate / Event** | Conferences, AV — panel mic tracking, speaker list |
| **Broadcast** | TV/radio — strict RF, many IEMs, tightly labeled |
| **House of Worship** | Church environments — volunteer-friendly, simplified views |

### User Roles (RBAC)
| Role | Access |
|---|---|
| `ADMIN` | Full access: all features, settings, device control, user management |
| `TECH` | Monitoring + device configuration, no system/user settings |
| `MONITOR` | Read-only monitoring (suitable for stage manager, talent wrangler) |

### Mobile (PWA)
- Progressive Web App — installable on iOS and Android from the browser
- Full monitoring view optimized for mobile
- Alert feed with action buttons
- Inventory with QR/barcode scanning (camera via browser)
- Audio monitoring via WebRTC stream
- Web Push notifications for critical alerts

---

## Hardware Support

### Phase 1 (Initial Launch)
| Manufacturer | Protocol | Capabilities |
|---|---|---|
| **Sennheiser** (EW-DX, EM 6000, EM 9046 — firmware ≥ 4.0) | SSCv2 (HTTPS/JSON REST) | Full: RF, AF, battery, mute, gain, frequency, identify, network config, spectrum scan |
| **Sennheiser Legacy** (G3, G4, EM 3732, etc.) | SSCv1 (TCP/UDP) | Monitoring: RF, battery, status |

### Phase 2+ (Planned)
- Shure (Axient Digital, ULX-D, SLX-D) — Shure System API + TCP 2202 command strings
- Wisycom (MRK series) — Ember+ open protocol
- Lectrosonics — via middleware bridge
- Sony, Sound Devices, Beyerdynamic — HTTP/JSON APIs

---

## Technology Stack

RFDeck runs on a **single Node.js codebase** for both the desktop app and hosted web app. The difference between deployment targets is configuration, not code.

| Layer | Technology | Version |
|---|---|---|
| **Runtime** | Node.js LTS | 24.x (Active LTS) |
| **Package Manager** | pnpm (workspaces) | 9.x |
| **Backend Framework** | Fastify | 5.x |
| **ORM** | Prisma | 7.x |
| **Database (Desktop)** | SQLite | via Prisma |
| **Database (Web)** | PostgreSQL | 16+ |
| **Frontend** | React + TypeScript | 19 / 5.x |
| **Frontend Build** | Vite | 6.x |
| **Real-time** | Socket.io | 4.x |
| **Desktop Shell** | Electron | 42.x |
| **Desktop Build** | electron-builder | 25.x |
| **Audio Gateway** | GStreamer | 1.24+ |
| **WebRTC** | gst-plugins-rs webrtcsink | latest |
| **Styling** | Vanilla CSS + Custom Properties | — |
| **Testing** | Vitest + Playwright | — |

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
│  GStreamer   │    │  GStreamer (sidecar)  │
│  (sidecar)   │    │  OS audio devices    │
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
├── design/              # Stitch design reference files
├── docs/                # Architecture documentation
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

## Development

> Prerequisites: Node.js 24 LTS, pnpm 9+, GStreamer 1.24+

```bash
# 1. Install dependencies
pnpm install

# 2. Start the Desktop App (Recommended)
# This will spawn the Fastify backend, load the Vite frontend, and open a native Electron window.
pnpm --filter @rfdeck/desktop dev

# --- Alternative Web-only workflow ---

# Start backend standalone
pnpm --filter @rfdeck/server dev

# Start frontend standalone (browser)
pnpm --filter @rfdeck/web dev
```

### Building for Production (Windows Executable)

To build a standalone `.exe` installer for Windows:

```bash
# 1. Build the shared types, frontend web app, and server
pnpm --filter @rfdeck/shared-types build
pnpm --filter @rfdeck/web build
pnpm --filter @rfdeck/server build

# 2. Build the desktop app and package it
pnpm --filter @rfdeck/desktop build
pnpm --filter @rfdeck/desktop package

# The resulting installer (e.g., RFDeck Setup 1.0.0.exe) will be located in:
# apps/desktop/dist/
```

---

## Roadmap

| Phase | Focus |
|---|---|
| **Phase 1** | Foundation: monorepo scaffold, Electron shell, Fastify server, Sennheiser SSCv2, monitoring dashboard, alert feed |
| **Phase 2** | Hardware inventory, battery management, show/event management, mic check mode, RF environment visualization |
| **Phase 3** | Audio monitoring (AES-67 + OS audio), GStreamer gateway, instant replay |
| **Phase 4** | Mobile PWA, performer/notebook system (Theater mode), backstage/talent view, Web Push |
| **Phase 5** | Additional hardware brands, Docker packaging, E2E tests, auto-update |

---

## License

Private / Proprietary — All rights reserved.
