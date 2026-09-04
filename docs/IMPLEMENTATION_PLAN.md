# RFDeck Implementation Plan

**Goal:** an application that is trustworthy in a live show and complete against the README.

## Progress

Stages 1–3 are complete. Items are marked ✅ as they land.

| Stage | State |
|---|---|
| 1 — Durability & truth | ✅ Complete |
| 2 — Shared state | ✅ 2.1–2.4 complete; 2.5 (control attribution) outstanding — see reconciliation note |
| 3 — Access control & deployment | ✅ Complete — PIN gate, encryption at rest, installer + updater, HTTPS, AES67, shell CLI |
| 4 — Show-day hardening | ✅ Complete — 4.3 show report landed as JSON, CSV, and a printable page |
| A — Audio monitoring *(added)* | ✅ Server-side capture, any-interface patching, AES67 subscriptions from RFDeck |
| 5 — Client reach | 5.1 responsive ✅; PWA, push and QR not started |
| 6 — Feature completion | ✅ 6.1 rolling capture and detection; ✅ 6.2 notebook and photos; 6.3 and 6.4 outstanding |
| B — Micboard & Go Live *(added)* | ✅ Read-only wall display; one action to put RFDeck on the rig |
| 7 — Breadth & operations | In progress — 156 tests; CI runs them on every push (7.5) |

*Last reconciled 2026-08-23 against commit `c78aa86`. See "Work since the plan" below for
what landed outside the original stages.*

**Answered since first draft:** scale is 2–128 channels and 1–10 concurrent
users; access control is an optional admin-set PIN rather than per-user login;
shows may live indefinitely or be archived, operator's choice.

**Verified end to end against a running server:** show creation, roster,
mic-check ticks and archiving all survive a restart; cascade delete removes
players and mic-check rows; the PIN gate accepts the right PIN, rejects the
wrong one, issues tokens, and always exempts loopback.

### Next up

1. **End-to-end tests (7.1).** 156 unit tests cover parsers, allocators and
   state machines — and every defect found in live use this cycle was in a
   flow none of them touch: a mute button that sent to a path the firmware
   does not serve, a Listen that toggled itself off, a page blank for thirty
   seconds after waking, a page that scrolled sideways on a phone. Playwright
   over go-live, the dashboard, mic check and the Micboard is the gap between
   "compiles" and "works".
2. **Rebuild and verify the desktop package.** It has not been built since
   before Stage A. The schema, the Prisma client staging and the recording
   directories have all changed under it, and the packaging was the hardest
   part of this project to stabilise. Left much longer it becomes archaeology.
3. **README accuracy.** It still marks the replay buffer as planned and
   dropout detection as partial, and does not mention Detections, the Micboard,
   Go Live, the performer notebook, or IEM assignment. It now understates the
   product rather than overstating it — the opposite of the original problem,
   and equally misleading.
4. **2.5 — Control command attribution.** Still blocked on a decision: with no
   named accounts, "who" can only be a label each client sets for itself.
5. **6.3 — Device maintenance log.** Small, and the device drawer is ready.
6. **7.3 — Shure support.** The largest single expansion of what RFDeck can
   talk to, and the audience Micboard already serves. Extract the hardware
   client interface first.

Stage 5 mobile is partly done: the responsive pass landed, so the Micboard and
dashboard work on a phone. PWA, push and QR remain unstarted and unurgent.

---

## Decisions on record

| Decision | Choice |
|---|---|
| Deployment | Headless server **and** desktop; multi-client in both cases |
| Spectrum scanning | **Not a feature.** Display connected-device frequencies and reported signal strength only |
| Identity | **Named user accounts.** Sharing credentials is the crew's choice, not a system design |

---

## Work since the plan

Landed between the Stage 3 progress note and `c78aa86`, mostly driven by testing
on a real server and real receivers rather than by the stage list. Recorded here
so the plan describes the application that exists.

| Area | What landed | Plan item it affects |
|---|---|---|
| **Deployment** | `install-ubuntu.sh` provisions a clean Ubuntu box end to end; `update-server.sh` is the fast code-only path with snapshot and rollback; HTTPS with a self-signed cert by default; `rfdeck` shell CLI for status, PIN recovery, and audio diagnostics | 3.3 — exceeded |
| **Remote access** | PIN configurable from any client when no PIN is set, or by an authenticated one — the loopback-only rule was unusable on a headless server | 3.1 — superseded |
| **Audio architecture** | Capture moved from each viewer's browser to the server; any ALSA interface, any width, probed not assumed; per-channel patch matrix; one capture per device demultiplexed to subscribers | new — "Stage A" |
| **AES67** | Daemon installed and configured by the installer; stream subscriptions (sinks) created from RFDeck with contiguous channel allocation; NMOS enabled; firewall opened for SAP, RTSP, RTP | new — "Stage A" |
| **Liveness** | Staleness keyed on device contact (heartbeat + quiet-stream probe), not telemetry churn — a silent mic is not a frozen feed | 4.4 — extended |
| **Device auth** | A device that answers but refuses its password is shown as its own state with a reason, a Retry, and a way to remove a stored password | new |
| **Discovery** | Hosts are claimed only on positive identification; both SSC probes are evaluated before deciding | 1.x hardening |
| **Performer roster** | Performers are a global entity cast into shows by reference; castings keep a name copy; existing rows backfilled | 6.2 — partial |
| **Mute lock** | Dashboard toggle that disables every Mute button; locked by default, per browser | new |
| **Tests** | 94, including parsers for ALSA output, AES67 channel allocation, discovery identification, RF state, battery estimation | 7.1 |

