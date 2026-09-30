# Moving RFDeck onto the integrations core — plan

RFDeck's side of `docs/INTEGRATIONS_CORE_HANDOFF.md`. Protocol answers are in
`docs/INTEGRATIONS_CORE_REVIEW.md`.

The shape is an **adapter**: one class implementing `HardwareClient` that wraps a
core session. `DeviceManagerService` builds clients through `trackDevice` and
talks to them only through that interface, so if the adapter is faithful nothing
above the protocol layer changes — normalisation, dropout detection, battery
projection, alerts and the socket surface Manifold depends on all stay put.

That is also what makes the migration reversible per protocol: the adapter can
back one family while the old client backs another.

## Three risks worth settling before code

**Raised with the core as items K, L and M in `INTEGRATIONS_CORE_REVIEW.md`**,
which is the channel the hand-off asks for and is where their answers will land.
That copy is canonical; what follows is the same three with RFDeck's own
sequencing attached.

### 1. Port 53212 — two sockets cannot share unicast, and this one is fragile

The hand-off suggests keeping `McpBus` for discovery probes only while the core
binds 53212 for telemetry. **That does not work the way it reads.** With
`SO_REUSEADDR` and no `SO_REUSEPORT`, a unicast datagram is delivered to exactly
one socket and which one is not defined. "Keep it for probes only" is not
something either side can enforce: a G3 answering a discovery probe and a G3
streaming telemetry are the same datagrams from the same port.

This is not theoretical for RFDeck. That socket has been the cause of a long run
of faults this month — probes starved by a concurrent sweep, telemetry dropped
because the receive buffer was at the OS default, receivers reported offline
because *other* devices were being found. Splitting ownership of it between two
runtimes would put every one of those back, with the added difficulty that the
evidence would be on the far side of an FFI boundary.

**Preference, in order:**

1. **The core does not bind.** RFDeck keeps `McpBus` as the sole owner of 53212
   and feeds the core received datagrams, taking its outbound datagrams back. A
   byte-level transport injection — `core.feed(id, bytes, fromAddr)` and an
   outbound `send` callback — keeps one socket, one buffer policy, one place to
   debug. This also makes the core testable without a network, which its own
   suite would benefit from.
2. **The core owns 53212 entirely**, including the MCP discovery probe and the
   passive listener, and `McpBus` is deleted. Clean, but it means discovery moves
   in the same step rather than later, which is a bigger PoC.
3. **Both bind.** Only as a knowingly temporary arrangement, with the acceptance
   that intermittent missing telemetry is expected and not a bug to chase.

I would not start the G3/G4 migration until this is decided. EW-DX and Digital
6000 have no such contention and can go first regardless.

### 2. Losing the SSC → MCP fallback removes a safety net that is load-bearing

The core takes spec and model as given. RFDeck today does not have to be right
up front: an SSC client that fails falls through to an MCP client, which is how a
G3 with a missing or placeholder model string is recognised at all.

That net is currently catching real cases. A receiver reporting itself as
`EWDX2CHDS` was classified as not-SSC until a fix this month, and a device added
with no model is stored as `"Sennheiser Device"` until it connects and says
otherwise — which it cannot do if it never connects.

So the migration has to include a decision for **"model unknown"**, and the honest
options are:

- keep the old clients as the path for unclassified devices, and use the core
  only once a model is known; or
- have RFDeck probe once to classify, then open a core session; or
- have the core accept `model: null` and identify the device itself.

The third is the best outcome and the most work for the core. The first is the
cheapest and is what I would do for the PoC.

### 3. EW-DX SSCv1 UDP is being removed, and nobody knows what depends on it

Change 8 drops the UDP telemetry receiver, the `/osc/` fallback and the
14-family path discovery. Those exist because of firmware variation nobody has
catalogued, and the rig is one rig.

`SSCClient` sets `udpDataActive` when UDP telemetry arrives, so **RFDeck can
answer this question without guessing**: log when that flag is set and which
resources arrive only that way. Worth doing before removal rather than after.

## Phases

### C.1 — Build the addon and prove it loads — **S**

Rust toolchain, `node scripts/build.mjs`, path dependency, `core.catalog()` from
a scratch script. Confirm it loads in the desktop sidecar as well as the server,
since those are different Node runtimes. No RFDeck code changes.

**Done when:** the catalogue prints from both runtimes.

### C.2 — The adapter — **M**

`hardware/core/CoreClient.ts` implementing `HardwareClient`: open on
`startPolling`, close on `stopPolling`, map events per the hand-off's table, and
map `state` patches into `DeviceStateTree`.

The mapping tables are the specification; they go in the adapter's tests, which
is where the ×20, the `af − 100` shift and the `"low"` → 10 conversions are
pinned. Those three are RFDeck's presentation and must produce exactly what they
produce today — a silent change there is a change to every dashboard.

**Done when:** the adapter passes a test suite built from the hand-off's tables,
with no device present.

### C.3 — Digital 6000 first — **S**

It has a simulator, no rig, no 53212 contention, and the fewest consumers. Run
`fakeDigital6000Device.ts` against the core to prove the adapter end to end
before a real device is involved.

**Done when:** the existing D6000 tests pass through the adapter.

### C.4 — EW-DX — **M**

Second because it is SSE over HTTPS, so it does not touch 53212 either. Gated on
risk 3 above being measured, and on the item A battery check, since the adapter
would otherwise be pinned to whichever behaviour is wrong.

Also: `setGain`, `setFrequency`, `identify` and `setNetwork` disappear for EW-DX.
The UI offers those. They must become visibly unavailable rather than silently
failing — which is what they do today, so this is an improvement to state
plainly rather than a regression to hide.

### C.5 — G3/G4 — **M**, blocked on risk 1

Last, and only once 53212 ownership is settled.

### C.6 — Retire the old clients — **S**

Only after all three have run on the rig through a show-length session. Protocol
tests move to the core's suite; the adapter keeps its own.

## What RFDeck should report back

- The item A and item E rig readings, which close two review items.
- Whether EW-DX UDP carries anything SSE does not (risk 3).
- Whether discovery and core sessions interfere on 53212, if option 3 is taken.
- The `af − 100` shift checked against the core's percentage, which the hand-off
  and my own answer to the units section both flag and neither has verified.
