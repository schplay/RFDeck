import { Server, Socket } from 'socket.io';

export class WebRTCSignaling {
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  public attach(socket: Socket) {
    // Basic signaling relay for WebRTC (React Client <-> GStreamer webrtcsink)
    // GStreamer's webrtcsink might connect here, or the client might.
    // We broadcast signaling messages to all OTHER clients in a specific room.
    
    socket.join('webrtc-room');

    socket.on('webrtc:offer', (offer) => {
      console.log(`[WebRTC] Offer received from ${socket.id}`);
      socket.to('webrtc-room').emit('webrtc:offer', offer);
    });

    socket.on('webrtc:answer', (answer) => {
      console.log(`[WebRTC] Answer received from ${socket.id}`);
      socket.to('webrtc-room').emit('webrtc:answer', answer);
    });

    socket.on('webrtc:ice-candidate', (candidate) => {
      // console.log(`[WebRTC] ICE candidate from ${socket.id}`);
      socket.to('webrtc-room').emit('webrtc:ice-candidate', candidate);
    });
  }
}
