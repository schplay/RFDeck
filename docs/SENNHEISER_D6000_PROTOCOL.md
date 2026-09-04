# Sennheiser Digital 6000, as RFDeck uses it

Working notes for `hardware/sennheiser/digital6000`. Everything here is quoted
from a primary source and cited. There is no EM 6000 on the development
machine, so what has and has not been verified is listed at the end.

## Sources

- **[Sennheiser Sound Control Protocol (SSC) — Digital 6000](https://www.sennheiser.com/globalassets/digizuite/41931-en-ti_1109_v2.2_sennheiser_sound_control_protocol_digital_6000_en.pdf)**
  (TI 1109 v2.2, 232 pp). Sennheiser's own developer's guide, and the source
  for every format below. Openly published — no account needed.
- **[Bitfocus Companion — Digital 6000 module](https://github.com/bitfocus/companion-module-sennheiser-digital6000)**
  — a working implementation, used as a cross-check.

## It is not the protocol RFDeck already spoke

Digital 6000 is Sennheiser, and RFDeck's `SSCClient` already speaks SSC. That
made this look like a small addition. It is not.

| | EW-DX (`SSCClient`) | Digital 6000 |
|---|---|---|
| Configuration | SSCv2 over **HTTPS 443** | none — UDP only |
| Telemetry | SSCv1 JSON over **UDP 45** | SSC JSON over **UDP 45** |
| Frequency | `rx1.frequency` | **`rx1.carrier`** |
| RF | `m.rx1.rsqi` | **`mm`**, a metering array |
| Battery | `mates.tx1.battery.gauge` | **`rx1.skx.battery`**, a *string* array |

"The SSC Server implemented for Digital 6000 devices supports only UDP/IP as
transport protocol." There is no HTTPS interface for `SSCClient`'s probe chain
to find, so before this client existed an EM 6000 would probe, fail, fall
through to the G3/G4 fallback, fail that too, and sit offline — while the
README claimed it was supported.

### The port is 45, not 6970

The Companion module defaults to **6970**. That number appears **nowhere** in
Sennheiser's 232-page specification, which says plainly:

> The UDP port number to used by the SSC Server should normally be discovered
> by the SSC Client by means of the server discovery protocol. **The default
> port number is 45.**
>
> Rationale: No other standard UDP service is expected to use 45. […]
> Sennheiser was founded in 1945.

RFDeck follows the document. An earlier version of `MANUFACTURER_ROADMAP.md`
repeated the 6970 figure from the Companion module without checking it.

## Subscriptions, not polling

This is the part that has to be right. The device pushes until a subscription
expires and then **goes quiet without closing anything** — the socket stays
open, pings still answer, and the receiver simply says nothing. That is
indistinguishable from a healthy channel nobody is talking on.

```json
{"osc":{"state":{"subscribe":[
  {"#":{"min":480,"max":480,"lifetime":20,"count":1000},"mm":null}
]}}}
```

The parameters above are the specification's own example for this node. RFDeck
renews at a third of the lifetime, so two lost datagrams are survivable, and
runs a silence timeout underneath in case renewal itself fails.

The metering array and the channel tree are subscribed separately: metering
wants a fixed fast rate, while names and frequencies should arrive when they
change. Asking for the channel tree at 480 ms would be a datagram of unchanged
names twice a second.

The device may also refuse: "The SSC Server MAY also reject the subscription
request completely (with SSC Error code 406)." RFDeck logs that rather than
treating the silence which follows as an idle rig.

## The metering array

```
mm = [[RF1, RF1-PEAK, RF2, RF2-PEAK, DIV1, DIV2, LQI, AF, AF-PEAK],  ← channel 1
      [ ...                                                      ]]  ← channel 2
```

Worked example from the document:

```json
{"mm":[[0,0,0,0,0,0,0,0,0],[83,0,53,0,1,1,128,165,0]]}
```

| Field | Meaning | Conversion |
|---|---|---|
| RF1 / RF2 | RF level per antenna | **dBm = (Value − 255) / 2** |
| RF1-PEAK / RF2-PEAK | a digital clip in the RF section, held ≥ 1 s | 0 / 1 |
| DIV1 / DIV2 | whether that diversity antenna is active | 0 / 1 |
| LQI | audio link quality | 255 best, 0 worst |
| AF | full-scale audio level | **dBFS = (Value + 1) / 2 − 128** |
| AF-PEAK | a digital clip in the audio section | 0 / 1 |

So channel 2 above is at −86 dBm and −101 dBm on its two antennas, both
antennas active, half link quality, and −45 dBFS of audio.

**The two formulae are written differently and are the same arithmetic**:
`(v+1)/2 − 128` expands to `(v−255)/2`. RFDeck keeps them as separate functions
because they convert different quantities — dBm at an antenna against dBFS
referred to full scale — and a future revision changing one should not silently
change the other. A test pins the equivalence, and originally asserted the
opposite and failed.

RF is converted to real dBm and then through the shared window in
`hardware/rfUnits.ts`, so a Sennheiser dBm and a Shure dBm land on the same
meter.

## The battery is four states, not a percentage

```json
{"rx1":{"skx":{"battery":["70%","5:12"]}}}
```

> States: {"100%", "70%", "30%", "low"}. Time notation: "x:xx" or "-:--" if
> time information is not available. […] An empty array indicates that the
> transmitter is not present or doesn't send valid battery information.

Three of the four states name their own percentage. **"low" does not**, and
RFDeck maps it to 10 — the one number in this implementation that is a choice
rather than a quotation. It sits under the 20% warning threshold and above the
5% critical one, so a pack the receiver calls low raises a warning and not a
crisis.

An empty array leaves battery **absent**, never zero. No transmitter paired is
not a flat pack, and the difference is a critical alert on a receiver nobody
has switched a transmitter on for.

## Warnings carry state that is not a level

> Warnings: {RFPeak, AFPeak, LowSignal, NoLink, LowBattery, BadClock, NoClock,
> Aes256Error, AnTxYBNCShorted}

`NoLink` is mapped onto RFDeck's `squelch` — the transmitter is off or out of
range, which is deliberate rather than a fault, the same distinction EW-DX
draws with TX_Mute. The rest are available and not yet surfaced.

## What has not been verified

- **Nothing has run against a real EM 6000.** The simulated device believes
  the same specification the client does, so a shared misreading passes both.
  What the simulator does prove is the lifecycle — subscription renewal,
  merging partial datagrams, and detecting the silence of a lapsed
  subscription, which it models deliberately.
- Whether a real device adapts the subscription parameters it is asked for.
  The specification permits it: "the SSC Server MAY adapt the requested
  parameters, and MUST send back the adapted parameter values in the Reply."
  RFDeck currently ignores the adapted values and renews on its own schedule,
  which is safe only while its schedule is the shorter one.
- Whether the EM 6000 announces over the DNS-SD service the specification
  requires (`_ssc._udp`). If it does, discovery could find one automatically
  instead of needing the model typed in. RFDeck's existing mDNS browser looks
  for `_ssc._tcp`, which Digital 6000 does not publish, since it has no TCP.
- The L 6000 charger shares this protocol and has a `slot`-based tree that is
  entirely unimplemented.
