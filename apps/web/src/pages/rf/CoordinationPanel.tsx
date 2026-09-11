import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Compass, Lock } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useSurfaceLocked, LOCKED_REASON } from '../../stores/uiStore';
import { useScanStore } from '../../stores/scanStore';

// Frequency coordination: a clean set of carriers for the rig that is
// actually on the air, and the button that tunes the hardware to it.
//
// Two things the panel is careful about. It never guesses a band: a receiver
// that does not report one is listed with the bands its carrier could be in
// and waits for a person. And applying a plan names what will move before
// it moves it — retuning a live rig is the most disruptive thing RFDeck can
// be asked to do.

interface RigDevice {
  id: string; name: string; family: string | null;
  bandReported: boolean; band: string | null; bandSource: 'reported' | 'declared' | null;
  dense: boolean; candidates: string[]; codes: string[];
  assumed: Array<'step' | 'spacing'>; ready: boolean; reason: string | null; channelCount: number;
}
interface Skipped { id: string; name: string; deviceId: string; reason: string }
interface Assignment { id: string; name: string; frequencyKHz: number; previousKHz?: number; moved: boolean; locked: boolean }
interface Plan {
  assignments: Assignment[];
  unassigned: Array<{ id: string; name: string; reason: string }>;
  complete: boolean; worstMarginKHz: number | null; worstThreeTxMarginKHz: number | null;
  moves: number; threeTxCleared: boolean; nodesExplored: number; budgetExhausted: boolean;
}

function mhz(khz: number | undefined | null): string {
  return khz == null ? '—' : (khz / 1000).toFixed(3);
}

/** "608-614, 470–476" in MHz → kHz spans. Anything unreadable is dropped, not guessed. */
export function parseExclusions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of text.split(/[,;\n]/)) {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)$/i);
    if (!m) continue;
    const lo = Math.round(Number(m[1]) * 1000), hi = Math.round(Number(m[2]) * 1000);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}

const FAMILY_LABEL: Record<string, string> = {
  'shure-ad': 'Axient Digital', 'shure-ulxd': 'ULX-D', 'shure-qlxd': 'QLX-D', 'shure-slxd': 'SLX-D',
  'senn-ewdx': 'EW-DX', 'senn-d6000': 'Digital 6000', 'senn-g3g4': 'EW G3/G4',
};

