import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from './useSocket';

// Listen to one RF channel's audio, captured on the server.
//
// The server owns the patch — which input of which interface a channel is wired
// to — so the client only names the channel. That keeps this working for any
// interface with any number of inputs, and keeps every client hearing the same
// source rather than each guessing at local hardware.
//
// One peer connection at a time: selecting a different channel renegotiates.

export function useChannelAudio() {
  const { socket } = useSocket();
  const [listeningTo, setListeningTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Mirrors listeningTo for use inside socket handlers, which would otherwise
  // close over a stale value.
  const listeningRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
  }, []);

  const stop = useCallback(() => {
    teardown();
    socket?.emit('audio:unsubscribe');
    listeningRef.current = null;
    setListeningTo(null);
  }, [socket, teardown]);

  const listen = useCallback(async (channelKey: string) => {
    if (!socket) return;
    setError(null);

    // Switching channels replaces the previous connection entirely.
    teardown();

    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;

    pc.ontrack = (event) => {
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.autoplay = true;
      }
      // A track can arrive with no stream association, in which case
      // event.streams is empty and srcObject would silently become undefined.
      // Wrap the track ourselves rather than depend on the sender having done so.
      audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      // Autoplay can be blocked until the page has been interacted with; a
      // click on Listen counts, so this normally succeeds.
      audioRef.current.play().catch(() => {
        setError('Your browser blocked playback — click Listen again.');
      });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('webrtc:ice-candidate', candidate);
    };

    // Receive-only: the browser never sends audio anywhere.
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', { ...offer, channelKey });
    listeningRef.current = channelKey;
    setListeningTo(channelKey);
  }, [socket, teardown]);

  useEffect(() => {
    if (!socket) return;

    const onAnswer = async (answer: RTCSessionDescriptionInit) => {
      try {
        await pcRef.current?.setRemoteDescription(new RTCSessionDescription(answer));
      } catch { /* connection was replaced mid-negotiation */ }
    };

    const onCandidate = async (candidate: RTCIceCandidateInit) => {
      try {
        await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
      } catch { /* candidate arrived after teardown */ }
    };

    const onError = ({ channelKey, message }: { channelKey: string; message: string }) => {
      // Every strip on the page has one of these handlers and the server
      // broadcasts the error to the socket, not to a strip. Acting on an
      // error about some other channel tore down a perfectly good session.
      if (channelKey && listeningRef.current && channelKey !== listeningRef.current) return;
      setError(message);
      teardown();
      listeningRef.current = null;
      setListeningTo(null);
    };

    socket.on('webrtc:answer', onAnswer);
    socket.on('webrtc:ice-candidate', onCandidate);
    socket.on('audio:error', onError);

    return () => {
      socket.off('webrtc:answer', onAnswer);
      socket.off('webrtc:ice-candidate', onCandidate);
      socket.off('audio:error', onError);
    };
  }, [socket, teardown]);

  useEffect(() => () => teardown(), [teardown]);

  return { listen, stop, listeningTo, error };
}
