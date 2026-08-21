import { Server, Socket } from 'socket.io';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from '@roamhq/wrtc';
import { AES67Manager } from './AES67Manager';
import { log } from '../logger';

export class WebRTCSignaling {
  private audioManager: AES67Manager;
  private peers = new Map<string, RTCPeerConnection>();

  constructor(_io: Server, audioManager: AES67Manager) {
    this.audioManager = audioManager;
  }

  attach(socket: Socket): void {
    socket.on('webrtc:offer', async (offer) => {
      try {
        // No external STUN needed — this app runs entirely on the local LAN.
        // Using Google STUN would cause DNS errors on closed networks.
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.peers.set(socket.id, pc);

        // Each client gets its own track fed by the shared audio source
        const track = this.audioManager.audioSource.createTrack();
        pc.addTrack(track);

        pc.onicecandidate = ({ candidate }) => {
          if (candidate) socket.emit('webrtc:ice-candidate', candidate);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', answer);

        log.debug(`[WebRTC] Connection established for ${socket.id}`);
      } catch (err) {
        log.error(`[WebRTC] Error handling offer from ${socket.id}:`, err);
      }
    });

    socket.on('webrtc:ice-candidate', async (candidate) => {
      const pc = this.peers.get(socket.id);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          log.error(`[WebRTC] Error adding ICE candidate for ${socket.id}:`, err);
        }
      }
    });

    socket.on('disconnect', () => {
      const pc = this.peers.get(socket.id);
      if (pc) {
        pc.close();
        this.peers.delete(socket.id);
        log.debug(`[WebRTC] Peer ${socket.id} disconnected.`);
      }
    });
  }
}
