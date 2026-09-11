import { useEffect, useRef, useState } from 'react';
import { useMeterStore } from '../stores/meterStore';
import { initialMeterState, stepMeter, MeterState } from '../lib/meterMath';

// One shared clock for every meter on the page.
//
// Ballistics and peak hold need to advance between telemetry frames, which
// arrive a few times a second. A requestAnimationFrame loop per meter would be
// hundreds of loops on a big rig; one interval that every meter subscribes to
// costs the same whether there are three meters or three hundred. 12 Hz is
// enough for a bar to fall smoothly and for a peak to be seen holding.

const TICK_MS = 83;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => listeners.forEach(l => l()), TICK_MS);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

/**
 * A reading with ballistics and peak hold applied, per the meter settings.
 *
 * Feed it the raw telemetry value; it returns what to draw. Re-renders on the
 * shared tick only while something is still moving, so a rig sitting still
 * costs nothing.
 */
export function useMeterValue(reading: number): { value: number; peak: number } {
  const ballistics = useMeterStore(s => s.ballistics);
  const peakHold   = useMeterStore(s => s.peakHold);
  const holdMs     = useMeterStore(s => s.peakHoldMs);

  const ref = useRef<MeterState>(initialMeterState(Date.now(), reading));
  const [, force] = useState(0);

  // A new reading is applied immediately, so attack is never late by a tick.
  const last = useRef(reading);
  if (last.current !== reading) {
    last.current = reading;
    ref.current = stepMeter(ref.current, Date.now(), reading, ballistics, peakHold, holdMs);
  }

  useEffect(() => subscribe(() => {
    const s = ref.current;
    const settled = Math.abs(s.value - last.current) < 0.05 && Math.abs(s.peak - s.value) < 0.05;
    if (settled && ballistics === 'instant' && !peakHold) return;
    const next = stepMeter(s, Date.now(), null, ballistics, peakHold, holdMs);
    const moved = Math.abs(next.value - s.value) > 0.05 || Math.abs(next.peak - s.peak) > 0.05;
    ref.current = next;
    if (moved) force(n => n + 1);
  }), [ballistics, peakHold, holdMs]);

  return { value: ref.current.value, peak: ref.current.peak };
}
