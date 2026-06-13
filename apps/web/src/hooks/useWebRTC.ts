import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

export const useWebRTC = (socket: Socket | null) => {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    if (!socket) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    pcRef.current = pc;

    pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote track');
      setStream(event.streams[0]);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', event.candidate);
      }
    };

    socket.on('webrtc:offer', async (offer) => {
      console.log('[WebRTC] Received offer');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc:answer', answer);
    });

    socket.on('webrtc:answer', async (answer) => {
      console.log('[WebRTC] Received answer');
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc:ice-candidate', async (candidate) => {
      // console.log('[WebRTC] Received ICE candidate');
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

    // Add a transceiver to force offer creation and set direction to receive audio
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const initiateCall = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc:offer', offer);
    };

    initiateCall();

    return () => {
      pc.close();
      pcRef.current = null;
      socket.off('webrtc:offer');
      socket.off('webrtc:answer');
      socket.off('webrtc:ice-candidate');
    };
  }, [socket]);

  return { stream };
};
