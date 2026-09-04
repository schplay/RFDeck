# Manufacturer support: research and plan

What it would take to talk to each remaining wireless manufacturer, what
evidence exists for each, and the order worth doing them in.

Written before any of it is built, because the research changes the plan: two
of the brands the README lists as "planned" turn out to have no public control
protocol at all, and one manufacturer RFDeck already claims to support is not
actually supported.

## Method

Every entry below is judged on two things, and needs both to be worth starting:

1. **A primary specification** — the manufacturer's own control-protocol
   document. Without one, the implementation is reverse-engineering.
2. **An active open-source implementation**, ideally a Bitfocus Companion
   module. Not a substitute for the spec, but it catches the things a spec
   leaves out — and, as the Shure work showed, it catches the things a spec
   *contains* that were misread.

The Shure integration is the worked example of why both matter. Reading only
micboard produced five errors, including two unit conversions that were display
scaling mistaken for physics. Cross-checking against Shure's document and the
Companion module found all five. Neither source alone was sufficient.

**Confidence in this document is not uniform.** Each entry says what was
actually verified and what is inference.

## Summary

| Target | Protocol | Port | Spec | Open source | Effort | Verdict |
|---|---|---|---|---|---|---|
| **Shure SLX-D** | Command strings | 2202/TCP | ✅ Shure | ✅ Companion, Q-SYS | **S** | **Do first** |
| **Shure PSM1000** (IEM) | Command strings | 2202/TCP | ✅ Shure | ✅ Companion, micboard | **S–M** | **Do second** |
| **Sennheiser Digital 6000** | SSC over UDP | 6970 | ✅ Developer's Guide | ✅ Companion | **L** | **Do third** — corrects a false claim |
| **Wisycom MRK / MCR** | Ember+ | ~9000 *(unconfirmed)* | ⚠️ partial | ❌ none for receivers | **XL** | Research first |
| **Sennheiser Spectera** | SSC over HTTPS | 443 | ⚠️ partial | ✅ Companion (large) | **L** | Later |
| **Audio-Technica ESW** | Proprietary TCP | 17200 | ❓ | ✅ Companion | **M** | Different market |
| **Shure UHF-R** | Command strings over UDP | 2202/UDP | ❓ | ✅ micboard | **S** | Legacy, low value |
| **Lectrosonics DSQD / Venue2** | Undocumented | 4080/TCP | ❌ **not published** | ❌ none | — | **Blocked** |
| **Sony DWX** | Proprietary | — | ❌ **none public** | ❌ none | — | **Blocked** |
| **Beyerdynamic TG1000** | Unknown | — | ❓ | ❌ none | — | Unresearched |

---

## Corrections to what RFDeck currently claims

Two things in the README are wrong, and were found by this research rather than
by using the application.

### EM 6000 and EM 9046 are not supported

The hardware table says:

> **Sennheiser** (EW-DX, EM 6000, EM 9046 — firmware ≥ 4.0) | SSCv2 (HTTPS/JSON REST)

EW-DX is correct. The other two are not. Sennheiser's own documentation states
that **"the SSC Server implemented for EM 6000 supports only UDP/IP as
transport protocol"** — it is not the HTTPS/REST SSCv2 that `SSCClient` speaks.
The Companion module for Digital 6000 defaults to **UDP port 6970**;
`SSCClient` uses HTTPS on 443 plus SSCv1 JSON-over-UDP on port **45**, and has
no path that would ever reach a Digital 6000.

An EM 6000 added to RFDeck today will fail its SSCv2 probe, fall through to the
G3/G4 fallback, fail that too, and sit offline. The README must stop claiming
it until Digital 6000 support is built.

EM 9046 is the Digital 9000 series and is a separate protocol again; it has not
been researched.

### "Sony — HTTP/JSON APIs" is unfounded

The Phase 2 list says Sony's DWX series is reachable over "HTTP/JSON APIs".
Nothing found supports that. Sony's DWX receivers are controlled by their own
Wireless Studio software, and no third-party control protocol is published.
That entry should be marked as blocked rather than planned.

---

## Shure SLX-D — do first

**Why first.** It is the same protocol on the same port as receivers RFDeck
already supports, so it is a new entry in an existing table rather than a new
client. SLX-D is also the volume seller of the three Shure digital lines: far
more venues own SLX-D than Axient.

**What is known.** From the Companion module's `parseSLXSample` and its
parameter comments, corroborated by a Q-SYS plugin for the same receivers:

```
< SAMPLE n ALL audPeak audRms rfLevel >
```

- Three metered fields, all with the **−120 offset** — the same as Axient, not
  ULX-D's −128/−50.
- **No antenna field and no channel quality.** The sample is shorter than every
  other family's.
