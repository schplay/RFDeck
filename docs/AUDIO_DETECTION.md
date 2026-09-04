# Detecting wireless faults in the audio itself

Notes behind `apps/server/src/recording/detectors.ts`. Written from the
restoration and broadcast-QC literature rather than from intuition, because the
failure mode of a detector nobody trusts is that it gets switched off.

## What the three faults actually look like

**The behaviour splits on modulation, not on brand.** An analog FM link degrades
gracefully into noise; a digital link holds perfect quality and then stops dead.
RFDeck sees both — G3/G4 is analog FM, EW-DX is digital — so a single detector
tuned for one is wrong for half the rack.

### 1. Dropout — digital mute, or analog squelch

A digital system "hits a 'digital cliff' and mutes entirely, resulting in dead
air"; a receiver's squelch "mutes receiver audio output if the incoming RF
signal drops below a set threshold". Either way the waveform goes to **digital
silence or near-silence, abruptly**, from whatever level it was at.

- **Signature:** RMS collapses by tens of dB within a frame or two and stays
  down. True zeros are common on a digital mute.
- **Duration:** concealment literature treats 2–100 ms as the range of a short
  mute; real dropouts run longer.
- **Confusable with:** an ordinary pause. The discriminator is *abruptness* —
  speech decays over tens of ms, a mute is instantaneous — plus the level it
  fell from.

### 2. Fuzz — analog noise burst

An analog link losing signal produces "intermittent static and fuzzing", a
"rushing sound that quickly stops (like 'pffft')", or hiss. This is **broadband
noise**: energy spread roughly evenly across the spectrum.

- **Signature:** the spectrum flattens. Spectral flatness (Wiener entropy) is
  "the geometric mean of the power spectrum, divided by the arithmetic mean";
  it runs 0→1, where "a high flatness value (close to 1.0) indicates that the
  spectrum has a similar amount of power in all spectral bands, which is likely
  noise" and a low value "would typically sound like a mixture of sine waves".
- **Cheap equivalent:** we do not need an FFT per frame per channel. The
  normalised lag-1 autocorrelation ρ₁ measures the same tilt: white noise gives
  ρ₁ ≈ 0, anything with low-frequency energy (all voiced speech) gives ρ₁ → 1.
  It is one pass over the frame.
- **Confusable with:** sibilance. `/s/` and `/ʃ/` are *also* broadband noise and
  will read as ρ₁ ≈ 0. This is the hardest false positive and is why the RF gate
  below matters.

### 3. Pop — impulsive click

Interference can produce "a brief but loud 'pop'". A click is a discontinuity
lasting a handful of samples.

- **Signature:** a large step in the high-frequency content. The standard
  detector is autoregressive prediction error; the documented cheap baseline is
  "a high-pass filter that filters coefficients, an absolute value calculator …
  and a threshold comparator". A second difference, `s[n] − 2s[n−1] + s[n−2]`,
  is a serviceable high-pass.
- **Threshold:** fixed thresholds fail as programme level changes. Use a robust
  scale estimate — MAD, which "is approximately 0.6745 times the standard
  deviation" for Gaussian data and, being median-based, does not get "dragged
  around" by the very outliers it is meant to find. We approximate it with an
  EMA that only updates on frames below the current threshold, so a click
  cannot raise the bar that would have caught it.
- **Confusable with:** plosives, mic handling, percussion.

## The discriminator the literature does not have

Every confusion above — sibilance, plosives, pauses — is a *legitimate* signal
that looks like a fault. Audio-only detection on a live vocal mic would fire
constantly, and an operator would rightly stop trusting it.

**RFDeck already knows the RF level of the same channel, at the same moment.**
That is the piece a general-purpose declicker never has. A burst of broadband
noise while RF is strong is a singer; the same burst while RF is collapsing is a
dropout. So:

- Audio evidence produces a **candidate**, with a confidence.
- A candidate is promoted to a Detection if RF was **marginal or falling**
  within a couple of seconds, **or** if the audio evidence is overwhelming on
  its own (sustained noise well past sibilant length; silence after loud
  speech).

This keeps the false-positive rate low without discarding events on channels
whose telemetry is coarse or late.

## Sizing

Per 10 ms frame the detector computes RMS, peak, zero-crossing rate, lag-1
autocorrelation and the largest second difference — one linear pass over 480
samples. At 32 channels that is roughly 1.5 M sample-operations per second,
which is negligible next to the capture already running.

## Sources

- [Anatomy of wireless dropouts, RF Venue](https://www.rfvenue.com/blog/2014/12/14/dropouts-explored)
- [Mixing analog and digital wireless, ProSoundWeb](https://www.prosoundweb.com/modern-problems-issues-when-mixing-analog-digital-wireless-systems/)
- [Digital wireless, DPA Microphones](https://www.dpamicrophones.com/mic-university/technology/digital-wireless-and-mics-it-s-digital-so-why-bother/)
- [Spectral flatness / Wiener entropy](https://en.wikipedia.org/wiki/Spectral_flatness)
- [Godsill & Rayner, *Digital Audio Restoration*](https://www.semanticscholar.org/paper/Digital-Audio-Restoration:-A-Statistical-Model-Godsill-Rayner/f76a56fc0a985a5424855e959a4ff098b4cceaf9)
- [Impulse noise filter with adaptive MAD-based threshold](https://www.researchgate.net/publication/4186529_Impulse_noise_filter_with_adaptive_MAD-based_threshold)
- [Audio mute concealment (US 8,538,038)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8538038)
