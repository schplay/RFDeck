import React, { useRef, useEffect } from 'react';
import { Channel } from '@rfdeck/shared-types';

interface Props {
  channels: Channel[];
}

// ── Frequency & signal map ──
//
// RFDeck does not perform spectrum scanning. This plots the frequencies our
// connected receivers report, at the signal strength they report. Everything
// drawn here traces to a real device reading — there is deliberately no
// synthetic noise floor, which would imply measurement we are not doing.

// Display range (kHz) — the UHF band these receivers operate in.
const FREQ_MIN = 470000;
const FREQ_MAX = 608000;

export function SpectrumCanvas({ channels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const padLeft = 40;
    const padBottom = 24;
    const plotW = W - padLeft - 8;
    const plotH = H - padBottom - 8;

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
      ctx.lineTo(W - 8, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const x = padLeft + (plotW / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, 8 + plotH);
      ctx.stroke();
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

    // X-axis labels
    ctx.textAlign = 'center';
    const freqLabels = [470, 490, 510, 530, 550, 570, 590, 608];
    freqLabels.forEach((freq, i) => {
      const x = padLeft + (plotW / (freqLabels.length - 1)) * i;
      ctx.fillText(String(freq), x, H - 6);
    });

    // Baseline. A flat rule, not a simulated noise floor — it marks zero, and
    // claims nothing about what is actually on air between our channels.
    ctx.beginPath();
    ctx.moveTo(padLeft, 8 + plotH);
    ctx.lineTo(W - 8, 8 + plotH);
    ctx.strokeStyle = 'rgba(59, 73, 75, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Channel peaks
    channels.forEach((ch) => {
      if (!ch.frequency) return;
      const freqKhz = ch.frequency; // frequency stored in kHz
      const normX = (freqKhz - FREQ_MIN) / (FREQ_MAX - FREQ_MIN);
      if (normX < 0 || normX > 1) return;

      const cx = padLeft + normX * plotW;
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
  }, [channels]);

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={200}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
