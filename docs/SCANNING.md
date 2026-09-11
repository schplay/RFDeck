# Spectrum scanning — exploration (C.3)

What could give RFDeck a picture of the spectrum, as opposed to the carriers
its own receivers sit on. Read from the manufacturers' protocol documents and
the coordination tools' own import specifications; anything not found in an
accessible source is marked **unverified**.

## The question

RFDeck already holds the plan — every tracked channel's frequency, and since
C.13 the coordination behind it. What makes a scan valuable is the
*difference* between the two: energy where the plan says there is none. That
is the feature (eighty32's Freq Show does exactly this), and it needs a source
of spectrum. There are three kinds.

## 1. Receivers already in the rack

| Family | Scan over a protocol RFDeck speaks? | Source |
|---|---|---|
| Sennheiser Digital 6000 (EM 6000) | **Yes, fully specified.** `/rx1/scan/config` ← `[1, start_hz, stop_hz, step_hz]` (step auto-corrected to a multiple of 25 000 Hz); reply appends a session id; `[0]` stops (~100 ms). Results on `/rx1/scan/result`, subscribable, delivered blockwise as `[start, stop, step, block_start, block_stop, session, RF1,RF2, RF1,RF2 …]` with the `/mm` byte mapping **dBm = (v − 255) / 2**. A `[block_start, block_stop]` write returns just that span, "also when no session is running". Also `/rx1/walktest`. | SSC Developer's Guide for Digital 6000 v2.2, §8.18–8.19, §8.100 |
| Sennheiser EW-DX | **No.** The SSC v1 method list has no scan address; AutoScan is a front-panel/WSM function. The SSCv2 OpenAPI is online-only and **unverified**. | EW-DX Sound Control Protocol (03/2023), full method list |
| Sennheiser G3/G4 | **No.** MCP carries `Name Frequency RF1 RF2 RF AF States Bat Msg`. WSM's scans with these use the receiver's own scan and WSM's own transport. | RFDeck's MCP parser; Sennheiser WSM help |
| Shure Axient Digital, ULX-D, QLX-D | **No.** The third-party command strings contain no scan command (ULX-D has only `SCAN_LOCK`, which *prevents* changes while "another device deploys a group scan"). WWB scans with these receivers over Shure's private device protocol. | AD, ULX-D and QLX-D command-string documents |
| Shure AXT600 / AD600 spectrum managers | **No third-party interface found.** Scan data goes to WWB ("save the scan on the hardware before you import it"). | AXT600 user guide; WWB Scanning |

So: one family can scan for RFDeck today, and it happens to be the one whose
receiver also publishes its own tuning limits. Whether an EM 6000 channel
stops receiving while it scans is **not stated** in the spec and must be
checked on hardware before RFDeck offers to scan on a live channel.

## 2. A sensor of RFDeck's own

| Device | Interface | Fit |
|---|---|---|
| **RF Explorer** (handheld, and the 3G/6G/Plus modules) | USB serial (CP210x), documented UART API: 500 kbps; `#<len>C2-F:<start7>,<end7>,<top4>,<bottom4>` sets the sweep (kHz, dBm); config reply `#C2-F:<start>,<step>,<top>,<bottom>,<points>,…`; sweeps arrive continuously as `$S<n>` + n bytes, **dBm = −byte / 2**. | The show-site standard: WWB, WSM and IAS all import its CSV. A small reader — on the server, or a node on the show LAN posting to RFDeck — is a day's work against a documented protocol. Dynamic range and RBW are those of a handheld analyser, which is what these tools already accept. |
| **RTL-SDR** (`rtl_power`) | USB; sweeps as CSV rows `date,time,hz_low,hz_high,step,samples,dB…` | Cheap and everywhere, but no front-end filtering: next to a rack of 50 mW transmitters it overloads, and its levels are relative. Usable as a *presence* sensor ("something is at 590.4 that was not there"), not as a measurement. Worth supporting as a second reader once the first exists; not the one to design around. |
| TinySA and others | Serial APIs exist | Not researched. The scan model below is device-agnostic on purpose. |

## 3. Scan files

Every coordination tool exchanges scans as frequency/level pairs, and this
is how a scan taken by one tool reaches another today:

- **WWB import**: `.csv`/`.txt`/`.spa`; "must not include any header
  information … frequency values, followed by a comma, followed by a signal
  level"; "minimum step size for all scan files is 25 kHz". Named sources:
  WiNRADiO `.35s`, TTi, RF Explorer, Sennheiser and R&S `.csv`, Anritsu
  `.spa`. WWB's own `.sdb2` is proprietary; a community converter exists.
- **WSM export**: `.csv`, `Frequency;RF level (%);RF level` (kHz; percent;
  dBm) per line.

Reading these gives RFDeck an environment layer from a scan somebody already
took with WWB or WSM; writing the WWB pair format gives those tools RFDeck's
scans. Both are parsers with fixtures — no hardware.

## What this means for C.3

The value was clear and the input was not. The input is now clear enough to
stage, smallest and most certain first:

1. **Scan model, import, export, and the environment layer** — S. A scan is
   `{ source, takenAt, startKHz, stepKHz, levelsDbm[] }`. Import WWB/WSM CSV,
   export the WWB pair form, store, draw on the RF page's frequency map
   under the carriers. Derive coordination exclusions from a scan's
   peak-hold above a threshold, the way WWB does, and hand them to the C.13
   solver. Pure parsers, fixtures, no hardware.
2. **Digital 6000 as a scanner** — M. Drive `/rx1/scan` from RFDeck into the
   same model. Needs one answer from the rig first: does the channel drop
   audio while it scans? If yes, offer it only on an idle channel.
3. **RF Explorer reader** — M. Serial reader producing continuous sweeps
   into the model; then the feature the whole item exists for: **carriers
   not in the plan**. Peak detection over the latest sweep, ignore anything
   within guard of a tracked channel, alert on the rest through the C.2
   dispatcher. Needs an RF Explorer to verify against; the protocol is
   documented well enough to write the reader and its tests without one.
4. **RTL-SDR reader** — S, after 3, as a presence sensor with its levels
   labelled relative.

Nothing here requires an SDR of RFDeck's own to be *designed*; only stage 3
requires one to be *verified*.

## Corrections to the record

- README's manufacturer table listed "spectrum scan" among EW-DX
  capabilities. Nothing in RFDeck did that, and the EW-DX SSC v1 method
  list has no scan. Removed.
- The EW-DX SSC v1 document confirms `/device/frequency_code` returns the
  code as printed, e.g. `{"device":{"frequency_code":"Q1-9"}}` — the string
  form the C.13 profile table is keyed on. Its arrival over the UDP
  subscription RFDeck sends is still to be seen on the rig.

## Sources

- Sennheiser *SSC Developer's Guide for Digital 6000* v2.2 (TI 1109) — §8.18 `/rx1/scan/config`, §8.19 `/rx1/scan/result`, §8.100 `/mm`.
- Sennheiser *EW-DX Sound Control Protocol* (03/2023), 70 pp. — full method list; `/device/frequency_code` §8.27.
- Shure *Axient Digital*, *ULX-D*, *QLX-D Command Strings* — no scan commands.
- Shure *Wireless Workbench — Scanning* (content-files.shure.com/Pubs/WWB) — import format, sources, scan settings, 8-hour continuous scans.
- Shure *AXT600 Spectrum Manager* user guide.
- RF Explorer *UART API interface specification* (github.com/RFExplorer/RFExplorer-for-.NET/wiki).
- Sennheiser WSM help — receiver-driven scans, CSV export form.
