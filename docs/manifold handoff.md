# RFDeck ↔ Manifold — integration hand-off

**Status:** RFDeck exists (github.com/schplay/rfdeck). This is what *manifold* needs from it, and the open
questions for the RFDeck team. Manifold plan workstream: **W13** (see `plans/SoftwareCompletionPlan.md`).

RFDeck is the product owner's wireless-audio manager/monitor: it connects to and manages wireless receivers
(Sennheiser, Shure, and others), and — its differentiator — **takes in the wireless audio and correlates it
with RF telemetry to detect audio problems** (fuzz, interference, drop-outs) that RF meters alone miss. It
runs as a desktop app or an always-on web app.

**Observed stack** (from the repo, to confirm): Node 24 / Fastify 5 / Prisma, React 19 + Vite, Electron,
**Socket.io** for real-time, SQLite (desktop) / PostgreSQL (web), WebRTC (`@roamhq/wrtc`) for audio, audio
routing over AES67 / WebRTC / OS audio.

## The relationship

**Manifold is a client of RFDeck; RFDeck stays the source of truth for wireless devices.** Two-way value:

- **Manifold → RFDeck:** manifold makes RFDeck setup/config faster (it already knows the channel list,
  labels, patch, and performer assignments an operator would otherwise re-enter).
- **RFDeck → Manifold:** wireless management and **real-time wireless health land in the console, next to the
  channel the mic feeds** — a failing mic shows on the mixing surface, not only in RFDeck.

Manifold does **not** reimplement RF coordination or device drivers; it displays RFDeck's data and assists
its configuration.

## What manifold needs from RFDeck

1. **Connect** — REST for inventory/config, **Socket.io** for live telemetry. Manifold configures an RFDeck
   address + auth in Settings, with an explicit enable/disable and graceful behaviour when RFDeck is absent.
2. **Inventory** — list devices (receivers/transmitters: make, model, firmware, serial, IP, location) and
   their channels, with **stable ids** manifold can persist in a show for the channel↔device mapping.
3. **Live per-channel telemetry** (the core read path) — RF level, AF/audio level, battery %, frequency,
   mute, and status flags, pushed over Socket.io. Manifold shows a compact badge on the strip (battery/RF/
   alert) and a fuller wireless page.
4. **Alert feed** — RFDeck's alerts (severity, timestamp, ack state), **including the audio-fault detections**
   (fuzz / interference / drop-out) that are RFDeck's differentiator, so manifold can raise them as
   channel-level alerts on the surface.
5. **Config assist (write)** — accept the setup manifold can help with: frequency-coordination hand-off,
   mute, gain, and **labels / performer assignment** (manifold already holds these). Gated in manifold by its
   user/permission model and show-safety posture.

Manifold will store the **channel ↔ RFDeck-device/channel mapping** in the show and try to auto-suggest it
from names/patch, so the right telemetry lands on the right strip.

## Open questions for the RFDeck team

1. **Socket.io contract:** what are the event names and payload shapes for channel telemetry and the alert
   feed? Is there a subscribe/scope mechanism (per device/channel) or is it a firehose?
2. **REST surface:** what endpoints cover inventory, channel config (mute/gain/frequency), performer/label
   assignment, and auth? An OpenAPI/schema would let manifold generate a typed client.
3. **Stable identity:** what is the durable id for a transmitter/channel across sessions and firmware
   updates, so manifold's show-stored mapping survives?
4. **Auth:** how does an external client authenticate (token, session, none-on-LAN)? Manifold stores such
   secrets machine-level, never in a show file.
5. **Audio-fault events:** how are fuzz/interference/drop-out surfaced — discrete alert types with a channel
   id and severity? Manifold wants to badge the specific channel, so a per-channel fault event is ideal.
6. **Write scope & safety:** which config writes are safe live vs. setup-only? Is there confirmation/locking
   so manifold and an RFDeck operator don't fight over a device mid-show?
7. **Deployment parity:** do desktop and always-on-web expose the same API/Socket.io surface, and how does
   manifold discover an instance (mDNS? configured URL only)?
8. **Audio path:** manifold does **not** need RFDeck's WebRTC/AES67 audio for the telemetry/management
   features. Is there any case where manifold should also receive RFDeck audio (e.g. a confidence listen), or
   is that out of scope for the manifold integration?

## Phasing (manifold side)

Read-only first (connect → inventory → telemetry → alerts → badges/page), then the mapping, then the
write/assist path behind permissions. None of it blocks on AES67/NMOS work; the telemetry path is an
independent client integration.
