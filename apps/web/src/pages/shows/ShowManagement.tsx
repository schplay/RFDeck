import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Show, Player, MicCheckAct, EnvironmentProfile, ENVIRONMENTS } from '@rfdeck/shared-types';
import { useShowStore, migrateLegacyShows } from '../../stores/showStore';
import { useChannelStore } from '../../stores/channelStore';
import { useDeviceStore } from '../../stores/deviceStore';
import { useChannelsByRole } from '../../hooks/useActiveChannels';
import { usePerformerStore } from '../../stores/performerStore';
import { channelKey } from '../../lib/channelKey';
import { API_BASE, getToken } from '../../lib/api';
import {
  Plus, Trash2, CheckCircle2, Circle, ChevronRight,
  ClipboardList, MessageSquare, RotateCcw, Users, Radio, Archive, ArchiveRestore,
  FileText, Download, BookOpen, ChevronDown,
} from 'lucide-react';
import './ShowManagement.css';

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Vocabulary and which notebook sections apply, per show type. Shared so the
// roster, this page and the printed report describe a production the same way.

// ── ShowListPanel ────────────────────────────────────────────────
function ShowListPanel({
  shows,
  activeId,
  onSelect,
  onCreate,
  loaded,
  error,
  archivedCount,
  showArchived,
  onToggleArchived,
}: {
  shows: Show[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  loaded: boolean;
  error: string | null;
  archivedCount: number;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  return (
    <div className="sm-list-panel">
      <div className="sm-panel-header">
        <h2 className="sm-panel-title">Shows</h2>
        <button className="btn-icon" onClick={onCreate} title="New Show">
          <Plus size={18} />
        </button>
      </div>

      {archivedCount > 0 && (
        <button className="sm-archive-toggle" onClick={onToggleArchived}>
          <Archive size={12} />
          {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
        </button>
      )}

      <div className="sm-show-list">
        {error && <div className="sm-list-error">{error}</div>}

        {!loaded && !error && (
          <div className="sm-empty-list"><p>Loading shows…</p></div>
        )}

        {loaded && !error && shows.length === 0 && (
          <div className="sm-empty-list">
            <ClipboardList size={32} />
            <p>{showArchived ? 'No shows' : 'No active shows'}</p>
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
              <div className="sm-show-item-name">
                {sh.name}
                {sh.archived && <span className="sm-archived-dot" title="Archived" />}
              </div>
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
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Show['environmentMode']>('THEATER');
  const [saving, setSaving] = useState(false);

  // Creation round-trips to the server, so guard against a double submit
  // producing two shows.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const sh = await createShow(name.trim(), mode);
    setSaving(false);
    if (sh) onDone();
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
        <button type="submit" className="btn-primary-sm" disabled={!name.trim() || saving}>
          {saving ? 'Creating…' : 'Create Show'}
        </button>
      </div>
    </form>
  );
}

// ── MicCheckTab ──────────────────────────────────────────────────
function MicCheckTab({ show, terms }: { show: Show; terms: EnvironmentProfile }) {
  const { setCurrentAct, setChannelChecked, setChannelNotes, resetAct } = useShowStore();
  // Mics only. An IEM carries a monitor feed, not a performer — ticking one
  // during a soundcheck means nothing, and its presence lengthens the list
  // the operator has to work through under time pressure.
  const { mics: channels } = useChannelsByRole();

  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [editingNotesFor, setEditingNotesFor] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState('');

  const currentAct = show.micCheck.currentAct;
  const actData = show.micCheck.acts[currentAct] || {};
  const checkedCount = channels.filter(ch => actData[channelKey(ch)]?.checked).length;
  const allChecked = channels.length > 0 && checkedCount === channels.length;

  // Keyed by stable channel key, not channel id — see lib/channelKey.
  const playerByChannelKey = new Map<string, Player>(
    show.players
      .filter(p => p.assignedChannelKey)
      .map(p => [p.assignedChannelKey!, p])
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.key === 'y' || e.key === 'Y') {
        if (focusedIdx >= 0 && focusedIdx < channels.length) {
          setChannelChecked(show.id, currentAct, channelKey(channels[focusedIdx]), true);
          const next = channels.findIndex((c, i) => i > focusedIdx && !actData[channelKey(c)]?.checked);
          if (next >= 0) setFocusedIdx(next);
        }
      } else if (e.key === 'n' || e.key === 'N') {
        if (focusedIdx >= 0 && focusedIdx < channels.length) {
          setChannelChecked(show.id, currentAct, channelKey(channels[focusedIdx]), false);
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

  const startEditNotes = (key: string) => {
    setEditingNotesFor(key);
    setNotesValue(actData[key]?.notes || '');
  };

  const commitNotes = (key: string) => {
    setChannelNotes(show.id, currentAct, key, notesValue.trim());
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
              const key = channelKey(ch);
              const entry = actData[key];
              const isChecked = entry?.checked ?? false;
              const isFocused = idx === focusedIdx;
              const player = playerByChannelKey.get(key);

              return (
                <div
                  key={ch.id}
                  className={`sm-channel-row ${isChecked ? 'checked' : ''} ${isFocused ? 'focused' : ''}`}
                  onClick={() => setFocusedIdx(idx)}
                >
                  <button
                    className="sm-check-toggle"
                    onClick={e => { e.stopPropagation(); setChannelChecked(show.id, currentAct, key, !isChecked); }}
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
                    {editingNotesFor === key ? (
                      <input
                        autoFocus
                        className="sm-notes-input"
                        value={notesValue}
                        onChange={e => setNotesValue(e.target.value)}
                        onBlur={() => commitNotes(key)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitNotes(key);
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
                      onClick={e => { e.stopPropagation(); startEditNotes(key); }}
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

// ── PlayerNotebook ───────────────────────────────────────────────
// Everything about one person in THIS show: notes that belong to the
// production rather than the person, and — where the environment works that
// way — the quick changes that take their pack off and back on.
function PlayerNotebook({ show, player, terms }: { show: Show; player: Player; terms: EnvironmentProfile }) {
  const { updatePlayer, addQuickChange, updateQuickChange, deleteQuickChange } = useShowStore();
  const changes = player.quickChanges ?? [];

  return (
    <div className="sm-notebook">
      <div className="sm-notebook-section">
        <label className="sm-notebook-label">
          Notes for this show
          <span className="sm-notebook-hint">
            Specific to {show.name}. Standing notes about the person live on the
            Performers page and follow them everywhere.
          </span>
        </label>
        <textarea
          className="sm-notebook-textarea"
          rows={2}
          value={player.notes}
          onChange={e => updatePlayer(show.id, player.id, { notes: e.target.value })}
          placeholder="e.g. doubles as the Innkeeper in Act 2 — second pack on the props table"
        />
      </div>

      {/* Theatre business. A worship service or a panel has no costume changes,
          and an empty section there is just clutter — see ENVIRONMENTS. */}
      {terms.quickChanges && (
        <div className="sm-notebook-section">
          <div className="sm-notebook-head">
            <label className="sm-notebook-label">
              Quick changes
              <span className="sm-notebook-hint">
                When the pack comes off and goes back on, so nobody is caught out by
                a dead channel that is dead on purpose.
              </span>
            </label>
            <button
              className="btn-text-primary"
              onClick={() => addQuickChange(show.id, player.id)}
            >
              <Plus size={12} /> Add
            </button>
          </div>

          {changes.length === 0 ? (
            <p className="sm-notebook-empty">No quick changes recorded.</p>
          ) : (
            <div className="sm-qc-list">
              <div className="sm-qc-header">
                <span>{terms.periodLabel}</span>
                <span>Off at</span>
                <span>Back at</span>
                <span>Notes</span>
                <span />
              </div>
              {changes.map(qc => (
                <div key={qc.id} className="sm-qc-row">
                  <input
                    className="sm-input sm-qc-act"
                    type="number"
                    min={1}
                    max={4}
                    value={qc.act ?? ''}
                    onChange={e => updateQuickChange(show.id, player.id, qc.id, {
                      act: e.target.value ? Number(e.target.value) : null,
                    })}
                    placeholder="—"
                  />
                  <input
                    className="sm-input"
                    value={qc.outCue}
                    onChange={e => updateQuickChange(show.id, player.id, qc.id, { outCue: e.target.value })}
                    placeholder="e.g. end of sc. 3"
                  />
                  <input
                    className="sm-input"
                    value={qc.inCue}
                    onChange={e => updateQuickChange(show.id, player.id, qc.id, { inCue: e.target.value })}
                    placeholder="e.g. top of sc. 5"
                  />
                  <input
                    className="sm-input"
                    value={qc.notes}
                    onChange={e => updateQuickChange(show.id, player.id, qc.id, { notes: e.target.value })}
                    placeholder="e.g. pack to SR quick-change booth"
                  />
                  <button
                    className="sm-player-delete"
                    onClick={() => deleteQuickChange(show.id, player.id, qc.id)}
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PlayersTab ───────────────────────────────────────────────────
function PlayersTab({ show, terms }: { show: Show; terms: EnvironmentProfile }) {
  const { addPlayer, updatePlayer, deletePlayer } = useShowStore();
  // A performer can wear both, so they are assigned separately.
  const { mics, iems } = useChannelsByRole();

  // The roster is shared across shows; this tab casts from it. A name typed
  // here joins the roster too, so the next show can pick the same person.
  const performers = usePerformerStore(s => s.performers);
  const rosterLoaded = usePerformerStore(s => s.loaded);
  const fetchPerformers = usePerformerStore(s => s.fetchPerformers);
  useEffect(() => { if (!rosterLoaded) void fetchPerformers(); }, [rosterLoaded, fetchPerformers]);

  const castIds = new Set(show.players.map(p => p.performerId).filter(Boolean));
  const uncast = performers.filter(p => !castIds.has(p.id));

  // Either pick someone from the roster or type a new name — not both.
  const [newPerformerId, setNewPerformerId] = useState('');
  const [newRealName, setNewRealName] = useState('');
  const [newCharName, setNewCharName] = useState('');
  const [openNotebook, setOpenNotebook] = useState<string | null>(null);
  const canAdd = !!newPerformerId || !!newRealName.trim();

  const handleAddPlayer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    addPlayer(
      show.id,
      newPerformerId ? { performerId: newPerformerId } : { realName: newRealName.trim() },
      newCharName.trim(),
    );
    setNewPerformerId('');
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
            <span>Mic</span>
            <span>IEM</span>
            <span>Notes</span>
            <span />
          </div>
          {show.players.map(player => (
            <div key={player.id} className="sm-player-entry">
            <div className="sm-player-row">
              {/* Who fills this slot. Names are edited on the Performers page,
                  where a change reaches every show; here you only recast. */}
              <select
                className="sm-select sm-player-field"
                value={player.performerId ?? ''}
                onChange={e => { if (e.target.value) updatePlayer(show.id, player.id, { performerId: e.target.value }); }}
                title={player.performerId ? 'Recast this slot' : `${player.realName} is not on the roster`}
              >
                {!player.performerId && <option value="">{player.realName} (not on roster)</option>}
                {performers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input
                className="sm-input sm-player-field"
                value={player.characterName}
                onChange={e => updatePlayer(show.id, player.id, { characterName: e.target.value })}
                placeholder={terms.roleLabel}
              />
              <select
                className="sm-select sm-player-field"
                value={player.assignedChannelKey || ''}
                onChange={e => updatePlayer(show.id, player.id, { assignedChannelKey: e.target.value || null })}
                title="Microphone channel — this is what the soundcheck ticks"
              >
                <option value="">— no mic —</option>
                {mics.map(ch => (
                  <option key={ch.id} value={channelKey(ch)}>
                    {ch.name || `CH ${ch.channelIndex}`}
                  </option>
                ))}
                {/* A saved assignment whose device is off or gone would
                    otherwise vanish from the select and read as unassigned. */}
                {player.assignedChannelKey &&
                 !mics.some(ch => channelKey(ch) === player.assignedChannelKey) && (
                  <option value={player.assignedChannelKey}>
                    {player.assignedChannelKey} (offline)
                  </option>
                )}
              </select>
              <select
                className="sm-select sm-player-field"
                value={player.iemChannelKey || ''}
                onChange={e => updatePlayer(show.id, player.id, { iemChannelKey: e.target.value || null })}
                title="In-ear monitor channel — assigned here, never part of the soundcheck"
              >
                <option value="">— no IEM —</option>
                {iems.map(ch => (
                  <option key={ch.id} value={channelKey(ch)}>
                    {ch.name || `CH ${ch.channelIndex}`}
                  </option>
                ))}
                {player.iemChannelKey &&
                 !iems.some(ch => channelKey(ch) === player.iemChannelKey) && (
                  <option value={player.iemChannelKey}>
                    {player.iemChannelKey} (offline)
                  </option>
                )}
              </select>
              <input
                className="sm-input sm-player-field"
                value={player.notes}
                onChange={e => updatePlayer(show.id, player.id, { notes: e.target.value })}
                placeholder="Notes"
              />
              <button
                className="sm-player-delete"
                onClick={() => setOpenNotebook(x => (x === player.id ? null : player.id))}
                title={openNotebook === player.id ? 'Hide notebook' : 'Notebook for this show'}
              >
                {openNotebook === player.id ? <ChevronDown size={13} /> : <BookOpen size={13} />}
              </button>
              <button
                className="sm-player-delete"
                onClick={() => deletePlayer(show.id, player.id)}
                title="Remove player"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {openNotebook === player.id && (
              <PlayerNotebook show={show} player={player} terms={terms} />
            )}
            </div>
          ))}
        </div>
      )}
      </div>

      <form className="sm-add-player-form" onSubmit={handleAddPlayer}>
        {uncast.length > 0 && (
          <select
            className="sm-select"
            value={newPerformerId}
            onChange={e => { setNewPerformerId(e.target.value); if (e.target.value) setNewRealName(''); }}
            title="Cast someone already on the roster"
          >
            <option value="">From roster…</option>
            {uncast.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <input
          className="sm-input"
          placeholder={uncast.length > 0 ? `or new ${terms.realNameLabel.toLowerCase()}` : `${terms.realNameLabel} *`}
          value={newRealName}
          onChange={e => { setNewRealName(e.target.value); if (e.target.value) setNewPerformerId(''); }}
        />
        <input
          className="sm-input"
          placeholder={terms.roleLabel}
          value={newCharName}
          onChange={e => setNewCharName(e.target.value)}
        />
        <button type="submit" className="btn-primary-sm" disabled={!canAdd}>
          <Plus size={14} /> {terms.addPersonLabel}
        </button>
        <Link to="/performers" className="sm-roster-link" title="Names and notes live on the roster, shared across shows">
          <Users size={13} /> Manage roster
        </Link>
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
  const { deleteShow, setActiveShow, setShowArchived } = useShowStore();
  const [activeTab, setActiveTab] = useState<'miccheck' | 'players' | 'devices'>('miccheck');
  const terms = ENVIRONMENTS[show.environmentMode];
  const inactiveCount = useDeviceStore(
    s => s.inventory.filter(d => d.active === false).length
  );

  return (
    <div className="sm-detail-panel">
      <div className="sm-detail-header">
        <div>
          <h1 className="sm-detail-title">
            {show.name}
            {show.archived && <span className="sm-archived-tag">Archived</span>}
          </h1>
          <span className="sm-detail-mode">{show.environmentMode.replace('_', ' ')}</span>
        </div>
        <div className="sm-detail-actions">
          {/* The report opens as a plain page so the browser's print dialog
              can make the PDF. A navigation cannot carry the auth header, so
              the token rides along as a query parameter when one exists. */}
          {(() => {
            const token = getToken();
            const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
            const base = `${API_BASE}/shows/${show.id}/report`;
            return (
              <>
                <a
                  className="btn-ghost"
                  href={`${base}.html${suffix}`}
                  target="_blank"
                  rel="noopener"
                  title="Printable show report — devices, roster, mic check, events, battery"
                >
                  <FileText size={14} /> Report
                </a>
                <a
                  className="btn-ghost"
                  href={`${base}.csv${suffix}`}
                  title="Download the report as a spreadsheet"
                >
                  <Download size={14} /> CSV
                </a>
              </>
            );
          })()}
          {/* Archiving is reversible and keeps the record; deleting is not. */}
          <button
            className="btn-ghost"
            onClick={() => setShowArchived(show.id, !show.archived)}
            title={show.archived ? 'Restore to the active list' : 'Archive — keeps all records'}
          >
            {show.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {show.archived ? 'Restore' : 'Archive'}
          </button>
          <button
            className="btn-ghost btn-danger"
            onClick={() => {
              if (window.confirm(
                `Permanently delete "${show.name}" and its mic check history?\n\n` +
                `To keep the records but hide the show, use Archive instead.`
              )) {
                deleteShow(show.id);
                setActiveShow(null);
              }
            }}
            title="Delete permanently"
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
  const { shows, activeShowId, setActiveShow, fetchShows, loaded, error } = useShowStore();
  const [creatingShow, setCreatingShow] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Shows are server-owned. Load once, then stay current via `show:*` socket
  // events; the legacy local-storage migration runs first so nothing is lost.
  useEffect(() => {
    (async () => {
      await migrateLegacyShows();
      await fetchShows();
    })();
  }, [fetchShows]);

  const activeShow = shows.find(s => s.id === activeShowId) || null;
  const visibleShows = showArchived ? shows : shows.filter(s => !s.archived);
  const archivedCount = shows.filter(s => s.archived).length;

  return (
    <div className="sm-root">
      <ShowListPanel
        shows={visibleShows}
        activeId={activeShowId}
        onSelect={setActiveShow}
        onCreate={() => setCreatingShow(true)}
        loaded={loaded}
        error={error}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived(v => !v)}
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
