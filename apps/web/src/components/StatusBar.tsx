import React from 'react';
import { Link } from 'react-router-dom';
import { Circle, Disc, Headphones, Radio } from 'lucide-react';
import { useChannelStore } from '../stores/channelStore';
import { useDeviceStore } from '../stores/deviceStore';
import { useLiveStore } from '../stores/liveStore';
import { useStatusStore } from '../stores/statusStore';
import { useSocket } from '../hooks/useSocket';
import './StatusBar.css';

// One line, always there, saying what RFDeck is doing.
//
// Every fact here already existed somewhere: in a component's local state, in a
// server log, on a page you have to navigate to, or — for standing by — nowhere
// at all, because the live indicator only appears once you are live. That is
// fine for a setting and wrong for something that changes underneath you
// mid-show.
//
// Deliberately not a copy of the header. The padlock already states the lock,
// and the sidebar already carries the connection dot; repeating them here would
// cost the space that the facts nothing else answers need.

function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function StatusBar() {
  const { isConnected } = useSocket();
  const channels = useChannelStore(s => s.channels);
  const inventory = useDeviceStore(s => s.inventory);
  const live = useLiveStore(s => s.live);
  const show = useLiveStore(s => s.show);
  const recordingEnabled = useStatusStore(s => s.recordingEnabled);
  const recordingChannels = useStatusStore(s => s.recordingChannels);
  const listeningTo = useStatusStore(s => s.listeningTo);
  const captures = useStatusStore(s => s.captures);

  const tracked = inventory.filter(d => d.active !== false).length;
  const online = inventory.filter(d => d.active !== false && d.online).length;
  const listening = listeningTo
    ? channels.find(c => c.id === listeningTo)
    : null;

  return (
    <footer className="sb" role="status" aria-label="RFDeck status">
      {/* Whether the rig is being worked, and whose. "Standing by" had no home
          anywhere in the interface — the live indicator renders nothing until
          you are live, so the state that matters before the house opens was
          the one state nothing showed. */}
      <span className={`sb-item ${live ? 'sb-live' : 'sb-standby'}`}>
        <Radio size={13} />
        {live ? (show ? `Live · ${show.name}` : 'Live') : 'Standing by'}
      </span>

      <span className="sb-sep" aria-hidden />

      {/* How much of the rig is actually reporting. A count of devices that
          should be talking against the number that are is the fastest way to
          notice a rack that has not come up. */}
      <span
        className={`sb-item ${tracked > 0 && online < tracked ? 'sb-warn' : ''}`}
        title={tracked === online
          ? 'Every tracked device is reporting'
          : `${tracked - online} tracked device(s) are not reporting`}
      >
        <Circle size={9} className="sb-dot" />
        {online}/{tracked} devices
      </span>

      <span className="sb-sep" aria-hidden />

      <span className="sb-item">{plural(channels.length, 'channel')}</span>

      {/* Whether audio is being kept. Standing down stops it and unpatching a
          channel drops it, both of which happen without anybody looking at the
          recording page. */}
      {recordingEnabled && recordingChannels > 0 && (
        <>
          <span className="sb-sep" aria-hidden />
          <Link to="/detections" className="sb-item sb-rec" title="Rolling capture is running. Detections keep the audio around them.">
            <Disc size={13} />
            Recording {recordingChannels}
          </Link>
        </>
      )}

      {/* Captures the operator asked for. A capture that is running is a
          promise being kept; one that has quietly ended is a promise broken,
          so this shows both the count and the soonest end. */}
      {captures.length > 0 && (
        <>
          <span className="sb-sep" aria-hidden />
          <Link to="/detections" className="sb-item sb-rec" title={captures.map(c => {
            const ch = channels.find(x => x.id === c.channelKey);
            return `${ch?.name ?? c.channelKey} until ${new Date(c.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
          }).join('\n')}>
            <Disc size={13} />
            Capturing {captures.length}
          </Link>
        </>
      )}

      {/* What is in the operator's ears, which is otherwise only knowable by
          finding the card you clicked. */}
      {listening && (
        <>
          <span className="sb-sep" aria-hidden />
          <span className="sb-item sb-listen" title="Monitoring this channel">
            <Headphones size={13} />
            {listening.name || `CH ${listening.channelIndex}`}
          </span>
        </>
      )}

      <span className="sb-spacer" />

      {!isConnected && (
        <span className="sb-item sb-offline">No server connection</span>
      )}
    </footer>
  );
}
