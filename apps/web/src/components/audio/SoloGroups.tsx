import React, { useMemo, useState } from 'react';
import { Headphones, Plus, X } from 'lucide-react';
import { useLayoutStore } from '../../stores/layoutStore';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { useChannelStore } from '../../stores/channelStore';
import { useShortcuts } from '../../lib/shortcuts';
import './SoloGroups.css';

// Eight recallable listen groups.
//
// "The four radio mics" is something an operator wants to hear together at
// every line check, and it should be one press rather than four. A group is
// the current listen bus, saved under a number; recalling it replaces the bus
// with that set. Per browser, like the card order: this is the operator's
// working set, not a property of the rig.
//
// Every click does something visible, and the strip says which. An earlier
// version drew eight identical numbers whose only affordance was a tooltip —
// an empty one swallowed a plain click silently, and the way to fill one
// (shift-click) was written nowhere on screen. Now an empty slot shows a "+"
// and saves what is playing, a full one shows its size and recalls, and the
// whole strip goes quiet with a reason when there is nothing to save.

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

export function SoloGroups() {
  const groups = useLayoutStore(s => s.soloGroups);
  const setGroup = useLayoutStore(s => s.setSoloGroup);
  const channels = useChannelStore(s => s.channels);
  const { listening, setBus } = useChannelAudio();
  const [expanded, setExpanded] = useState(false);

  const recall = (n: number) => {
    const keys = groups[n];
    if (keys && keys.length > 0) void setBus(keys);
  };
  const store = (n: number) => {
    // Storing an empty bus would make a group that silences everything on
    // recall, which is never what the operator meant.
    if (listening.length > 0) setGroup(n, listening);
  };
  const clear = (n: number) => setGroup(n, []);

  useShortcuts('Dashboard', useMemo(() => [
    {
      keys: '1-8',
      label: 'Listen to that group',
      match: (e: KeyboardEvent) => /^[1-8]$/.test(e.key) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: (e: KeyboardEvent) => recall(Number(e.key)),
    },
    {
      keys: 'Shift+1-8',
      label: 'Save what is playing as that group',
      // Shift changes e.key on most layouts (1 becomes !), so match on code.
      match: (e: KeyboardEvent) => e.shiftKey && /^Digit[1-8]$/.test(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: (e: KeyboardEvent) => store(Number(e.code.slice(5))),
    },
  ], [groups, listening, setBus, setGroup]));

  const nameOf = (id: string) => {
    const ch = channels.find(c => c.id === id);
    return ch ? (ch.name || `CH ${ch.channelIndex}`) : '(gone)';
  };

  const anyPlaying = listening.length > 0;
  const usedSlots = SLOTS.filter(n => (groups[n] ?? []).length > 0);

  return (
    <div className="sg" role="group" aria-label="Listen groups">
      <button
        className="sg-legend"
        onClick={() => setExpanded(x => !x)}
        aria-expanded={expanded}
        title={expanded ? 'Hide what each group holds' : 'Show what each group holds'}
      >
        <Headphones size={13} aria-hidden />
        <span className="sg-legend-text">Groups</span>
      </button>

      <div className="sg-slots">
        {SLOTS.map(n => {
          const keys = groups[n] ?? [];
          const has = keys.length > 0;
          const active = has && keys.length === listening.length && keys.every(k => listening.includes(k));
          // An empty slot is a save button; a full one is a recall button.
          const saveable = !has && anyPlaying;
          const inert = !has && !anyPlaying;

          const title = has
            ? `Group ${n} — ${keys.map(nameOf).join(', ')}\n` +
              `Click to listen to these · Shift-click to replace with what is playing now`
            : anyPlaying
              ? `Save the ${listening.length} channel${listening.length === 1 ? '' : 's'} you are listening to as group ${n}`
              : `Group ${n} is empty. Listen to some channels, then click here to save them as a group.`;

          return (
            <button
              key={n}
              className={`sg-btn ${has ? 'has' : ''} ${active ? 'active' : ''} ${saveable ? 'saveable' : ''}`}
              title={title}
              aria-label={has
                ? `Listen to group ${n} (${keys.length} channels)`
                : `Save current listen bus as group ${n}`}
              aria-pressed={active}
              disabled={inert}
              onClick={e => {
                if (has && !e.shiftKey) recall(n);
                else store(n);
              }}
            >
              <span className="sg-num">{n}</span>
              {has
                ? <span className="sg-count">{keys.length}</span>
                : saveable && <Plus size={10} className="sg-plus" aria-hidden />}
            </button>
          );
        })}
      </div>

      {/* What is actually in each group, on request. The tooltip answers it for
          one slot at a time, which is no use when the question is "which one
          was the band?". */}
      {expanded && (
        <div className="sg-panel" role="dialog" aria-label="Listen groups">
          {usedSlots.length === 0 ? (
            <p className="sg-panel-empty">
              No groups saved yet. Listen to the channels you want together, then
              click an empty number to save them.
            </p>
          ) : (
            <ul className="sg-panel-list">
              {usedSlots.map(n => (
                <li key={n} className="sg-panel-row">
                  <button className="sg-panel-recall" onClick={() => recall(n)}>
                    <span className="sg-panel-num">{n}</span>
                    <span className="sg-panel-names">
                      {(groups[n] ?? []).map(nameOf).join(', ')}
                    </span>
                  </button>
                  <button
                    className="sg-panel-clear"
                    onClick={() => clear(n)}
                    title={`Clear group ${n}`}
                    aria-label={`Clear group ${n}`}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="sg-panel-hint">Keys 1–8 recall · Shift+1–8 save</p>
        </div>
      )}
    </div>
  );
}
