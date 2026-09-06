import React, { useEffect, useState } from 'react';
import { Show, ENVIRONMENTS } from '@rfdeck/shared-types';
import { useShowStore } from '../../stores/showStore';

// What a production *is*, as opposed to what is happening in it.
//
// All of this was decided at creation and then unreachable. A show created as a
// Theatre stayed a Theatre for good, and every show had exactly four acts —
// whether it was a two-act play, a single Sunday service, or a festival with
// eight sets. The count is not RFDeck's to assume: it decides how many periods
// the mic check offers, so getting it wrong means either tabs nobody can fill
// in or periods that cannot be checked at all.
//
// Saved per field as it is changed, rather than behind a Save button, matching
// the rest of this page — nothing is lost by navigating away mid-edit.

export function ShowSettingsTab({ show }: { show: Show }) {
  const updateShowSettings = useShowStore(s => s.updateShowSettings);
  const terms = ENVIRONMENTS[show.environmentMode];

  const [name, setName] = useState(show.name);
  const [venue, setVenue] = useState(show.venue ?? '');
  const [date, setDate] = useState(show.date ?? '');

  // Follow the show if it changes underneath: another client editing it, or the
  // server clamping a value this one sent.
  useEffect(() => { setName(show.name); }, [show.name]);
  useEffect(() => { setVenue(show.venue ?? ''); }, [show.venue]);
  useEffect(() => { setDate(show.date ?? ''); }, [show.date]);

  const commitName = () => {
    const next = name.trim();
    // A show with no name is not a correction anyone meant to make.
    if (!next || next === show.name) { setName(show.name); return; }
    updateShowSettings(show.id, { name: next });
  };

  const periods = show.periodCount ?? 4;

  // Periods that already have ticks but would fall outside a reduced count.
  // Lowering the number hides them rather than deleting them, and saying so is
  // the difference between a change someone will make during a run and one
  // they will not risk.
  const checkedBeyond = Object.entries(show.micCheck.acts)
    .filter(([act, entries]) =>
      Number(act) > periods && Object.values(entries ?? {}).some(e => e.checked))
    .map(([act]) => Number(act))
    .sort((a, b) => a - b);

  return (
    <div className="sm-settings-tab">
      <div className="sm-form-group">
        <label>Show Name</label>
        <input
          type="text"
          className="sm-input"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
        />
      </div>

      <div className="sm-form-group">
        <label>Environment</label>
        <select
          className="sm-select"
          value={show.environmentMode}
          onChange={e => updateShowSettings(show.id, {
            environmentMode: e.target.value as Show['environmentMode'],
          })}
        >
          {(Object.keys(ENVIRONMENTS) as Show['environmentMode'][]).map(m => (
            <option key={m} value={m}>{ENVIRONMENTS[m].label}</option>
          ))}
        </select>
        <p className="sm-form-hint">
          Decides what this show calls its people and its periods, and which
          parts of the performer notebook apply to it.
        </p>
      </div>

      <div className="sm-form-group">
        <label>{terms.periodLabel}s</label>
        <input
          type="number"
          className="sm-input"
          min={1}
          max={12}
          value={periods}
          onChange={e => updateShowSettings(show.id, {
            periodCount: Math.min(12, Math.max(1, Number(e.target.value) || 1)),
          })}
        />
        <p className="sm-form-hint">
          How many {terms.periodLabel.toLowerCase()}s the mic check covers.
        </p>
        {checkedBeyond.length > 0 && (
          <p className="sm-form-hint sm-form-warn">
            {terms.periodLabel} {checkedBeyond.join(', ')}{' '}
            {checkedBeyond.length === 1 ? 'already has' : 'already have'} mic checks
            recorded. They are kept, and come back if you raise the count again.
          </p>
        )}
      </div>

      <div className="sm-form-group">
        <label>Venue</label>
        <input
          type="text"
          className="sm-input"
          placeholder="Optional"
          value={venue}
          onChange={e => setVenue(e.target.value)}
          onBlur={() => { if (venue !== (show.venue ?? '')) updateShowSettings(show.id, { venue }); }}
        />
      </div>

      <div className="sm-form-group">
        <label>Date</label>
        <input
          type="text"
          className="sm-input"
          placeholder="Optional — free text, e.g. Spring run 2026"
          value={date}
          onChange={e => setDate(e.target.value)}
          onBlur={() => { if (date !== (show.date ?? '')) updateShowSettings(show.id, { date }); }}
        />
      </div>
    </div>
  );
}