export function CoordinationPanel() {
  const locked = useSurfaceLocked();
  const [devices, setDevices] = useState<RigDevice[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [transmitterCount, setTransmitterCount] = useState(0);
  const [exclusions, setExclusions] = useState('');
  const [threeTx, setThreeTx] = useState<'preferred' | 'required' | 'ignored'>('preferred');
  const scan = useScanStore(s => s.selected);
  const [useScan, setUseScan] = useState(true);
  const [scanThreshold, setScanThreshold] = useState(-85);
  const [scanExclusions, setScanExclusions] = useState<number | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ sent: number; failed: number; results: Array<{ id: string; ok: boolean; message: string | null }> } | null>(null);

  const loadRig = useCallback(async () => {
    try {
      const rig = await apiFetch<{ devices: RigDevice[]; skipped: Skipped[]; transmitterCount: number }>('/coordination/rig');
      setDevices(rig.devices); setSkipped(rig.skipped); setTransmitterCount(rig.transmitterCount);
    } catch (e: any) { setError(e?.message ?? 'Could not read the rig'); }
  }, []);

  useEffect(() => { loadRig(); }, [loadRig]);

  const declare = async (device: RigDevice, band: string | null) => {
    setError(null);
    try {
      await apiFetch(`/coordination/devices/${device.id}/band`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ band }),
      });
      setPlan(null);
      await loadRig();
    } catch (e: any) { setError(e?.message ?? 'Could not set the band'); }
  };

  const runPlan = async () => {
    setBusy('plan'); setError(null); setApplied(null);
    try {
      const withScan = useScan && scan ? { scanId: scan.id, scanThresholdDbm: scanThreshold } : {};
      const res = await apiFetch<{ plan: Plan; devices: RigDevice[]; skipped: Skipped[]; scanExclusions: number }>('/coordination/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclusionsKHz: parseExclusions(exclusions), threeTx, ...withScan }),
      });
      setPlan(res.plan); setDevices(res.devices); setSkipped(res.skipped);
      setScanExclusions(useScan && scan ? res.scanExclusions : null);
    } catch (e: any) { setError(e?.message ?? 'Planning failed'); }
    finally { setBusy(null); }
  };

  const moved = useMemo(() => plan?.assignments.filter(a => a.moved) ?? [], [plan]);

  const apply = async () => {
    if (!plan || moved.length === 0 || locked) return;
    const list = moved.map(a => `  ${a.name}: ${mhz(a.previousKHz)} → ${mhz(a.frequencyKHz)} MHz`).join('\n');
    if (!window.confirm(`Retune ${moved.length} transmitter${moved.length === 1 ? '' : 's'} now?\n\n${list}\n\nAnything on those channels will drop while it moves.`)) return;
    setBusy('apply'); setError(null);
    try {
      const res = await apiFetch<{ sent: number; failed: number; results: Array<{ id: string; ok: boolean; message: string | null }> }>('/coordination/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: moved.map(a => ({ id: a.id, frequencyKHz: a.frequencyKHz })) }),
      });
      setApplied(res);
    } catch (e: any) { setError(e?.message ?? 'Apply failed'); }
    finally { setBusy(null); }
  };

  const assumedNote = useMemo(() => {
    const items = new Set<string>();
    for (const d of devices) {
      if (!d.ready) continue;
      const fam = FAMILY_LABEL[d.family ?? ''] ?? d.family;
      if (d.assumed.includes('spacing')) items.add(`${fam} spacing`);
      if (d.assumed.includes('step')) items.add(`${fam} tuning step`);
    }
    return [...items];
  }, [devices]);

  return (
    <section className="rf-card" aria-label="Frequency coordination">
      <div className="rf-card-header">
        <div className="rf-card-title">
          <Compass size={16} className="card-icon" />
          Coordination
        </div>
        <span className="table-count">
          {transmitterCount} transmitter{transmitterCount === 1 ? '' : 's'} ready
        </span>
      </div>

      <div className="co-body">
        <div>
          <p className="co-section-title">Bands</p>
          {devices.length === 0 ? (
            <p className="co-note">No active receivers in the inventory. Nothing to coordinate.</p>
          ) : (
            <div className="co-table" role="table" aria-label="Receiver bands">
              <div className="co-row co-row-head" role="row">
                <span>Receiver</span><span>Family</span><span>Band</span><span>Status</span>
              </div>
              {devices.map(d => (
                <div key={d.id} className="co-row" role="row">
                  <span className="co-name" title={d.name}>{d.name}</span>
                  <span className="co-muted">{FAMILY_LABEL[d.family ?? ''] ?? (d.family ?? 'not tunable')}</span>
                  <span>
                    {d.bandSource === 'reported' || (d.family === 'senn-d6000' && d.ready) ? (
                      <span className="co-mono">{d.band ?? 'own limits'}{d.dense ? ' · dense' : ''}</span>
                    ) : d.family && !d.bandReported ? (
                      <select
                        className="co-select"
                        aria-label={`Band for ${d.name}`}
                        value={d.band ?? ''}
                        disabled={locked}
                        title={locked ? LOCKED_REASON : undefined}
                        onChange={e => declare(d, e.target.value || null)}
                      >
                        <option value="">Declare band…</option>
                        {d.candidates.length > 0 && (
                          <optgroup label="Contains the current frequency">
                            {d.candidates.map(c => <option key={`c-${c}`} value={c}>{c}</option>)}
                          </optgroup>
                        )}
                        <optgroup label="All bands">
                          {d.codes.map(c => <option key={c} value={c}>{c}</option>)}
                        </optgroup>
                      </select>
                    ) : (
                      <span className="co-muted">{d.band ?? '—'}</span>
                    )}
                  </span>
                  <span>
                    {d.ready
                      ? <span className={`co-badge co-badge-${d.bandSource ?? 'reported'}`}>{d.bandSource ?? 'reported'}</span>
                      : <span className="co-badge co-badge-missing" title={d.reason ?? ''}>{d.reason}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {assumedNote.length > 0 && (
            <p className="co-note" style={{ marginTop: 8 }}>
              Not published by the manufacturer, so chosen conservatively: {assumedNote.join(', ')}.
              See docs/COORDINATION_PROFILES.md.
            </p>
          )}
        </div>

        <div className="co-controls">
          <label className="co-field">
            Keep out of (MHz)
            <input
              className="co-input"
              placeholder="e.g. 608-614, 470-476"
              value={exclusions}
              onChange={e => setExclusions(e.target.value)}
              aria-label="Exclusions in MHz"
            />
          </label>
          <label className="co-field">
            3-transmitter products
            <select className="co-select" value={threeTx} onChange={e => setThreeTx(e.target.value as any)} aria-label="Three-transmitter products">
              <option value="preferred">Clear if the rig allows</option>
              <option value="required">Must be clear</option>
              <option value="ignored">Ignore</option>
            </select>
          </label>
          <button className="btn-secondary-rf" onClick={runPlan} disabled={busy !== null || transmitterCount === 0}>
            {busy === 'plan' ? 'Planning…' : 'Plan'}
          </button>
        </div>

        {scan && (
          <label className="co-check">
            <input type="checkbox" checked={useScan} onChange={e => setUseScan(e.target.checked)} />
            Keep out of what “{scan.name}” shows above
            <input
              className="co-input" type="number" step={1} style={{ width: 72 }}
              value={scanThreshold} onChange={e => setScanThreshold(Number(e.target.value))}
              aria-label="Scan threshold in dBm" disabled={!useScan}
            />
            dBm
            {scanExclusions !== null && <span className="co-muted">— {scanExclusions} span{scanExclusions === 1 ? '' : 's'} excluded</span>}
          </label>
        )}

        {error && <p className="co-note co-note-err" role="alert">{error}</p>}

        {plan && (
          <div>
            <p className="co-section-title">Plan</p>
            <div className="co-summary">
              <span>{plan.assignments.length} placed</span>
              <span><strong>{plan.moves}</strong> to move</span>
              <span>2-transmitter margin <strong>{plan.worstMarginKHz ?? '—'}</strong> kHz</span>
              <span>3-transmitter margin <strong>{plan.worstThreeTxMarginKHz ?? '—'}</strong> kHz</span>
            </div>
            {!plan.threeTxCleared && (
              <p className="co-note co-note-warn" style={{ marginTop: 6 }}>
                Too dense to clear three-transmitter products; two-transmitter products are clear.
                The intermodulation panel will still show the three-transmitter ones — that is the rig, not a mistake.
              </p>
            )}
            {plan.budgetExhausted && (
              <p className="co-note co-note-warn" style={{ marginTop: 6 }}>The search ran out of budget; this is the best plan it found.</p>
            )}
            {plan.unassigned.length > 0 && (
              <p className="co-note co-note-warn" style={{ marginTop: 6 }}>
                Not placed: {plan.unassigned.map(u => `${u.name} (${u.reason})`).join('; ')}.
              </p>
            )}
            {plan.complete && plan.moves === 0 && (
              <p className="co-note co-note-ok" style={{ marginTop: 6 }}>The rig is already clean. Nothing needs to move.</p>
            )}

            {plan.assignments.length > 0 && (
              <div className="co-table" role="table" aria-label="Planned frequencies" style={{ marginTop: 8 }}>
                <div className="co-row co-row-head" role="row">
                  <span>Transmitter</span><span>Now</span><span>Plan</span><span></span>
                </div>
                {plan.assignments.map(a => (
                  <div key={a.id} className="co-row" role="row">
                    <span className="co-name">{a.name}</span>
                    <span className="co-mono">{mhz(a.previousKHz)}</span>
                    <span className="co-mono">{mhz(a.frequencyKHz)}</span>
                    <span className={a.moved ? 'co-moved' : 'co-muted'}>{a.locked ? 'locked' : a.moved ? 'moves' : 'stays'}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="co-actions" style={{ marginTop: 10 }}>
              <button
                className="btn-secondary-rf"
                onClick={apply}
                disabled={locked || busy !== null || moved.length === 0}
                title={locked ? LOCKED_REASON : undefined}
              >
                {locked && <Lock size={14} />}
                {busy === 'apply' ? 'Tuning…' : `Apply — retune ${moved.length}`}
              </button>
              {applied && (
                <span className={`co-note ${applied.failed ? 'co-note-warn' : 'co-note-ok'}`}>
                  {applied.sent} sent{applied.failed ? `, ${applied.failed} failed: ${applied.results.filter(r => !r.ok).map(r => r.message).join('; ')}` : ''}
                </span>
              )}
            </div>
          </div>
        )}

        {skipped.length > 0 && (
          <p className="co-note">
            Left out: {skipped.map(s => `${s.name} — ${s.reason}`).join('; ')}.
          </p>
        )}
      </div>
    </section>
  );
}
