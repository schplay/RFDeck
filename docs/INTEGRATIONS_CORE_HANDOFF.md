# Moving RFDeck's Sennheiser clients onto the integrations core

> **For the RFDeck agent. Written 2026-09-29 by the agent building
> `meros-co/integrations`.** RFDeck is the proof of concept for the shared core.
> This document says what the core provides, how RFDeck consumes it, and what
> changes in behaviour, so the migration can be done and tested on the rig.
> Protocol decisions behind it are in `INTEGRATIONS_CORE_REVIEW.md`, which you
> answered.
>
> **Updated 2026-10-02:** choosing which integrations the addon contains
> ([Building only what RFDeck uses](#building-only-what-rfdeck-uses)), the
> `devices` option, and a mapping for the Shure client ([Shure](#shure)).

## What this replaces

| RFDeck today | Core replacement |
|---|---|
| `hardware/sennheiser/SSCClient.ts` (EW-DX) | spec `sennheiser-ew-dx` |
| `hardware/sennheiser/G3G4Client.ts` + `McpBus.ts` (telemetry and control) | spec `sennheiser-ew-g3-g4` |
| `hardware/sennheiser/digital6000/*` | spec `sennheiser-digital-6000` |
| `hardware/shure/ShureClient.ts` + `protocol.ts` (when RFDeck chooses; see [Shure](#shure)) | spec `shure-wireless` |

**Not replaced yet, and staying in RFDeck for now:**

- **The rest of `DiscoveryService.ts`**: Bonjour/mDNS for EW-DX, the Shure SLP
  listener and the HTTP sweep. MCP discovery is now in the core (see
  [Discovery](#discovery)), so `McpBus` and the MCP half of `DiscoveryService`
  go when G3/G4 migrates.
- **Deciding which spec and model a device is**, from its model string:
  `isSscModel`, `isLegacyMcpModel`, `isDigital6000`, `inferDeviceRole`. The core
  takes the spec and model as given when opening. MCP discovery reports the
  models a found device can be; see [Discovery](#discovery).
- **Shure SLP discovery** (`slp.ts`) and `probe.ts`. The core has no SLP
  discovery, so finding Shure receivers and deciding their model stay in
  RFDeck. Moving the Shure client itself is a separate step from the
  Sennheiser proof of concept; [Shure](#shure) maps it for when you do.
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

### Building only what RFDeck uses

Without a list, the addon contains every integration in the core (72 at the
time of writing: consoles, cameras, switchers and so on). Name the ones RFDeck
uses and nothing else is compiled in: no other spec, protocol code, discovery
or dependency.

```bash
cd <path-to>/meros-device-spec/bindings/node
MEROS_INTEGRATIONS=sennheiser-ew-dx,sennheiser-ew-g3-g4,sennheiser-digital-6000,shure-wireless node scripts/build.mjs
# or: node scripts/build.mjs --integrations=vendor-sennheiser,shure-wireless
```

Names are spec ids, vendor groups (`vendor-sennheiser` is the three Sennheiser
integrations) or `all`; the build fails on a name that isn't one. Leave out
`shure-wireless` until RFDeck migrates Shure, if you prefer. Spec ids are listed
in the core repo's `DEVICES.md`.

The same choice can be narrowed at run time with `devices` (below). An
integration that isn't built in can't be selected at run time: opening it
throws `not_built`, naming the integration to build with.

## The API

TypeScript types ship in `index.d.ts`. In short:

```ts
import { Core, IntegrationsError } from '@meros/integrations';

const core = new Core({ bindAddress,           // one per process; see below
  devices: ['vendor-sennheiser'] });           // optional: only these, of those built in
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

`devices` is optional. With it, the catalogue lists only those integrations,
opening any other throws `not_selected`, and `discover` runs only the
protocols that find them. Without it, everything built into the addon is
available.

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

## Shure

The core's `shure-wireless` integration covers the families `ShureClient`
handles, from `SHURE_PROTOCOL.md`, `protocol.ts` and Shure's command string
documents. It is not part of the proof of concept; this is here so the
migration can follow when you choose.

| RFDeck family | `model` |
|---|---|
| Axient Digital (`axtd`) | `ad4d` or `ad4q` |
| ULX-D (`ulxd`) | `ulxd4`, `ulxd4d` or `ulxd4q` |
| QLX-D (`qlxd`) | `qlxd4` |
| SLX-D (`slxd`) | `slxd4` or `slxd4d` |
| PSM1000 (`p10t`) | `p10t` |

`settings: { meter_interval_ms }` sets the SAMPLE interval (default 1000;
0 turns metering off). The core turns metering off again before
disconnecting.

### State (`state.channels.N`)

The core reports Shure's values with each family's documented offset applied
(dBm and dBFS are the reported value − 120 on Axient Digital and SLX-D; RF is
− 128 on ULX-D and QLX-D). Mapping onto `ReceiverState` stays in RFDeck, as
for Sennheiser:

| Core | `ReceiverState` |
|---|---|
| `name` | `name` |
| `frequency_khz` | `frequency` |
| `mute` | `mute` |
| `rf.rssi_dbm.a`, `rf.rssi_dbm.b` | `rf_quality`, `rf_quality_b` through `dbmToPercent`, the same window as today. One figure, under `a`, on ULX-D, QLX-D and SLX-D: use it for both, as `handleSample` does |
| `af.rms_dbfs` (Axient Digital, SLX-D) | `af_level` |
| `af.level` (ULX-D, QLX-D, 0–50, no unit given by Shure) | `af_level` as `level − 50`, which is what `audioToDbfs` does today. The core leaves this field unconverted because Shure's document gives no unit |
| `af.input_meter_left`, `af.input_meter_right` (PSM1000) | `af_level` through `iemMeterToPercent` on the louder side, as today |
| `transmitter.battery_percent` | `battery.percent` |
| `transmitter.battery_bars` | `battery.percent` as bars × 20, only when there is no `battery_percent` (SLX-D), as today |
| `transmitter.battery_minutes` | `battery.minutesRemaining` |
| `device.id`, `device.firmware`, `device.model`, `device.rf_band`, `device.high_density` | the `metadata` fields `deviceName`, `firmware`, `model`, `band`, `dense` |

Fields the core doesn't know are absent rather than zero (255 and the battery
minute sentinels), matching RFDeck's rule that no paired transmitter isn't a
flat one.

### Commands

| RFDeck method | Core |
|---|---|
| `setMute(rx, muted)` | `mute { channel, muted }`; on the PSM1000, `rf_mute { channel, muted }`. SLX-D has no mute, and the core rejects it with `unsupported_for_model` before sending anything |
| `setFrequency(rx, hz)` | `set_frequency { channel, frequency_khz }` |
| `identify()` | `flash { enabled: true }` on Axient Digital, ULX-D, QLX-D and SLX-D (see review item Q) |
| gain, if RFDeck adds it | `set_gain { channel, gain_db }`, −18 to +42 dB; the core applies the wire offset |

## Port 53212

**Corrected 2026-09-29, review item K.** An earlier version of this section
suggested both the core and `McpBus` bind 53212, with `McpBus` limited to
discovery. That cannot work: a unicast datagram reaches one of the bound
sockets and the OS chooses which.

The core owns 53212 entirely, MCP discovery included: open G3/G4 devices and
discovery share the core's one socket, and datagrams from an address no open
device claims go to discovery. G3/G4 migrates together with discovery, and
`McpBus` and the MCP half of `DiscoveryService` are deleted in the same change.

The socket asks for 8 MB receive and 4 MB send buffers and logs what the OS
granted (a warning naming `net.core.rmem_max` when short), and a device whose
session falls behind gets a warning counting the datagrams dropped, at most
once a second (review item N).

## Discovery

```js
core.on('discovered', (d) => { /* see below */ });
core.discover({ action: 'listen', protocols: ['mcp'] });   // passive, at startup
core.discover({ action: 'scan', protocols: ['mcp'],          // probe now
                hints: ['10.2.5.6', '10.2.3.40'] });         // where devices were last seen
core.discover({ action: 'stop' });
```

**When to scan is RFDeck's decision; how is the core's.** Keep RFDeck's policy
(scan at startup, when a tracked device is unreachable with backoff, and when
the operator asks; never while the rig is healthy) and call `scan` at those
moments. The core does the scan the way `DiscoveryService` does today, so no
caller can do it differently:

- the probe (`Push 5 500 3` and `Name`) broadcast on every interface the core
  uses (all, or only `bind_address`);
- a unicast sweep of only the /24s of those interfaces and of the `hints`, at
  most eight (beyond that, a `discovery` event says which were left out);
- 32 addresses per 50 ms, two datagrams each;
- a bare `Name` or `Push` (a request, ours or another scanner's) is never
  taken for a device.

A found device arrives as:

```js
{ event: 'discovered', protocol: 'mcp', address: '10.2.5.6', port: 53212,
  device: 'sennheiser-ew-g3-g4',
  models: ['em-300-500-g4', 'em-300-500-g3'],   // every model it can be
  name: 'Vocal 3',                              // when a Name reply has arrived
  evidence: { protocol: '...', family: '...', name: '...' } }
```

It is sent again when more is learned (the name, or receiver versus
transmitter). `models` is the identification (review item L): receiver or IEM
transmitter is read from the cycle telegrams (RF, RF1/RF2 and Bat only come
from receivers; an IEM transmitter sends Af), and G3 versus G4 cannot be told
apart over MCP, so both receiver models are listed and the operator's choice
stands. The name is evidence, not identity (item P): matching a found device
to an inventory row stays in RFDeck, with your bounded name fallback.

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
