import React, { useEffect, useRef, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useWebRTC } from '../../hooks/useWebRTC';
import { Volume2, VolumeX, PlaySquare, Square } from 'lucide-react';
import './AudioMonitor.css';

export function AudioMonitor() {
  const { socket } = useSocket();
  const { stream } = useWebRTC(socket);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlayingTest, setIsPlayingTest] = useState(false);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  const toggleMute = () => {
    if (audioRef.current) {
      audioRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const toggleTestTone = () => {
    if (!socket) return;
    if (isPlayingTest) {
      socket.emit('audio:stop');
      setIsPlayingTest(false);
    } else {
      socket.emit('audio:start-test');
      setIsPlayingTest(true);
    }
  };

  return (
    <div className="audio-monitor">
      <audio ref={audioRef} autoPlay muted={isMuted} />
      <div className="audio-controls">
        <button onClick={toggleTestTone} className="control-btn" title={isPlayingTest ? "Stop GStreamer" : "Start GStreamer Test"}>
          {isPlayingTest ? <Square size={16} /> : <PlaySquare size={16} />}
        </button>
        <button onClick={toggleMute} className="control-btn" title="Toggle Mute">
          {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <span className="status-text">
          {stream ? "Stream Active" : "No Stream"}
        </span>
      </div>
    </div>
  );
}
