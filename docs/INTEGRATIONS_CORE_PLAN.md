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

## Three risks — raised as K, L and M, and all three answered

Raised with the core in `INTEGRATIONS_CORE_REVIEW.md`, which is canonical. All
three came back on 2026-09-29 and two of them changed this plan:

| | Outcome |
|---|---|
| **K** — 53212 | The core agreed the split was unenforceable and **took the whole port, discovery included**. `McpBus` and the MCP half of `DiscoveryService` are deleted in the same change that migrates G3/G4. Socket-policy faults become reported events rather than silent symptoms |
| **L** — model identification | **Option 3 is in scope** — the core will identify devices itself, shipping with discovery. For the proof of concept RFDeck takes option 1: old clients keep unclassified devices. Note their finding that **G3 and G4 cannot be told apart over MCP**, so the operator's choice stands |
| **M** — EW-DX UDP | Agreed it is RFDeck's to measure, and change 8 stands only if the measurement supports it. They will add an SSCv1 UDP mode either way, from the document |

What that changes here: **C.5 is no longer "blocked", it is bigger.** G3/G4 now
moves together with MCP discovery, and `McpBus` goes with it — the socket whose
behaviour cost most of this month is handed over whole rather than shared. That
is the right call and it is also the riskiest single step in the migration, so it
goes last and gets a show-length session before the old code is deleted.

### 1. Port 53212 — settled: the core takes it

The hand-off's arrangement could not be implemented by either side, and the core
agreed. It now owns 53212 outright, including the broadcast probe, the paced
unicast sweep over ranges RFDeck supplies, and the passive listener.

RFDeck's concern was that the fault classes this socket produced would become
harder to see across an FFI boundary. Their answer is that buffer sizes granted,
datagrams dropped on a full queue and probes deferred for pacing all become
reported events. **That is a better position than RFDeck is in today** — those
three facts were exactly what was missing while they were being diagnosed here,
and each had to be inferred.

What RFDeck keeps: Bonjour, the HTTPS sweep, and the decision about which address
ranges are worth sweeping. What RFDeck loses: `McpBus`, and with it the buffer
sizing and pacing added this month. Those lessons need to arrive in the core as
tests, not as prose — see "What RFDeck should report back".

### 2. Model identification — settled: the core will do it, later

For the proof of concept RFDeck keeps the old clients as the path for
unclassified devices, and opens a core session only when the model is known. That
preserves the fallback exactly as it is today, so nothing regresses while the
core's identification is built.

One thing from their answer that RFDeck should act on independently: **G3 and G4
cannot be distinguished over MCP.** RFDeck's `isLegacyMcpModel` treats them as one
family already, which is right, but anywhere the UI claims to know which
generation a device is, it is claiming more than the protocol supports.

### 3. EW-DX SSCv1 UDP — measurement built, waiting on the rig

`SSCClient` now records which telemetry fields arrived over SSE and which over
SSCv1 UDP, and reports the difference once, sixty seconds after the first
telemetry of either kind. At `info`, so a deployed server prints it.

It states the conclusion rather than leaving two lists to compare:

- fields that arrived **only** over UDP are named in a `warn`, because those are
  what change 8 would lose;
- a device served entirely by UDP, where SSE never delivered, gets its own `warn`.

**To collect it:** bring the rig up with EW-DX receivers connected and, a couple
of minutes later:

```bash
sudo journalctl -u rfdeck --since "-5 min" --no-pager | grep "transport survey"
```

One line per EW-DX. Paste them into item M and the core can act on them.

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

### C.5 — G3/G4 and MCP discovery together — **L**

No longer merely last: this is now the largest step. The core takes 53212,
`McpBus` is deleted, and the MCP half of `DiscoveryService` — the broadcast probe,
the paced sweep and the passive listener — goes with it. RFDeck keeps Bonjour and
the HTTPS sweep, and supplies the address ranges to sweep.

Everything learned about that socket this month has to arrive in the core as
tests rather than as advice: the buffer sizing, the send pacing, the ordering that
keeps a sweep from starving telemetry, and a device being reported offline because
another was found. RFDeck's `g3g4Lifecycle.test.ts` is the shape of what should
move — a sequence through connect, loss, backoff, recovery and loss again, since
every fault in that file lived in a transition.

Needs a show-length session on the rig before C.6 deletes anything.

### C.6 — Retire the old clients — **S**

Only after all three have run on the rig through a show-length session. Protocol
tests move to the core's suite; the adapter keeps its own.

## What RFDeck should report back

- The item A and item E rig readings, which close two review items.
- The transport survey lines, which close item M.
- The `af − 100` shift checked against the core's percentage, which the hand-off
  and RFDeck's answer to the units section both flag and neither has verified.
- **The 53212 lessons, as tests rather than prose.** The core is taking that
  socket on the strength of having read about its faults. Buffer sizing, send
  pacing, sweep-versus-telemetry ordering and the transition coverage in
  `g3g4Lifecycle.test.ts` are the four that cost real deploys here, and a
  paragraph describing them is not the same as a test that fails without them.
  **Raised as item N**, with each of the four stated and the reason it is
  invisible in review.

Two of RFDeck's own faults are recorded there as well, because the core is about
to own the same code and neither is a wrong reading:

- **Item O** — a refused password was presented up to twenty times a second,
  indefinitely, because the probe walks five candidate URLs on a 250 ms tick. It
  made an EW-DX need re-adopting in Control Cockpit, which cannot be done
  remotely. Now backed off to once a minute with a single `auth-failed`.
- **Item P** — a G3/G4 off-link has no readable MAC, ever: the neighbour table
  holds directly-attached addresses only. RFDeck had gated its name fallback on
  having one, so on a routed rig nothing could be recognised. Whatever identity
  scheme the core ships for this family cannot depend on a MAC.