- Device parameters: `FW_VER`, `DEVICE_ID`, `RF_BAND`, `MODEL`, `LOCK_STATUS`
- Channel parameters: `CHAN_NAME`, `METER_RATE`, `AUDIO_GAIN`, `GROUP_CHAN`,
  `FREQUENCY`, `AUDIO_OUT_LVL_SWITCH`
- Transmitter parameters: `TX_TYPE`, `TX_BATT_BARS`, `TX_BATT_MINS` — the
  Axient names, not ULX-D's.

So SLX-D is a genuine third family: Axient's vocabulary and offsets, ULX-D's
brevity, and a sample layout shared with neither.

**A bug this creates in existing code.** `probe.ts` decides the family by
whether `MODEL` is answered at all — "only Axient has it". **SLX-D answers
`MODEL` too.** An SLX-D receiver discovered today would be identified as
Axient and then have its sample misparsed: `audPeak` read as channel quality,
`rfLevel` read as an antenna status string. The fix is to key on the model
*string* rather than its presence, which `identifyModel()` already does — the
fallback `model ? 'axtd' : 'ulxd'` is the part that is wrong.

That fallback is wrong *today*, before any SLX-D work, for any Axient model
this build does not recognise. Worth fixing regardless.

**Still to do before building.** Fetch Shure's SLX-D command-strings document
the same way the Axient and ULX-D ones were fetched (their CDN serves them to a
browser user-agent). Everything above is from two implementations, not from
Shure.

**Effort: S.** A family entry, a sample-parser branch, a model table addition,
a probe fix, and tests. No new transport, no new client.

---

## Shure PSM1000 — do second

**Why.** RFDeck already models IEMs as first-class: performers have a mic and
an IEM, `deviceType` distinguishes input from output, and the Micboard shows an
IEM badge. What it cannot do is *talk* to an IEM transmitter. PSM1000 is the
common one.

**What is known.** The Companion module and micboard's `p10t` profile agree:
same `< ... >` framing, **same port 2202**, same `METER_RATE` subscription. Two
channels. Differences from a receiver:

- `< GET DEVICE_NAME >` rather than `DEVICE_ID`
- Audio is an **input** level per side: `AUDIO_IN_LVL_L`, `AUDIO_IN_LVL_R`
- Transmitter concerns instead of receiver ones: `TX_MODE` (mono / stereo /
  point-to-point), `TX_POWER` (10/50/100 mW), `AUDIO_MUTE`
- No battery, no antenna, no RF level — it transmits, so there is nothing to
  receive. **This is the interesting part for RFDeck**, because the
  `ReceiverState` contract assumes RF and battery exist.
- Companion terminates commands with `\r\n` after the `>`, which the receiver
  modules do not. Harmless either way, but worth matching.

**The design question this raises.** An IEM transmitter has no `rf_quality` and
no `battery`, and RFDeck's dashboard, RF dropout detection and battery
projection all assume a channel has both. Today an IEM would appear as a
channel permanently at 0% RF — indistinguishable from a dead link, and it would
raise dropout alerts forever.

That is not a Shure problem; it is a gap in RFDeck's channel model that
building this would force into the open. `deviceType: 'output'` exists but
nothing downstream honours it. **This work should start there**, not with the
protocol.

**Effort: S for the protocol, M for the model change.** The model change is the
real work and benefits every future IEM.

---

## Sennheiser Digital 6000 — do third

**Why.** It is in daily use in exactly RFDeck's market — theatre and broadcast
— and the README already claims it works. Closing a false claim is worth more
than adding a new brand.

**What is known.**

- SSC (Sennheiser Sound Control) over **UDP**, not HTTPS. Sennheiser's
  documentation is explicit that the EM 6000's SSC server is UDP-only.
- The Companion module defaults to **port 6970**, and models EM 6000, EM 6000
  Dante, and L 6000 (the charger).
- It is a subscription protocol: the module's constants declare subscription
  lifetime 20 s, count 1000, interval 50–10000 ms — so a client subscribes and
  renews rather than polling.
- The address tree is SSC's — `osc/state/subscribe`, `osc/feature/...` — which
  is the same *shape* as the SSCv1 JSON that `SSCClient` already sends to port
  45 for EW-DX telemetry.

**Why this is L and not M.** The existing `SSCClient` is built around an HTTPS
probe chain with a UDP telemetry sidecar. Digital 6000 is UDP-primary with a
subscription lifecycle that must be renewed. That is a different client, even
though it shares a message format — and it should be a separate class rather
than a fourth mode bolted onto a 1244-line file that already handles three.

**Still to do before building.** Obtain Sennheiser's "Developer's Guide for
Digital 6000 devices", referenced in their documentation portal. The Companion
module alone is not enough for a subscription protocol, where getting the
renewal wrong means telemetry that works for twenty seconds.

