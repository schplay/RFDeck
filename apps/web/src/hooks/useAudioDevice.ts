import { useState, useEffect, useRef, useCallback } from 'react';
import { useAudioStore } from '../stores/audioStore';
import { audioSupport, AudioSupport } from '../lib/audioSupport';

interface AudioDeviceHook {
  /** Whether audio capture is usable here, and why not if it isn't. */
  support: AudioSupport;
  availableDevices: MediaDeviceInfo[];
  refreshDevices: () => Promise<void>;
  monitoringChannelId: string | null;
  monitorChannel: (channelId: string, inputIndex: number) => void;
  stopMonitoring: () => void;
}

// Singleton audio context and stream shared across all ChannelStrip instances
let sharedContext: AudioContext | null = null;
let sharedStream: MediaStream | null = null;
let sharedStreamDeviceId: string | null = null;
let sharedSplitter: ChannelSplitterNode | null = null;
let monitoringGain: GainNode | null = null;
let monitoringDest: AudioDestinationNode | null = null;
let monitoringAudio: HTMLAudioElement | null = null;

function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

async function ensureStream(deviceId: string, channelCount: number): Promise<MediaStream> {
  if (sharedStream && sharedStreamDeviceId === deviceId) return sharedStream;

  // Stop previous stream if device changed
  sharedStream?.getTracks().forEach(t => t.stop());
  sharedSplitter?.disconnect();
  sharedSplitter = null;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      channelCount: { ideal: channelCount },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  sharedStream = stream;
  sharedStreamDeviceId = deviceId;
  return stream;
}

export function useAudioDevice(): AudioDeviceHook {
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>([]);
  const [monitoringChannelId, setMonitoringChannelId] = useState<string | null>(null);
  const { selectedDeviceId } = useAudioStore();

  const refreshDevices = useCallback(async () => {
    // No API at all outside a secure context — nothing to enumerate.
    if (!audioSupport.available) {
      setAvailableDevices([]);
      return;
    }

    try {
      // Request permission first so labels are populated
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    } catch { /* permission denied — list what we can */ }

    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setAvailableDevices(all.filter(d => d.kind === 'audioinput'));
    } catch (err) {
      console.warn('[useAudioDevice] Could not enumerate audio devices:', err);
      setAvailableDevices([]);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    if (!audioSupport.available) return;
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  const monitorChannel = useCallback(async (channelId: string, inputIndex: number) => {
    if (!audioSupport.available || !selectedDeviceId) return;

    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      // Open stream with enough channels for the requested input index
      const stream = await ensureStream(selectedDeviceId, Math.max(inputIndex, 2));
      const actualChannels = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1;

      // Build splitter if needed
      if (!sharedSplitter || sharedSplitter.numberOfOutputs < actualChannels) {
        sharedSplitter?.disconnect();
        const src = ctx.createMediaStreamSource(stream);
        sharedSplitter = ctx.createChannelSplitter(Math.max(actualChannels, 2));
        src.connect(sharedSplitter);
      }

      // Disconnect any previous monitoring gain
      monitoringGain?.disconnect();
      monitoringGain = ctx.createGain();
      monitoringGain.gain.value = 1;

      // Route the requested input channel (1-based → 0-based) to the gain node
      const chIndex = Math.min(inputIndex - 1, sharedSplitter.numberOfOutputs - 1);
      sharedSplitter.connect(monitoringGain, chIndex);

      // Output to a MediaStream destination and drive an <audio> element
      const dest = ctx.createMediaStreamDestination();
      monitoringGain.connect(dest);

      if (!monitoringAudio) {
        monitoringAudio = new Audio();
        monitoringAudio.autoplay = true;
      }
      monitoringAudio.srcObject = dest.stream;

      setMonitoringChannelId(channelId);
    } catch (err) {
      console.error('[useAudioDevice] monitorChannel failed:', err);
    }
  }, [selectedDeviceId]);

  const stopMonitoring = useCallback(() => {
    monitoringGain?.disconnect();
    monitoringGain = null;
    if (monitoringAudio) {
      monitoringAudio.srcObject = null;
    }
    setMonitoringChannelId(null);
  }, []);

  return { support: audioSupport, availableDevices, refreshDevices, monitoringChannelId, monitorChannel, stopMonitoring };
}