### Stage A — Audio monitoring *(added)*

Not in the original plan because the original plan assumed browser-side capture.
The correction — audio comes from the machine running RFDeck — reshaped the
whole path, and it is now complete for the supported case: a server with any
number of interfaces, each patched per channel, streamed to browsers over WebRTC.
What remains here belongs to 6.1 (replay buffer), which builds on the same
capture.

Unverified on real hardware at the time of writing: the AES67 kernel module
surviving a kernel upgrade, and the `ufw` rules on a host with pre-existing
firewall policy.

---

## Deployment model

RFDeck ships in two deployment shapes from one codebase:

- **Headless server** — Fastify running on a machine in the rack or on the venue network.
- **Desktop application** — the same server inside an Electron shell.

**In both cases the application is a network service with multiple concurrent clients.**
An operator at FOH, a second on a laptop backstage, and a tech on a phone walking the stage
all connect to the same instance and must see the same state. The desktop build is not a
single-operator tool that happens to have a web view; it is the same multi-client server with
a local window attached.

This has consequences that run through the whole plan:

- **Server state is authoritative.** Anything two people could disagree about — show records,
  mic-check ticks, the event log, alert acknowledgement — lives on the server and is pushed to
  clients. Client-local storage is reserved for genuine per-viewer preferences.
- **The server is network-exposed by design**, so authentication is a correctness requirement,
  not a hosted-deployment nicety.
- **Every client is a first-class target.** Mobile is a supported surface, not an afterthought.

---

## How this plan is ordered

"Feature complete" and "operational live" are different bars, and the second is more urgent.
Before feature breadth matters, four guarantees have to hold:

1. **It cannot lose their work.** Show data survives restarts and crashes.
2. **It cannot lie to them.** Nothing on screen is fabricated, stale, or mislabelled.
3. **It cannot disagree with itself.** Every connected client sees the same truth.
4. **It cannot fall over mid-show.** One bad panel doesn't take out the app.

Stages 1–3 deliver those. **Stage 3 is the gate for unattended live use** — until authentication
lands, the instance must only run on a trusted, isolated show network.

| Stage | Theme | Gate |
|---|---|---|
| 1 | Durability & truth | Required before relying on show records |
| 2 | Shared state | Required before a second client connects |
| 3 | Access control & deployment | **Required before exposure to any untrusted network** |
| 4 | Show-day hardening | Required to serve as system of record |
| 5 | Client reach | Mobile and remote surfaces |
| 6 | Feature completion | README parity |
| 7 | Breadth & operations | More hardware, reliable shipping |

Sizing is relative: **S** ≈ a sitting, **M** ≈ a day, **L** ≈ several days, **XL** ≈ a week or more.

---

## Stage 1 — Durability & truth

*No new functionality. This is the work that makes existing functionality safe to depend on.*

### 1.1 Move shows and roster into the database — **L**

**Problem.** `InventoryDevice` and `Settings` are the only persisted models. Every show, player,
act, mic-check tick, and note lives in browser local storage under `rfdeck-shows-v2`. Clearing
site data, resetting the Electron profile, or opening from a different client destroys or
diverges from it. In a multi-client deployment this is doubly wrong: two operators running mic
check see two different sets of ticks.

**Approach.** Three Prisma models in `apps/server/prisma/schema.prisma`:

```
Show          id, name, environmentMode, date?, venue?, notes?,
              currentAct, createdAt, updatedAt
Player        id, showId → Show, realName, characterName, notes,
              assignedChannelKey?, sortIndex
MicCheckEntry id, showId → Show, act (1–4), channelKey,
              checked, checkedAt?, checkedBy?, notes?
              @@unique([showId, act, channelKey])
```

Key decision: store **`channelKey` (the channel name), not the channel id.** Channel ids embed
the device IP, which changes on DHCP reassignment — the same reason `layoutStore` keys custom
ordering by name. A show record must survive a power cycle that moves every receiver.

`checkedBy` is nullable now and populated once Stage 3 lands identity — worth adding to the
schema up front to avoid a second migration.

New routes in `apps/server/src/routes/shows.ts`:

