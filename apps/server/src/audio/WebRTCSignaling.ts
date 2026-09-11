import { Server, Socket } from 'socket.io';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } from '@roamhq/wrtc';
import { AES67Manager } from './AES67Manager';
import { CaptureManager } from './CaptureManager';
import { Mixer } from './Mixer';
import { prisma } from '../db';
import { log } from '../logger';

// Streams server-captured audio to browsers, as a listen bus.
//
// One peer connection per socket, negotiated once, carrying one track: the
// output of a mixer owned by that peer. What is on the bus is changed with a
// message, not a renegotiation — the mixer's inputs change and the track
// carries on. Listening to one channel is a bus with one member; the old
// single-channel offer still works and means exactly that.
//
// The server owns the patch — which input of which interface each channel is
// wired to — so a client only names channels. A channel that is not patched
// is reported by name and skipped; it does not take the rest of the bus down.
//
// With no channels requested the peer gets the shared AES67 / test-tone source,
// which is what the header monitor uses.

interface PeerState {
  pc: RTCPeerConnection;
  mixer: Mixer | null;
  levels: ReturnType<typeof setInterval> | null;
}

const LEVELS_MS = 100;

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
        // Older clients sent the bare offer; newer ones wrap it with what they
        // want to hear — one key, or a list.
        const offer = payload?.sdp ? payload : payload?.offer ?? payload;
        const keys = this.requestedKeys(payload);

        this.teardown(socket.id);

        // No external STUN needed — this app runs entirely on the local LAN.
        // Using Google STUN would cause DNS errors on closed networks.
        const pc = new RTCPeerConnection({ iceServers: [] });
        const state: PeerState = { pc, mixer: null, levels: null };
        this.peers.set(socket.id, state);

        let track: any;
        if (keys.length > 0) {
          state.mixer = new Mixer(this.captureManager);
          track = state.mixer.createTrack();
          await this.applyBus(socket, state, keys);
        } else {
          // Fall back to the shared source (AES67 stream or test tone).
          track = this.audioManager.audioSource.createTrack();
        }

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

        log.debug(`[WebRTC] Streaming ${keys.length ? keys.join(', ') : 'shared source'} to ${socket.id}`);
      } catch (err) {
        log.error(`[WebRTC] Error handling offer from ${socket.id}:`, err);
      }
    });

    // Change what is on the bus without renegotiating.
    socket.on('audio:listen', async (payload: any) => {
      const state = this.peers.get(socket.id);
      const keys = this.requestedKeys(payload);
      if (!state) {
        // No peer yet: the client will offer. Tell it so rather than dropping
        // the request on the floor.
        socket.emit('audio:listening', { channelKeys: [], needsOffer: true });
        return;
      }
      if (!state.mixer) {
        // The peer was negotiated on the shared source; a bus needs its own
        // track, which means a fresh offer.
        socket.emit('audio:listening', { channelKeys: [], needsOffer: true });
        return;
      }
      await this.applyBus(socket, state, keys);
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

  private requestedKeys(payload: any): string[] {
    if (Array.isArray(payload?.channelKeys)) {
      return [...new Set(payload.channelKeys.filter((k: unknown) => typeof k === 'string' && k))] as string[];
    }
    if (typeof payload?.channelKey === 'string' && payload.channelKey) return [payload.channelKey];
    return [];
  }

  /**
   * Resolve each key to its patch and make the mixer match.
   *
   * Reports per key: a channel with no patch, or whose input will not open,
   * is named in an audio:error and left off the bus. The rest play.
   */
  private async applyBus(socket: Socket, state: PeerState, keys: string[]): Promise<void> {
    if (!state.mixer) return;
    const wanted: Array<{ key: string; deviceId: string; channel: number }> = [];
    for (const key of keys) {
      const patch = await prisma.channelAudioMap.findUnique({ where: { channelKey: key } });
      if (!patch) {
        socket.emit('audio:error', {
          channelKey: key,
          message: 'This channel is not patched to an audio input yet.',
        });
        continue;
      }
      wanted.push({ key, deviceId: patch.deviceId, channel: patch.inputChannel });
    }

    const { failed } = state.mixer.set(wanted);
    for (const key of failed) {
      const w = wanted.find(x => x.key === key)!;
      socket.emit('audio:error', {
        channelKey: key,
        message: `Could not open ${w.deviceId} input ${w.channel}.`,
      });
    }

    const on = state.mixer.keys();
    socket.emit('audio:listening', { channelKeys: on });

    // Levels from the audio itself, only while something is on the bus.
    if (on.length > 0 && !state.levels) {
      state.levels = setInterval(() => {
        if (!state.mixer) return;
        socket.emit('audio:levels', state.mixer.levels());
      }, LEVELS_MS);
    } else if (on.length === 0 && state.levels) {
      clearInterval(state.levels);
      state.levels = null;
    }
  }

  // Close the peer and release everything it held open, so an interface is
  // not left open by a client that navigated away.
  private teardown(socketId: string): void {
    const state = this.peers.get(socketId);
    if (!state) return;
    if (state.levels) clearInterval(state.levels);
    state.mixer?.close();
    try { state.pc.close(); } catch { /* already closed */ }
    this.peers.delete(socketId);
  }
}
