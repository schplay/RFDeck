import React, { useState, useEffect } from 'react';
import { Show, Player, MicCheckAct } from '@rfdeck/shared-types';
import { useShowStore } from '../../stores/showStore';
import { useChannelStore } from '../../stores/channelStore';
import { useDeviceStore } from '../../stores/deviceStore';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import {
  Plus, Trash2, CheckCircle2, Circle, ChevronRight,
  ClipboardList, MessageSquare, RotateCcw, Users, Radio,
} from 'lucide-react';
import './ShowManagement.css';

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface EnvTerms {
  periodLabel: string;   // Act / Service / Set / Session / Segment
  rosterLabel: string;   // Players / Roster / Performers / Presenters / Talent
  personLabel: string;   // Player / Musician / Performer / Presenter
  roleLabel: string;     // Character / Part-Instrument / Role / Title
  addPersonLabel: string;
  emptyRoster: string;
  realNameLabel: string;
}

const ENV_TERMS: Record<Show['environmentMode'], EnvTerms> = {
  THEATER: {
    periodLabel:    'Act',
    rosterLabel:    'Players',
    personLabel:    'Player',
    roleLabel:      'Character',
    addPersonLabel: 'Add Player',
    emptyRoster:    'No players yet — add your cast below',
    realNameLabel:  'Real Name',
  },
  CONCERT: {
    periodLabel:    'Set',
    rosterLabel:    'Performers',
    personLabel:    'Performer',
    roleLabel:      'Instrument / Role',
    addPersonLabel: 'Add Performer',
    emptyRoster:    'No performers yet — add your band below',
    realNameLabel:  'Name',
  },
  CORPORATE: {
    periodLabel:    'Session',
    rosterLabel:    'Presenters',
    personLabel:    'Presenter',
    roleLabel:      'Title',
    addPersonLabel: 'Add Presenter',
    emptyRoster:    'No presenters yet — add your speakers below',
    realNameLabel:  'Name',
  },
  BROADCAST: {
    periodLabel:    'Segment',
    rosterLabel:    'Talent',
    personLabel:    'Talent',
    roleLabel:      'Role',
    addPersonLabel: 'Add Talent',
    emptyRoster:    'No talent yet — add your on-air team below',
    realNameLabel:  'Name',
  },
  HOUSE_OF_WORSHIP: {
    periodLabel:    'Service',
    rosterLabel:    'Roster',
    personLabel:    'Musician',
    roleLabel:      'Part / Instrument',
    addPersonLabel: 'Add to Roster',
    emptyRoster:    'No one on the roster yet — add musicians below',
    realNameLabel:  'Name',
  },
};