```
GET    /api/shows                     list with players + mic check
POST   /api/shows                     create
PUT    /api/shows/:id                 update metadata
DELETE /api/shows/:id
POST   /api/shows/:id/players         add
PUT    /api/shows/:id/players/:pid    update
DELETE /api/shows/:id/players/:pid
PUT    /api/shows/:id/check           upsert one mic-check entry
DELETE /api/shows/:id/acts/:act       reset an act
```

Rewrite `apps/web/src/stores/showStore.ts` to call the API instead of `persist`. Every mutation
also broadcasts over the socket — see 2.1, which should be built in the same pass rather than
bolted on afterward.

**Migration — do not skip this.** There may be real show data in local storage already. On first
load after upgrade: if `rfdeck-shows-v2` exists and `GET /api/shows` returns empty, POST the
local shows up, then set a `rfdeck-shows-migrated` flag. Leave the old key in place for one
release as a fallback rather than deleting it.

**Done when:** show data survives a full restart, and a second client sees the same records.

---

### 1.2 Make the RF page honest — **S**

**Problem.** `SpectrumCanvas.tsx` draws a synthetic noise floor beneath the real channel data
(`generateNoise(200)`, line 25), and the page carries a "Simulated" badge. RFDeck does not do
spectrum scanning and is not going to — the intended feature is displaying the frequencies of
connected devices and their reported signal strength.

The good news: the channel plot itself is already real. Channels are positioned by actual
frequency with peak height from `rfLevelA` (lines 96–135). Only the fake noise floor and the
framing around it are wrong.

**Approach.** Delete `generateNoise` and the noise-floor path. Keep the channel plot, axes, and
peak markers. Drop the "Simulated" badge. Retitle the panel to describe what it is — a frequency
and signal map of connected channels, not a spectrum analyzer. Correct the corresponding README
bullet, which currently promises "live spectrum scan visualization".

**Done when:** everything drawn on the RF page traces to a real device reading.

---

### 1.3 Fix the Electron preload script — **S**

**Problem.** `apps/desktop/package.json` sets `"type": "module"`, so the emitted
`dist/preload.js` is treated as ESM — but Electron loads preload scripts as CommonJS. The script
throws at startup and `contextBridge` never reaches the renderer.

**Approach.** A CJS file needs a `.cjs` extension under `"type": "module"`. Add
`apps/desktop/tsconfig.preload.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist"
  },
  "include": ["src/preload.ts"]
}
```

Exclude `src/preload.ts` from the main `tsconfig.json`, chain the build, and rename the output:

```
"build": "tsc && tsc -p tsconfig.preload.json && node -e \"require('fs').renameSync('dist/preload.js','dist/preload.cjs')\""
```

Point the `preload:` path in `apps/desktop/src/main.ts` at `preload.cjs`.

**Done when:** no module error in the DevTools console at launch, and `window.electron` is defined.

---

### 1.4 Remove fabricated data from the backstage view — **S**

**Problem.** `BackstageView.tsx` falls back to four invented channels whenever none are
connected. This view runs full-screen on a display facing stage crew; placeholder data that
looks like live telemetry is a safety issue.

**Approach.** Delete `demoChannels` and the fallback. Make the existing empty state
unambiguous, and include server connection status so a viewer can distinguish "nothing is on"
from "we lost the server".

---

### 1.5 Make the inactive-device filter consistent — **S**

Dashboard, backstage, and mic check read channels through `useActiveChannels`. The battery
dashboard (`BatteryDashboard.tsx:7`) and RF scanner (`RFScanner.tsx:50`) still read
`useChannelStore` directly, so a narrow race can leave a deactivated device's channel visible
there. Switch both. Leave `ShowManagement.tsx:448` alone — the `DevicesTab` counts channels
across all devices deliberately.

---

### 1.6 Error boundaries and a crash-safe shell — **M**

**Problem.** No React error boundaries exist. A render error anywhere — a malformed telemetry
payload, an undefined field — unmounts the entire app. Mid-show that is a black window.

**Approach.** An `ErrorBoundary` wrapping each route element in `router.tsx`, plus one around
each `ChannelStrip` so a single bad channel degrades to one error card instead of killing the
page. Pair with a hardening pass on `normalizeAndEmit` in `DeviceManagerService.ts`: coerce
every hardware-supplied field at the boundary so malformed data never reaches React.

---

## Stage 2 — Shared state

*The point at which a second client stops being a liability.*

### 2.1 Broadcast show and mic-check mutations — **M**

**Problem.** Mic check is the flow most likely to be run by two people at once — one at the
rack, one on stage. With show state in the database but no push, a tick made backstage does not
appear at FOH until a manual reload.

**Approach.** Emit `show:updated`, `show:check-changed`, `show:player-changed`, and
`show:deleted` from the show routes, mirroring the existing `device:*` event pattern in
`plugins/socket.ts`. Clients apply incoming events to `showStore` directly rather than refetching.

