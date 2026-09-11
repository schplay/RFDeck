import { useCallback, useEffect, useRef, useState } from 'react';
import { useStatusStore } from '../stores/statusStore';
import { useSocket } from './useSocket';

// Listen to one or more RF channels, captured and mixed on the server.
//
// The server owns the patch — which input of which interface a channel is
// wired to — so the client only names channels. It also owns the mix: one
// peer connection carrying one track, and what is on that track is changed
// with a message rather than a renegotiation. Listening to one channel is a
// bus with one member.
//
// Plain Listen replaces the bus with that channel (solo). Adding stacks. The
// set is shared state, so every card, the menu and the status bar agree about
// what is in the operator's ears.

// One peer connection for the whole page, whichever hook instance made it.
// Every card has an instance of this hook; if each held its own connection,
// listening from a second card would leave the first one's playing.
let pc: RTCPeerConnection | null = null;
let audioEl: HTMLAudioElement | null = null;
let offered = false;

function teardownShared() {
  pc?.close();
  pc = null;
  offered = false;
  if (audioEl) audioEl.srcObject = null;
}

export function useChannelAudio() {
  const { socket } = useSocket();
  const listening = useStatusStore(s => s.listening);
  const setListening = useStatusStore(s => s.setListening);
  const [error, setError] = useState<string | null>(null);
  // Mirrors the bus for use inside socket handlers, which would otherwise
  // close over a stale value.
  const busRef = useRef<string[]>(listening);
  busRef.current = listening;

  const offer = useCallback(async (keys: string[]) => {
    if (!socket) return;
    teardownShared();
    pc = new RTCPeerConnection({ iceServers: [] });
    offered = true;

    pc.ontrack = (event) => {
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
      }
      // A track can arrive with no stream association, in which case
      // event.streams is empty and srcObject would silently become undefined.
      audioEl.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      // Autoplay can be blocked until the page has been interacted with; a
      // click on Listen counts, so this normally succeeds.
      audioEl.play().catch(() => {
        setError('Your browser blocked playback — click Listen again.');
      });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('webrtc:ice-candidate', candidate);
    };

    // Receive-only: the browser never sends audio anywhere.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const desc = await pc.createOffer();
    await pc.setLocalDescription(desc);
    socket.emit('webrtc:offer', { ...desc, channelKeys: keys });
  }, [socket]);

  /** Make the bus exactly these channels. */
  const setBus = useCallback(async (keys: string[]) => {
    if (!socket) return;
    setError(null);
    const unique = [...new Set(keys)];
    setListening(unique);
    if (unique.length === 0) {
      teardownShared();
      socket.emit('audio:unsubscribe');
      return;
    }
    // A live bus changes with a message; the first listen negotiates.
    if (pc && offered) socket.emit('audio:listen', { channelKeys: unique });
    else await offer(unique);
  }, [socket, offer, setListening]);

  const listen = useCallback((key: string) => setBus([key]), [setBus]);
  const add    = useCallback((key: string) => setBus([...busRef.current, key]), [setBus]);
  const remove = useCallback((key: string) => setBus(busRef.current.filter(k => k !== key)), [setBus]);
  const toggle = useCallback((key: string) =>
    busRef.current.includes(key) ? remove(key) : add(key), [add, remove]);
  const stop   = useCallback(() => setBus([]), [setBus]);

  useEffect(() => {
    if (!socket) return;

    const onAnswer = async (answer: RTCSessionDescriptionInit) => {
      try { await pc?.setRemoteDescription(new RTCSessionDescription(answer)); }
      catch { /* connection was replaced mid-negotiation */ }
    };
    const onCandidate = async (candidate: RTCIceCandidateInit) => {
      try { await pc?.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch { /* candidate arrived after teardown */ }
    };
    // What the server actually put on the bus, which may be less than asked
    // for. If it needs a fresh negotiation — no peer yet, or a peer made on
    // the shared source — it says so and we offer.
    const onListening = ({ channelKeys, needsOffer }: { channelKeys: string[]; needsOffer?: boolean }) => {
      if (needsOffer) { void offer(busRef.current); return; }
      setListening(channelKeys);
    };
    // Per channel: an unpatched member is reported and dropped, and the rest
    // of the bus carries on. Only surface the message if it concerns
    // something this page asked for.
    const onError = ({ channelKey, message }: { channelKey: string; message: string }) => {
      if (channelKey && !busRef.current.includes(channelKey)) return;
      setError(message);
    };
    const onLevels = (levels: Record<string, { peak: number; rms: number }>) => {
      useStatusStore.getState().applyAudioLevels(levels);
    };
    // A reconnect means the server-side peer is gone. Re-offer what was on
    // the bus so the audio comes back without a click.
    const onConnect = () => {
      if (busRef.current.length > 0) void offer(busRef.current);
    };

    socket.on('webrtc:answer', onAnswer);
    socket.on('webrtc:ice-candidate', onCandidate);
    socket.on('audio:listening', onListening);
    socket.on('audio:error', onError);
    socket.on('audio:levels', onLevels);
    socket.on('connect', onConnect);
    return () => {
      socket.off('webrtc:answer', onAnswer);
      socket.off('webrtc:ice-candidate', onCandidate);
      socket.off('audio:listening', onListening);
      socket.off('audio:error', onError);
      socket.off('audio:levels', onLevels);
      socket.off('connect', onConnect);
    };
  }, [socket, offer, setListening]);

  return {
    listening,
    isListening: (key: string) => listening.includes(key),
    listen, add, remove, toggle, setBus, stop,
    error,
  };
}
