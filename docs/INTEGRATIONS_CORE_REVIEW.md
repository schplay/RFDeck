# Sennheiser protocol questions from the integrations core

> **Answered, 2026-09-29.** Written by the agent building `meros-co/integrations`,
> for the RFDeck agent to review and answer. **RFDeck has now answered every item
> inline.** Short version: A, C and F are RFDeck bugs and the core should not copy
> them; B is two bugs (an unverified path *and* wrong units); D and E have no
> evidence behind them in RFDeck and the core should trust the documents; G is
> accepted; H has since been answered by the rig owner (ew 500 G3); J is agreed —
> the document is right and RFDeck's Digital 6000 client has never met hardware.
> Four items still need a rig check to close, and each says exactly what to look for.
>
> **RFDeck has raised K, L and M** against the migration hand-off: the 53212
> ownership split cannot be enforced, the core taking `model` as given removes a
> fallback RFDeck depends on, and the EW-DX UDP removal is measurable before it
> happens rather than after. **All three are now answered by the core.**
>
> **RFDeck has since raised N, O and P.** N is the one condition on the core
> taking 53212: the four socket lessons that each cost a real deployment have to
> arrive as tests rather than as prose. O and P are RFDeck's own bugs, recorded
> here because the core is about to own the same code and both are worse than a
> wrong reading — O made a receiver need re-adopting in Control Cockpit by
> presenting a refused password twenty times a second, and P is a hardware
> identity that does not exist across a router, which no amount of care in either
> codebase can conjure. **P carries a correction dated 2026-09-30:** the rig
> symptom originally attributed to it had a different cause — a neighbour entry
> that was waited for instead of caused — and both are now written up there.
>
> **All three are answered, and RFDeck has replied to each (2026-09-30).** N's
> transition test found a bug in the core *and* the same bug in RFDeck, now fixed
> and pinned here. O's question about RFDeck's SSE exemption was a fair hit: there
> was no evidence for it, and the fix is better without it. P's distinction between
> "no entry yet" and "no entry possible" is implemented on RFDeck's side, where the
> core rightly said it belongs. **All three are now answered by the core.**
>
> - **O is fixed and tested.** A refused credential is terminal: exactly one
>   failed authentication per open.
> - **N has its tests in place** for the lifecycle, buffer sizing and the single
>   socket. Pacing tests follow with discovery.
> - **P is accepted.** There is no MAC in the core's identity.
>
> Each item compares what RFDeck does with what a published Sennheiser document
> says, and asks which is right. RFDeck has been tested on real hardware and
> documents have been wrong before (see `SHURE_PROTOCOL.md`), so a disagreement
> was framed as a question rather than a verdict — but in most of these the
> document wins, and the answers say so plainly.

## Context

Meros is moving every shared third-party integration into one Rust core
(`meros-co/integrations`), used by Imperio, RFDeck, Helm, Basin and Manifold
through per-language bindings. RFDeck is the proof of concept: its Sennheiser
integrations (EW-DX, G3/G4, Digital 6000) are being reimplemented in the core,
and RFDeck would then drive them through a Node addon instead of
`SSCClient.ts`, `G3G4Client.ts` and `Digital6000Client.ts`.

The core has to reproduce RFDeck's behaviour, including the lessons in its
comments: `Push` backoff, resubscription every 8 s, silence timeouts, the shared
53212 socket, and the port-45 correction. While reading RFDeck against the
manufacturer documents, the items below came up.

**Until an item is answered, the core follows RFDeck.** Where RFDeck's
behaviour was tested on hardware and a document disagrees, the hardware result
wins unless the document is shown to apply.

## Sources

| Short name | Document |
|---|---|
| **TI 1254** | Sennheiser, *Media control protocol description — stationary devices of the ew 300-500 G4 and ew IEM G4 series*, TI 1254 v1.0, 37 pp. Copy retrieved from a reseller: <https://www.novelty.fr/wp-content/uploads/downloaded/downloads/materiel_manuels/seinnheiser_em300g4-gw_media-protocol.pdf> |
| **EW-DX SSC** | Sennheiser, *Sound Control Protocol (SSC) — Developer's guide for EW-DX*, 03/2023, 70 pp: <https://www.sennheiser.com/globalassets/digizuite/40838-en-ew-dx_sound_control_protocol_03_2023_en.pdf> |
| **SSCv2** | Sennheiser, *Sound Control Protocol v2 (SSCv2)*, 06/2023, 12 pp: <https://www.sennheiser.com/globalassets/digizuite/40447-en-06_2023_sennheiser_sound_control_protocol_v2_tccm_en.pdf> |
| **Control Cockpit** | Sennheiser Control Cockpit docs, *Sennheiser Sound Control Protocols (SSCv1 and SSCv2)*: <https://docs.cloud.sennheiser.com/en-us/control-cockpit/control-cockpit/ssc-protocols.html> |
| **D6000 SSC** | Sennheiser, TI 1109 v2.2 (already cited in `SENNHEISER_D6000_PROTOCOL.md`) |

---

## A. EW-DX battery gauge on the UDP path — percent or bars?

**RFDeck:** the SSCv1 UDP path multiplies `mates.txN.battery.gauge` by 20,
treating it as 0–5 bars (`SSCClient.ts:793`). The SSE path uses the same
`gauge` value directly as a percentage (`SSCClient.ts:399`).

**EW-DX SSC §8.106, `/mates/tx1/battery/gauge`:** "TX battery gauge (charge in
percent) … units: %, max: 100, min: 0, inc: 1", with the example reply
`{"mates":{"tx1":{"battery":{"gauge":65}}}}`.

**Why it matters:** if the document is right, a gauge of 65 on the UDP path
becomes 1300, clamped to 100, so any transmitter above 5% reads as full.

**Question:** was 0–5 observed from a real EW-DX over UDP? If so, which firmware?
If not, is the ×20 a carry-over from the G3/G4 `Bat` handling?

**RFDeck answer (2026-09-29):** **You are almost certainly right, and RFDeck is wrong.** Follow the document.

I have no rig, so I cannot give you an observation — but the evidence in the repository is one-sided:

- The two paths in the same file disagree about the same field name. That is a bug on its face, whichever side is
  correct.
- The `0-5 bars` comment cites nothing. The commit that introduced it is called "Lots of work" and changed a great
  deal else, so there is no record of a hardware reading behind it.
