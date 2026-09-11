# Coordination device profiles — research (C.13, part 1)

What each supported family publishes about its tuning range, step size and
minimum spacing, and — the question that decides the design — whether the
receiver *tells RFDeck its band* over the protocol RFDeck already speaks.

Everything below was read from the manufacturer's own document or from the
open-source implementation named in *Sources*. Where a value could not be
found in an accessible source it is marked **unverified** and must not be
promoted to a profile constant until it has been — on the rig or in a document.

## The finding that shapes the design

The receiver reports its band for **two** of the six families, its own carrier
limits for one, and nothing at all for the other three:

| Family | Band over the protocol | Where the tuning range comes from |
|---|---|---|
| Shure Axient Digital (AD4D/AD4Q) | **Yes** — `< GET RF_BAND >` → `< REP RF_BAND {G55 } >` (8-char string) | band code → table below |
| Shure ULX-D | **No** — `RF_BAND` is not in the ULX-D command set | operator declares the band |
| Shure QLX-D | **No** | operator declares the band |
| Shure SLX-D | Reported by Companion as `RF_BAND` (device list `FW_VER,DEVICE_ID,RF_BAND,MODEL,LOCK_STATUS`) — **unverified against Shure's own SLX-D document** | band code → table (not yet compiled) |
| Sennheiser EW-DX | **Yes** — `/device/frequency_code` (SSC v1; Companion reads it). SSCv2 path `/api/device/frequency_code` is already in `SSCClient`'s diagnostic probe list but its reply has **not been seen on the rig** | code → table below |
| Sennheiser Digital 6000 (EM 6000) | **Better** — `/rx1/carrier` publishes its own limits: `min 470100, max 713900, inc 25` (kHz). The A/B band is a *transmitter* property and is not reported | the receiver's own limits; transmitter band declared by the operator if it matters |
| Sennheiser G3/G4 (MCP) | **No** — MCP carries only `Name Frequency RF1 RF2 RF AF States Bat Msg` | operator declares the range letter |

So a device's band is a **stored attribute with provenance**: `reported` when
the protocol gave it, `declared` when the operator set it. Where it is neither,
the coordinator can offer the bands whose range contains the current carrier
as candidates, but must not silently pick one — a ULX-D on 540.000 MHz is in
G50, H50 *and* H52.

Transmission-mode (density) is reported wherever the band is, plus ULX-D:

| Family | Mode over the protocol |
|---|---|
| Axient Digital | `< GET TRANSMISSION_MODE >` → `STANDARD` / `HIGH_DENSITY` (GET/REP only) |
| ULX-D | `< GET HIGH_DENSITY >` → `ON` / `OFF` (GET/SET/REP) |
| QLX-D | none (no HD mode) |
| EW-DX | `/device/link_density_mode` boolean |
| Digital 6000 | LR/LD is a system mode; a receiver-side address for it was **not found** in the SSC v2.2 method list |
| G3/G4 | n/a |

## Step size and minimum spacing

| Family | Tuning step | Minimum carrier spacing | Source |
|---|---|---|---|
| Axient Digital | 25 kHz, "varies by region"; `FREQUENCY` is "Range and Step per the RF Band" | Standard **350 kHz**, High Density **125 kHz** | AD4 user guide, Specifications; AD command strings |
| ULX-D | 25 kHz, "varies by region" | Standard **350 kHz**, HD **125 kHz** ("channel spacing … reduced from 350 kHz to 125 kHz") | ULX-D user guide |
| QLX-D | 25 kHz, "varies by region" | Not stated as a number. Guide quotes the same 17 systems per 6 MHz TV channel as ULX-D standard mode → **assume 350 kHz, unverified** | QLX-D user guide |
| EW-DX | Factory presets sit on a **600 kHz** grid (Q1-9 table: 470.200, 470.800, 471.400 …). Manual tuning step **not found** in any accessible document — do not assume 25 kHz | Standard **600 kHz**, Link Density **300 kHz**, "equidistant grid" (146 / 293 channels per range) | Q1-9 frequency table; EW-D/EW-DX System Design Guide |
| Digital 6000 | **25 kHz** (`inc: 25` on `/rx1/carrier`; manual: "adjust a frequency in 25 kHz steps") | LR **400 kHz**, LD **200 kHz**, equidistant grid | SSC v2.2 §8.17; Digital 6000 manual |
| G3/G4 | **25 kHz** ("Max 1680 receiving frequencies, adjustable in 25 kHz steps") | Not published as a number; banks are "calculated to be intermodulation-free". **Needs a decision** — use the engine's guard and a conservative figure, and say so in the UI | EK IEM G4 technical data; Sennheiser G3/G4 help |