Replay on connect, as `getChannelSnapshot` and `getOnlineDevices` already do for devices, so a
client joining mid-show is immediately current.

**Done when:** a tick on one client appears on another within a second, with no reload.

---

### 2.2 Move dropout detection server-side — **M**

**Problem.** `rfEventStore.addTelemetry` computes dropout and recovery events **in the browser**.
Consequences in a multi-client deployment: every client keeps its own divergent log; events are
missed entirely by clients that were closed at the time; two operators comparing logs disagree;
and the log a show report would draw from is not authoritative anywhere.

The server already does most of this work — `DeviceManagerService` has confirmation timers and
re-alert cooldowns for its own alerts. The client duplicates that logic with different thresholds.

**Approach.** Delete detection from `rfEventStore` and make it a passive receiver of server-pushed
events. Extend the existing server-side dropout logic to emit `rf:event` for both dropout and
recovery, using one set of thresholds sourced from `Settings.dropoutSensitivity`. Clients render
what the server sends.

This is a prerequisite for the persisted event log in 4.1 — build it with that in mind.

**Done when:** every client shows an identical RF event log, including one that just connected.

---

### 2.3 Shared alert acknowledgement — **S**

**Problem.** `alert:new` is broadcast, but acknowledge and dismiss are client-local. One operator
clearing an alert leaves it active for everyone else — the classic duplicated-response failure.

**Approach.** `POST /api/alerts/:id/ack` and `/dismiss`, broadcast to all clients. Once Stage 3
lands, record who acknowledged it.

---

### 2.4 Decide per-client vs shared preferences — **S**

Some client-local state is correct and should stay local; some is a bug. Settle it explicitly:

| State | Store | Recommendation |
|---|---|---|
| Custom card order | `layoutStore` | **Per-client.** FOH and backstage legitimately want different orders. |
| Backstage column count | `layoutStore` | **Per-client.** A function of the physical display. |
| Sort mode, view mode, filters | component state | **Per-client.** |
| Show / mic check | `showStore` | **Shared** — fixed in 1.1 / 2.1. |
| RF event log | `rfEventStore` | **Shared** — fixed in 2.2. |
| Alert ack state | `alertStore` | **Shared** — fixed in 2.3. |

Worth considering later: a show-level *default* card order that a client can override locally.
Not needed now, but it is the natural request once several people use it.

---

### 2.5 Control-command conflict handling — **M** — *decision needed*

