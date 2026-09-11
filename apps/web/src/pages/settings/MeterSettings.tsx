import React, { useEffect, useState } from 'react';
import { useMeterStore, METER_DEFAULTS } from '../../stores/meterStore';
import { Ballistics } from '../../lib/meterMath';
import { Meter } from '../../components/meters/Meter';

// How the meters look and move.
//
// Every one of these used to be a number somebody typed into a component and
// never revisited — and the three views disagreed with each other. They are
// preferences now, per browser, and they apply to every view at once. The
// preview at the top is live, so a change is seen before it is trusted.

const BALLISTICS_OPTIONS: Array<{ value: Ballistics; label: string; hint: string }> = [
  { value: 'instant',  label: 'Instant',  hint: 'The bar is the reading. Every telemetry frame, as it arrives.' },
  { value: 'fast',     label: 'Fast',     hint: 'Peak-reading: rises at once, falls slowly enough to be seen.' },
  { value: 'averaged', label: 'Averaged', hint: 'VU-like: moves both ways at a steady pace. Calmer, later.' },
];

export function MeterSettings() {
  const s = useMeterStore();

  // A demonstration signal for the preview: a slow sweep with the occasional
  // spike, so ballistics and peak hold have something to show.
  const [demo, setDemo] = useState({ rf: 70, af: 40 });
  useEffect(() => {
    let t = 0;
    const id = setInterval(() => {
      t += 1;
      const rf = 55 + Math.round(30 * Math.sin(t / 4)) + (t % 17 === 0 ? -35 : 0);
      const af = 45 + Math.round(25 * Math.sin(t / 3)) + (t % 11 === 0 ? 45 : 0);
      setDemo({ rf: Math.max(0, Math.min(100, rf)), af: Math.max(0, Math.min(100, af)) });
    }, 400);
    return () => clearInterval(id);
  }, []);

  // Thresholds are kept in the right order as they are typed, so the meter
  // never ends up with a warning band above its critical band.
  const setRf = (k: 'warn' | 'crit', v: number) => {
    const next = { ...s.rf, [k]: v };
    if (next.crit >= next.warn) {
      if (k === 'crit') next.warn = Math.min(100, next.crit + 1);
      else next.crit = Math.max(0, next.warn - 1);
    }
    s.update({ rf: next });
  };
  const setAf = (k: 'warn' | 'crit', v: number) => {
    const next = { ...s.af, [k]: v };
    if (next.warn >= next.crit) {
      if (k === 'warn') next.crit = Math.min(100, next.warn + 1);
      else next.warn = Math.max(0, next.crit - 1);
    }
    s.update({ af: next });
  };

  const clamp = (v: string) => Math.max(0, Math.min(100, Number(v) || 0));

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3>Meters</h3>
        <button className="btn-ghost" onClick={s.reset} title="Back to the defaults">Reset</button>
      </div>
      <p className="settings-desc">
        How levels are drawn on the dashboard, Backstage and the Micboard. These
        are preferences for this browser — a change here does not affect what
        anyone else sees, and does not change when alerts fire.
      </p>

      <div className="ms-preview" aria-label="Meter preview">
        <div className="ms-preview-col">
          <span className="ms-preview-label">RF</span>
          <div className="ms-preview-meter"><Meter value={demo.rf} kind="rf" segments={10} orientation="vertical" /></div>
        </div>
        <div className="ms-preview-col">
          <span className="ms-preview-label">AF</span>
          <div className="ms-preview-meter"><Meter value={demo.af} kind="af" segments={10} orientation="vertical" /></div>
        </div>
        <div className="ms-preview-col ms-preview-wide">
          <span className="ms-preview-label">Wall display</span>
          <div className="ms-preview-bar"><Meter value={demo.rf} kind="rf" variant="bar" /></div>
          <div className="ms-preview-bar"><Meter value={demo.af} kind="af" variant="bar" /></div>
        </div>
      </div>

      <div className="settings-form">
        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={s.peakHold}
              onChange={e => s.update({ peakHold: e.target.checked })}
            />{' '}
            Peak hold
          </label>
          <p className="settings-desc">
            Keep a tick at the highest recent reading. A transient dropout or an
            audio spike is over before the eye reaches the bar; the tick is what
            says it happened.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="ms-hold">Hold time (ms)</label>
          <input
            id="ms-hold"
            type="number"
            min={200}
            max={10000}
            step={100}
            disabled={!s.peakHold}
            value={s.peakHoldMs}
            onChange={e => s.update({ peakHoldMs: Math.max(200, Math.min(10000, Number(e.target.value) || 200)) })}
          />
        </div>

        <div className="form-group">
          {/* Labels are wired to their controls here, unlike the older forms on
              this page — a screen reader, and a test, should be able to find
              "Ballistics" and land on the select. */}
          <label htmlFor="ms-ballistics">Ballistics</label>
          <select id="ms-ballistics" value={s.ballistics} onChange={e => s.update({ ballistics: e.target.value as Ballistics })}>
            {BALLISTICS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="settings-desc">
            {BALLISTICS_OPTIONS.find(o => o.value === s.ballistics)?.hint}
          </p>
          <p className="settings-desc">
            The audio level here is the one the receiver reports, not the audio
            itself, so a true RMS reading is not possible from it. Metering from
            the audio arrives with the listen bus.
          </p>
        </div>

        <div className="form-group">
          <label>RF thresholds — low is bad</label>
          <div className="ms-pair">
            <span>Warn below</span>
            <input type="number" min={0} max={100} value={s.rf.warn} onChange={e => setRf('warn', clamp(e.target.value))} />
            <span>Critical below</span>
            <input type="number" min={0} max={100} value={s.rf.crit} onChange={e => setRf('crit', clamp(e.target.value))} />
          </div>
          <p className="settings-desc">
            Defaults match the server's dropout alert: it confirms a dropout
            at {METER_DEFAULTS.rf.crit}% and recovery at {METER_DEFAULTS.rf.warn}%, so
            out of the box a red meter and a dropout alert mean the same thing.
          </p>
        </div>

        <div className="form-group">
          <label>Audio thresholds — high is bad</label>
          <div className="ms-pair">
            <span>Warn above</span>
            <input type="number" min={0} max={100} value={s.af.warn} onChange={e => setAf('warn', clamp(e.target.value))} />
            <span>Critical above</span>
            <input type="number" min={0} max={100} value={s.af.crit} onChange={e => setAf('crit', clamp(e.target.value))} />
          </div>
        </div>

        <div className="form-group">
          <label>Colours</label>
          <div className="ms-colors">
            {(['good', 'warn', 'crit'] as const).map(k => {
              const name = k === 'good' ? 'Good' : k === 'warn' ? 'Warning' : 'Critical';
              return (
                <label key={k} className="ms-color">
                  <input
                    type="color"
                    value={s.colors[k]}
                    onChange={e => s.update({ colors: { ...s.colors, [k]: e.target.value } })}
                    aria-label={`${name} colour`}
                  />
                  <span>{name}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
