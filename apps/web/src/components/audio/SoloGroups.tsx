import React, { useMemo } from 'react';
import { Headphones } from 'lucide-react';
import { useLayoutStore } from '../../stores/layoutStore';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { useChannelStore } from '../../stores/channelStore';
import { useShortcuts } from '../../lib/shortcuts';
import './SoloGroups.css';

// Eight recallable listen buses.
//
// "The four radio mics" is something an operator wants to hear together at
// every line check, and it should be one press rather than four. A group is
// the current bus, saved under a number; recalling it replaces the bus with
// that set. Per browser, like the card order: this is the operator's working
// set, not a property of the rig.
//
// Click recalls. Shift-click stores what is playing now. The digit keys do the
// same, and the overlay from C.12 says so.

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

export function SoloGroups() {
  const groups = useLayoutStore(s => s.soloGroups);
  const setGroup = useLayoutStore(s => s.setSoloGroup);
  const channels = useChannelStore(s => s.channels);
  const { listening, setBus } = useChannelAudio();

  const recall = (n: number) => {
    const keys = groups[n];
    if (keys && keys.length > 0) void setBus(keys);
  };
  const store = (n: number) => {
    // Storing an empty bus would make a group that silences everything on
    // recall, which is never what a shift-click meant.
    if (listening.length > 0) setGroup(n, listening);
  };
  const clear = (n: number) => setGroup(n, []);

  useShortcuts('Dashboard', useMemo(() => [
    {
      keys: '1-8',
      label: 'Listen to that solo group',
      match: (e: KeyboardEvent) => /^[1-8]$/.test(e.key) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: (e: KeyboardEvent) => recall(Number(e.key)),
    },
    {
      keys: 'Shift+1-8',
      label: 'Store what is playing as that solo group',
      // Shift changes e.key on most layouts (1 becomes !), so match on code.
      match: (e: KeyboardEvent) => e.shiftKey && /^Digit[1-8]$/.test(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: (e: KeyboardEvent) => store(Number(e.code.slice(5))),
    },
  ], [groups, listening, setBus, setGroup]));

  const nameOf = (id: string) => {
    const ch = channels.find(c => c.id === id);
    return ch ? (ch.name || `CH ${ch.channelIndex}`) : '(gone)';
  };

  return (
    <div className="sg" role="group" aria-label="Solo groups">
      <Headphones size={13} className="sg-icon" aria-hidden />
      {SLOTS.map(n => {
        const keys = groups[n] ?? [];
        const has = keys.length > 0;
        const active = has && keys.length === listening.length && keys.every(k => listening.includes(k));
        const title = has
          ? `Group ${n}: ${keys.map(nameOf).join(', ')}\nClick to listen · Shift-click to overwrite with what is playing · Right-click to clear`
          : `Group ${n} is empty\nShift-click to store what is playing`;
        return (
          <button
            key={n}
            className={`sg-btn ${has ? 'has' : ''} ${active ? 'active' : ''}`}
            title={title}
            aria-label={`Solo group ${n}${has ? ` (${keys.length})` : ' (empty)'}`}
            aria-pressed={active}
            onClick={e => e.shiftKey ? store(n) : recall(n)}
            onContextMenu={e => { e.preventDefault(); if (has) clear(n); }}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}