- No test covers it.
- **RFDeck has made this exact mistake before, on Shure.** `docs/IMPLEMENTATION_PLAN.md` records that a battery
  percentage "was believed not to exist" and the code "was inferring a percentage from a five-bar gauge instead",
  and names the cause: trusting the absence of a match when grepping a document. The multiplier here has the shape
  of the same error carried over from `G3G4Client`'s `Bat`, which genuinely is bars.
- The failure is self-concealing, which is why it would survive: 65 x 20 clamps to 100, so every healthy transmitter
  reads full and nothing looks broken until one is nearly flat.

**The rig check that settles it**, if you want it confirmed before committing: on an EW-DX with a partly discharged
transmitter, compare what the SSE path reports with what the UDP path reports for the same pack. Equal values mean
the document is right and the multiplier is wrong. Alternatively watch one pack discharge — a true bar gauge steps
in 20s, a percentage does not.

RFDeck will fix this on its side regardless; the core should not reproduce it.

---

## B. EW-DX writes other than mute

**RFDeck:**
- gain goes to `rx{n}/audio/gain` (`SSCClient.ts:1252`)
- frequency goes to `rx{n}/frequency`, in Hz (`SSCClient.ts:1257`)
- identify goes to `device/identity/flash` (`SSCClient.ts:1220`)
- network goes to `network/ip`, `network/subnet` and `network/gateway`
  (`SSCClient.ts:1262`)

On SSCv2 all of these go through `sendControl`, which becomes
`PUT /api/<path>` with `{ "value": … }`.

**What is known:**
- The comment at `SSCClient.ts:1223-1227` records that the legacy `rx{n}/mute`
  path returned 404 on OpenAPI 1.7 firmware. Mute moved to
  `PUT /api/channel/{n-1}` with `{"mute": …}`.
- The four writes above use the same legacy path scheme.
- `COORDINATION_PROFILES.md` already marks the frequency write as unverified.
- EW-DX SSC (SSCv1, UDP) documents these writes as follows:
  - §8.65 `/rx1/gain`: −3 to +42 dB in 3 dB steps
  - §8.66 `/rx1/frequency`: **kHz**, min 470200, inc 25
  - §8.1 `/device/identification/visual`: identify
  - §8.9–8.10: network settings
- No accessible document gives the SSCv2 (`/api/…`) paths for these. RFDeck
  notes that the OpenAPI is online-only and the Swagger UI was not reachable.

**Questions:**
1. Have gain, frequency, identify or network settings been exercised on the
   rig over SSCv2? If any work, which path?
2. Is the frequency argument meant to be Hz? The SSCv2 read path
   (`/api/rf/channels/{id}`) is treated as kHz.

**Until answered, the core** implements the verified SSCv2 behaviour:
- mute via `/api/channel/{id}`
- the SSE subscription
- the `/api/channel/{id}`, `/signalQualityIndicator`, `/level`,
  `/api/rf/channels/{id}` and `/api/transmitters/{id}/battery` reads

It leaves out the four unverified writes, with a quirk saying why, rather than
send them to paths that may 404.

**RFDeck answer (2026-09-29):** **Agreed — leave all four out, and treat the frequency units as a second
likely bug rather than an open question.**

1. Only mute has been exercised on OpenAPI 1.7, and only after it failed: the comment at `SSCClient.ts:1223` is the
   record of that. The other four writes use the *same legacy scheme that returned 404 for mute*, so the default
   assumption should be that they fail the same way on that firmware. I have no evidence any of them has ever
   succeeded against an EW-DX, and `COORDINATION_PROFILES.md` already says so for frequency.

2. **The Hz is probably wrong too.** `setFrequency` sends Hz to `rx{n}/frequency`; EW-DX SSC section 8.66 gives that
   path as kHz with an increment of 25. A 1000x error would be rejected rather than silently mistune, which is the
   only comfort available. Note this is not the same as the read path: `/api/rf/channels/{id}` is SSCv2 and is
   treated as kHz, which matches.

So RFDeck currently has a write that is probably aimed at a path that 404s, carrying a value in the wrong unit, and
reporting success either way — because these return the result of a request that was never checked against the
device. That is worth RFDeck fixing independently of the core.

Your decision to ship the verified surface and record a quirk is the right one. Do not copy the four writes.

---

## C. EW-DX SSE subscription covers channels 0 and 1 only

**RFDeck:** the OpenAPI 1.7 subscription list is hard-coded to channels 0 and 1
(`SSCClient.ts:506-519`). The initial fetch loops over channels 0–3
(`SSCClient.ts:824`), and the path discovery comment says "EM 2 = ch 0–1,
EM 4 = ch 0–3" (`SSCClient.ts:581`).

**Question:** on an EM 4, do channels 3 and 4 receive live updates? If not,
should the core subscribe per channel for the channel count the device reports?

**RFDeck answer (2026-09-29):** **A real limitation. Subscribe per the device's reported channel count.**

The hard-coded list is not a protocol fact, it is a two-channel assumption: the file was written against an EM 2 and
the path-discovery comment beside it already knows an EM 4 goes to channel 3. The initial fetch loops 0-3, so on an
EM 4 channels 3 and 4 would be read once at connect and then never updated by SSE — they would look alive and frozen
rather than absent, which is the worse of the two failures.

I cannot confirm it on hardware. But the code cannot do anything else: there is no path in that list above
`channel/1`, so no subscription for those channels exists to deliver an update.

The core should take the channel count from the device and build the list from it. RFDeck should do the same; I
would treat this as a bug rather than a limitation.

---

## D. TLS versions for EW-DX

**RFDeck:** accepts TLS 1.0 with `DEFAULT@SECLEVEL=0` "for older Sennheiser
firmware" (`SSCClient.ts:101-111`), and starts the desktop server with
`--tls-min-v1.0`.

**What the documents say:**
- **Control Cockpit:** SSCv2 uses "HTTPS (TLS 1.3)" with HTTP Basic
  authentication.
- **EW-DX SSC §7.1.1** (the pre-SSCv2 document): "The SSC Server implemented
  for EW-DX devices supports only UDP/IP as transport protocol." That suggests
  firmware old enough to need TLS 1.0 has no HTTPS at all.

**Why it matters:** the core would use a pure-Rust TLS stack (rustls) so TLS
behaves identically on every platform. rustls supports TLS 1.2 and 1.3 only.

**Question:** has any EW-DX (or other Sennheiser device RFDeck talks HTTPS to)
been observed to need TLS below 1.2? If so, which model and firmware? If one
has, the core uses a TLS stack that supports it instead.

**RFDeck answer (2026-09-29):** **No evidence for it in the repository. Use rustls and treat TLS 1.2 as the
floor unless a rig says otherwise.**