---

## Wisycom — research before planning

**What was found.** The MRK980 and MCR54 receivers control over Ethernet using
**Ember+**, per Wisycom's own product material — the MRK980 "detects sub-tones
and informs the mixer via the Ctrl1 Ethernet port with Ember+ protocol", and
its firmware has an Ember+ enable setting.

**What was not found.** The port, the Ember+ tree layout, or any open-source
implementation for the receivers. The only Wisycom Companion module is
`companion-module-wisycom-mat`, and **MAT244/MAT288 are antenna matrices, not
receivers** — TCP 2101, a binary protocol with its own framing. Useful as
evidence Wisycom publishes enough to implement against, and a good reference if
RFDeck ever models antenna distribution, but not a route to receiver telemetry.

**Why this is XL.** Ember+ is a full protocol with its own encoding (BER/S101
framing, a Glow object model) — not a line-based ASCII protocol like everything
RFDeck currently speaks. It means a dependency or an implementation, plus
discovering the tree layout Wisycom exposes. That is a different order of work
from adding a family to an existing client.

**Next step:** ask Wisycom for the Ember+ tree documentation, or capture it from
a device with an Ember+ browser. Not startable from public sources alone.

---

## Sennheiser Spectera — later

Sennheiser's new wideband bidirectional system. There is an active Companion
module and it is substantial (a 58 KB API file, 68 KB of presets), using
`undici` for HTTP — so **HTTPS REST**, closer to the SSCv2 that `SSCClient`
already speaks than Digital 6000 is.

Deferred not because it is hard but because almost nobody has one yet. Revisit
when a user asks.

---

## Audio-Technica ESW — different market

`companion-module-audiotechnica-esw` targets the ESW R4180DAN over **TCP port
17200**. The actions it exposes — channel mute, volume, HPF, preset recall,
transmitter mic gain and polar pattern — describe an installed conference
system rather than a live production rig.

Worth doing if a user asks. It is not what RFDeck is aimed at, and the effort
would be a whole new client for a market segment the rest of the application
does not serve.

---

## Shure UHF-R — legacy, low value

micboard supports it, so the protocol is known: the same command strings but
over **UDP** on 2202, with `*` delimiters instead of `< >`, and different
parameter names (`TX_BAT`, `CHAN_NAME`, `GROUP_CHAN`). Battery is a raw value
rather than bars; RF converts as `100 × (100 − raw) / 80`; audio is derived
from the most significant bit of a bitmap.

Discontinued in 2019. Only worth building if someone with a rack of them asks.

---

## Blocked: no public protocol

These cannot be started responsibly, and the README should say so rather than
listing them as planned.

### Lectrosonics (DSQD, Venue2, DCHR)

Lectrosonics documents the *port* — TCP 4080 primary, 4081 secondary, in the
DSQD web help — and nothing else. Their own page says "the network interface
for DSQD serial control is configured here" and never documents the serial
protocol. No specification, no Companion module (the one Lectrosonics module,
`lectrosonics-aspen`, is for their Aspen DSP line, not wireless), no other
open-source implementation found.

The README's "via middleware bridge" was an honest read of this situation.

**Next step:** ask Lectrosonics for the serial control specification. They have
historically shared protocol documents for their DSP products on request, so
this is plausibly a request away rather than a reverse-engineering job.

### Sony DWX

No published third-party control protocol. Sony's own Wireless Studio software
is the only documented route. Nothing to build against.

### Beyerdynamic TG1000

Not researched — no Companion module and nothing surfaced in a first pass.
Lowest priority of everything here.

---

## Recommended order

1. **Fix the SLX-D-shaped bug in `probe.ts` now** — the `model ? 'axtd'`
   fallback is already wrong for any unrecognised Axient model, and will
   silently misparse SLX-D the moment it is added.
2. **Shure SLX-D.** Small, high install base, extends existing code.
3. **Make RFDeck's channel model honest about IEMs**, then **Shure PSM1000**.
   The model change is the valuable half.
4. **Sennheiser Digital 6000**, and correct the README's claim either way —
   immediately, not when the work lands.
5. **Wisycom**, once the Ember+ tree is documented.
6. Spectera, Audio-Technica, UHF-R on request.
7. Lectrosonics and Sony stay blocked until a vendor publishes something.

## What none of this can do without hardware

Every integration here would land in the same state Shure did: written against
a specification, cross-checked against open source, tested against a simulated
device that believes the same specification. That catches framing, lifecycle
and unit errors. It cannot catch a misread specification, because the simulator
misreads it identically.

The simulated-device pattern from `fakeShureDevice.ts` should be repeated for
each, and each brand should carry the same honest "not verified on hardware"
marking in the README until someone runs it against a real receiver.
