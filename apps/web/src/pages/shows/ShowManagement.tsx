import React, { useState } from 'react';
import { Show, ShowSlot } from '@rfdeck/shared-types';
import { useShowStore } from '../../stores/showStore';
import { useChannelStore } from '../../stores/channelStore';
import {
  Plus, Trash2, CheckCircle2, AlertCircle, SkipForward,
  RotateCcw, Play, ChevronRight, Mic, Radio, ClipboardList
} from 'lucide-react';
import './ShowManagement.css';

// ── Status helpers ──────────────────────────────────────────────
const STATUS_META = {
  PENDING:  { label: 'Pending',  color: '#849495', icon: <Mic size={16} /> },
  CHECKED:  { label: 'Checked',  color: '#4ae176', icon: <CheckCircle2 size={16} /> },
  ISSUE:    { label: 'Issue',    color: '#ff5555', icon: <AlertCircle size={16} /> },
  SKIPPED:  { label: 'Skipped', color: '#ffb86c', icon: <SkipForward size={16} /> },
} as const;

// ── Subcomponents ───────────────────────────────────────────────
function ShowListPanel({
  shows,
  activeId,
  onSelect,
  onCreate,
}: {
  shows: Show[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="sm-list-panel">
      <div className="sm-panel-header">
        <h2 className="sm-panel-title">Shows</h2>
        <button className="btn-icon" onClick={onCreate} title="New Show">
          <Plus size={18} />
        </button>
      </div>
      <div className="sm-show-list">
        {shows.length === 0 && (
          <div className="sm-empty-list">
            <ClipboardList size={32} />
            <p>No shows yet</p>
            <button className="btn-primary-sm mt-2" onClick={onCreate}>Create First Show</button>
          </div>
        )}
        {shows.map(sh => {
          const checked = sh.slots.filter(s => s.micCheckStatus === 'CHECKED').length;
          const total = sh.slots.length;
          return (
            <button
              key={sh.id}
              className={`sm-show-item ${activeId === sh.id ? 'active' : ''}`}
              onClick={() => onSelect(sh.id)}
            >
              <div className="sm-show-item-name">{sh.name}</div>
              <div className="sm-show-item-meta">
                <span className="sm-show-mode">{sh.environmentMode.replace('_', ' ')}</span>
                {total > 0 && (
                  <span className="sm-show-progress">{checked}/{total}</span>
                )}
              </div>
              <ChevronRight size={14} className="sm-chevron" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NewShowDialog({ onDone }: { onDone: () => void }) {
  const createShow = useShowStore(s => s.createShow);
  const setActiveShow = useShowStore(s => s.setActiveShow);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Show['environmentMode']>('THEATER');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const sh = createShow(name.trim(), mode);
    setActiveShow(sh.id);
    onDone();
  };

  return (
    <form className="sm-new-show-form" onSubmit={handleSubmit}>
      <h3 className="sm-form-title">New Show</h3>
      <div className="sm-form-group">
        <label>Show Name</label>
        <input
          type="text"
          className="sm-input"
          placeholder="e.g. Spring Musical 2025"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="sm-form-group">
        <label>Environment</label>
        <select className="sm-select" value={mode} onChange={e => setMode(e.target.value as Show['environmentMode'])}>
          <option value="THEATER">Theater</option>
          <option value="CONCERT">Concert</option>
          <option value="CORPORATE">Corporate</option>
          <option value="BROADCAST">Broadcast</option>
          <option value="HOUSE_OF_WORSHIP">House of Worship</option>
        </select>
      </div>
      <div className="sm-form-actions">
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary-sm">Create Show</button>
      </div>
    </form>
  );
}

function ShowDetail({ show }: { show: Show }) {
  const { addSlot, deleteSlot, updateSlot, deleteShow, setActiveShow, resetMicCheck, setMicCheckStatus } = useShowStore();
  const channels = useChannelStore(s => s.channels);

  const [newSlotName, setNewSlotName] = useState('');
  const [micCheckActive, setMicCheckActive] = useState(false);
  const [micCheckIndex, setMicCheckIndex] = useState(0);

  // Sorted slots
  const slots = [...show.slots].sort((a, b) => a.order - b.order);
  const pendingSlots = slots.filter(s => s.micCheckStatus === 'PENDING');
  const currentSlot = micCheckActive ? (pendingSlots[micCheckIndex] || null) : null;

  const handleAddSlot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlotName.trim()) return;
    addSlot(show.id, newSlotName.trim());
    setNewSlotName('');
  };

  const handleMicCheckAction = (status: 'CHECKED' | 'ISSUE' | 'SKIPPED', notes?: string) => {
    if (!currentSlot) return;
    setMicCheckStatus(show.id, currentSlot.id, status, notes);
    const nextIdx = micCheckIndex + 1;
    if (nextIdx >= pendingSlots.length) {
      setMicCheckActive(false);
      setMicCheckIndex(0);
    } else {
      setMicCheckIndex(nextIdx);
    }
  };

  const handleStartMicCheck = () => {
    resetMicCheck(show.id);
    setMicCheckIndex(0);
    setMicCheckActive(true);
  };

  const checkedCount = slots.filter(s => s.micCheckStatus === 'CHECKED').length;
  const issueCount = slots.filter(s => s.micCheckStatus === 'ISSUE').length;
  const allDone = slots.length > 0 && slots.every(s => s.micCheckStatus !== 'PENDING');

  return (
    <div className="sm-detail-panel">
      <div className="sm-detail-header">
        <div>
          <h1 className="sm-detail-title">{show.name}</h1>
          <span className="sm-detail-mode">{show.environmentMode.replace('_', ' ')}</span>
        </div>
        <div className="sm-detail-actions">
          {slots.length > 0 && !micCheckActive && (
            <button className="btn-primary-sm" onClick={handleStartMicCheck}>
              <Play size={14} /> Start Mic Check
            </button>
          )}
          {micCheckActive && (
            <button className="btn-ghost sm-stop-btn" onClick={() => setMicCheckActive(false)}>
              Stop Check
            </button>
          )}
          <button
            className="btn-ghost btn-danger"
            onClick={() => {
              if (window.confirm(`Delete show "${show.name}"?`)) {
                deleteShow(show.id);
                setActiveShow(null);
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Mic Check Progress Banner */}
      {slots.length > 0 && (
        <div className="sm-progress-bar-wrap">
          <div className="sm-progress-stats">
            <span className="sm-stat checked">{checkedCount} Checked</span>
            {issueCount > 0 && <span className="sm-stat issue">{issueCount} Issue{issueCount > 1 ? 's' : ''}</span>}
            <span className="sm-stat total">{slots.length} Total</span>
          </div>
          <div className="sm-progress-track">
            <div
              className="sm-progress-fill"
              style={{ width: `${(checkedCount / slots.length) * 100}%` }}
            />
          </div>
          {allDone && (
            <div className={`sm-done-banner ${issueCount > 0 ? 'with-issues' : ''}`}>
              {issueCount > 0
                ? `⚠ Mic check complete with ${issueCount} issue${issueCount > 1 ? 's' : ''}`
                : '✓ All channels checked — ready for show'}
              <button className="btn-ghost ml-auto" onClick={() => { resetMicCheck(show.id); }}>
                <RotateCcw size={12} /> Reset
              </button>
            </div>
          )}
        </div>
      )}

      {/* Active Mic Check Mode */}
      {micCheckActive && currentSlot && (
        <div className="sm-mic-check-active">
          <div className="sm-mic-check-label">
            Slot {micCheckIndex + 1} of {pendingSlots.length}
          </div>
          <div className="sm-mic-check-slot-name">{currentSlot.name}</div>

          {currentSlot.assignedChannelIds.length > 0 && (
            <div className="sm-mic-check-channels">
              {currentSlot.assignedChannelIds.map(cid => {
                const ch = channels.find(c => c.id === cid);
                return ch ? (
                  <div key={cid} className="sm-mic-check-ch-pill">
                    <Radio size={10} /> {ch.name}
                  </div>
                ) : null;
              })}
            </div>
          )}

          <div className="sm-mic-check-buttons">
            <button className="sm-mc-btn sm-mc-checked" onClick={() => handleMicCheckAction('CHECKED')}>
              <CheckCircle2 size={20} /> Checked
            </button>
            <button className="sm-mc-btn sm-mc-issue" onClick={() => handleMicCheckAction('ISSUE')}>
              <AlertCircle size={20} /> Issue
            </button>
            <button className="sm-mc-btn sm-mc-skip" onClick={() => handleMicCheckAction('SKIPPED')}>
              <SkipForward size={20} /> Skip
            </button>
          </div>
        </div>
      )}

      {/* Slot List */}
      <div className="sm-slots-header">
        <h3 className="sm-section-title">Slots ({slots.length})</h3>
      </div>
      <div className="sm-slot-list">
        {slots.map(slot => {
          const meta = STATUS_META[slot.micCheckStatus];
          const isCurrent = micCheckActive && currentSlot?.id === slot.id;
          return (
            <div key={slot.id} className={`sm-slot-row ${isCurrent ? 'sm-slot-current' : ''}`}>
              <div className="sm-slot-status-icon" style={{ color: meta.color }}>
                {meta.icon}
              </div>
              <div className="sm-slot-info">
                <div className="sm-slot-name">{slot.name}</div>
                {slot.micCheckNotes && (
                  <div className="sm-slot-notes">{slot.micCheckNotes}</div>
                )}
                {slot.micCheckTimestamp && (
                  <div className="sm-slot-time">
                    {new Date(slot.micCheckTimestamp).toLocaleTimeString()}
                  </div>
                )}
              </div>
              <span className="sm-slot-status-label" style={{ color: meta.color }}>
                {meta.label}
              </span>
              {!micCheckActive && (
                <button
                  className="sm-slot-delete"
                  onClick={() => deleteSlot(show.id, slot.id)}
                  title="Remove slot"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
        {slots.length === 0 && (
          <div className="sm-empty-slots">
            Add slots below to build out your show rundown
          </div>
        )}
      </div>

      {/* Add Slot Form */}
      {!micCheckActive && (
        <form className="sm-add-slot-form" onSubmit={handleAddSlot}>
          <input
            type="text"
            className="sm-input flex-1"
            placeholder="e.g. Act 1 – Opening Number"
            value={newSlotName}
            onChange={e => setNewSlotName(e.target.value)}
          />
          <button type="submit" className="btn-primary-sm">
            <Plus size={14} /> Add Slot
          </button>
        </form>
      )}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────
export default function ShowManagement() {
  const { shows, activeShowId, setActiveShow } = useShowStore();
  const [creatingShow, setCreatingShow] = useState(false);

  const activeShow = shows.find(s => s.id === activeShowId) || null;

  return (
    <div className="sm-root">
      <ShowListPanel
        shows={shows}
        activeId={activeShowId}
        onSelect={setActiveShow}
        onCreate={() => setCreatingShow(true)}
      />

      <div className="sm-main">
        {creatingShow && (
          <div className="sm-modal-overlay">
            <div className="sm-modal">
              <NewShowDialog onDone={() => setCreatingShow(false)} />
            </div>
          </div>
        )}

        {activeShow ? (
          <ShowDetail show={activeShow} />
        ) : (
          <div className="sm-no-selection">
            <ClipboardList size={48} />
            <h2>Show Management</h2>
            <p>Select or create a show to manage slots and run your mic check.</p>
            <button className="btn-primary-sm mt-4" onClick={() => setCreatingShow(true)}>
              <Plus size={14} /> Create Show
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
