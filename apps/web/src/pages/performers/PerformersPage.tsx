import React, { useEffect, useState } from 'react';
import { Users, Plus, Trash2 } from 'lucide-react';
import { usePerformerStore } from '../../stores/performerStore';
import './PerformersPage.css';

// The performer roster: people, independent of any show.
//
// Shows cast from this list rather than owning their own names, so the same
// person appears once across a season. Per-show details — role, channel,
// notes for that show — live on the casting, in Show & Mic Check.

export default function PerformersPage() {
  const { performers, loaded, error, fetchPerformers, addPerformer, updatePerformer, deletePerformer } =
    usePerformerStore();
  const [newName, setNewName] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => { void fetchPerformers(); }, [fetchPerformers]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    if (await addPerformer(newName.trim(), newNotes.trim())) {
      setNewName('');
      setNewNotes('');
    }
  };

  const handleDelete = (id: string, name: string, castingCount: number) => {
    const detail = castingCount > 0
      ? `\n\n${name} is cast in ${castingCount} show${castingCount === 1 ? '' : 's'}. ` +
        'Those cast lists keep the name; they just stop pointing at this roster entry.'
      : '';
    if (window.confirm(`Remove "${name}" from the roster?${detail}`)) deletePerformer(id);
  };

  const q = filter.trim().toLowerCase();
  const visible = q
    ? performers.filter(p => p.name.toLowerCase().includes(q) || p.notes.toLowerCase().includes(q))
    : performers;

  return (
    <div className="performers-page">
      <header className="performers-header">
        <div>
          <h1 className="page-title">Performers</h1>
          <p className="performers-subtitle">
            Everyone you put a mic on, across every show. Cast them into a show from
            Show &amp; Mic Check.
          </p>
        </div>
        <span className="performers-count">{performers.length} on the roster</span>
      </header>

      {error && <p className="performers-error">{error}</p>}

      <form className="performers-add" onSubmit={handleAdd}>
        <input
          className="performers-input"
          placeholder="Name *"
          value={newName}
          onChange={e => setNewName(e.target.value)}
        />
        <input
          className="performers-input"
          placeholder="Notes (optional)"
          value={newNotes}
          onChange={e => setNewNotes(e.target.value)}
        />
        <button type="submit" className="btn-primary-sm" disabled={!newName.trim()}>
          <Plus size={14} /> Add performer
        </button>
      </form>

      {performers.length > 8 && (
        <input
          className="performers-input performers-filter"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      )}

      {!loaded ? (
        <p className="performers-empty">Loading the roster…</p>
      ) : performers.length === 0 ? (
        <div className="performers-empty">
          <Users size={36} />
          <p>No performers yet. Add people here, or type a name into a show's cast list and they will appear here too.</p>
        </div>
      ) : (
        <div className="performers-list">
          <div className="performers-list-header">
            <span>Name</span>
            <span>Notes</span>
            <span>Shows</span>
            <span />
          </div>
          {visible.map(p => (
            <div key={p.id} className="performers-row">
              <input
                className="performers-input"
                value={p.name}
                onChange={e => updatePerformer(p.id, { name: e.target.value })}
                onBlur={e => { if (!e.target.value.trim()) updatePerformer(p.id, { name: p.name }); }}
              />
              <input
                className="performers-input"
                value={p.notes}
                onChange={e => updatePerformer(p.id, { notes: e.target.value })}
                placeholder="Notes"
              />
              <span className="performers-castings" title="Shows this performer is cast in">
                {p.castingCount}
              </span>
              <button
                className="performers-delete"
                onClick={() => handleDelete(p.id, p.name, p.castingCount)}
                title="Remove from roster"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {visible.length === 0 && (
            <p className="performers-empty">No one matches "{filter}".</p>
          )}
        </div>
      )}
    </div>
  );
}