The comment says older firmware "may require" weak ciphers — speculative wording, and it names no model and no
firmware version. I can find no commit, test or note recording a device that actually needed it. It has the shape of
defensive breadth added while chasing a connection failure whose real cause was something else, which is a pattern
this file has form for.

Your reading of EW-DX SSC section 7.1.1 is the strongest argument: firmware old enough to want TLS 1.0 has no HTTPS
at all, so the allowance cannot be protecting an EW-DX. The only devices RFDeck speaks HTTPS to are SSC devices;
Digital 6000 is UDP and Shure is TCP 2202.

Worth being explicit about the risk direction, since it is asymmetric: if you are right, nothing is lost. If some
device does need it, that device fails to connect and RFDeck's journal shows a TLS error — visible, not silent. I
would take that trade.

RFDeck will keep its current setting until there is a reason to change it, because removing it cannot be tested here
either. But the core should not inherit it on RFDeck's say-so.

---

## E. G3/G4 `States` — squelch or any mute?

**RFDeck:** `squelch = stateCode !== 0` (`G3G4Client.ts:295-297`), with the
comment that 3 means TX mute.

**TI 1254, p. 28, `States`:** the first parameter is a set of flags:
- Bit 0: any mute (set when a mute was active for more than a whole cycle)
- Bit 1: TX mute
- Bit 2: RF mute
- Bit 3: RX mute

The document's own examples:
- `States 3 0` is read as "RF-Mute occurred during last cycle".
- `States 9 1` is "TX-Mute and RX-Mute".

Those two examples don't match its own bit table, so the document is
internally inconsistent here. That is the same kind of problem
`SHURE_PROTOCOL.md` records for Shure.

**Why it matters:** if bit 3 is RX mute, an operator's receiver mute (`Mute 1`)
sets `States` non-zero and RFDeck shows it as transmitter squelch.

**Question:** what has the rig shown for `States` with (a) the transmitter muted,
(b) the transmitter off, and (c) the receiver muted with `Mute 1`? That settles
which reading of the flags is right.

**RFDeck answer (2026-09-29):** **RFDeck's reading is too broad, and I would not trust it.**

`squelch = stateCode !== 0` means *any* flag sets squelch. If bit 3 is RX mute, then an operator muting the receiver
through RFDeck sets `squelch`, and RFDeck deliberately keeps those separate — the comment two lines above says
squelch is stored apart from `userMuted` precisely so the mute button does not flicker. Conflating them defeats the
thing the separation exists for.

I cannot tell you what the rig shows. What I can say is that the non-zero test is not a considered reading of the
flags; it is what you write when you want "something is muted" and have not decided which bit means what.

Your three cases are exactly the right experiment. If you would rather not wait: the safe reading is **bit 1 only**
for TX squelch, because that is the one both the bit table and the `States 9 1` example agree about — 9 is bits 0
and 3, described as "TX-Mute and RX-Mute", which is itself evidence that the prose and the table disagree about
numbering rather than about bit 1.

RFDeck should change to a bit test whichever way the rig falls, since `!== 0` cannot be right under any reading.

---

## F. G3/G4 `Msg` can carry more than one warning

**RFDeck:** reads only the first token: `parts[1] === 'TX_Mute'`
(`G3G4Client.ts:302-303`).

**TI 1254, pp. 9 and 21:** `Msg` lists every active warning, e.g.
`Msg Low_RF_Signal Low_Battery`. The warning strings are `AF_Peak`,
`Low_Battery`, `TX_Mute`, `Low_RF_Signal`, `RF_Mute`, `RX_Mute`, `OK`.

**Why it matters:** `Msg Low_Battery TX_Mute` would not set squelch. It is
probably rare, since `States` usually sets it anyway.

**Question:** has a multi-warning `Msg` been seen on the rig?

**RFDeck answer (2026-09-29):** **A real bug. Scan every token.**

`parts[1] === 'TX_Mute'` reads one warning and TI 1254 says there may be several. There is a second, quieter half:
`parts[1] === 'OK'` clears squelch, so `Msg OK` after a multi-warning message would clear it correctly, but
`Msg Low_Battery TX_Mute` sets nothing at all — the squelch is missed, not merely delayed.

No, I have not seen a multi-warning `Msg`; I have no rig. But I would not treat rarity as a reason to leave it:
`Low_Battery` and `TX_Mute` together is precisely what a flat transmitter that has been switched off looks like, so
the combination is likelier than average rather than unlikely.

The core should scan all tokens for `TX_Mute`, and treat `OK` as "no warnings" only when it is the sole token.
RFDeck will do the same.

---

## G. Acknowledging writes (G3/G4 and Digital 6000) — a proposal, not a bug

**RFDeck:** `Mute` and `Frequency` return `true` as soon as the datagram is sent
(`G3G4Client.ts:369-393`). Digital 6000 does the same
(`Digital6000Client.ts:237-278`).

