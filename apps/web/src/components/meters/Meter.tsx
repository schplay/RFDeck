import React from 'react';
import { useMeterStore } from '../../stores/meterStore';
import { useMeterValue } from '../../hooks/useMeterValue';
import { segmentsFor, toneFor, LOW_IS_BAD, MeterKind, Thresholds } from '../../lib/meterMath';
import './Meter.css';

// The one meter, used everywhere a level is drawn.
//
// The dashboard, Backstage and the Micboard each had their own — different
// segment counts, different thresholds, different colours, all compiled in.
// This is the single implementation they now share, drawing from the meter
// settings so that a change made once applies to every view at once.

interface Props {
  /** Raw 0–100 reading from telemetry. */
  value: number;
  kind: MeterKind;
  /** Segmented bars for the dashboard and Backstage; a fill bar for the Micboard. */
  variant?: 'segments' | 'bar';
  orientation?: 'vertical' | 'horizontal';
  segments?: number;
  /**
   * Override the thresholds from settings — for a battery meter, whose
   * thresholds are the server's alert settings rather than a display
   * preference.
   */
  thresholds?: Thresholds;
  lowIsBad?: boolean;
  label?: string;
  className?: string;
}

export function Meter({
  value: raw,
  kind,
  variant = 'segments',
  orientation = 'vertical',
  segments = 10,
  thresholds,
  lowIsBad,
  label,
  className = '',
}: Props) {
  const settings = useMeterStore(s => s[kind]);
  const colors = useMeterStore(s => s.colors);
  const t = thresholds ?? settings;
  const low = lowIsBad ?? LOW_IS_BAD[kind];
  const { value, peak } = useMeterValue(Number.isFinite(raw) ? raw : 0);

  const style = {
    '--meter-good': colors.good,
    '--meter-warn': colors.warn,
    '--meter-crit': colors.crit,
  } as React.CSSProperties;

  const ariaLabel = `${label ?? kind.toUpperCase()} ${Math.round(value)}%`;

  if (variant === 'bar') {
    const tone = toneFor(value, t, low);
    const pct = Math.max(0, Math.min(100, value));
    const peakPct = Math.max(0, Math.min(100, peak));
    return (
      <div className={`meter meter-bar meter-${tone} ${className}`} style={style} role="meter" aria-label={ariaLabel} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-bar-fill" style={{ width: `${pct}%` }} />
        {peak > value + 0.5 && (
          <div className="meter-bar-peak" style={{ left: `calc(${peakPct}% - 1px)` }} />
        )}
      </div>
    );
  }

  const segs = segmentsFor(value, peak, segments, t, low);
  // Vertical meters fill from the bottom, so the top segment is drawn first.
  const ordered = orientation === 'vertical' ? [...segs].reverse() : segs;

  return (
    <div className={`meter meter-segments meter-${orientation} ${className}`} style={style} role="meter" aria-label={ariaLabel} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      {ordered.map((s, i) => (
        <div
          key={i}
          className={`meter-seg${s.lit ? ` lit tone-${s.tone}` : ''}${s.peak ? ` peak tone-${s.tone}` : ''}`}
        />
      ))}
    </div>
  );
}