// ── ShowListPanel ────────────────────────────────────────────────
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
          const totalChecked = Object.values(sh.micCheck.acts).reduce((sum, act) =>
            sum + Object.values(act || {}).filter(e => e.checked).length, 0);
          return (
            <button
              key={sh.id}
              className={`sm-show-item ${activeId === sh.id ? 'active' : ''}`}
              onClick={() => onSelect(sh.id)}
            >
              <div className="sm-show-item-name">{sh.name}</div>
              <div className="sm-show-item-meta">
                <span className="sm-show-mode">{sh.environmentMode.replace('_', ' ')}</span>
                {totalChecked > 0 && (
                  <span className="sm-show-progress">{totalChecked} checked</span>
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

// ── NewShowDialog ────────────────────────────────────────────────
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
    <form onSubmit={handleSubmit}>
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
        <button type="submit" className="btn-primary-sm" disabled={!name.trim()}>Create Show</button>
      </div>
    </form>
  );
}

// ── MicCheckTab ──────────────────────────────────────────────────
function MicCheckTab({ show, terms }: { show: Show; terms: EnvTerms }) {
  const { setCurrentAct, setChannelChecked, setChannelNotes, resetAct } = useShowStore();
  const channels = useActiveChannels();

  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [editingNotesFor, setEditingNotesFor] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState('');

  const currentAct = show.micCheck.currentAct;
  const actData = show.micCheck.acts[currentAct] || {};
  const checkedCount = channels.filter(ch => actData[ch.id]?.checked).length;
  const allChecked = channels.length > 0 && checkedCount === channels.length;

  const playerByChannelId = new Map<string, Player>(
    show.players
      .filter(p => p.assignedChannelId)
      .map(p => [p.assignedChannelId!, p])
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.key === 'y' || e.key === 'Y') {
        if (focusedIdx >= 0 && focusedIdx < channels.length) {
          setChannelChecked(show.id, currentAct, channels[focusedIdx].id, true);
          const next = channels.findIndex((c, i) => i > focusedIdx && !actData[c.id]?.checked);
          if (next >= 0) setFocusedIdx(next);
        }
      } else if (e.key === 'n' || e.key === 'N') {
        if (focusedIdx >= 0 && focusedIdx < channels.length) {
          setChannelChecked(show.id, currentAct, channels[focusedIdx].id, false);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx(i => Math.min(i + 1, channels.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx(i => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [focusedIdx, channels, show.id, currentAct, actData, setChannelChecked]);

  const startEditNotes = (channelId: string) => {
    setEditingNotesFor(channelId);
    setNotesValue(actData[channelId]?.notes || '');
  };

  const commitNotes = (channelId: string) => {
    setChannelNotes(show.id, currentAct, channelId, notesValue.trim());
    setEditingNotesFor(null);
  };

  return (
    <div className="sm-miccheck-tab">
      <div className="sm-act-bar">
        <div className="sm-act-selector">
          {([1, 2, 3, 4] as MicCheckAct[]).map(act => (
            <button
              key={act}
              className={`sm-act-btn ${currentAct === act ? 'active' : ''}`}
              onClick={() => setCurrentAct(show.id, act)}
            >
              {terms.periodLabel} {act}
            </button>
          ))}
        </div>
        <div className="sm-check-stats">
          <span className={`sm-check-count ${allChecked ? 'all-done' : ''}`}>
            {checkedCount} / {channels.length} checked
          </span>
          <button
            className="btn-ghost sm-reset-btn"
            onClick={() => { if (window.confirm(`Reset ${terms.periodLabel} ${currentAct} mic check?`)) resetAct(show.id, currentAct); }}
            disabled={Object.keys(actData).length === 0}
          >
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="sm-no-channels">
          <Radio size={36} />
          <p>No channels online — connect hardware to begin mic check</p>
        </div>
      ) : (
        <>
          <div className="sm-channel-list">
            {channels.map((ch, idx) => {
              const entry = actData[ch.id];
              const isChecked = entry?.checked ?? false;
              const isFocused = idx === focusedIdx;
              const player = playerByChannelId.get(ch.id);

              return (
                <div
                  key={ch.id}
                  className={`sm-channel-row ${isChecked ? 'checked' : ''} ${isFocused ? 'focused' : ''}`}
                  onClick={() => setFocusedIdx(idx)}
                >
                  <button
                    className="sm-check-toggle"
                    onClick={e => { e.stopPropagation(); setChannelChecked(show.id, currentAct, ch.id, !isChecked); }}
                    title={isChecked ? 'Mark unchecked' : 'Mark checked'}
                  >
                    {isChecked
                      ? <CheckCircle2 size={22} className="check-icon-on" />
                      : <Circle size={22} className="check-icon-off" />
                    }
                  </button>

                  <div className="sm-ch-info">
                    <div className="sm-ch-name">{ch.name || `CH ${ch.channelIndex}`}</div>
                    {player && (
                      <div className="sm-ch-player">
                        {player.characterName
                          ? `${player.characterName} · ${player.realName}`
                          : player.realName}
                      </div>
                    )}
                    {editingNotesFor === ch.id ? (
                      <input
                        autoFocus
                        className="sm-notes-input"
                        value={notesValue}
                        onChange={e => setNotesValue(e.target.value)}
                        onBlur={() => commitNotes(ch.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitNotes(ch.id);
                          if (e.key === 'Escape') setEditingNotesFor(null);
                        }}
                        placeholder="Add a note..."
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      entry?.notes && <div className="sm-ch-notes-text">{entry.notes}</div>
                    )}
                  </div>

                  <div className="sm-ch-meta">
                    {isChecked && entry?.checkedAt && (
                      <span className="sm-ch-time">{formatTime(entry.checkedAt)}</span>
                    )}
                    <button
                      className={`sm-notes-btn ${entry?.notes ? 'has-notes' : ''}`}
                      title="Add note"
                      onClick={e => { e.stopPropagation(); startEditNotes(ch.id); }}
                    >
                      <MessageSquare size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="sm-keyboard-hint">
            Click row to focus · <kbd>↑↓</kbd> navigate · <kbd>Y</kbd> check · <kbd>N</kbd> uncheck
          </div>
        </>
      )}
    </div>
  );
}

// ── PlayersTab ───────────────────────────────────────────────────
function PlayersTab({ show, terms }: { show: Show; terms: EnvTerms }) {
  const { addPlayer, updatePlayer, deletePlayer } = useShowStore();
  const channels = useActiveChannels();

  const [newRealName, setNewRealName] = useState('');
  const [newCharName, setNewCharName] = useState('');

  const handleAddPlayer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRealName.trim()) return;
    addPlayer(show.id, newRealName.trim(), newCharName.trim());
    setNewRealName('');
    setNewCharName('');
  };

  return (
    <div className="sm-players-tab">
      <div className="sm-players-scroll">
      {show.players.length === 0 ? (
        <div className="sm-no-players">
          <Users size={36} />
          <p>{terms.emptyRoster}</p>
        </div>
      ) : (
        <div className="sm-player-list">
          <div className="sm-player-list-header">
            <span>{terms.realNameLabel}</span>
            <span>{terms.roleLabel}</span>
            <span>Channel</span>
            <span>Notes</span>
            <span />
          </div>
          {show.players.map(player => (
            <div key={player.id} className="sm-player-row">
              <input
                className="sm-input sm-player-field"
                value={player.realName}
                onChange={e => updatePlayer(show.id, player.id, { realName: e.target.value })}
                placeholder={terms.realNameLabel}
              />
              <input
                className="sm-input sm-player-field"
                value={player.characterName}
                onChange={e => updatePlayer(show.id, player.id, { characterName: e.target.value })}
                placeholder={terms.roleLabel}
              />
              <select
                className="sm-select sm-player-field"
                value={player.assignedChannelId || ''}
                onChange={e => updatePlayer(show.id, player.id, { assignedChannelId: e.target.value || null })}
              >
                <option value="">— unassigned —</option>
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name || `CH ${ch.channelIndex}`}
                  </option>
                ))}
              </select>
              <input
                className="sm-input sm-player-field"
                value={player.notes}
                onChange={e => updatePlayer(show.id, player.id, { notes: e.target.value })}
                placeholder="Notes"
              />
              <button
                className="sm-player-delete"
                onClick={() => deletePlayer(show.id, player.id)}
                title="Remove player"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      </div>

      <form className="sm-add-player-form" onSubmit={handleAddPlayer}>
        <input
          className="sm-input"
          placeholder={`${terms.realNameLabel} *`}
          value={newRealName}
          onChange={e => setNewRealName(e.target.value)}
        />
        <input
          className="sm-input"
          placeholder={terms.roleLabel}
          value={newCharName}
          onChange={e => setNewCharName(e.target.value)}
        />
        <button type="submit" className="btn-primary-sm" disabled={!newRealName.trim()}>
          <Plus size={14} /> {terms.addPersonLabel}
        </button>
      </form>
    </div>
  );
}

// ── DevicesTab ───────────────────────────────────────────────────
// Toggle devices in/out of the show without leaving the mic check. Inactive
// devices disappear from the mic check list and stop raising dropout alerts.
function DevicesTab() {
  const inventory = useDeviceStore(s => s.inventory);
  const setDeviceActive = useDeviceStore(s => s.setDeviceActive);
  const allChannels = useChannelStore(s => s.channels);

  const channelCountFor = (ip: string) =>
    allChannels.filter(c => c.deviceId.split(':')[0] === ip).length;

  if (inventory.length === 0) {
    return (
      <div className="sm-devices-tab">
        <div className="sm-no-players">
          <Radio size={36} />
          <p>No devices in inventory — add hardware to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sm-devices-tab">
      <p className="sm-devices-hint">
        Turn a device off when it's intentionally powered down. Inactive devices are
        hidden from the mic check and dashboard, and never raise dropout alerts.
      </p>
      <div className="sm-device-list">
        {inventory.map(dev => {
          const isActive = dev.active !== false;
          const chCount = channelCountFor(dev.ip);
          return (
            <div key={dev.id} className={`sm-device-row ${isActive ? '' : 'inactive'}`}>
              <div className={`sm-device-dot ${!isActive ? 'off' : dev.online ? 'online' : 'offline'}`} />
              <div className="sm-device-info">
                <div className="sm-device-name">{dev.name}</div>
                <div className="sm-device-meta">
                  {dev.ip}
                  {isActive && chCount > 0 && ` · ${chCount} channel${chCount === 1 ? '' : 's'}`}
                  {isActive && !dev.online && ' · offline'}
                  {!isActive && ' · inactive'}
                </div>
              </div>
              <button
                className={`active-switch ${isActive ? 'on' : 'off'}`}
                role="switch"
                aria-checked={isActive}
                onClick={() => setDeviceActive(dev.id, !isActive)}
                title={isActive ? 'Set inactive' : 'Set active'}
              >
                <span className="active-switch-knob" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ShowDetail ───────────────────────────────────────────────────
function ShowDetail({ show }: { show: Show }) {
  const { deleteShow, setActiveShow } = useShowStore();
  const [activeTab, setActiveTab] = useState<'miccheck' | 'players' | 'devices'>('miccheck');
  const terms = ENV_TERMS[show.environmentMode];
  const inactiveCount = useDeviceStore(
    s => s.inventory.filter(d => d.active === false).length
  );

  return (
    <div className="sm-detail-panel">
      <div className="sm-detail-header">
        <div>
          <h1 className="sm-detail-title">{show.name}</h1>
          <span className="sm-detail-mode">{show.environmentMode.replace('_', ' ')}</span>
        </div>
        <div className="sm-detail-actions">
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

      <div className="sm-tabs">
        <button
          className={`sm-tab ${activeTab === 'miccheck' ? 'active' : ''}`}
          onClick={() => setActiveTab('miccheck')}
        >
          Mic Check
        </button>
        <button
          className={`sm-tab ${activeTab === 'players' ? 'active' : ''}`}
          onClick={() => setActiveTab('players')}
        >
          <Users size={13} />
          {terms.rosterLabel}
          {show.players.length > 0 && (
            <span className="sm-tab-badge">{show.players.length}</span>
          )}
        </button>
        <button
          className={`sm-tab ${activeTab === 'devices' ? 'active' : ''}`}
          onClick={() => setActiveTab('devices')}
        >
          <Radio size={13} />
          Devices
          {inactiveCount > 0 && (
            <span className="sm-tab-badge muted">{inactiveCount} off</span>
          )}
        </button>
      </div>

      {activeTab === 'miccheck' ? (
        <MicCheckTab show={show} terms={terms} />
      ) : activeTab === 'players' ? (
        <PlayersTab show={show} terms={terms} />
      ) : (
        <DevicesTab />
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────
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
            <p>Select or create a show to manage your mic check.</p>
            <button className="btn-primary-sm mt-4" onClick={() => setCreatingShow(true)}>
              <Plus size={14} /> Create Show
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
