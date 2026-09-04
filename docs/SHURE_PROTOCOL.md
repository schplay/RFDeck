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
- **[Shure device IP ports and protocols](https://content-files.shure.com/FileRepository/common-ip-ports-v2.pdf)**
  — confirms 2202/TCP and 5353/UDP mDNS.

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

| Parameter | Format | Conversion |
|---|---|---|
| `RSSI` | 3 digits | dBm = reported − 120 |
| `AUDIO_LEVEL_RMS`, `AUDIO_LEVEL_PEAK` | 3 digits | dBFS = reported − 120, range −120…0 |
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

- **Audio.** `afLevel = 100 + dBFS = 100 + (reported − 120) = reported − 20`.
  This falls out of RFDeck's existing convention, and independently matches what
  micboard does for Axient (`audio_level - 20`). Two derivations agreeing is
  worth more than either alone.
- **RF.** `rfLevel = 100 × reported / 115`, which is micboard's mapping. In dBm
  that is 0% at −120 dBm and 100% at −5 dBm. It matters that the result lands
  the existing thresholds somewhere sensible, and it does: RFDeck calls a
  channel CRITICAL below 20 (−97 dBm) and marginal below 35 (−80 dBm), which are
  reasonable numbers for a wireless mic link.
- **Battery.** `TX_BATT_BARS` is 0–5, so `percent = bars × 20`. Coarse, and
  honestly so — Axient does not report a battery percentage over this protocol.
- **Runtime.** `TX_BATT_MINS` is the transmitter's own estimate. RFDeck
  normally derives runtime by regression over observed drain; where the
  hardware states it, the hardware wins.

## Command names differ between families

The Axient document does not cover ULX-D or QLX-D, and the names are **not**
the same. Using one set for both would fail silently — a `GET` for a parameter
the device does not have simply never produces a `REP`.

| Meaning | ULX-D / QLX-D | Axient Digital |
|---|---|---|
| Battery bars | `BATT_BARS` | `TX_BATT_BARS` |
| Battery runtime | `BATT_RUN_TIME` | `TX_BATT_MINS` |
| RF level | `RX_RF_LVL` | `RSSI` |
| Audio level | `AUDIO_LVL` | `AUDIO_LEVEL_RMS` |
| Antenna | `RF_ANTENNA` | `ANTENNA_STATUS` |
| Link quality | *not supported* | `CHAN_QUALITY` |
| Channel name | `CHAN_NAME` | `CHAN_NAME` |
| Frequency | `FREQUENCY` | `FREQUENCY` |

Source: micboard `py/device_config.py`. The ULX-D scaling also differs —
micboard doubles `AUDIO_LVL` and divides `RX_RF_LVL` by 115 — which is why the
family's conversions live beside its command names rather than in one shared
function.

## Channel counts by model

From micboard's `DCID_MODEL` tables, corroborated by Shure's product pages:

| Model | Channels |
|---|---|
| AD4D | 2 |
| AD4Q | 4 |
| ULX-D single / dual / quad | 1 / 2 / 4 |
| QLX-D | 1 |

## Not yet verified on hardware

Everything below is written from the specification and cannot be confirmed
without a receiver on the bench:

- That a real AD4D accepts `< GET 0 ALL >` and answers with the full set,
  rather than needing per-parameter GETs.
- The actual RSSI range a working link produces, and therefore whether the
  0–100 mapping puts the CRITICAL threshold in a useful place in a real room.
- Whether ULX-D's `SAMPLE` has the layout micboard's indices imply — that
  family has no equivalent public document, so its parser rests on one source.
- mDNS discovery. Shure devices announce over 5353/UDP, but the service type
  string is not in any document found; discovery will need a capture from a
  real device, so RFDeck adds Shure receivers by IP until then.