Cross-family spacing: take the larger of the two families' minimums. That is
conservative and defensible; anything cleverer is unpublished.

### IF and image frequencies

Nobody publishes them. Shure states "Image Rejection >70 dB, typical" (AD,
ULX-D, QLX-D); Sennheiser states ">100 dB, typical, double superheterodyne"
for the EM 6000. **Image products will not be modelled.** The solver covers
carrier spacing and third/fifth-order intermod (already in `intermod.ts`),
which is what the manufacturers' own tools visibly do.

## Band tables

Ranges in MHz, as printed. Gaps are part of the profile — a plan that lands in
608–614 on a G57 is wrong, not merely suboptimal.

### Shure Axient Digital (AD4 user guide, "Receiver Frequency Bands")

| Band | Range | Band | Range |
|---|---|---|---|
| G53 | 470–510 | K55 | 606–694 |
| G54 | 479–565 | K56 | 606–714 |
| G55 | 470–636, gap 608–614 | K57 | 606–790 |
| G56 | 470–636 | K58 | 622–698 |
| G57 | 470–616, gap 608–614 (G57+ adds 614–616 at ≤10 mW) | L54 | 630–787 |
| G62 | 510–530 | L60 | 630.125–697.875 |
| H54 | 520–636 | P55 | 694–703, 748–758, 803–806 |
| K53 | 606–698, gap 608–614 | R52 | 794–806 |
| K54 | 606–663, gaps 608–614 and 616–653 | JB | 806–810 |
| | | X51 | 925–937.5 |
| | | X55 | 941–960 |
| | | Z16 | 1240–1260 (Japan) |

Receiver hardware variants: AD4D=A 470–636, =B 606–810, =C 750–960. `RF_BAND`
is what to trust; the variant is only which codes a unit can offer.

### Shure ULX-D (ULX-D user guide, "Frequency Range and Transmitter Output Power")

G50 470–534 · G51 470–534 · G52 479–534 · G53 470–510 · G54 479–565 ·
G55 470–608 & 614–636 · G56 470–636 · G57 470–608 · G62 510–530 · G65 470–606 ·
G66 487–606 · H50 534–598 · H51 534–598 · H52 534–565 · H54 520–636 ·
J50 572–636 · J50A 572–608 · J51 572–636 · K51 606–670 · L50 632–696 ·
L51 632–696 · L53 632–714 · M19 694–703 · P51 710–782 · R51 800–810 ·
JB 806–810 (Tx only) · AB 770–810 · Q12 748–758 · Q51 794–806.
(The guide's table continues onto a further page that was not captured; treat
the list as incomplete until it is.)

### Shure QLX-D (QLX-D user guide, same table)

G50 470–534 · G51 470–534 · G52 479–534 · G53 470–510 · G62 510–530 ·
H50 534–598 · H51 534–598 · H52 534–565 · H53 534–598 · J50 572–636 ·
J51 572–636 · JB 806–810 · K51 606–670 · K52 606–670 · L50 632–696 ·
L51 632–696 · L52 632–694 · L53 632–714 · M19 694–703 · P51 710–782 ·
P52 710–782 · Q12 748–758 · Q51 794–806 · S50 823–832 & 863–865 ·
V50 174–216 · V51 174–216 · V52 174–210 · X51 925–937.5 · X52 902–928 ·
X53 902–907.5 & 915–928 · X54 915–928 · Z17 1492–1525 · Z18 1785–1805 ·
Z19 1785–1800 · Z20 1790–1805.

### Sennheiser EW-DX (EW-D/EW-DX instruction manual, product listing)

| Code | Range |
|---|---|
| Q1-9 | 470.2–550 |
| R1-9 | 520–607.8 |
| R4-9 | 552–607.8 |
| S1-10 | 606.2–693.8 |
| S2-10 | 614.2–693.8 |
| S4-10 | 630–693.8 |
| U1/5 | 823.2–831.8 & 863.2–864.8 |
| V3-4 | 925.2–937.3 |
| V5-7 | 941.7–951.8 & 953.05–956.05 & 956.65–959.65 |
| Y1-3 | 1785.2–1799.8 |

The exact string the device returns for `frequency_code` (e.g. `Q1-9` vs
`Q1_9`) is **unverified** — read it off the rig before keying a table on it.

### Sennheiser Digital 6000

Receiver: 470.1–713.9 MHz from its own `/rx1/carrier` limits (regional
variants exist; always read the limits rather than assuming). Transmitter
bands from the manual: A1-A4 470.2–558, A5-A8 550–638 (from the frequency
table header), B1-B4 630–718 (JP 630–713.85, KO 630–697.9).

The receiver also exposes its factory banks (`/rx1/freq/b1..b6/00..99`, read
only) and user banks (`u1..u6`), and `/rx1/active_bank_channel`.