> With named accounts superseded (3.1), there is no identity to attribute a
> command to. The workable substitute is a **per-client operator label** — a
> name each browser sets for itself ("FOH", "Dana", "Stage L") and sends with
> every control command and mic-check tick. It is self-declared, so it is
> context rather than audit, but it answers the actual question ("who just
> muted CH 4?") without reintroducing accounts. Needs a yes before building.

**Problem.** Mute, gain, and frequency commands arrive over the socket from any client with no
arbitration. Two operators can fight over a channel, and neither sees the other's action except
as telemetry snapping back.

**Approach.** Commands are already fire-and-forget to hardware, and hardware state echoes back
via telemetry — that is a reasonable base. Add: broadcast a `control:applied` event naming the
channel, the change, and (post-Stage 3) the operator, so every client can surface "FOH muted
CH 4" rather than showing an unexplained state change. Full locking is almost certainly
overkill; visibility is what is actually missing.

---

## Stage 3 — Access control & deployment

*This is the gate. Below this line the server must only run on a trusted, isolated show network.*

### 3.1 Authentication and RBAC — **XL** — *superseded*

> **Superseded by decision.** Access control is an optional admin-set PIN that
> remote clients enter, with an admin-chosen re-authentication interval; the
> network is trusted by default. There are no named accounts and no roles. The
> design below is kept as the record of what was considered, and as the shape
> to reach for if per-operator attribution is ever required. Consequences:
> `checkedBy`, `acknowledgedBy`, and the operator on `control:applied` have no
> identity to carry — see the note under 2.5.

**Problem.** The Fastify server and Socket.io endpoint are entirely unauthenticated. Since the
application is network-exposed by design, anyone who can reach the port can mute channels,
retune frequencies, rewrite inventory, and read stored device passwords. The three roles the
README specifies — `ADMIN`, `TECH`, `MONITOR` — do not exist.

**Decision: named user accounts.** Each account identifies one login, and actions are attributed
to it. If a crew prefers to create a generically-named account and share the credentials among
several people, that is their operational choice — the system supports it without designing for
it. This keeps attribution meaningful by default and costs nothing when a crew opts out.

Two consequences follow directly and should be built in from the start:

- **Concurrent sessions per account are allowed.** A shared "FOH" account used by two people at
  once must work. Never assume one active session per user.
- **Attribution displays the account name verbatim**, which may be a person or a position.
  Phrase it neutrally so both read correctly — "Checked by FOH" and "Checked by Dana" should
  each look intentional.

**Model.**

```
User  id, username, passwordHash, displayName, role, active,
      createdAt, lastLoginAt?
```

Username rather than email as the identifier. A venue has no mail infrastructure, and crews will
not want to type addresses at a rack; allow an optional email field but never require it.

**Approach.** Session-based auth with route guards enforcing the three roles.

**The socket must be authenticated too.** Control commands arrive over the socket, not REST, so
guarding only REST leaves the actual attack surface open. Authenticate at connection time and
re-check role on each control event.

Role mapping: `MONITOR` read-only (correct for a stage manager or talent wrangler), `TECH` adds
device control and configuration, `ADMIN` adds user and system settings.

Deployment shapes differ in first-run experience, not in enforcement:

- **Headless** — a first-run setup flow creating the initial admin. Never a default password.
- **Desktop** — the local window may auto-authenticate as admin over loopback, since physical
  access to the machine already implies control. Remote clients authenticate normally.

**Also in scope:**

- **User management UI** (`ADMIN` only) — create, rename, change role, deactivate, reset
  password. Deactivate rather than delete, so historical attribution survives.
- **Admin-mediated password reset.** There is no mail server in a venue, so self-service reset
  by email is not an option. An admin sets a new password directly.
- **Connected-clients view.** Named accounts make it cheap and genuinely useful to show who is
  currently connected during a show — surface it in settings or the sidebar.

**Backfill attribution** once this lands: `MicCheckEntry.checkedBy` (1.1),
`Event.acknowledgedBy` (4.1), and the operator name on `control:applied` (2.5) are all specified
as nullable ahead of this stage and become populated here.

**Done when:** an unauthenticated client can neither read telemetry nor issue a control command
over REST or socket; two clients signed into the same account both work normally; and mic-check
ticks and alert acknowledgements carry the account that performed them.

---

### 3.2 Encrypt device passwords at rest — **M**

**Problem.** `InventoryDevice.password` is plaintext in SQLite. The file is readable by anyone
with filesystem access, and the passwords unlock the wireless hardware itself.

**Approach.** Encrypt with a key derived from a server-held secret; decrypt only in memory when
constructing a client. Never return password material from `GET /api/inventory` — the API
currently returns the whole row, so the frontend receives every device password today. Fix that
regardless of encryption timing; it is a one-line omission with real consequences.

---

### 3.3 Verify and document headless deployment — **M**

**Problem.** The server is structured to run standalone, but the headless path is not
exercised or documented. `apps/server/.env` is committed with a SQLite `DATABASE_URL` that
assumes the desktop layout.

**Approach.** Confirm `pnpm --filter @rfdeck/server dev` serves the built frontend, that
`bindInterface` in `Settings` correctly controls the listen address, and that discovery works
on a server NIC. Document the deployment: environment variables, ports (HTTP, UDP 53212 for MCP,
UDP 5353 for mDNS, UDP 45 for EW-DX telemetry), and firewall requirements — the Windows firewall
handling in `main.ts` has no headless equivalent.

**Done when:** a clean machine can run RFDeck headless from documented steps, and clients on the
network reach it.

---

## Stage 4 — Show-day hardening

### 4.1 Persist the event log — **M**

Building on 2.2, write server-computed events to an `Event` model (`id, timestamp, severity,
type, message, channelKey, deviceId, showId?, acknowledged, acknowledgedBy?, dismissed`).
Add `GET /api/events` with time-range and severity filters, and scope events to the active show
so a report can bound itself. Cap the table and prune on startup so a long-running install does
not grow without limit.

### 4.2 Battery runtime estimation — **L**

**Problem.** The battery dashboard shows current percentage only. The operationally useful
question is not "what percent is pack 7" but **"will pack 7 last the act."**

**Approach.** Sample battery percentage per channel server-side (a ring buffer covering roughly
the last hour). Fit drain rate by regression over the recent window and project time-to-empty.
Computing this on the server rather than per-client also keeps every client's estimate identical.

Two caveats to design around: many transmitters report coarse, stepped percentages, so raw
deltas are noisy and need smoothing; and a freshly-fitted pack needs a warm-up period before an
estimate means anything. Show "—" rather than a confidently wrong number.

Then add show-duration projection — given the active show's expected length, flag packs that
will not make it. That is the output an A2 actually acts on.

### 4.3 Show report export — **M** — ✅ *complete*

> `GET /api/shows/:id/report` (JSON), `report.csv` (sectioned spreadsheet), and
> `report.html` (printable; the browser's print dialog is the PDF path, so no
> PDF dependency). Covers show metadata, device list with serials and firmware,
> roster with channels, mic check per act with who and when, events in the
> show's window, and live battery at generation. Events are not tagged with a
> show, so the window is the show's lifetime — creation to archive or now —
> with `?from`/`?to` overrides. Report and CSV links sit in the show header.

One generator over the now-persisted models: show metadata, device list with firmware and
serials, roster with channel assignments, mic-check results per act with timestamps and
operator, all events in the show window, and battery summary. CSV first; PDF via a print
stylesheet rather than a new dependency — Electron can print to PDF and the browser build can
use the native print dialog from the same HTML.

### 4.4 Connection-loss visibility — **S** — ✅ *complete, then extended*

> Shipped as written, then corrected in use: telemetry is sent only on change,
> so "no update for six seconds" flagged every quiet mic as frozen. Staleness
> now keys on **device contact** — any traffic, or a direct probe when the
> stream has been quiet — broadcast every two seconds as a heartbeat. A quiet
> channel and a dead stream are finally different things.

When the socket drops, cards keep showing their last values with no indication the data is
frozen. Track last-update time per channel, visibly mark stale cards past a threshold, and dim
the dashboard with a persistent banner on disconnect. Pulling the network cable should be
obvious from across a room.

---

## Stage 5 — Client reach

*Mobile and remote surfaces. Core to the product, not an add-on.*

### 5.1 Responsive layouts — **L** — *deprioritised*

> Operators running a soundcheck are at their console, not on a phone, so the
> mobile mic-check flow that was to drive this work is not important. Stage 5
> moves behind Stage 6; revisit if a genuinely mobile use — a tech walking
> the stage with a receiver rack out of sight — turns out to matter.

The dashboard, inventory, and mic check are built for desktop widths. Mic check on a phone is
the highest-value mobile flow — a tech walking the stage ticking channels — so it should drive
the responsive work rather than being retrofitted last.

### 5.2 Progressive Web App — **M**

Manifest, service worker, install path, and an offline shell that degrades honestly when the
server is unreachable. Depends on 5.1.

### 5.3 Web push notifications — **M**

Subscription storage and delivery for critical alerts. Depends on 3.1 for identity and 5.2 for
the service worker. Route by role — a `MONITOR` should not be paged for a gain change.

### 5.4 QR / barcode scanning — **S**

Camera-based device lookup in inventory. Small, and genuinely useful for a tech at a rack.

---

## Stage 6 — Feature completion

### 6.1 Rolling capture, problem detection, and flagged clips — **XL** — *critical; next*

*Reframed 2026-08-23. The original entry described a replay buffer for manual
scrubbing. The actual requirement is that RFDeck **notices wireless problems
by itself and keeps the audio that proves them**: dropouts, hits, and
interference that a busy operator did not hear at the time but needs to find
afterwards — and, in a multi-night run, needs to correlate with a position on
stage or a moment in the show.*

**What it does.**

1. **Rolling capture, per patched channel, on the server.** The capture path
   already exists (Stage A): one `arecord` per interface, demultiplexed into
   per-channel streams. This adds a ring buffer per channel — the last N
   minutes of audio held in memory or on disk, continuously overwritten.
2. **Detection.** A detector runs over telemetry and audio together and raises
   a *detection* when something looks like a wireless fault: RF dropout or
   squelch events (already computed server-side, 2.2), RF level collapsing
   while AF stays hot, audio signatures of a hit or dropout (a sharp
   discontinuity, a burst of noise, a gap) on a channel whose RF was marginal.
   Telemetry-driven triggers are the first release; audio-signature triggers
   are the second, because they need tuning against real recordings.
3. **Clip retention.** On a detection, the seconds before and after it are
   copied out of the ring into a stored clip and kept — the ring keeps
   rolling. Each detection records the channel, the time, the trigger, the RF
   readings around it, the active show and act, and the clip.
4. **Detection log.** A server-authoritative list, shown in the app and in the
   show report: every detection with its clip. Operators **flag** the ones
   that matter (with a note), dismiss the ones that do not, and **listen to
   the clip** from any client — the clip is served over the same path as live
   monitoring.
5. **Always on, within a disk budget the operator sets.** Recording is not a
   mode to remember to switch on: every channel with an audio patch is
   captured continuously, from the moment it is patched. The settings page
   reports the server's free disk space and takes a maximum the application
   may use; clips fill that budget **FIFO**, oldest discarded first, so the
   operator gets as much history as the space they allotted. Flagged clips are
   exempt from automatic pruning — flagging is what says "keep this".

**Approach.** Builds directly on `CaptureManager` (per-channel PCM already
flows through it) and the persisted event log (4.1 — detections are a new
event source with a clip attached). Clips are stored as files on disk with a
path reference in the database, never as blobs. Playback is a WebRTC track fed
from a file rather than a live source, so the client's listen path is reused
unchanged.

**Sizing guidance.** 48 kHz 16-bit mono is 5.8 MB per minute per channel; a
five-minute ring for 32 channels is under a gigabyte in memory, and clips of
twenty seconds are about 2 MB each.

**Done when:** a deliberate dropout on a live receiver produces a detection
with a playable clip within seconds, on every connected client, and survives a
server restart; and a flagged detection is still there after the pruning that
removes unflagged ones.

### 6.2 Performer notebook and photos — **M** — *roster done; notebook and photos outstanding*

> The roster half exists: `Performer` is a global model, shows cast from it by
> reference, and it has its own page with notes. What remains is the
> per-performer notebook proper (rich notes, quick-change log) and headshot
> upload, which should hang off `Performer` rather than the per-show casting.

Extends the `Player` model from 1.1: rich notes, headshot upload, quick-change log. Store images
on disk with a path reference, not as database blobs — and serve them through the same auth
layer as everything else.

### 6.3 Device maintenance log — **S**

A `MaintenanceEntry` model related to `InventoryDevice`, surfaced in the device drawer.

### 6.4 Stage plot view — **L**

Spatial channel layout for Concert/Touring mode, persisted per show and shared across clients.
The drag interaction from card reordering is a reasonable starting point.

---

## Stage 7 — Breadth & operations

### 7.1 Test suite — **L** *(start during Stage 1)*

*Status: 94 Vitest tests across 7 files (RF state machine, battery estimation,
PIN hashing, secret box, ALSA parsers, AES67 sink allocation, discovery
identification). No Playwright. No CI — see 7.5.*

No test files existed when this was written, despite the README specifying Vitest and Playwright. Listed last because it
is not user-facing, but the highest-value tests should be written **during Stage 1**: the IP
reconciliation logic in `DeviceManagerService`, control-vs-Dante discrimination, and dropout
debounce. That logic is subtle, hardware-dependent, expensive to verify by hand, and has already
regressed once. Playwright coverage for mic check and inventory follows.

### 7.2 PostgreSQL support — **M**

SQLite is adequate for a single headless instance serving a venue. Postgres matters for a hosted
multi-venue deployment and for concurrent write volume beyond one show's worth of traffic.
Prisma makes the provider swap mechanical; the work is migration strategy and verifying no
SQLite-specific behaviour leaked into queries.

### 7.3 Additional manufacturers — **XL each**

Shure (Axient Digital, ULX-D, SLX-D) first — largest installed base, documented API. Then
Wisycom via Ember+, then Lectrosonics.

Before starting, extract an explicit hardware-client interface. `SSCClient` and `G3G4Client`
already share an implicit contract through the `ClientType` union; making it explicit turns a
third manufacturer into an addition rather than a refactor.

### 7.4 Packaging and updates — **M**

Docker image for the headless target, auto-update for the desktop build.

---

## Verification protocol

Run before any show, and after any change to the connectivity layer.

**Cold start.** All receivers off. Start the app. Power receivers on. Every device reaches
online without intervention. *Exercises staggered startup scans.*

**DHCP shuffle.** With the app running, power-cycle the network so receivers get new addresses.
All devices recover without editing inventory. *Exercises reconciliation.*

**Dual-interface.** With an EW-DX on both control and Dante, confirm it appears exactly once in
discovery and once in inventory. *Exercises NIC discrimination.*

**Intentional power-down.** Mark a device inactive, power it off. No dropout alerts, no dashboard
card, no offline warnings.

**Cable pull.** Disconnect the network mid-session. Stale data is unmistakable. Reconnect;
telemetry resumes without a restart.

**Restart under load.** Restart the server while devices stream. Channels, online status, and
ordering all restore.

**Two-client agreement.** Connect two clients. Tick mic check on one, acknowledge an alert on
one, deactivate a device on one — all reflected on the other within a second. Connect a third
mid-show; it arrives fully current. *(Blocked until Stage 2.)*

**Show persistence.** Create a show, tick channels, add players, restart. Everything intact.
*(Blocked until 1.1.)*

**Headless parity.** Run the server headless. A browser client on another machine has full
functionality. *(Blocked until 3.3.)*

**Long run.** Leave running for a full performance with hardware connected. No memory growth,
no event flooding, no degradation.

---

## Suggested sequence

**Stage 1 first, 1.1 leading** — it retires the largest risk and everything downstream assumes
real persistence. Items 1.2–1.5 are small and batch into one sitting. Write the
`DeviceManagerService` unit tests from 7.1 alongside this stage, while the reconnection
behaviour is fresh.

**Build 2.1 together with 1.1.** Broadcasting show mutations is far cheaper designed in than
retrofitted, and 1.1 is not really complete without it in a multi-client product.

**Stage 3 before any deployment beyond a trusted show network.** 3.2's API leak — the inventory
endpoint currently returns device passwords to every client — is worth fixing immediately rather
than waiting for the rest of the stage.

**Stage 4 converts a good monitoring tool into a system of record.** Battery runtime (4.2) and
the show report (4.3) are the two features most likely to be requested first by someone using
this for real work.

Stages 5–7 reorder freely against what the next production needs.

---

### 7.5 Continuous integration — **S** — ✅ *complete*

> `.github/workflows/ci.yml`: on every push to `main` and every pull request —
> install, Prisma generate, shared-types build, typecheck of server and web,
> the Vitest suite, the web build, and a syntax check of the deploy scripts.
> The desktop build is deliberately excluded; Electron packaging is verified on
> a clean machine.

94 tests and a full typecheck exist, and nothing runs them unless someone
remembers to. A workflow that runs `tsc --noEmit` for every package, the Vitest
suite, and the web build on every push closes the gap — the regex-escape bug
that capped every audio device at two channels would have been caught by the
parser tests the moment they existed, had anything been running them. Depends on
where the repository is hosted; see the reconciliation note.

---

## Open questions — resolved

All four original questions have been answered and the answers are in effect:

- **Show scale** — 2–128 channels, 1–10 concurrent clients. No partitioning or
  virtualised rendering needed at that size.
- **Venue network trust** — trusted by default; an optional admin-set PIN for
  remote clients when it is not. This is why 3.1's account model was superseded.
- **Show lifecycle** — either: shows live indefinitely or are archived, the
  operator's choice. Per-act reset exists for multi-night runs.
- **README stance** — it is updated as features land, and incomplete features
  are flagged rather than removed.

Still open: **2.5 attribution without accounts** — see the note under 2.5.

---

## Dependency flag — Prisma 5 → 7

The deploy script reports Prisma 5.22 → 7.x as available. Recorded here so the
decision is deliberate rather than eventually forced. `^5.0.0` dates from the
initial scaffold and was never revisited; 5.22 is simply the end of that line.

**Prisma 6** is effectively free for this project: its breaking changes are
PostgreSQL relation tables, full-text search, `Bytes`→`Uint8Array`, and the
removal of `NotFoundError`, none of which this code touches. Node 24 and TS 5
already satisfy its minimums.

**Prisma 7** is a real migration, in five parts, verified against the upgrade
guide rather than recalled:

1. The Rust query engine is removed; a driver adapter is mandatory. For SQLite
   that is `@prisma/adapter-better-sqlite3`, a native module. `db.ts`'s
   `new PrismaClient({ datasources })` becomes `new PrismaClient({ adapter })`.
2. `url = env("DATABASE_URL")` in the schema is deprecated for `prisma.config.ts`.
   The environment variable survives; it is read from a different place.
3. `prisma-client-js` is deprecated for `prisma-client`, which requires an
   explicit `output` and changes the import path. It supports
   `moduleFormat = "cjs"`, so the server's CommonJS build need not move to ESM.
4. `prisma db push --skip-generate` no longer exists and `db push` no longer
   runs `generate`. **Both deploy scripts pass that flag and would fail.**
5. The desktop build stages the generated client *and the native query engine*
   into the package. Under 7 the engine is gone and `better-sqlite3` must be
   compiled against Electron's ABI (`@electron/rebuild`) and unpacked from the
   asar. This is the costly part and the one most likely to need rounds on a
   clean machine.

**Recommendation:** not during testing. 5.22 is neither broken nor insecure, and
the desktop packaging was the hardest part of this project to stabilise. Moving
to `^6` first is near-zero risk and can be done any time; 7 is an afternoon on
the server plus a separate budget for Electron. A useful side effect of 7: the
engine DLL that causes `EPERM` on `prisma generate` under Windows goes away.

---

## Stage B — Micboard & Go Live *(added)*

Not in the original plan. Both came out of using the application rather than
from the stage list.

### B.1 Micboard — ✅ *complete*

A read-only wall display: one tile per channel, leading with the performer's
face and name over RF, audio, battery and status, sized to be read across a
room rather than studied. Photos come from the cast list of the show that is
live.

Read-only without a PIN, because the PIN exists to prevent unauthorised
changes rather than to hide telemetry — and enforced rather than trusted: a
display announces itself at the socket handshake and the server then never
registers the control or audio handlers for it. The REST exemption is matched
by method as well as path.

Deliberately not built: Micboard's numbered groups. One grid of every active
channel until using it shows grouping is needed.

### B.2 Go Live — ✅ *complete*

One action for "I am working the rig now": track every device in the
inventory, start rolling capture and fault detection, put the chosen show's
cast on the Micboard. Standing down reverses all three.

This replaced a heuristic that was quietly wrong. Detections and the Micboard
had been picking the most recently *updated* unarchived show — but a mic-check
tick writes to `MicCheckEntry`, not the show row, so renaming an old show
outranked the one actually on stage, and detections were filed against the
wrong show. The live show is now declared, never inferred, and held as a
single nullable pointer so two shows cannot be live at once.
