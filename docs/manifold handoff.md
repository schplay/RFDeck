# RFDeck ↔ Manifold — integration hand-off

**Status (2026-09-28):** manifold's RFDeck client is built and in use — manifold plan workstream **W13** is done
except for one item that needs RFDeck (a channel display-name write, below). This document is for the RFDeck side:
what manifold relies on, so a change here does not quietly break the console, and what manifold still asks for.
Manifold's own copy, with the full history, is `plans/handoff/RFDeck.md` in the manifold repo. Read against RFDeck
at `5242955`.

## The relationship

**Manifold is a client of RFDeck; RFDeck stays the source of truth for wireless devices.** A console shows RFDeck's
channels, telemetry, alerts and audio-fault detections next to the strip each mic feeds, and hands RFDeck the small
things the console already knows (who wears which pack, which frequency). Manifold does not reimplement RF
coordination, device drivers or detection; every value it shows is what RFDeck last said, and every write shows up
on the console only when RFDeck's telemetry comes back changed.

Nothing on RFDeck's side had to be built for any of this. It uses RFDeck's existing surface, as it is.

## What manifold uses — please keep these stable

Manifold's client is `engine/src/net/RfDeckClient.{h,cpp}`; its test fake (`engine/tests/protocol/rfdeck_client_test.py`)
mirrors the shapes below, so a change here should be told to manifold so the fake can move with it.

**Transport.** Socket.io on the default namespace over the **Engine.IO long-polling transport**
(`/socket.io/?EIO=4&transport=polling`) — manifold's engine has an HTTP client and no WebSocket client, so please
keep polling enabled on the server. Pings are answered. The state replay on connect is what a reconnecting console
relies on to fill itself back in.

**Auth.** `POST /auth/login {pin}` → `{authenticated, token}`, once; manifold keeps the token (machine-level, never in
a show file) and never the PIN. The token rides as `x-rfdeck-token` on REST and as `handshake.auth.token` on the
Socket.io CONNECT. A `PIN_REQUIRED` refusal is shown to the operator as "log in once in Settings".

**Events read** (from the socket):

| Event | Fields manifold reads |
|---|---|
| `channel:telemetry` | the whole `Channel`: `id`, `deviceId`, `channelIndex`, `name`, `frequency` (**kHz**), `rfLevelA/B`, `afLevel`, `batteryPercent`, `isMuted`, `isTxMuted`, `gain`, `role`, `status` |
| `channel:removed` | `channelId` |
| `alert:new` | the whole `Alert` (`channelId`, `severity`, `type`, `message`, `acknowledged`, `dismissed`) |
| `battery:estimate` | keyed by `channelId` |
| `detection:new` / `detection:updated` | `id`, `channelKey`, `trigger`, `severity`, `message`, `flagged`, `dismissed` (a dismissed one leaves the console's list) |
| `detection:pruned` / `detection:deleted` | `ids` / `id` |
| `show:updated` / `show:deleted` | the serialized show (`id`, `name`, `archived`, `players[]` with `id`, `realName`, `characterName`, `assignedChannelKey`, `iemChannelKey`) / `id` |
| `device:*`, `discovery:scan-complete` | trigger a fresh `GET /inventory` |
| `live:changed` | kept as status |
| `control:result` | `ok`, `message` — a refusal is shown to the operator |

**Controls sent** (socket, from a full-access client): `channel:mute {deviceId, rxIndex, muted}`,
`channel:gain {deviceId, rxIndex, gain}`, `channel:frequency {deviceId, rxIndex, frequencyHz}` (**Hz**, as the
drivers take it).

**REST:** `GET /inventory`; `GET /shows`; `PUT /shows/:id/players/:playerId {assignedChannelKey}` (put a cast member
on a channel, or `null` to take them off); `PATCH /detections/:id {flagged | dismissed}`; `POST /coordination/plan
{lockedIds}` (manifold shows the plan's `assignments`, `unassigned`, `worstMarginKHz`, `moves`); `POST
/coordination/apply {assignments: [{id, frequencyKHz}]}` (manifold shows each channel's `results[]` entry).

**Identity.** Channel ids (`<inventory row id>:<slot>`) are stored in manifold's show files as the strip ↔ channel
mapping, so they need to stay stable across restarts and firmware updates, as they are now. Detections keyed on the
same id (`channelKey`) is what lets the console badge the right strip.

**Units.** Telemetry `frequency` is kHz; `channel:frequency` takes Hz; the coordination routes take kHz. Manifold
converts at each edge; a unit change on any of the three would retune the wrong way.

## How the console uses it (for context)

- Every write is the operator's, behind manifold's `patch` permission; manifold never retunes, mutes or dismisses on
  its own. (An AI assistant connected to the console over MCP has retuning asked of the operator first.)
- Calls to RFDeck run on a worker thread in manifold, so a slow or absent RFDeck never stalls the console.
- The console suggests which strip each mic feeds from receiver names and from the cast (never applied without the
  operator), and can name its strips from the cast wearing each pack.

## What manifold would still like from RFDeck

1. **A channel display name, writable** — the one thing blocking the rest of W13.4. A channel's name on RFDeck's side
   comes from the receiver, so "Vox Lead" typed at the console cannot reach RFDeck. A display-name field on the
   channel, kept by RFDeck and shown instead of the receiver's own name when set (for example `PUT
   /channels/:id {displayName}` or a socket event answered by `control:result`), would let the console keep both in
   step. Performer assignment is already covered by the shows API.
2. **Tokens that survive a restart** (or confirmation that they deliberately do not). Tokens are held in memory
   (`pinAuth.ts`), so every RFDeck restart logs the console out until someone gives the PIN in its Settings again.
   With `reauthHours` at its default of 0 a token otherwise never expires, so a persisted token (or a longer-lived
   device credential for integrations) would match what that setting already means.
3. *Optional:* a `GET /channels` (and `GET /alerts`) snapshot, so a REST-only or reconnecting client could recover
   without waiting for the socket replay. Not needed today.

## The original questions, answered from the code (2026-09-23, updated 2026-09-28)

1. **Socket.io contract** — the default namespace, a firehose, full state replayed on connect (table above).
2. **REST** — `/inventory`, `/performers`, `/shows`, `/detections`, `/coordination/*`, `/live`, `/auth/*`; no
   OpenAPI, and `packages/shared-types` serves as the schema.
3. **Stable identity** — `<inventory row id>:<slot>`.
4. **Auth** — open with the PIN off, always open from loopback, otherwise a token from `/auth/login`; a
   `micboard: true` handshake gets read-only telemetry without a PIN (not used by manifold, which needs the controls).
5. **Audio faults** — `detection:*` events keyed on the channel, as manifold wanted.
6. **Write safety** — no locking between RFDeck and the console; each refused control is reported, nothing retried.
7. **Parity / discovery** — one codebase for desktop and web; the console is given RFDeck's address (no advert).
8. **Audio** — out of scope; manifold does not take RFDeck's audio.