### Sennheiser G3/G4 (EK IEM G4 technical data; G4 bank documentation)

A1 470–516 · A 516–558 · AS 520–558 · G 566–608 · GB 606–648 · B 626–668 ·
C 734–776 · C-TH 748.2–757.8 · D 780–822 · E 823–865. The G4 range list also
names **K+** and **1G8**; their numeric ranges were not in the pages read.

## Deployment notes (part 3) learned along the way

- Shure: `SET x FREQUENCY` is kHz without padding (RFDeck already does this).
  Setting a frequency makes the receiver report `GROUP_CHANNEL {--,--}` —
  expected, not an error. Axient channels in **FD-C mode** carry a second
  carrier (`FREQUENCY2`/`GROUP_CHANNEL2`) that RFDeck does not model; the
  coordinator must treat such a channel as two transmitters or refuse it.
- Digital 6000: `/rx1/carrier` in kHz, and the device will "adapt an
  out-of-range argument to the allowed range" silently — read back after
  writing. Its full-band RF scan (`/rx1/scan/config` →
  `[1, start_hz, stop_hz, step_hz]`, results blockwise on `/rx1/scan/result`)
  is the first real input for C.3.
- EW-DX: RFDeck sets `rx{n}/frequency` over SSCv2 today; whether the device
  snaps to a grid, and which, is **unverified**.
- G3/G4: `Frequency <kHz>` over MCP, the unit the receiver's own `Frequency`
  line reports. Sending is **unverified**; only reading is proven.
- Every driver now reaches `setFrequency` through the capability check
  rather than `instanceof SSCClient`, which had silently limited tuning to
  EW-DX.

## What this does to the C.13 estimate

It does not invalidate it; it changes the shape. The solver is unchanged. The
profile layer is a static table keyed on `(vendor, family, bandCode)` →
`{ segments: [minKHz, maxKHz][], stepKHz, spacingKHz: { standard, dense } }`,
plus a per-device `band` attribute with provenance and a UI to declare it
where the hardware will not. The three things to verify on the rig before the
table is trusted: the EW-DX `frequency_code` string and its SSCv2 path, the
EW-DX manual tuning step, and SLX-D `RF_BAND`.

## Sources

Read directly (text extracted from the PDF or page, not a search summary):

- Shure *Axient Digital Command Strings* (content-files.shure.com/Pubs/AD4D/…) — `RF_BAND`, `TRANSMISSION_MODE`, `FREQUENCY`, `GROUP_CHANNEL`, FD-C notes.
- Shure *ULX-D Command Strings* (musson mirror of Shure's PDF) — `HIGH_DENSITY`, `FREQUENCY`, `GROUP_CHAN`, `MODEL`, `SCAN_LOCK`; no `RF_BAND`.
- Shure *QLX-D Command Strings* (content-files.shure.com/Pubs/qlxd4/…) — no `RF_BAND`, no `HIGH_DENSITY`.
- Shure AD4D/AD4Q, ULX-D, QLX-D user guides (pubs.shure.com/view/guide/…) — step size, spacing, band tables.
- Shure *Axient Digital Frequency Compatibility Supplement* — band index and factory group tables.
- Sennheiser *SSC Developer's Guide for Digital 6000* v2.2 (TI 1109) — `/rx1/carrier` limits, banks, scan.
- Sennheiser *Digital 6000* instruction manual (docs.cloud.sennheiser.com, 04/2026) — 25 kHz steps, LR/LD spacing, transmitter ranges.
- Sennheiser *EW-D / EW-DX* instruction manual (09/2026) — frequency-code ranges.
- Sennheiser *EW-DX Q1-9 frequency range* table (04/2023) — 600 kHz preset grid.
- Sennheiser *EW-D & EW-DX System Design Guide* (2025) — equidistant grid, 600/300 kHz, 146/293 channels.
- Sennheiser *EK IEM G4 technical data*, *G4 frequency bank system* pages — G4 ranges, 25 kHz, bank counts.
- Sennheiser *3rd Party API* PDF (08/2026) — confirms the EW-DX OpenAPI is online-only (Swagger); no offline copy.
- bitfocus `companion-module-shure-wireless` `internalAPI.js` — per-family device/channel parameter lists; SLX-D `RF_BAND`.
- bitfocus `companion-module-sennheiser-ewdx` `ewdxReceiver.ts` — `/device/frequency_code`, `/device/link_density_mode`.

Not accessible to the fetcher (403 / JS-only): Shure's pubs portal pages,
Sennheiser's Swagger UI, the EW-DX EM2/EM4 product-specification PDFs, and the
SLX-D command-strings page.
