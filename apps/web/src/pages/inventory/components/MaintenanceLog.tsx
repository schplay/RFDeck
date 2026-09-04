import React, { useState } from 'react';
import { Plus, Trash2, Cpu } from 'lucide-react';
import {
  MAINTENANCE_KINDS, maintenanceKindLabel, type MaintenanceKind,
} from '@rfdeck/shared-types';
import { useMaintenance } from '../../../hooks/useMaintenance';
import './MaintenanceLog.css';

// What has been done to this piece of hardware, and when.
//
// The question it answers is "has this one been trouble before" — asked when a
// channel misbehaves and the operator is deciding whether to swap the pack or
// chase the RF. A season, a rental fleet or a change of A2 all defeat memory.

interface Props {
  /**
   * The log itself is owned by the drawer, not by this component, so the
   * "remove device" confirmation can say how much history it is about to
   * delete. One fetch either way.
   */
  log: ReturnType<typeof useMaintenance>;
}

/** Today, as the yyyy-mm-dd a date input wants, in local time rather than UTC. */
function todayLocal(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

export function MaintenanceLog({ log }: Props) {
  const { entries, loading, error, add, remove } = log;

  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<MaintenanceKind>('ELEMENT');
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [at, setAt] = useState(todayLocal());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hint = MAINTENANCE_KINDS.find(k => k.kind === kind)?.hint ?? '';

  const reset = () => {
    setAdding(false);
    setKind('ELEMENT');
    setSummary('');
    setDetail('');
    setAt(todayLocal());
    setSaveError(null);
  };

  const submit = async () => {
    if (!summary.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Midday rather than midnight: a date-only value parsed as UTC midnight
      // shows as the previous day for anyone west of Greenwich, which is most
      // of this application's users.
      await add({ kind, summary: summary.trim(), detail: detail.trim(), at: `${at}T12:00:00` });
      reset();
    } catch {
      setSaveError('Could not save that entry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="maint">
      {error && <p className="maint-error">{error}</p>}

      {!loading && entries.length === 0 && !adding && (
        <p className="maint-empty">
          Nothing logged yet. Record element and battery changes, repairs and
          service here — it is the only record of work that never appears over
          the network.
        </p>
      )}

      {entries.length > 0 && (
        <ul className="maint-list">
          {entries.map(e => (
            <li key={e.id} className={`maint-entry ${e.automatic ? 'is-auto' : ''}`}>
              <div className="maint-entry-head">
                <span className={`maint-kind maint-kind-${e.kind.toLowerCase()}`}>
                  {maintenanceKindLabel(e.kind)}
                </span>
                <time className="maint-date" dateTime={e.at}>
                  {new Date(e.at).toLocaleDateString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                  })}
                </time>
                {e.automatic && (
                  <span className="maint-auto" title="Recorded by RFDeck, not typed in">
                    <Cpu size={11} /> auto
                  </span>
                )}
                <button
                  className="maint-del"
                  title="Delete this entry"
                  onClick={() => {
                    if (window.confirm('Delete this maintenance entry?')) remove(e.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <p className="maint-summary">{e.summary}</p>
              {e.detail && <p className="maint-detail">{e.detail}</p>}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="maint-form">
          <div className="maint-form-row">
            <select
              value={kind}
              onChange={ev => setKind(ev.target.value as MaintenanceKind)}
              aria-label="Kind of work"
            >
              {MAINTENANCE_KINDS.map(k => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </select>
            <input
              type="date"
              value={at}
              max={todayLocal()}
              onChange={ev => setAt(ev.target.value)}
              aria-label="When the work happened"
              title="When the work happened — not when you are writing it down"
            />
          </div>

          <input
            className="maint-summary-input"
            placeholder={hint}
            value={summary}
            maxLength={200}
            onChange={ev => setSummary(ev.target.value)}
            aria-label="Summary"
          />

          <textarea
            className="maint-detail-input"
            placeholder="Anything else worth knowing (optional)"
            value={detail}
            rows={2}
            maxLength={4000}
            onChange={ev => setDetail(ev.target.value)}
            aria-label="Detail"
          />

          {saveError && <p className="maint-error">{saveError}</p>}

          <div className="maint-form-actions">
            <button className="btn-secondary-sm" onClick={reset} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn-primary-sm"
              onClick={submit}
              disabled={saving || !summary.trim()}
            >
              {saving ? 'Saving…' : 'Add entry'}
            </button>
          </div>
        </div>
      ) : (
        <button className="maint-add" onClick={() => setAdding(true)}>
          <Plus size={13} /> Log maintenance
        </button>
      )}
    </div>
  );
}
