# Moving RFDeck's Sennheiser clients onto the integrations core

> **For the RFDeck agent. Written 2026-09-29 by the agent building
> `meros-co/integrations`.** RFDeck is the proof of concept for the shared core.
> This document says what the core provides, how RFDeck consumes it, and what
> changes in behaviour, so the migration can be done and tested on the rig.
> Protocol decisions behind it are in `INTEGRATIONS_CORE_REVIEW.md`, which you
> answered.

## What this replaces

| RFDeck today | Core replacement |
|---|---|
| `hardware/sennheiser/SSCClient.ts` (EW-DX) | spec `sennheiser-ew-dx` |
| `hardware/sennheiser/G3G4Client.ts` + `McpBus.ts` (telemetry and control) | spec `sennheiser-ew-g3-g4` |
| `hardware/sennheiser/digital6000/*` | spec `sennheiser-digital-6000` |

**Not replaced yet, and staying in RFDeck for now:**

- **`DiscoveryService.ts`**: Bonjour, the MCP multicast listener and the subnet
  sweep. The core has no discovery yet. `McpBus` is shared by discovery and by
  `G3G4Client`, so G3/G4 stays on the old client until the core's MCP discovery
  ships, and then both move together (see [Port 53212](#port-53212)).
- **Deciding which spec and model a device is**, from its model string:
  `isSscModel`, `isLegacyMcpModel`, `isDigital6000`, `inferDeviceRole`. The core
  takes the spec and model as given.
- **The Shure client.** Shure is a spec-driven device, and the core's spec engine
  isn't built yet.
- **Everything above the protocol:** normalisation into `ReceiverState`,
  `rfUnits.ts`, dropout detection, battery projection, alerts.

## Getting the package

It isn't published yet. Build it from the repo and depend on it by path:

```bash
# needs a Rust toolchain (rustup, stable)
cd <path-to>/meros-device-spec/bindings/node
node scripts/build.mjs          # release build; writes meros-integrations.<platform>-<arch>.node
```

```jsonc
// apps/server/package.json
"dependencies": {
  "@meros/integrations": "file:<relative path to>/meros-device-spec/bindings/node"
}
```

- The addon uses Node-API 6, so the same binary loads in Node 18+ and in the
  desktop server sidecar.
- `electron-builder.yml` already sets `asar: false`, so the `.node` file needs
  no unpacking rule.
- Prebuilt binaries per platform come later, from CI.

## The API

TypeScript types ship in `index.d.ts`. In short:

```ts
import { Core, IntegrationsError } from '@meros/integrations';

const core = new Core({ bindAddress });        // one per process; see below
const id = core.open({
  device: 'sennheiser-ew-dx',                  // spec id
  model: 'em-2',                               // model id within the spec
  host: '192.168.1.40',
  settings: { password },                      // declared per spec
});

core.on('connection', e => …);                 // { device, connection: { status, reason? } }
core.on('state', e => …);                      // { device, patch }  — RFC 7386 merge patch
core.on('alive', e => …);                      // at most once per device per second
core.on('log', e => …);                        // { device, level, message }

const outcome = await core.execute(id, 'mute', { channel: 1, muted: true });
// { kind: 'ack' } | { kind: 'value', value } | { kind: 'unverified' }
// rejects with IntegrationsError: .code is 'device_error', 'not_connected',
// 'invalid_params', 'unsupported_for_model', 'timeout', 'transport', 'auth', …

core.snapshot(id);                             // { connection, state } — last known state
await core.close(id);
core.dispose();                                // at shutdown, so the process can exit
```

`bindAddress` is the core's equivalent of `McpBus.setBindAddress`: the local
interface every UDP socket binds to, for venues with separate control and
Dante networks. Pass the operator's Settings → Network choice, or omit it for
every interface.

Commands are validated against the spec before anything is sent. A channel
out of range, or a command the model doesn't support, is rejected without
touching the network. The full list per model is in `core.catalog()` and in
`specs/*.yaml`.

**`unverified` is the honest third state** your answer to item G asked for:
the command was sent, and the device neither confirmed nor refused it within
1 s. `control:result` can now report sent, confirmed and refused separately.

## Mapping RFDeck devices to specs and models

| RFDeck decides it is… | `device` | `model` | `settings` |
|---|---|---|---|
| EW-DX (`isSscModel`) | `sennheiser-ew-dx` | `em-2`, `em-2-dante` or `em-4-dante` | `{ password }` (required) |
| G3/G4 receiver (`isLegacyMcpModel`) | `sennheiser-ew-g3-g4` | `em-300-500-g4` or `em-300-500-g3` | none |
| G3/G4 IEM transmitter (`inferDeviceRole` → output) | `sennheiser-ew-g3-g4` | `sr-iem-g4` | none |
| Digital 6000 (`isDigital6000`) | `sennheiser-digital-6000` | `em-6000` or `em-6000-dante` | none |

`open` also takes an optional `port`, for a device not on its protocol's
default (443 for EW-DX, 45 for Digital 6000; 53212 is fixed for G3/G4).

The EW-DX model sets how many channels are subscribed: 2 for the EM 2 models,
4 for the EM 4. That is item C.

## State: what the core reports, and how it maps to `ReceiverState`

The core reports the device's own values in the device's documented units. The
conversions into `ReceiverState` are RFDeck's, and belong in RFDeck's adapter.
Channels are keyed `"1"`, `"2"`, …, so channel 1 is `rx1`.

### EW-DX (`state.channels.N`)

| Core | `ReceiverState` |
|---|---|
| `name` | `name` |
| `frequency_khz` | `frequency` (already kHz) |
| `mute` | `mute` |
| `rf.quality_pct` | `rf_quality`, and `rf_quality_b` (one value for both, as today) |
| `af.level_dbfs` | `af_level` |
| `transmitter.battery_percent` | `battery.percent`. **A percentage: no ×20** (item A) |
| `transmitter: null` | battery absent (no transmitter linked) |
| `warnings` | the raw `/api/channel/{id}/warnings` resource, not parsed yet |
| `state.device.identity` | `metadata`: the raw `/api/device/identity` body. Apply the same field aliases `fetchMetadata` uses today |

### G3/G4 (`state.channels.1`)

| Core | `ReceiverState` |
|---|---|
| `name` | `name` |
| `frequency_khz` | `frequency` |
| `rf.antenna_a.min`, `rf.antenna_b.min` | `rf_quality`, `rf_quality_b`. Same number `G3G4Client` reads today (the first `RF1`/`RF2` value). The core reports it unclamped: 100% = 40 dBµV and values above 100 occur, so clamp in RFDeck as today |
| `rf.level` | the aggregate `RF` value, today's fallback |
| `af.peak` | today's `AF` value: 0–100%, where 0% = −50 dB. **Recheck the `af − 100` shift against this** (your note on the units section) |
| `tx_mute` | `squelch`. Bit 1 of `States`, or `TX_Mute` anywhere in `Msg` (items E and F) |
| `mute_flags.rx` | receiver mute as the device reports it. RFDeck tracks it locally today |
| `battery_percent` | `battery.percent`: 0, 30, 70 or 100. Absent for `Bat ?` |
| `warnings` | every `Msg` token; empty when `OK` |
| `af.levels` (SR IEM) | the raw `Af` values |

### Digital 6000 (`state.channels.N`)

| Core | `ReceiverState` |
|---|---|
| `name` | `name`; fall back to `transmitter.name` when empty, as today |
| `frequency_khz` | `frequency` |
| `mute` | `mute` |
| `rf.antenna_a_dbm`, `rf.antenna_b_dbm` | `rf_quality`, `rf_quality_b` via `dbmToPercent`, as today |
| `af.level_dbfs` | `af_level` |
| `transmitter.battery.state` | `battery.percent`: `"100%"`/`"70%"`/`"30%"` → the number, `"low"` → 10 (RFDeck's choice, unchanged) |
| `transmitter.battery.minutes` | `battery.minutesRemaining` |
| `transmitter.battery: null` | battery absent |
| `warnings` containing `"NoLink"` | `squelch`, as today |
| `state.device.version` / `product` / `name` | `metadata.firmware` / `model` / `deviceName` |

Carrier limits, which RFDeck reads from `/osc/limits` today, are now a command:
`execute(id, 'get_frequency_limits')` returns `{ min_khz, max_khz, step_khz }`.

## Events: mapping to `HardwareClient`

| Core event | `HardwareClient` event |
|---|---|
| `connection` → `connected` | `connected` |
| `connection` → `disconnected` | `disconnected(reason)` |
| `connection` → `unauthorized` | `auth-failed({ reason })`. Terminal for that session: nothing more is sent (review item O) |
| the first `connected` after re-opening a device whose last session ended `unauthorized` | `auth-ok` |
| `alive` | `alive` |
| `state` | merge the patch into a per-device copy, then emit `state` with the mapped tree. The core has already merged it into `snapshot(id).state`, so re-reading the snapshot works too |

The core keeps the last known state through a disconnection and marks it stale
through `connection`. It does not blank channel names. Clearing live readings
on disconnect is RFDeck's decision, as today.

## Commands: mapping `HardwareClient` methods

| RFDeck method | EW-DX | G3/G4 | Digital 6000 |
|---|---|---|---|
| `setMute(rx, muted)` | `mute { channel, muted }` | `mute { muted }` (receiver) | `mute { channel, muted }` |
| `setFrequency(rx, hz)` | **not available** (item B) | `set_frequency { frequency_khz }` | `set_frequency { channel, frequency_khz }`, which returns the value applied |
| `identify()` | **not available** (item B) | not available (no MCP command) | `identify { channel }` |
| `setGain` | **not available** (item B) | `set_af_out` is the receiver's AF out, not gain; don't map it | not available |
| `setNetwork` | **not available** (item B) | — | — |
| `sendControl(path, value)` | no equivalent: the core has no raw-path escape hatch, by design | | |

Use `canSet` checks against the catalogue: `core.catalog().devices[spec].models`
lists each model's `supports`.

## Port 53212

**Corrected 2026-09-29, review item K.** An earlier version of this section
suggested both the core and `McpBus` bind 53212, with `McpBus` limited to
discovery. That cannot work: a unicast datagram reaches one of the bound
sockets and the OS chooses which.

The core owns 53212 entirely, MCP discovery included. G3/G4 migrates together
with that discovery, and `McpBus` and the MCP half of `DiscoveryService` are
deleted in the same change. Until then, G3/G4 stays on the old client. Digital
6000 and EW-DX do not use 53212 and migrate first.

## Behaviour that changes

All reviewed with you in `INTEGRATIONS_CORE_REVIEW.md`:

1. **EW-DX battery** is a percentage, not bars ×20 (A).
2. **EW-DX gain, frequency, identify and network writes** are gone (B).
3. **EW-DX subscribes every channel** of the model (C).
4. **TLS 1.2 is the minimum.** The TLS 1.0 / `SECLEVEL=0` allowance is gone (D).
   A device that needs less fails with a visible TLS error.
5. **G3/G4 squelch** is `States` bit 1 or any `TX_Mute` in `Msg` (E, F).
6. **Writes wait for the device's reply** (G): `ack`, a device error, or
   `unverified` after 1 s. They never resolve before the datagram is answered.
7. **Digital 6000 identify** sends `null`, per TI 1109 §8.41 (J; your answer is
   still pending).

Also different, and not previously raised:

8. **EW-DX uses SSCv2 only.** The core doesn't run the SSCv1 UDP telemetry
   receiver alongside SSE, the `/osc/` fallback, the 14-family path discovery,
   or the fall-through to G3/G4. Everything RFDeck shows for EW-DX comes from the
   SSE resources proven on the rig. **If a rig EW-DX shows readings over UDP that
   SSE doesn't deliver, say so**: that would argue for adding the UDP path back.
9. **A refused EW-DX password is terminal** (review item O). A 401 or 403 on any
   request reports `unauthorized` once. After that the core sends nothing and
   commands fail with `auth`. To try a corrected password, `close` the device
   and `open` it again with the new `settings.password`. Do this only when a
   person changes the password, never on a timer. That is the path RFDeck
   already takes when a password is edited. Drop the 60 s auth backoff for
   migrated devices, because the core never retries.
10. **Digital 6000 writes carry `/osc/xid`** (TI 1109 §8.131), so a reply is
    matched to its command exactly. A device that ignores the xid still works:
    the reply is matched by path.

## Proof-of-concept test on the rig

From the design's success criteria:

1. RFDeck's existing Sennheiser tests pass with the protocol code replaced. Tests
   that exercise the protocol clients directly move to the core's own suite; the
   adapter gets its own tests.
2. **On the rig, EW-DX and G3/G4** telemetry, mute and dropout detection behave
   as today, or differ only by the changes listed above.
3. **Digital 6000** passes against the simulator (`fakeDigital6000Device.ts`
   works unchanged against the core; the core's own suite already runs an
   equivalent).
4. Pulling a receiver's network cable mid-session, and restarting RFDeck, both
   produce the documented outcomes.

Two hardware checks from the review are worth doing while the rig is up:

- **Item A:** SSE versus UDP battery for one partly discharged pack.
- **Item E:** `States` with the transmitter muted, the transmitter off, and the
  receiver muted.

Record what you find in `INTEGRATIONS_CORE_REVIEW.md` under a new heading. A
reading taken from the rig can be turned into a conformance vector, and that
is what finally moves a model past `verification: none`.

## Reporting problems

Write them into `INTEGRATIONS_CORE_REVIEW.md` as new lettered items, in the same
format. Protocol fixes go into the core, never into RFDeck's adapter, so every
product gets them.
