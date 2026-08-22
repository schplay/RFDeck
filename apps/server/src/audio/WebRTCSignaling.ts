import { Server, Socket } from 'socket.io';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } from '@roamhq/wrtc';
import { AES67Manager } from './AES67Manager';
import { CaptureManager } from './CaptureManager';
import { prisma } from '../db';
import { log } from '../logger';

// Streams server-captured audio to browsers.
//
// A client asks for a specific RF channel; the server looks up which input of
// which interface that channel is patched to and streams that one input. The
// patch is per-installation and arbitrary — any device, any input — so nothing
// here assumes a channel count or a particular rig.
//
// With no channel requested the client gets the shared AES67 / test-tone source,
// which is what the header monitor uses.

interface PeerState {
  pc: RTCPeerConnection;
  /** What this peer holds open, so it can be released on disconnect. */
  capture: { deviceId: string; channel: number } | null;
}

export class WebRTCSignaling {
  private audioManager: AES67Manager;
  private captureManager: CaptureManager;
  private peers = new Map<string, PeerState>();

  constructor(_io: Server, audioManager: AES67Manager, captureManager: CaptureManager) {
    this.audioManager = audioManager;
    this.captureManager = captureManager;
  }

  attach(socket: Socket): void {
    socket.on('webrtc:offer', async (payload: any) => {
      try {
        // Older clients sent the bare offer; newer ones wrap it with the
        // channel they want to hear.
        const offer = payload?.sdp ? payload : payload?.offer ?? payload;
        const channelKey: string | undefined = payload?.channelKey;

        this.teardown(socket.id);

        // No external STUN needed — this app runs entirely on the local LAN.
        // Using Google STUN would cause DNS errors on closed networks.
        const pc = new RTCPeerConnection({ iceServers: [] });
        const state: PeerState = { pc, capture: null };
        this.peers.set(socket.id, state);

        let track: any = null;

        if (channelKey) {
          const patch = await prisma.channelAudioMap.findUnique({ where: { channelKey } });
          if (!patch) {
            socket.emit('audio:error', {
              channelKey,
              message: 'This channel is not patched to an audio input yet.',
            });
          } else {
            const source = this.captureManager.acquire(patch.deviceId, patch.inputChannel);
            if (source) {
              track = source.createTrack();
              state.capture = { deviceId: patch.deviceId, channel: patch.inputChannel };
            } else {
              socket.emit('audio:error', {
                channelKey,
                message: `Could not open ${patch.deviceId} input ${patch.inputChannel}.`,
              });
            }
          }
        }

        // Fall back to the shared source (AES67 stream or test tone).
        if (!track) track = this.audioManager.audioSource.createTrack();

        // The stream is not optional. A track added on its own has no stream
        // association in the SDP, so the browser's ontrack fires with an EMPTY
        // streams array; a client doing `srcObject = event.streams[0]` then
        // assigns undefined and plays nothing, with no error anywhere. Verified
        // against node-webrtc directly: bare addTrack -> 0 streams, with a
        // MediaStream -> 1.
        pc.addTrack(track, new MediaStream([track]));

        pc.onicecandidate = ({ candidate }: any) => {
          if (candidate) socket.emit('webrtc:ice-candidate', candidate);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', answer);

        log.debug(`[WebRTC] Streaming ${channelKey ?? 'shared source'} to ${socket.id}`);
      } catch (err) {
        log.error(`[WebRTC] Error handling offer from ${socket.id}:`, err);
      }
    });

    socket.on('webrtc:ice-candidate', async (candidate: any) => {
      const state = this.peers.get(socket.id);
      if (state && candidate) {
        try {
          await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          log.error(`[WebRTC] Error adding ICE candidate for ${socket.id}:`, err);
        }
      }
    });

    socket.on('audio:unsubscribe', () => this.teardown(socket.id));

    socket.on('disconnect', () => {
      this.teardown(socket.id);
      log.debug(`[WebRTC] Peer ${socket.id} disconnected.`);
    });
  }

  // Close the peer and release its capture, so an interface is not left open
  // by a client that navigated away.
  private teardown(socketId: string): void {
    const state = this.peers.get(socketId);
    if (!state) return;
    try { state.pc.close(); } catch { /* already closed */ }
    if (state.capture) {
      this.captureManager.release(state.capture.deviceId, state.capture.channel);
    }
    this.peers.delete(socketId);
  }
}