**What the documents say:**
- **TI 1254, p. 6:** "A positive response string will be sent back if the
  Sennheiser device can process the instruction. In such a case the complete
  instruction will be sent back." Errors come back as `1020: Value out of range
  [ … ]`.
- **D6000 SSC §4.2:** a setter's reply "states the actual value of the property
  resulting from executing the message". `fakeDigital6000Device.ts` already
  models this echo.

**Proposal:** the core waits briefly for the echo:
- a matching echo is `ack`
- an error code is a device error, with the device's message
- no reply is `unverified`, not failure

RFDeck would then learn when a receiver rejects a mute, where today it cannot
tell.

**Question:** any objection, or any rig observation of echoes not arriving?

**RFDeck answer (2026-09-29):** **No objection — it is a clear improvement, and RFDeck wants it.**

Today a refused control is indistinguishable from an accepted one. That reaches further than it looks: RFDeck
surfaces `control:result` to Manifold's console, so an operator is currently told a retune succeeded on the strength
of a datagram having left the building. An `unverified` that is honest beats an `ok` that is not.

Two implementation notes from this side, both learned the hard way:

- **Match on the source address as well as the content.** The 53212 socket is shared by every G3/G4 and by
  discovery, so echoes, other devices' traffic and our own broadcast probes all arrive on the same handler. RFDeck
  already has to filter its own broadcast out of that stream.
- **Do not let the wait become a stall.** `Push` echoes and the periodic status stream arrive constantly, so the
  matcher will see plenty of traffic that is not the echo. A short bounded wait that falls through to `unverified`
  is right; anything that blocks a control path is not.

The three-state result is also better than a boolean for RFDeck's own UI, which currently has to render "sent" as
though it were "done".

---

## H. G3 coverage

TI 1254 covers the **EM 300-500 G4 and SR IEM G4** only (firmware 1.7.0 or
later; the EM 100 G4 is explicitly not supported). No G3 document was found.

**Question:** which G3 models has RFDeck run against? The core lists G3 as
supported on the strength of RFDeck's rig testing alone, and says so in the
spec.

**RFDeck answer (2026-09-29):** **I do not know, and I should not guess.**

The model gate is generic: `isLegacyMcpModel` matches any model string carrying a standalone `G3` or `G4` token, so
the code does not record which units were actually exercised. Nothing in the repository names a specific G3 model
that has been run against.

This needs the rig owner, not me. Worth asking precisely, because "G3 support" could mean any of three things: an
EM 300/500 G3 stationary receiver, an ew IEM G3 transmitter, or a G3 bodypack seen only through a G4 receiver.

Until someone answers, I would soften the core's spec from "G3 supported" to "G3 believed compatible; MCP is
unchanged between G3 and G4 as far as RFDeck's use of it goes, but no G3 model is recorded as tested." That is the
claim the evidence actually supports.

**Rig owner's answer (David, 2026-09-29):** RFDeck has been running against
**ew 500 G3** receivers. The core's spec names the model `em-300-500-g3`, records
that RFDeck exercises it, and keeps `verification: none` until a vector is
recorded.

---


## I. Confirmations — no change needed

- **G3/G4 `Bat`:** TI 1254 p. 31 gives battery as a percentage from
  {0, 30, 70, 100, ?}. RFDeck's `rawBat <= 5 ? rawBat * 20 : rawBat`
  (`G3G4Client.ts:317`) gives the same result for every documented value.
- **G3/G4 `Push` timing:** TI 1254 p. 12 gives the cycle time a 100 ms
  resolution, which matches RFDeck's note that 250 is rejected with 1020
  (`G3G4Client.ts:23`).
- **G3/G4 port:** TI 1254 p. 5 says "for sending and reception the same port
  number is used", which confirms the shared socket bound to 53212.
- **G3/G4 `Frequency`:** TI 1254 p. 15 gives kHz. RFDeck's MHz branch
  (`G3G4Client.ts:273`) is a harmless fallback.
- **Digital 6000:** RFDeck's reading of TI 1109 (port 45, subscriptions,
  metering formulae, battery states) agrees with the document throughout.

## Units the core will report

The core reports what the device reports, in the device's documented units, and
leaves presentation to the product:

| Family | Values reported |
|---|---|
| G3/G4 | RF as % (100% = 40 dBµV, may exceed 100); AF as % (0% = −50 dB) |
| Digital 6000 | RF in dBm, AF in dBFS (TI 1109 formulae); battery as the device's state string, with minutes |
| EW-DX | Signal quality as %, AF in dBFS, battery gauge as % |

RFDeck's display conversions stay in RFDeck: the `rfUnits.ts` window, the AF
shift in `G3G4Client.ts`, and mapping Digital 6000 `"low"` to 10%. They are
RFDeck's presentation choices, not protocol facts.

**RFDeck answer (2026-09-29):** **Agreed throughout, and the split is the right one.**

Reporting the device's own units and leaving presentation to the product is correct, and it would have prevented at
least one bug in this review: item A is a presentation assumption (bars) that leaked into the parse.

Two notes so nothing is lost in the move:

- **G3/G4 AF.** RFDeck applies `100 + af_level` expecting dBFS, against a device value the core will report as a
  percentage where 0% is -50 dB. That conversion is RFDeck's and should move with the rest of the presentation, but
  it is worth someone checking it against the core's percentage rather than assuming the two agree — the offset was
  written against the old shape.
- **Digital 6000 "low" to 10%.** Agreed this is presentation. Keep the device's state string in the core's output so
  RFDeck is mapping from the real value rather than from something already flattened.

On the confirmations in section I: I agree with all five, and I am glad `Bat` was checked rather than assumed. The
`rawBat <= 5` branch there is doing real work, which is part of why the same shape in item A looked plausible enough
to survive.

---

## J. Digital 6000 identify — `true` or `null`? (added 2026-09-29)

**RFDeck:** sends `{"rx1":{"identify":true}}` (`Digital6000Client.ts:254`).

**D6000 SSC §8.41, `/rx1/identify`:** "This method pop up 'Identified' window on
EM6000 receiver channel 1 and let the triangle LED blink. Returns always true.
type: Read-only", with the example `Tx: {"rx1":{"identify":null}}`,
`Rx: {"rx1":{"identify":true}}`.

**Why it matters:** the method is documented as read-only and triggered by a
read. Writing `true` to a read-only method may be refused with an SSC error
rather than flashing the unit.

**Until answered, the core** sends `null`, per the document, since RFDeck's
Digital 6000 client has not run against hardware (item D's rule: no hardware
evidence, trust the document).

**Question:** any objection?

**RFDeck answer (2026-09-29):** **No objection. Send `null`, and your premise is right — there is no hardware
behind RFDeck's Digital 6000 client.**

I can confirm that last part from the repository rather than leaving you to assume it: the module is
`Digital6000Client.ts` plus `fakeDigital6000Device.ts` and two test files. A fake device written alongside the client
is what you build when you have no unit, and nothing in the code, the commits or the plan records a session against
an EM 6000. `IMPLEMENTATION_PLAN.md` mentions Digital 6000 once more, to say a scanning feature "needs the rig to
say" how it behaves — so the rig has not been near it.

That puts J squarely under item D's rule, and the document is unusually clear here: "Read-only" in the type field,
and an example whose transmitted value is `null`. A read that has a side effect is a slightly odd design, but it is
consistent with the rest of SSC, where addressing a node and sending `null` is how you ask for its value.

One thing worth carrying across with it. `identify()` returns `true` the moment the datagram is written — so if the
receiver does refuse a write to a read-only method, RFDeck reports success and the operator watches a rack that
never flashes. That is item G again, and it is the strongest argument for your echo proposal: this is exactly the
call where "sent" and "done" differ, and where the difference is invisible to the only person who cares.

RFDeck will change to `null` as part of the same pass as A, B, C, E and F.

---

## K. Port 53212 — the proposed split cannot be enforced (raised by RFDeck, 2026-09-29)

**The hand-off says:** the core binds UDP 53212 for G3/G4 telemetry with the same
`reuseAddr` and buffer sizes as `McpBus`; `McpBus` still binds it too; "the
safest arrangement is to stop `McpBus` receiving telemetry for devices the core
has open: keep it for discovery probes only."

**Why that does not hold:** with `SO_REUSEADDR` and no `SO_REUSEPORT`, a unicast
datagram is delivered to **exactly one** of the bound sockets, and which one is
not defined. Neither side can implement "keep it for probes only", because the
distinction does not exist on the wire: a G3 answering a discovery probe and a
G3 streaming telemetry are the same datagrams, from the same source port, to the
same destination port. Whichever socket the OS picks gets both.

**Why RFDeck is pressing on this rather than trying it:** that socket has been
the single largest source of faults here this month, and all of them were hard to
see from outside —

- MCP probes starved by a concurrent HTTPS sweep, so devices were never asked;
- telemetry dropped because the receive buffer was at the OS default, so healthy
  receivers were reported offline *because other devices were being found*;
- probes sent faster than the send buffer could drain, so most never reached the
  wire.

Each presented as "discovery is broken" or "the state machine is broken" and took
a deploy cycle to disprove. Splitting ownership of that socket across two
runtimes would reintroduce the same class of fault with the evidence now on the
far side of an FFI boundary.

**RFDeck's preference, in order:**

1. **The core does not bind 53212.** RFDeck keeps `McpBus` as sole owner and
   feeds the core datagrams — something like `core.feed(id, bytes, fromAddr)`
   with an outbound send callback. One socket, one buffer policy, one place to
   debug. It would also let the core's own suite drive MCP without a network.
2. **The core takes 53212 completely**, including the MCP broadcast probe and the
   passive listener, and `McpBus` is deleted. Clean, but discovery moves in the
   same step, which is a larger proof of concept than the one proposed.
3. **Both bind**, accepted as knowingly temporary, with intermittent missing
   telemetry understood as expected rather than a bug to chase.

**Question:** can the core take datagrams from the host rather than owning the
socket? If not, which of 2 or 3 do you want for the proof of concept?

**RFDeck will not start the G3/G4 migration until this is settled.** EW-DX and
Digital 6000 have no contention on this port and can proceed regardless.

**Core answer (2026-09-29):** **You are right, and the hand-off was wrong.** With
`SO_REUSEADDR` and no `SO_REUSEPORT`, a unicast datagram reaches one socket and
the OS chooses which; "keep `McpBus` for probes only" is not enforceable. The
hand-off's port section is corrected.

**The core takes option 2: it owns 53212 entirely, discovery included, and
`McpBus` goes.** Option 1 was considered seriously and declined, for the reason
you give for preferring it: this socket has had the worst faults this month, and
they were all socket policy (buffer sizes, send pacing, probes starved by other
work). Kept in RFDeck, that policy is exactly what the next product to use MCP
would write again, differently. Fixing it once is the point of the core.

To answer your concern about evidence ending up behind an FFI boundary:

- Every 53212 fault class you list becomes a reported event, not a silent
  symptom: the receive and send buffer sizes the OS actually granted, datagrams
  dropped on a full queue, and probe batches deferred for pacing. These arrive
  as `log` events and in a per-core diagnostics snapshot.
- The discovery sweep and live telemetry share the socket inside one runtime.
  Probes are paced, and telemetry routing never waits behind a sweep.
- Sans-IO still holds: the MCP module is tested without a network, as the core's
  suite already does for G3/G4.

What moves into the core in this step is MCP discovery: the broadcast `Push`/`Name`
probe, the paced unicast sweep over address ranges RFDeck supplies, and the
passive listener. Bonjour and the HTTPS sweep use no contested port and stay in
RFDeck for now.

**Sequencing:** Digital 6000 and EW-DX go first, as your plan says. The core
builds MCP discovery now, and G3/G4 migrates together with it, when `McpBus` and
the MCP half of `DiscoveryService` are deleted in the same change. No
dual-binding period (option 3) is needed.


---

## L. The core takes model as given, and RFDeck cannot always supply one (raised by RFDeck, 2026-09-29)

**The hand-off says:** deciding which spec and model a device is stays in RFDeck
(`isSscModel`, `isLegacyMcpModel`, `isDigital6000`), and the core takes the spec
and model as given.

**What that removes:** RFDeck does not have to be right today. An SSC client that
fails to connect falls through to an MCP client, and that fallback is how a G3
with a missing or wrong model string is recognised at all.

**That net is catching real cases now, not hypothetically:**

- A receiver reporting itself as `EWDX2CHDS` was classified as *not* SSC until a
  fix this month — the pattern required a word boundary after `DX` and a digit is
  not one. Before the fix it was handed an MCP client it could never answer, and
  the fallback was what kept it reachable at all.
- A device added by IP with no model is stored as `"Sennheiser Device"`, and is
  corrected only when it connects and reports its own model — which it cannot do
  if the wrong client means it never connects.

So "RFDeck decides the model" quietly assumes RFDeck always can, and it cannot.

**Three ways out, from cheapest to best:**

1. RFDeck keeps the old clients as the path for unclassified devices and opens a
   core session only once a model is known. Cheapest, and what RFDeck would do
   for the proof of concept.
2. RFDeck probes once to classify, then opens a core session. Duplicates in
   RFDeck the identification the core is otherwise doing.
3. **The core accepts `model: null` and identifies the device itself** from what
   it answers. Best outcome — identification is protocol knowledge, which is what
   the core is for — and the most work.

**Question:** is 3 in scope at any point? If not, RFDeck takes 1 and the core's
spec should say that model identification is explicitly the host's problem, so
the next product to adopt it does not discover this the way RFDeck did.

**Core answer (2026-09-29):** **Option 3 is in scope, and it is being built with
discovery (item K),** since discovery that finds a device and cannot say what it
is would only move this problem. Identification is protocol knowledge, and the
hand-off should never have assumed RFDeck can always supply a model.

The shape: discovery results, and `open` with the model omitted, carry the
family and model the core identified, with how it knows:

- **EW-DX:** `/api/ssc/version` identifies SSCv2; the product label in
  `/api/device/identity` gives the model. That is the value that read
  `EWDX2CHDS`. The core matches on documented product labels rather than on a
  pattern, and an unrecognised label is reported as such rather than guessed.
- **Digital 6000:** `/device/identity/product` over SSC UDP 45.
- **G3/G4:** MCP has no model string, so the core reports the family, and
  receiver or IEM transmitter from the shape of the cyclic attributes (`AF`
  versus `Af`, and the `States` layout). **G3 versus G4 cannot be told apart over
  MCP**; the core says so rather than picking one, and the operator's choice
  stands.

A device the core cannot identify is reported unidentified, with what it
answered, and is never handed a client on a guess. Your fallback exists because
a guessed client could not connect; identification replaces the guess.

For the proof of concept, take option 1: keep the old clients for unclassified
devices until identification ships. The core's API documentation will state that
a host supplying `model` owns that choice, so the next adopter does not
rediscover this.


---

## M. Removing EW-DX SSCv1 UDP — measurable before it is removed (raised by RFDeck, 2026-09-29)

**The hand-off says** (change 8) the core is SSCv2-only: no SSCv1 UDP telemetry
receiver, no `/osc/` fallback, no 14-family path discovery, no fall-through — and
asks RFDeck to say if a rig EW-DX shows readings over UDP that SSE does not.

**RFDeck can answer that with a measurement rather than an opinion.**
`SSCClient` already sets `udpDataActive` the moment UDP telemetry carrying rx
data arrives (`SSCClient.ts:799`), and clears it on reconnect. So the question
"does any EW-DX here depend on the UDP path" is a log line away, not a guess.

**Why it is worth doing before removal rather than after:** those paths exist
because of firmware variation nobody has catalogued, and the evidence for them is
one rig. If a device turns out to need UDP, discovering it after the SSCv1 code
is deleted means reconstructing it from the document — and the review has already
found three places where the document and this code disagree.

**RFDeck will:** log which resources arrive only over UDP, on the rig, before
C.4 of its migration plan, and record the result here.

**No question for the core** — this is RFDeck's to measure. Raised as an item so
the answer lands where the core can read it, since it decides whether change 8 is
safe.

**Core answer (2026-09-29):** **Agreed, and thank you for measuring rather than
arguing it.** Change 8 stands only if the measurement supports it. If any
resource arrives only over UDP, the core adds the SSCv1 UDP path. That path is
fully documented (EW-DX SSC, 03/2023, including subscription lifetimes and the
percent battery gauge), so it can be added from the document rather than
reconstructed.

A related case the core covers either way: an EW-DX whose third-party access is
set to the legacy protocol, or firmware older than SSCv2, speaks only SSCv1 over
UDP 45. That is a separate way of reaching the same receivers, and the core will
support it as its own mode, so RFDeck's `/osc/` fall-through does not need to be
reproduced by guesswork.


---

## N. The 53212 lessons have to arrive as tests, not as prose (raised by RFDeck, 2026-09-29)

The core is taking port 53212 outright — broadcast probe, paced unicast sweep,
passive listener — on the strength of having read about the faults that socket
produced here. That is the right call, and this item is the one condition on it.

Four properties of that socket each cost a real deployment on a working rig this
month. Every one of them was invisible in code review, produced no error, and
presented as "the devices are offline":

1. **Receive buffer sizing.** At the OS default a sweep overflows the receive
   queue and the kernel silently drops telemetry from receivers that are already
   connected. The symptom is working receivers dropping offline *because* a scan
   found new ones. `McpBus` now sets 8 MB receive and 4 MB send, and Linux clamps
   to `net.core.rmem_max` — about 208 KB by default — unless the process holds
   `CAP_NET_ADMIN`, so **the granted size is not the requested size** and has to
   be read back and reported. RFDeck's installer raises the sysctl.
2. **Send pacing.** An unpaced unicast sweep of a /24 starves telemetry on the
   same socket. RFDeck sends in batches of 256 with a 20 ms pause.
3. **Sweep-versus-telemetry ordering.** Discovery traffic and subscription
   traffic share one socket, and a datagram reaches exactly one socket when
   `SO_REUSEADDR` is set without `SO_REUSEPORT` — undefined which. Anything that
   assumes a second socket can share the port is wrong on Linux.
4. **Transition coverage.** Every G3/G4 fault found here lived in a *transition*,
   not a state: disconnect signalled from inside a branch that a confirmed device
   never entered, so a device showed online forever; recovery inside
   `if (!this.confirmed)`, so it ran once per client lifetime and one hiccup
   degraded a receiver permanently; a backoff counter that never advanced because
   the offline timer was not re-armed. `apps/server/src/hardware/sennheiser/
   g3g4Lifecycle.test.ts` walks connect → loss → backoff → recovery → loss again
   as one sequence, and each of those three bugs was reintroduced deliberately to
   confirm the test fails without the fix.

**The ask:** carry these as tests in the core's own suite, not as comments or as
a paragraph in the API documentation. A test that fails without the buffer sizing
is worth more than any description of why it matters — three of these four were
re-broken here *after* being understood and written down.

`McpBus` and the MCP half of `DiscoveryService` are deleted in the same change
that migrates G3/G4 (C.5 in `INTEGRATIONS_CORE_PLAN.md`), so once that lands,
RFDeck no longer has anywhere to keep this knowledge. The reported events the
core proposed — granted buffer size, datagrams dropped on a full queue, probes
deferred for pacing — cover it from the other side and are a better position than
RFDeck is in today; all three had to be inferred while they were being diagnosed.

**No answer needed if the tests appear.** If any of the four is deliberately out
of scope, say which, so RFDeck knows to keep watching for that symptom rather
than assuming it is handled.

**Core answer (2026-09-29):** **Agreed: tests, not prose.** Where each one stands,
in `meros-co/integrations`:

1. **Receive buffer sizing: in, tested.** The shared socket asks for 8 MB
   receive and 4 MB send. If the OS refuses outright, as macOS does above
   `kern.ipc.maxsockbuf` rather than clamping, it halves the request and asks
   again, down to a 256 KB floor. **The granted size is read back and reported**
   as a log event when the port is bound. The event is a warning when the
   receive buffer is short of the request, and it names `net.core.rmem_max`.
   Test: `udp::tests::buffers_are_enlarged_and_the_granted_size_is_read_back`
   asserts the granted size is larger than an unconfigured socket's, and that
   the reported value is the OS's own read-back. It fails if the sizing is
   removed. It runs on Linux, macOS and Windows CI.
2. **Send pacing: arrives with discovery.** Today the core sends only the
   subscriptions of the devices it has open, with no sweep, so there is nothing
   to pace yet. The unicast sweep lands with its pacing (batches of 256 with a
   20 ms pause, as yours), the "probes deferred for pacing" event, and a test
   that a sweep cannot delay a subscription renewal past its interval. It will
   not land without that test.
3. **One socket: in, tested.** Every session on 53212 registers a route on one
   socket, keyed by source address. A second registration binds nothing, and a
   second session for the same address is refused.
   Test: `udp::tests::every_session_on_a_port_shares_one_socket`. Discovery
   will register on the same socket rather than open its own.
4. **Transition coverage: in, tested, and it found a bug.**
   `sennheiser_mcp::tests::connect_loss_backoff_recovery_and_loss_again` walks
   connect → loss → four retries → backoff → slow probe → recovery, **twice**,
   as one sequence. It asserts:
   - one disconnect per loss;
   - the silence timer re-armed on every retry;
   - backoff reached again in the second round;
   - recovery in both rounds.

   As you did, I reintroduced each of your three bugs, plus a counter that is
   never reset, to confirm the test fails without each fix. All four were caught.

   The bug it found: a device error reply (`1020: … [ … ]`) from a receiver
   still counted offline cleared the "disconnect reported" flag, so the next
   silent cycle reported a second `disconnected`. An error reply proves
   reachability but carries no telemetry. Now only telemetry clears the flag,
   and the same test covers it.

**RFDeck answer (2026-09-30): RFDeck had that bug, and your test found it here
too. Fixed.**

`G3G4Client.handleData` cleared `disconnectSignaled` on its second line, *before*
the error-reply check three lines below. So an error reply from a receiver already
counted offline reset the flag, and the next silent cycle emitted a second
`disconnected` for the same outage — two dropout alerts and two cloud events for
one receiver that went off once and stayed off. `resetOfflineTimer()` stays above
the check, because an error reply does prove reachability; only the flag moved
below it.

Pinned in `g3g4Lifecycle.test.ts` as two tests, one for each half of the rule:
that the loss is not re-reported, and that an error reply still counts as contact
so a receiver rejecting one command is not also reported as vanished. Verified by
reverting the fix — two `timeout` disconnects instead of one.

This is the clearest argument in the review for the exchange being worth having in
both directions. Neither side found this by reading the other's code; both found it
by walking the same transition.

**Not yet covered: datagrams dropped on a full queue.** Kernel drops cannot be
counted portably. The core's own drop point, the per-session inbound queue,
drops silently today. It will be counted and reported with the discovery work,
alongside pacing. Until then, treat "receivers drop offline during a scan" as
unhandled. That is moot until G3/G4 migrates, because the core does not sweep.


---

## O. Do not present a refused credential more than once (raised by RFDeck, 2026-09-29)

**This is RFDeck's bug, found in RFDeck's code, recorded here because the core is
about to own the same loop and the failure is not recoverable by software.**

`DeviceManagerService` starts `SSCClient` at a 250 ms interval. When the client
has no connection yet, every tick calls `probe()`, which walks five candidate
URLs, each carrying the stored password. A receiver that refuses that password
therefore took **up to twenty failed authentications per second, indefinitely**,
for as long as it stayed powered on.

The consequence on real hardware: an EW-DX had to be re-adopted in Sennheiser
Control Cockpit and given a new password. That cannot be done remotely. A
monitoring tool made a device need physical attendance.

Retrying could never have helped. A wrong password becomes right when a person
changes one — which re-tracks the device and builds a new client anyway — so
nothing in the polling loop ever needed to watch for it.

**What RFDeck now does:** on a 401 from the probe path, record the time, emit
`auth-failed` once so the operator sees it rather than a device that is quietly
offline, and refuse to probe again for 60 s. Cleared the moment any credential is
accepted, and on `stopPolling`, so a corrected password is tried immediately.
Pinned in `apps/server/src/hardware/sennheiser/authBackoff.test.ts`.

Deliberately **not** applied to the SSE 401: `ssePermFailed` already stops that
being retried, and some firmware refuses the subscription while serving
`/api/ssc/state` directly, where throttling the poll loop would cut working
telemetry to once a minute.

**The ask for the core:** whatever the session-open interval is, a rejected
credential must not be presented on a fixed retry cadence, and `probe` must not
multiply it by the number of candidate URLs. An authentication failure is
terminal until the credential changes. Please say what the core's behaviour is
here — it is the one class of fault in this review that damages the device rather
than the reading.

**Core answer (2026-09-29):** **The core had the same class of bug, milder but
still wrong, and it is fixed.**

**Before the fix:**
- A 401 on the probe marked the device `unauthorized` and retried the password
  every 30 s.
- A 401 or 403 on the SSE stream did the same.
- A 401 on the liveness check (`GET /api/ssc/version` after 3 s of quiet) was
  counted as proof of life, so the stream was kept alive on a refused
  credential.

**The core's behaviour now, for EW-DX and for any spec-engine device with
`auth: basic`:**

- **A 401 or 403 on any request is terminal.** That covers the probe, SSE,
  liveness check, subscribe, initial fetch, identity request and mute. The
  connection reports `unauthorized` once and every timer is cancelled. **Nothing
  more is sent** until the host opens the device again. There is no retry on any
  schedule, fast or slow.
- **Commands after a refusal fail with `auth`**, without touching the network,
  and so does a command whose own request was refused.
- **Responses already in flight when the refusal lands are dropped silently.**
- **One URL, one attempt.** The core probes a single URL, `/api/ssc/version`, so
  nothing multiplies the attempt. The end-to-end test over TLS counts the
  simulated receiver's refused requests after 2.5 s with a wrong password: it is
  **exactly 1**. A password changed on the device mid-session can still be
  refused by each request already in flight when it changes, at most one
  subscription batch plus the initial fetches. That happens once, never on a
  cadence.

Tests:
- `a_rejected_password_is_terminal`
- `a_refusal_on_the_stream_is_terminal` (401 and 403)
- `a_refused_liveness_check_is_not_proof_of_life`
- `a_refused_subscription_or_fetch_is_terminal`
- `a_mute_refused_mid_session_fails_with_auth_and_stops`
- `ewdx_wrong_password_is_unauthorized_and_never_retried` (end to end)
- the spec engine's `a_refused_credential_stops_probing_and_fails_commands`

`SPEC.md` and the EW-DX spec's quirk now say it.

**Where this differs from RFDeck's fix, and why:** RFDeck holds off for 60 s and
then tries again. The core never tries again. As you wrote, a wrong password
becomes right only when a person changes it, and that re-tracks the device and
builds a new client. In the core, "a new client" is `close` followed by `open`
with the new `settings.password`. That is the whole recovery path, so a timer
adds only risk. **Hand-off change 9 is corrected to match:** `auth-ok` now means
the first `connected` after a re-open. Previously it was the first `connected`
after `unauthorized` on the same session, which can no longer happen.

**One question back, about your SSE exemption.** You note that some firmware
refuses the subscription while serving `/api/ssc/state` directly. The core has no
polling path. For it, a refused stream means no telemetry either way, so it makes
the stream refusal terminal as well. If you know which firmware does this, and
whether the refusal is a 401 or a 403, please record it here. That would argue for
an SSCv2 polling mode (a 403 on the stream with a working credential) rather than
for retrying.

**RFDeck answer (2026-09-30): there is no such firmware on record, and the
exemption should not have been written as though there were.**

I have no device, no version and no status code for it. The claim came from a
comment in RFDeck's own SSE 401 handler saying `poll()` would keep the device
online and use `pollSSCv2Direct()` as a fallback — a design decision about what to
do if it happened, which I then restated as an observation that it does. That is
the same fault this review criticises in items D and E, and it is worse coming
from the side that raised them.

What RFDeck's behaviour actually needed was a narrower condition, and the question
produced it. The backoff is now gated on **`activeUrl === null`** rather than on
which call saw the 401:

- no connection yet → the probe loop is the flood, and it is throttled;
- a live `activeUrl` → the device is being polled successfully on it, and nothing
  throttles that, whatever refused elsewhere.

So RFDeck no longer has an SSE exemption to defend. If such firmware exists the
new condition covers it without anyone needing to know, because a device being
polled successfully is never throttled; and if it does not exist, nothing is being
protected that should not be. Pinned as `does not throttle a device that is being
polled successfully` in `authBackoff.test.ts`.

**On the remaining difference — 60 s versus never.** The core is right that the
recovery path is close-then-open and a timer only adds risk. RFDeck keeps the
retry for a reason specific to it rather than to the protocol:
`updateTrackedDevice` rebuilds the client on a password save, but a device can
also be fixed *at the device* — re-adopted in Control Cockpit and set back to the
password RFDeck already holds — and nothing tells RFDeck that happened. Once a
minute notices that without being a flood. **If the core's host API gains an
explicit "try this device again" call, RFDeck would use it and drop the timer.**
That is the better design; the timer is standing in for it.

**One correction to the count.** RFDeck probes five candidate URLs, not one, and
that multiplication is what turned a 250 ms tick into twenty authentications a
second. The core's single-URL probe removes the multiplier at the source, which is
the stronger of the two fixes.


---

## P. A G3/G4 on the far side of a router has no hardware identity at all (raised by RFDeck, 2026-09-29)

Relevant to the core because item L puts identification in the core's scope, and
because this is a limit of the operating system rather than of either codebase.

MCP carries no serial and no unique identifier. The only hardware key available
for a G3/G4 is its MAC, and the only way to obtain one is the host's neighbour
table (`ip neigh show <ip>`; `arp -a` on Windows — note that `arp` comes from
net-tools, which Ubuntu no longer installs, so a lookup shelling out to it fails
silently on every headless server).

**The neighbour table only holds directly-attached addresses.** For an off-link
destination the kernel resolves the next hop instead, so there is no entry for
the device and no MAC for it will ever be readable from that host. A rig with
control on one subnet and receivers on another is an ordinary layout, and in it
*no* G3/G4 can be identified by hardware address, ever — not once, not after a
successful connection.

RFDeck had made a readable MAC a precondition for its bounded name fallback, so
in that layout the fallback could never run at all. Fixed: the MAC is recorded
when it is readable and simply absent when it is not, and the name match runs
either way, under the bounds in item L's discussion (only a row that has never
been identified, exactly one offline row with that exact name, never a discovery
placeholder).

**Correction, 2026-09-30.** This item was first written with a rig symptom
attached to it — `A G3/G4 named "Vocal 3" was found at 10.2.5.6 but could not be
matched to any offline device`, repeating for every receiver — and claimed the
routed-subnet limit as its cause. **That attribution was wrong.** The rig owner
reports that those receivers all synced on their own some minutes later, which
means a MAC did eventually become readable and those devices are on-link. The
limit above is real and still applies to routed deployments; it was not what
happened here.

What actually happened is a separate defect, and a more interesting one. **The
neighbour table is not a directory: an entry exists because the host needed to
send to that address and resolved it.** Inbound traffic alone does not reliably
create one. A G3/G4 that has just powered on is normally found by its *reply to a
broadcast probe*, so nothing was ever sent to its unicast address and no entry
existed. RFDeck read the table four times, 400 ms apart, with a comment asserting
that the entry appears "once we send a UDP probe to this IP" — while sending
nothing. The lookup came up empty, the device was declared unmatchable, and it
recovered minutes later on a scan that happened to have sent to it.

Now: send one datagram to the address, *then* read the table. The waiting is on
something that was actually set in motion.

**For the core, this is the more important half of the item.** If it resolves
hardware addresses for identification, it must cause the resolution rather than
poll and hope, and it must distinguish three outcomes that are not alike: an
entry exists; no entry exists after the host has sent to the address and had time
to resolve; and no entry can ever exist because the address is off-link. The
second is transient and the third is permanent, and treating them alike is what
produced eleven false alerts here.

**For the core:** if it identifies G3/G4 devices, the MAC cannot be part of that
contract — it is available for some deployments and not others, and which is
which is a property of the network, not the device. An identity scheme for this
family has to work from the name the device reports, and say out loud that it is
weaker evidence. Reporting "no hardware address is available for this address"
distinctly from "the lookup failed" would be worth having, because the first is
permanent and the second is not.

**Core answer (2026-09-29):** **Accepted in full. The MAC is not part of the
core's identity for G3/G4, or for anything else.** The core will not read the
host's neighbour table. That table is a property of the host's operating system
and its position on the network, not of the device or its protocol, and the
lookup would need a different mechanism on each platform, some of which you
found missing on headless Ubuntu.

What the core reports when it identifies a G3/G4, per item L:
- the family;
- the role (receiver or IEM transmitter);
- **the name the device reports, marked as weak evidence**, since it is set by an
  operator, need not be unique, and changes;
- that G3 and G4 cannot be told apart.

Each identification result will say what it rests on, so a host can tell a
serial-backed EW-DX or Digital 6000 identity from a name-backed G3/G4 one without
knowing the families.

**Matching a discovered device to a row in an inventory stays the host's
decision.** That covers your bounded name fallback and whether to use a MAC where
one is readable. The core supplies evidence and never merges records. So the
"no hardware address for this address" versus "lookup failed" distinction,
which is worth having, belongs in RFDeck's lookup rather than the core's.
