import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Layout, Lock, Unlock, Users, Shuffle } from 'lucide-react';
import { Channel, ENVIRONMENTS } from '@rfdeck/shared-types';
import { pointToStage, arrangeEvenly, STAGE_CENTRE, STAGE_MAX } from '@rfdeck/shared-utils';
import { useShowStore } from '../../stores/showStore';
import { useLiveStore } from '../../stores/liveStore';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { useDeviceStore } from '../../stores/deviceStore';
import { useConnectionHealth } from '../../hooks/useConnectionHealth';
import { channelKey } from '../../lib/channelKey';
import { channelStatus } from '../../lib/channelStatus';
import './StagePlotView.css';

/**
 * The stage plot: who is standing where, with their mic's state on them.
 *
 * The question this answers is one a list cannot. An operator hears a dropout and
 * needs to know *which person on stage* — "Vocal 7" is a row in a table, "the one
 * downstage left" is a place to look. So the layout is spatial and the status colour
 * is on the performer rather than beside their name.
 *
 * Positions are thousandths of the stage, stored on the `Player`, so the plot is the
 * production's and not this browser's: dragged at FOH, read on a phone in the wings,
 * and carried to the next venue in the show file.
 *
 * Read-only unless unlocked. This is a screen someone glances at during a show, and a
 * stray drag mid-performance would silently rearrange the production's plot for
 * everyone — so moving people is a mode you enter deliberately.
 */

/** Where the audience is. The whole point of a plot is knowing which way is out. */
const DOWNSTAGE_LABEL = 'Audience';

interface Placed {
  playerId: string;
  name: string;
  role: string;
  x: number;
  y: number;
  channel: Channel | null;
  channelName: string | null;
  online: boolean;
  stale: boolean;
}

