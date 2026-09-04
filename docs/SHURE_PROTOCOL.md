# Shure command strings, as RFDeck uses them

Working notes for the Shure hardware client. Everything here was read out of a
primary source and is cited; nothing is from memory. Where two sources
disagreed, both are recorded along with which one the code follows and why.

There is no Shure hardware on the development machine, so the protocol layer is
written as pure functions tested against strings copied verbatim from the
specification, and the client is exercised against a fake device that speaks
the same wire format. That is not the same as running against a real AD4D —
what remains to be verified on hardware is listed at the end.

## Sources

- **[Axient Digital — Command Strings](https://content-files.shure.com/Pubs/AD4D/Axient_Digital_network_string_commands.pdf)**
  (Shure, preliminary, 2 May 2018, 47 pp). The authoritative document, and the
  source for every format and range below unless stated otherwise. Shure's CDN
  returns 403 to a bare request; it downloads with an ordinary browser
  user-agent.
- **[micboard](https://github.com/karlcswanson/micboard)** — `py/device_config.py`,
  `py/networkdevice.py`, `py/mic.py`. A working implementation used in venues,
  covering UHF-R, QLX-D, ULX-D, Axient Digital and PSM1000. Useful as
  corroboration and as the source for the ULX-D/QLX-D command names, which the
  Axient document does not cover.
- **[SLX-D Command Strings](https://www.shure.com/en-US/docs/commandstrings/SLXD)**
  (Shure, 13 pp). Definitive for SLX-D, and it settles a disagreement: its own
  *introduction* shows the Axient sample layout, which is a copy-paste — the
  SLX-D section a few pages later defines a three-field sample, and every
  implementation agrees with the section rather than the intro.
- **[ULX-D Command Strings](https://content-files.shure.com/Pubs/ulx/ulx-d-network-string-commands.pdf)**
  (Shure Applications Engineering, 12 Jan 2018). The ULX-D/QLX-D equivalent,
  found later than it should have been — the first version of this file said no
  such document existed and leaned on a third-party implementation instead.
- **[PSM1000 Command Strings](https://web.archive.org/web/20230922221808/https://pubs.shure.com/command-strings/PSM1000/en-US)**
  — Shure's own page, via the Internet Archive. The live page is now a
  JavaScript-only shell that serves no content to a fetch; the 2023 snapshot
  predates that and carries the full command table.
- **[wirelessboard](https://github.com/willcgage/wirelessboard)** — the actively
  maintained micboard fork. Its `py/shure_protocol.py` isolates the vendor
  knowledge deliberately and is the cleanest statement of the framing rules.
- **[Bitfocus Companion — Shure Wireless module](https://github.com/bitfocus/companion-module-shure-wireless)**
  — `src/index.js`, `src/internalAPI.js`, `src/setup.js`. Covers ULX-D, QLX-D,
  Axient Digital and SLX-D, and is the second independent implementation used
  to check every conversion below.
- **[Shure device IP ports and protocols](https://content-files.shure.com/FileRepository/common-ip-ports-v2.pdf)**
  — confirms 2202/TCP ("AMX/Crestron Control Strings") and 8427/UDP
  ("Shure SLP (discovery) (multicast)").

## Transport

TCP, **port 2202** — the port Shure documents for "AMX/Crestron control
strings". UHF-R uses the same port over **UDP**, which is why the transport is
per-family rather than global.

Messages are ASCII, delimited by angle brackets:

```
< GET 1 CHAN_NAME >
< REP 1 CHAN_NAME {Lead Vox                       } >
```

Reads must be split on `>` rather than on newlines: the device does not send
line breaks, and several messages arrive in one TCP segment. A partial message
at the end of a segment has to be carried into the next one — the same problem
the audio demuxer has with frame boundaries, and it goes wrong the same way if
ignored.

Braces delimit string values and are padded with spaces to a fixed width. The
padding is part of the wire format, not part of the name.

## Message types

| Type | Direction | Meaning |
|---|---|---|
| `GET` | to device | Ask for a parameter |
| `SET` | to device | Change a parameter |
| `REP` | from device | The value. Sent in reply to GET/SET **and unprompted whenever a parameter changes** |
| `SAMPLE` | from device | Periodic metering, one message per channel |

Because `REP` arrives unprompted on change, a client does not need to poll
anything except metering. `< GET 0 ALL >` asks for every device and channel
property at once and is the right thing to send on connect.

The first index is the channel, 1–4. Device-level parameters have no index:
`< GET DEVICE_ID >`, not `< GET 0 DEVICE_ID >`.

## Metering

```
< SET 1 METER_RATE 00100 >      → < REP 1 METER_RATE 00100 >
```

Five-character fixed width. `00000` turns metering off (the default); `00100`
to `65535` is the interval in milliseconds. Metering must be enabled per
channel, and turned off on disconnect — a receiver left metering into a closed
socket is a receiver still doing work for nobody.

### The SAMPLE line changes shape with the channel's mode

This is the part most likely to be got wrong, because the common case looks
like a fixed-width record:

```
Standard (Quadversity off, FD off or FD-S)
< SAMPLE chNum ALL qual audBitmap audPeak audRms rfAntStats rfBitmapA rfRssiA rfBitmapB rfRssiB >
< SAMPLE 1 ALL 005 031 102 102 BB 31 086 31 065 >

Quadversity on
< SAMPLE 1 ALL 005 031 102 102 BBBB 31 083 31 068 31 069 31 072 >

FD-C (frequency diversity, combined) — a second RF section is appended
< SAMPLE 1 ALL 005 031 102 102 BB 31 082 31 060 BB 31 082 31 060 >

Quadversity + FD-C
< SAMPLE 1 ALL 005 031 102 102 BBBB 31 084 31 065 31 070 31 070 BBBB 31 084 31 065 31 070 31 070 >
```

Fields 0–6 (`SAMPLE`, channel, `ALL`, quality, audio bitmap, audio peak, audio
RMS) are in the same place in all four layouts, and so are the antenna status
and the first two RSSI values. What varies is how many antenna readings follow.

**The antenna status field tells you how many there are**: one character per
antenna, so `BB` means two and `BBBB` means four. RFDeck reads the count from
that string rather than assuming a layout, which also makes the FD-C second
section detectable rather than silently misread as more antennas.

micboard reads fixed indices 7 and 9 for antenna status and RSSI A. That is
correct for every layout above, and RFDeck agrees with it for A and B; the
difference is only that RFDeck will not misparse a Quadversity or FD-C rig.

## Values

> **The conversion offsets are not the same between families.** Getting this
> wrong is the single easiest mistake here, and the first version of this file
> made it: it took micboard's display scaling (`2 × audio`, `rf / 115`) for a
> unit conversion and applied Axient's offsets to everything.

| Parameter | Format | Conversion |
|---|---|---|
| `RSSI` (Axient) | 3 digits | dBm = reported − 120 |
| RF level `aaa` (ULX-D) | 3 digits, 000–115 | **dBm = reported − 128** |
| `AUDIO_LEVEL_RMS`, `AUDIO_LEVEL_PEAK` (Axient) | 3 digits | dBFS = reported − 120, range −120…0 |
| audio level `eee` (ULX-D) | 3 digits, 000–050 | dBFS = reported − 50 *(units inferred — see below)* |
| `TX_BATT_CHARGE_PERCENT` (Axient), `BATT_CHARGE` (ULX-D) | 3 digits | percent 0–100; **255 = unknown** |
| `CHAN_QUALITY` | 3 digits | 0–5; **255 = unknown** |
| `ANTENNA_STATUS` | 2 or 4 chars | per antenna: `X` off, `R` red, `B` blue |
| `TX_BATT_BARS` | 3 digits | 0–5; **255 = unknown** |
| `TX_BATT_MINS` | 5 digits | minutes 0–65532; **65533 battery comm warning, 65534 calculating, 65535 unknown** |
| `FREQUENCY` | 7 digits | kHz — `0578350` is 578.350 MHz |
| `AUDIO_MUTE` | `ON` / `OFF` | also accepts `TOGGLE` on SET |
| `CHAN_NAME`, `DEVICE_ID`, `TX_DEVICE_ID` | `{padded}` | trim the padding |

The `TX_BATT_MINS` sentinels matter: taken at face value, 65535 is a
transmitter with forty-five years of battery left, and it would sail through
any range check that only rejects negatives.

### Mapping onto RFDeck's channel model

RFDeck's `Channel` carries `rfLevelA`/`rfLevelB` and `afLevel` as **0–100**,
and `frequency` in **kHz** — Sennheiser's `rf_quality` is already 0–100 and its
AF is dBFS converted as `100 + dBFS`.

- **Audio.** Convert to real dBFS with the family's own offset and hand that
  over; `DeviceManagerService` applies `100 + dBFS` itself, exactly as it does
  for Sennheiser.
- **RF.** Convert to real dBm with the family's own offset, then map dBm to
  0–100 with **one** window shared by every family — which is the point of
  converting rather than rescaling per family.

  The window is −95 dBm to −35 dBm, chosen for where it leaves the thresholds
  the rest of the application already uses rather than for tidiness. A receiver
  squelches around −95, a well-set-up link sits between −60 and −40, and above
  −35 is as good as it gets. That puts RFDeck's CRITICAL threshold (below 20)
  at exactly −83 dBm and marginal (below 35) at exactly −74 — near squelch and
  worth-watching respectively — while a healthy −50 dBm link reads 75%.
- **Battery.** Prefer the reported charge percentage; fall back to
  `bars × 20` only for a transmitter that reports bars and no percentage. Bars
  must never overwrite a real percentage — 4 bars would drag a reported 71% to
  80%.
- **Runtime.** `TX_BATT_MINS` / `BATT_RUN_TIME` is the transmitter's own
  estimate. RFDeck normally derives runtime by regression over observed drain;
  where the hardware states it, the hardware wins.

## Command names differ between families

The names are **not** the same, and using one set for both fails silently — a
`GET` for a parameter the device does not have simply never produces a `REP`,
so the receiver looks dead rather than misconfigured.

| Meaning | ULX-D / QLX-D | Axient Digital | SLX-D |
|---|---|---|---|
| Battery bars | `BATT_BARS` | `TX_BATT_BARS` | `TX_BATT_BARS` |
| Battery charge % | `BATT_CHARGE` | `TX_BATT_CHARGE_PERCENT` | **none** |
| Battery runtime | `BATT_RUN_TIME` | `TX_BATT_MINS` | `TX_BATT_MINS` |
| Battery health % | `BATT_HEALTH` | `TX_BATT_HEALTH_PERCENT` | none |
| Battery cycles | `BATT_CYCLE` | `TX_BATT_CYCLE_COUNT` | none |
| Channel name | `CHAN_NAME` | `CHAN_NAME` | `CHAN_NAME` |
| Frequency | `FREQUENCY` | `FREQUENCY` | `FREQUENCY` |
| Mute | `AUDIO_MUTE` | `AUDIO_MUTE` | **none at all** |
| Link quality | *not reported* | `CHAN_QUALITY` | none |
| RF level | *sample only* | `RSSI` | `RSSI` |
| Audio level | *sample only* | `AUDIO_LEVEL_RMS` | `AUDIO_LEVEL_RMS` |
| Antenna | *sample only* | `ANTENNA_STATUS` | none |

**SLX-D has no mute command of any kind.** Searching its specification for
"mute" returns nothing. RFDeck's `setMute` returns false for an SLX-D rather
than sending a command the device would ignore — otherwise an operator presses
Mute during a show, sees the button respond, and the channel stays open.

**"Sample only" is a real distinction, not a gap in the research.** Shure's
ULX-D document defines RF, audio and antenna state solely as fields of
`< SAMPLE x ALL nn aaa eee >`; there is no name to GET them by. Names for them
(`RX_RF_LVL`, `AUDIO_LVL`, `RF_ANTENNA`) appear in micboard's configuration
table, are in no Shure document, and are never actually sent by micboard or by
Companion. RFDeck therefore leaves those entries undefined rather than
inheriting invented names that would produce GETs answered by silence.

### The SLX-D sample

```
< SAMPLE chNum ALL audPeak audRms rfRssi >
< SAMPLE 1 ALL 102 102 086 >
```

Three fields, and Axient's **−120 offset** for both — SLX-D's document states
it outright for `RSSI` (dBm) and `AUDIO_LEVEL_RMS`/`PEAK` (dBFS). So SLX-D
borrows Axient's units and its transmitter-side vocabulary while sending a
sample shaped like nothing else.

No antenna status and no channel quality. RFDeck reports no antenna state for
SLX-D rather than a default: an antenna indicator permanently showing "off"
reads as a fault on a receiver that simply has no such indicator.

Channels are 1 or 2 only — the document's index table lists 0 (all channels),
1 and 2.

**SLX-D blocks command strings by default.** Network control has to be enabled
on the receiver before any of this works; until it is, the device accepts the
TCP connection and answers nothing, which looks exactly like a wrong model
selection. The add-device form says so when an SLX-D model is picked.

### The ULX-D sample

```
< SAMPLE x ALL nn aaa eee >
```

- `nn` — which antenna LEDs are lit, positionally: `AX` is antenna A on and B
  off, `XB` the reverse, `XX` both off. Note this is a *different vocabulary*
  from Axient's per-antenna `X`/`R`/`B`.
- `aaa` — RF level, 000–115. "To convert this value to dBm, subtract 128."
- `eee` — audio level, 000–050. **The document gives the range but no units.**
  The −50 offset RFDeck uses is inferred from that range and matches Bitfocus
  Companion; it is the only conversion here not stated outright by Shure.

There is one RF figure, not one per antenna.

## The PSM1000 is a different dialect

Same port, same angle brackets, and almost nothing else in common. Every
difference below fails silently rather than loudly — a wrong mute value looks
accepted, a wrong meter-rate width is ignored, an ALL command to a device that
has none simply goes unanswered.

| | Receivers | PSM1000 |
|---|---|---|
| Reply keyword | `REP` | `REPORT` |
| String values | `{braced and padded}` | bare |
| Terminator | none | **CRLF** — "each message is terminated by a carriage return and line feed" |
| Mute | `AUDIO_MUTE ON`/`OFF` | **`RF_MUTE 1`/`0`** |
| Meter rate | `00100`, 5 chars fixed | `100`, 11-char milliseconds |
| `GET n ALL` | yes | **no such command** |
| Metering | a `SAMPLE` message | periodic `REPORT AUDIO_IN_LVL_L` / `_R` |
| Battery | bars, minutes, sometimes percent | **none** — it is a transmitter |
| RF | RSSI per antenna | **none** — it transmits |

Other parameters: `DEVICE_NAME` (device-level, 8 chars), `RF_TX_LVL`,
`AUDIO_TX_MODE` (1 mono / 2 point-to-point / 3 stereo), `AUDIO_IN_LINE_LVL`
(0 Aux / 1 Line), `AUDIO_IN_LVL` — which despite the name is a *setting*, the
input gain, and not the meter.

That PSM1000 has no `SAMPLE` is worth stating plainly, because micboard's IEM
class has `parse_sample: pass` and that reads like an unfinished implementation.
It is not — there is nothing to parse.

### The meter has no documented units

`AUDIO_IN_LVL_L` and `AUDIO_IN_LVL_R` appear in Shure's command table as
"Audio Meter Level" with an 11-character value and no units, range or scale.
Companion's module says so outright in its source: `AUDIO_IN_LVL_L: unknown
format`.

The values are large linear amplitudes. micboard, and the actively maintained
wirelessboard fork, bucket them with these thresholds:

```
10272  23728  85488  246260  641928  1588744  2157767  2502970
```

Converted to dB those edges sit at roughly −58, −51, −40, −31, −22, −14, −12
and −10.5: wide steps at the bottom, compressed at the top. That is the shape
of an LED ladder, so this reproduces the transmitter's own front-panel meter
rather than measuring anything.

RFDeck uses that ladder and **deliberately does not convert to dBFS**. Doing so
needs a full-scale reference nobody documents, and inventing one is precisely
how the ULX-D conversions went wrong. The value is carried on `af_level` as a
0–100 meter reading offset by −100, and is labelled as a meter rather than a
measurement.

## Channel counts by model

Shure's product pages, micboard's `DCID_MODEL` table and Companion's model
table all agree:

| Model | Channels |
|---|---|
| AD4D | 2 |
| AD4Q | 4 |
| ULXD4 / ULXD4D / ULXD4Q | 1 / 2 / 4 |
| QLXD4 | 1 |
| SLXD4 / SLXD4D (and the "+" variants) | 1 / 2 |
| P10T (PSM1000) | 2 |

## Discovery

Shure devices announce themselves over **SLP on multicast group
239.255.254.253, UDP port 8427** — not mDNS. Shure's own ports document lists
8427 as "Shure SLP (discovery) (multicast)", and micboard's `py/discover.py`
joins exactly that group and listens.

The payload is comma-separated parenthesised fields, one of which is
`cd:<DCID>` — a device class id that maps to a model through `DCIDMap.xml`,
a proprietary file shipping with Wireless Workbench and the Shure Update
Utility. micboard ships a converted copy of that map.

**RFDeck does not use it.** The announcement's *source address* is the useful
part; everything else is asked of the device directly on 2202. That avoids
depending on a proprietary file, and it is also more honest: an announcement
proves something is multicasting, not that it is a receiver RFDeck can talk to.

So discovery is the same two-stage shape as the existing Sennheiser G3/G4 path
— a passive listener produces candidates, and a probe confirms them:

1. `slp.ts` joins the group on every local IPv4 interface (a venue machine
   routinely has a control network and a Dante network; joining only the
   default route misses everything on the other) and emits an address.
2. `probe.ts` connects to 2202 and asks `< GET MODEL >`, `< GET DEVICE_ID >`,
   `< GET FW_VER >` and `< GET n CHAN_NAME >` for n=1..4.

### What the probe infers, and from what

- **Is this a Shure receiver at all?** Only if it replies with a well-formed
  `< REP ... >`. An open port is not identification — the Sennheiser discovery
  learned that expensively, by claiming every device on a venue network that
  answered HTTPS on 443.
- **Which family?** Axient answers `MODEL`; ULX-D and QLX-D have no such
  parameter and answer nothing. **The absence of a reply is the evidence**,
  which is worth stating plainly because it is the kind of inference that
  silently inverts.
- **How many channels?** Whichever channel indices answered `CHAN_NAME`. A
  two-channel receiver simply does not reply for channels 3 and 4. This is
  preferred over the count implied by the model string, so a receiver with a
  card pulled — or a model string this build does not recognise — is described
  by what it does rather than by a table.

Because the probe learns the model, the discovered device carries it through to
the inventory row rather than being guessed at from its name. That matters more
for Shure than for other manufacturers: a device called "Rack1" would otherwise
be filed as a receiver of model "Rack1", and the model is what selects the
command vocabulary.

Announcements repeat every few seconds, so probed addresses are remembered —
otherwise every announcement would open a TCP connection, forever. A device
removed from inventory is forgotten again, so it can be offered a second time.

The port needs opening on both deployment shapes: the Ubuntu installer adds
`ufw allow 8427/udp` and the desktop build adds a matching Windows Firewall
rule, alongside the ones already there for mDNS and G3/G4.

**An earlier version of this document said the service type "is not in any
document found" and that discovery "will need a capture from a real device".
That was wrong — it was in Shure's own ports PDF and in micboard, neither of
which had been checked at the time.**

## What has and has not been verified

Every format above now has at least two independent sources, and the ones that
matter most have three (Shure's document, micboard, Companion). The cross-check
was worth doing: it found a wrong RF offset for ULX-D, a wrong audio offset for
ULX-D, a battery percentage wrongly believed not to exist, three invented
parameter names, and the discovery error above.

One part *has* been verified for real, because it is a purely local
operation: the SLP listener binds UDP 8427, joins 239.255.254.253 on a physical
interface, and receives and parses a multicast datagram. Confirmed by hand on
Windows 11 and covered by tests that send an announcement to the running
listener.

What still cannot be confirmed without a receiver on the bench:

- **No command-strings exchange has run against real hardware.** The simulated
  device believes the same specification the client does, so a shared
  misreading of the spec passes both. That is the honest limit of this
  approach.
- Whether a real AD4D answers `< GET n ALL >` with the full set, rather than
  needing per-parameter GETs.
- The actual RSSI range a working link produces in a room, and therefore
  whether the −95/−35 dBm window puts the CRITICAL threshold where an operator
  would want it.
- Whether the ULX-D audio field really is dBFS (the range is documented, the
  units are not).
- **The announcement payload.** The `cd:` field is the only one whose format is
  known, from micboard's parser. What else a real announcement carries, and
  whether every supported model announces at all, is unknown — which is exactly
  why the probe does the identifying and the announcement only supplies an
  address.
- Whether a receiver answers a probe promptly enough for the 350 ms quiet
  window and 2.5 s timeout on a loaded network.
