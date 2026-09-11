import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Headphones, VolumeX, Volume2, Disc, Square, Radio, User, Wrench, Cable,
} from 'lucide-react';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useChannelStore } from '../../stores/channelStore';
import { useDeviceStore, InventoryDevice } from '../../stores/deviceStore';
import { useShowStore } from '../../stores/showStore';
import { useLiveStore } from '../../stores/liveStore';
import { useUiStore, LOCKED_REASON } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { useChannelCapture } from '../../hooks/useChannelCapture';
import './ChannelContextMenu.css';

// Right-click a channel for the things otherwise reached through drawers and
// other pages.
//
// The complication is that a channel is not a record. It is telemetry keyed
// on an inventory row and a receiver slot, and the things an operator wants
// to do with it belong to other records: the device it is a slot of, the
// person cast onto it, the audio input it is patched to. So each entry here
// first resolves to whatever actually owns the thing, and says plainly when
// nothing does — a menu entry that opens the wrong record is worse than no
// menu at all.

export type DrawerSection = 'device' | 'maintenance';

interface Props {
  /** Open the device drawer on the page that owns it, at a section. */
  onOpenDevice: (device: InventoryDevice, section: DrawerSection) => void;
}

export function ChannelContextMenu({ onOpenDevice }: Props) {
  const menu = useContextMenuStore(s => s.menu);
  const close = useContextMenuStore(s => s.close);
  const navigate = useNavigate();

  const channel = useChannelStore(s => menu ? s.channels.find(c => c.id === menu.channelId) ?? null : null);
  const inventory = useDeviceStore(s => s.inventory);
  const shows = useShowStore(s => s.shows);
  const liveShow = useLiveStore(s => s.show);
  const mutesLocked = useUiStore(s => s.mutesLocked);
  const surfaceLocked = useUiStore(s => s.surfaceLocked);
  const { socket, isConnected } = useSocket();

  // ── Resolve what owns this channel ────────────────────────────────────
  const device = useMemo(() => {
    if (!channel) return null;
    const ip = channel.deviceId.split(':')[0];
    return inventory.find(d => d.ip === ip) ?? null;
  }, [channel, inventory]);

  // The live show first, then any other, so a rehearsal with no show live
  // still finds the person. Mic or IEM: either assignment counts.
  const casting = useMemo(() => {
    if (!channel) return null;
    const ordered = liveShow
      ? [...shows.filter(s => s.id === liveShow.id), ...shows.filter(s => s.id !== liveShow.id)]
      : shows;
    for (const show of ordered) {
      const player = show.players.find(
        p => p.assignedChannelKey === channel.id || p.iemChannelKey === channel.id,
      );
      if (player) return { show, player, asIem: player.iemChannelKey === channel.id };
    }
    return null;
  }, [channel, shows, liveShow]);

  // ── Actions ───────────────────────────────────────────────────────────
  const { listen, stop, listeningTo } = useChannelAudio();
  const isListening = !!channel && listeningTo === channel.id;
  const capture = useChannelCapture(channel ?? { id: '', name: '' } as any);

  const [capturePick, setCapturePick] = useState(false);
  useEffect(() => { if (!menu) setCapturePick(false); }, [menu]);

  const mute = () => {
    if (!channel || !socket || !isConnected) return;
    socket.emit('channel:mute', {
      deviceId: channel.deviceId,
      rxIndex: channel.channelIndex,
      muted: !channel.isMuted,
    });
  };

  // ── Placement and dismissal ───────────────────────────────────────────
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) { setPos(null); return; }
    // Keep it on screen: flip left or up when the cursor is near an edge.
    const r = ref.current.getBoundingClientRect();
    const x = menu.x + r.width > window.innerWidth - 8 ? Math.max(8, menu.x - r.width) : menu.x;
    const y = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y;
    setPos({ x, y });
    // The first item takes focus, so the keyboard works from the moment it
    // opens.
    ref.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, close]);

  if (!menu || !channel) return null;

  const name = channel.name || `CH ${channel.channelIndex}`;
  const act = (fn: () => void) => () => { fn(); close(); };

  return (
    <div
      ref={ref}
      className="ccm"
      role="menu"
      aria-label={`${name} actions`}
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="ccm-head">
        <span className="ccm-name">{name}</span>
        <span className="ccm-sub">
          {device ? device.name : channel.deviceId.split(':')[0]} · slot {channel.channelIndex}
        </span>
      </div>

      {/* Listening and capture change nothing about the rig, so they stay
          available under the surface lock. */}
      <button role="menuitem" className="ccm-item" onClick={act(() => isListening ? stop() : listen(channel.id))}>
        <Headphones size={14} /> {isListening ? 'Stop listening' : 'Listen'}
      </button>

      {capture.capture ? (
        <button role="menuitem" className="ccm-item ccm-rec" onClick={act(() => void capture.stop())}>
          <Square size={14} /> Stop capture
          <span className="ccm-hint">
            until {new Date(capture.capture.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </button>
      ) : capturePick ? (
        <div className="ccm-row" role="group" aria-label="Capture length">
          {[1, 5, 15, 60].map(m => (
            <button key={m} role="menuitem" className="ccm-chip" onClick={act(() => void capture.start(m))}>
              {m} min
            </button>
          ))}
        </div>
      ) : (
        <button role="menuitem" className="ccm-item" onClick={() => setCapturePick(true)}>
          <Disc size={14} /> Capture…
        </button>
      )}

      <button
        role="menuitem"
        className="ccm-item"
        disabled={mutesLocked || surfaceLocked}
        title={surfaceLocked ? LOCKED_REASON : mutesLocked ? 'Mutes are locked' : undefined}
        onClick={act(mute)}
      >
        {channel.isMuted ? <Volume2 size={14} /> : <VolumeX size={14} />}
        {channel.isMuted ? 'Unmute' : 'Mute'}
      </button>

      <div className="ccm-sep" />

      {/* Each of these resolves to the record that owns the thing, and says
          so when nothing does. */}
      <button
        role="menuitem"
        className="ccm-item"
        disabled={!device}
        title={device ? undefined : 'This channel is not from a device in the inventory'}
        onClick={act(() => device && onOpenDevice(device, 'device'))}
      >
        <Radio size={14} /> Open device
        {device && <span className="ccm-hint">{device.model}</span>}
      </button>

      <button
        role="menuitem"
        className="ccm-item"
        disabled={!casting}
        title={casting ? undefined : 'Nobody is cast onto this channel in any show'}
        onClick={act(() => {
          if (!casting) return;
          if (casting.player.performerId) {
            navigate(`/performers?performer=${encodeURIComponent(casting.player.performerId)}`);
          } else {
            useShowStore.getState().setActiveShow(casting.show.id);
            navigate('/shows?tab=players');
          }
        })}
      >
        <User size={14} /> Open performer
        {casting && (
          <span className="ccm-hint">
            {casting.player.realName}{casting.asIem ? ' (IEM)' : ''}
          </span>
        )}
      </button>

      <button
        role="menuitem"
        className="ccm-item"
        disabled={!device}
        title={device ? undefined : 'This channel is not from a device in the inventory'}
        onClick={act(() => device && onOpenDevice(device, 'maintenance'))}
      >
        <Wrench size={14} /> Add maintenance note
      </button>

      <button
        role="menuitem"
        className="ccm-item"
        onClick={act(() => navigate(`/settings?tab=audio&channel=${encodeURIComponent(channel.id)}`))}
      >
        <Cable size={14} /> Patch audio…
      </button>

      {capture.error && <div className="ccm-error" role="status">{capture.error}</div>}
    </div>
  );
}
