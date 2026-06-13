import { Server, Socket } from 'socket.io';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from '@roamhq/wrtc';
import { AES67Manager } from './AES67Manager';

export class WebRTCSignaling {
  private audioManager: AES67Manager;
  private peers = new Map<string, RTCPeerConnection>();

  constructor(_io: Server, audioManager: AES67Manager) {
    this.audioManager = audioManager;
  }

  attach(socket: Socket): void {
    socket.on('webrtc:offer', async (offer) => {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
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

        console.log(`[WebRTC] Connection established for ${socket.id}`);
      } catch (err) {
        console.error(`[WebRTC] Error handling offer from ${socket.id}:`, err);
      }
    });

    socket.on('webrtc:ice-candidate', async (candidate) => {
      const pc = this.peers.get(socket.id);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error(`[WebRTC] Error adding ICE candidate for ${socket.id}:`, err);
        }
      }
    });

    socket.on('disconnect', () => {
      const pc = this.peers.get(socket.id);
      if (pc) {
        pc.close();
        this.peers.delete(socket.id);
        console.log(`[WebRTC] Peer ${socket.id} disconnected.`);
      }
    });
  }
}