export default function StagePlotView() {
  const shows = useShowStore(s => s.shows);
  const activeShowId = useShowStore(s => s.activeShowId);
  const setStagePositions = useShowStore(s => s.setStagePositions);
  const liveShowId = useLiveStore(s => s.show?.id ?? null);

  const channels = useActiveChannels();
  const inventory = useDeviceStore(s => s.inventory);
  const { isChannelStale } = useConnectionHealth();

  const [unlocked, setUnlocked] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The live show if there is one, else whatever the operator last opened. A plot
  // is most useful during a performance, so the running show wins.
  const show = useMemo(
    () => shows.find(s => s.id === (liveShowId ?? activeShowId)) ?? null,
    [shows, liveShowId, activeShowId],
  );

  const channelsByKey = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const ch of channels) m.set(channelKey(ch), ch);
    return m;
  }, [channels]);

  const onlineByIp = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const d of inventory) m.set(d.ip, d.online);
    return m;
  }, [inventory]);

  const describe = useCallback((playerId: string, key: string | null): Omit<Placed, 'playerId' | 'name' | 'role' | 'x' | 'y'> => {
    const channel = key ? channelsByKey.get(key) ?? null : null;
    return {
      channel,
      channelName: channel?.name ?? null,
      online: channel ? (onlineByIp.get(channel.deviceId.split(':')[0]) ?? true) : false,
      stale: channel ? isChannelStale(channel.id) : false,
    };
  }, [channelsByKey, onlineByIp, isChannelStale]);

  const { placed, unplaced } = useMemo(() => {
    const placed: Placed[] = [];
    const unplaced: Array<{ playerId: string; name: string; role: string }> = [];
    for (const p of show?.players ?? []) {
      const name = p.realName || 'Unnamed';
      const role = p.characterName || '';
      if (p.stageX === null || p.stageY === null) {
        unplaced.push({ playerId: p.id, name, role });
      } else {
        placed.push({
          playerId: p.id, name, role,
          x: p.stageX, y: p.stageY,
          ...describe(p.id, p.assignedChannelKey),
        });
      }
    }
    return { placed, unplaced };
  }, [show, describe]);

  /**
   * Pointer position as a stage coordinate.
   *
   * The maths lives in `@rfdeck/shared-utils` so this and the server agree exactly:
   * the client clamps to keep a card on screen, the server clamps because a bad value
   * would persist. Two implementations of one rule would eventually disagree.
   */
  const toStageCoords = (clientX: number, clientY: number) => {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return null;
    return pointToStage({ x: clientX, y: clientY }, box);
  };

  // Pointer events rather than mouse events, so this works with a finger on the
  // tablet someone is actually holding while walking the stage.
  const startDrag = (playerId: string) => (e: React.PointerEvent) => {
    if (!unlocked || !show) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(playerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!dragging || !show) return;
    const at = toStageCoords(e.clientX, e.clientY);
    if (!at) return;
    // Straight to the store, which is optimistic — the card follows the pointer and
    // the write is debounced by the drag ending rather than by a timer.
    void setStagePositions(show.id, [{ playerId: dragging, x: at.x, y: at.y }]);
  };

  const endDrag = () => setDragging(null);

  /** Drop an unplaced performer onto the middle of the stage to start. */
  const place = (playerId: string) => {
    if (!show) return;
    void setStagePositions(show.id, [{ playerId, x: STAGE_CENTRE, y: STAGE_CENTRE }]);
  };

  const unplace = (playerId: string) => {
    if (!show) return;
    void setStagePositions(show.id, [{ playerId, x: null, y: null }]);
  };

  /**
   * Spread everyone across the stage in a sensible arc.
   *
   * Not a layout algorithm pretending to know the production — it exists so a plot
   * does not start as thirty cards stacked in the middle, which is the state that
   * makes an operator give up on the feature before using it.
   */
  const arrange = () => {
    if (!show || show.players.length === 0) return;
    const spots = arrangeEvenly(show.players.length);
    void setStagePositions(
      show.id,
      show.players.map((p, i) => ({ playerId: p.id, ...spots[i] })),
    );
  };

  if (!show) {
    return (
      <div className="page">
        <div className="page-header">
          <h2><Layout size={18} /> Stage Plot</h2>
        </div>
        <div className="sp-empty">
          <p>No show open.</p>
          <p className="sp-empty-hint">
            Open a show under Shows, or go live, and its cast appears here to place.
          </p>
        </div>
      </div>
    );
  }

  const terms = ENVIRONMENTS[show.environmentMode];

  return (
    <div className="page sp-page">
      <div className="page-header">
        <h2><Layout size={18} /> Stage Plot</h2>
        <div className="sp-header-actions">
          <span className="sp-show-name">
            {show.name}
            <span className="sp-show-mode">{terms.label}</span>
          </span>
          {unlocked && (
            <button className="btn-ghost" onClick={arrange} title="Spread the cast evenly to start from">
              <Shuffle size={14} /> Arrange
            </button>
          )}
          <button
            className={unlocked ? 'btn-primary' : 'btn-ghost'}
            onClick={() => { setUnlocked(v => !v); setDragging(null); }}
            title={unlocked ? 'Stop moving people' : 'Move people on the plot'}
          >
            {unlocked ? <><Unlock size={14} /> Editing</> : <><Lock size={14} /> Locked</>}
          </button>
        </div>
      </div>

      <p className="sp-desc">
        Where everyone stands, with their mic's state on them — so a dropout is a
        place to look rather than a row in a table. The plot belongs to the show: it
        is the same on every screen and travels in the show file.
        {!unlocked && ' Unlock to move people.'}
      </p>

      <div
        ref={surfaceRef}
        className={`sp-stage ${unlocked ? 'is-editing' : ''}`}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Upstage/downstage marked, because a plot with no orientation is a
            scatter chart. */}
        <div className="sp-upstage-label">Upstage</div>
        <div className="sp-centre-line" aria-hidden="true" />

        {placed.map(p => {
          const status = p.channel
            ? channelStatus(p.channel, p.online, p.stale)
            : { label: 'NO MIC', tone: 'idle' as const };
          return (
            <div
              key={p.playerId}
              className={`sp-performer tone-${status.tone} ${dragging === p.playerId ? 'is-dragging' : ''}`}
              style={{ left: `${(p.x / STAGE_MAX) * 100}%`, top: `${(p.y / STAGE_MAX) * 100}%` }}
              onPointerDown={startDrag(p.playerId)}
              onDoubleClick={() => unlocked && unplace(p.playerId)}
              title={unlocked ? 'Drag to move · double-click to take off the plot' : undefined}
            >
              <span className="sp-performer-name">{p.name}</span>
              {p.role && <span className="sp-performer-role">{p.role}</span>}
              <span className="sp-performer-status">{status.label}</span>
              {p.channel && (
                <span className="sp-performer-meta">
                  {p.channelName}
                  {typeof p.channel.batteryPercent === 'number' && ` · ${p.channel.batteryPercent}%`}
                </span>
              )}
            </div>
          );
        })}

        <div className="sp-downstage-label">{DOWNSTAGE_LABEL}</div>
      </div>

      {unplaced.length > 0 && (
        <div className="sp-bench">
          <div className="sp-bench-header">
            <Users size={14} />
            <span>
              {unplaced.length} not on the plot
              {!unlocked && ' — unlock to place them'}
            </span>
          </div>
          <div className="sp-bench-list">
            {unplaced.map(p => (
              <button
                key={p.playerId}
                className="sp-bench-item"
                disabled={!unlocked}
                onClick={() => place(p.playerId)}
                title={unlocked ? 'Put on the plot' : undefined}
              >
                {p.name}
                {p.role && <span className="sp-bench-role">{p.role}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
