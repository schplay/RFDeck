import React, { useRef, useEffect } from 'react';
import { Channel } from '@rfdeck/shared-types';
import type { ScanData } from '../../../stores/scanStore';

interface Props {
  channels: Channel[];
  /** An imported spectrum scan to draw under the carriers, if one is selected. */
  scan?: ScanData | null;
}

// ── Frequency & signal map ──
//
// Two layers, and they are deliberately not on the same axis.
//
// The carriers are what our own receivers report, at the 0–100 quality they
// report — not calibrated dBm, so labelled as a percentage on the left.
//
// The scan, when there is one, is a measurement somebody took of the room
// with an analyser and imported: real dBm, labelled on the right. Without a
// scan there is no noise floor drawn, because that would imply a measurement
// nobody made.

const SCAN_TOP_DBM = -30;
const SCAN_BOTTOM_DBM = -110;

/** The span to draw: the UHF core, widened to whatever the data actually covers. */
export function displayRange(channels: Channel[], scan?: ScanData | null): [number, number] {
  let lo = 470_000, hi = 608_000;
  for (const ch of channels) {
    if (!ch.frequency) continue;
    lo = Math.min(lo, ch.frequency); hi = Math.max(hi, ch.frequency);
  }
  if (scan) { lo = Math.min(lo, scan.startKHz); hi = Math.max(hi, scan.endKHz); }
  // Round out to 10 MHz so the labels land on round numbers.
  return [Math.floor(lo / 10_000) * 10_000, Math.ceil(hi / 10_000) * 10_000];
}

export function SpectrumCanvas({ channels, scan }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const padLeft = 40;
    const padRight = scan ? 40 : 8;
    const padBottom = 24;
    const plotW = W - padLeft - padRight;
    const plotH = H - padBottom - 8;
    const [FREQ_MIN, FREQ_MAX] = displayRange(channels, scan);
    const xOf = (kHz: number) => padLeft + ((kHz - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * plotW;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(59, 73, 75, 0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = 8 + (plotH / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const x = padLeft + (plotW / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, 8 + plotH);
      ctx.stroke();
    }

    // The scan, first, so the carriers sit on top of it.
    if (scan) {
      const yOfDbm = (dBm: number) => {
        const t = (Math.min(SCAN_TOP_DBM, Math.max(SCAN_BOTTOM_DBM, dBm)) - SCAN_BOTTOM_DBM) / (SCAN_TOP_DBM - SCAN_BOTTOM_DBM);
        return 8 + plotH - t * plotH;
      };
      ctx.beginPath();
      let drawing = false;
      scan.levelsDbm.forEach((dBm, i) => {
        const kHz = scan.startKHz + i * scan.stepKHz;
        if (dBm === null) { drawing = false; return; }
        const x = xOf(kHz), y = yOfDbm(dBm);
        if (!drawing) { ctx.moveTo(x, 8 + plotH); ctx.lineTo(x, y); drawing = true; }
        else ctx.lineTo(x, y);
        const next = scan.levelsDbm[i + 1];
        if (next === null || next === undefined) { ctx.lineTo(x, 8 + plotH); drawing = false; }
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(150, 130, 90, 0.28)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(210, 180, 120, 0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Right axis: dBm, for the scan only.
      ctx.fillStyle = 'rgba(210, 180, 120, 0.6)';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const dBm = SCAN_TOP_DBM - ((SCAN_TOP_DBM - SCAN_BOTTOM_DBM) / 4) * i;
        ctx.fillText(`${dBm}`, W - padRight + 4, yOfDbm(dBm) + 4);
      }
    }

    // Y-axis: reported signal strength as a percentage. Receivers give us a
    // 0–100 quality figure, not calibrated dBm, so labelling it in dBm would
    // be inventing precision the hardware never reported.
    ctx.fillStyle = 'rgba(185, 202, 203, 0.4)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    const signalLabels = ['100%', '80', '60', '40', '20', '0'];
    signalLabels.forEach((label, i) => {
      const y = 8 + (plotH / 5) * i;
      ctx.fillText(label, padLeft - 4, y + 4);
    });

    // X-axis labels, on the round numbers of whatever span is shown.
    ctx.textAlign = 'center';
    const labelCount = 8;
    for (let i = 0; i <= labelCount; i++) {
      const kHz = FREQ_MIN + ((FREQ_MAX - FREQ_MIN) / labelCount) * i;
      ctx.fillText(String(Math.round(kHz / 1000)), xOf(kHz), H - 6);
    }

    // Baseline. A flat rule, not a simulated noise floor — it marks zero, and
    // claims nothing about what is actually on air between our channels.
    ctx.beginPath();
    ctx.moveTo(padLeft, 8 + plotH);
    ctx.lineTo(W - padRight, 8 + plotH);
    ctx.strokeStyle = 'rgba(59, 73, 75, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Channel peaks
    channels.forEach((ch) => {
      if (!ch.frequency) return;
      const freqKhz = ch.frequency; // frequency stored in kHz
      if (freqKhz < FREQ_MIN || freqKhz > FREQ_MAX) return;

      const cx = xOf(freqKhz);
      const peakStrength = Math.max(0.1, ch.rfLevelA / 100); // 0–1
      const peakH = peakStrength * plotH * 0.85;

      // Peak fill gradient
      const grad = ctx.createLinearGradient(cx, 8 + plotH - peakH, cx, 8 + plotH);
      const color = ch.status === 'CRITICAL' ? '255,180,171' :
                    ch.status === 'WARNING' ? '255,167,100' : '0,219,233';
      grad.addColorStop(0, `rgba(${color}, 0.5)`);
      grad.addColorStop(1, `rgba(${color}, 0.0)`);

      // Peak shape (triangle)
      ctx.beginPath();
      ctx.moveTo(cx - 12, 8 + plotH);
      ctx.lineTo(cx, 8 + plotH - peakH);
      ctx.lineTo(cx + 12, 8 + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Peak line glow
      ctx.beginPath();
      ctx.moveTo(cx, 8 + plotH);
      ctx.lineTo(cx, 8 + plotH - peakH);
      ctx.strokeStyle = `rgba(${color}, 0.9)`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = `rgba(${color}, 0.7)`;
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Dot at peak
      ctx.beginPath();
      ctx.arc(cx, 8 + plotH - peakH, 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color}, 1)`;
      ctx.fill();
    });
  }, [channels, scan]);

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={200}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
