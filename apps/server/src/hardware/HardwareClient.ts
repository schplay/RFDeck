import { EventEmitter } from 'events';

// What RFDeck needs from a receiver, whoever made it.
//
// This interface is a description of something that already existed rather than
// a new design: SSCClient and G3G4Client had converged on the same shape, and
// DeviceManagerService told them apart with `instanceof` at eleven sites. Every
// vendor-specific thing above that line was an optional capability being
// checked by asking what class the object was.
//
// Writing it down does two things: a third manufacturer can be added without
// touching the manager, and the parts that genuinely are vendor-specific —
// gain, frequency, network configuration — are now optional methods rather than
// class checks, so "this device cannot do that" is a property of the device
// instead of a fact about the code.

/**
 * One receiver channel, in the shape the manager normalises from.
 *
 * This — not the class — is the real contract. A client that emits `state`
 * with this shape gets telemetry, alerts, RF dropout detection, battery
 * projection and recording for free, because everything above consumes the
 * normalised form rather than anything vendor-specific.
 *
 * The units are the part to get right, and they are not obvious:
 */
export interface ReceiverState {
  /** The channel name as the hardware knows it. */
  name?: string;
  /** **Kilohertz.** 578350 is 578.350 MHz. */
  frequency?: number;
  /** **0–100**, already a percentage. Not dBm — convert before emitting. */
  rf_quality?: number;
  /** Antenna B, same scale. Falls back to rf_quality when the device has one antenna. */
  rf_quality_b?: number;
  /** **dBFS**, normally negative. The manager applies `100 + af_level` itself. */
  af_level?: number;
  /** Receiver-side mute, asked for by an operator. */
  mute?: boolean;
  /** Transmitter-side mute — the performer's own switch. Deliberate, not a fault. */
  squelch?: boolean;
  /**
   * What this channel is for, where the *device* knows.
   *
   * A PSM1000 is an IEM transmitter whatever the operator ticked when adding
   * it, and the hardware is a better authority than the inventory checkbox.
   * Left undefined by clients that cannot tell, in which case the inventory's
   * `deviceType` decides.
   */
  role?: 'mic' | 'iem';
  battery?: {
    /** 0–100. Absent when no transmitter is paired, which is not the same as 0. */
    percent?: number;
    /** Minutes, where the hardware states it rather than RFDeck estimating it. */
    minutesRemaining?: number;
  };
}

/**
 * A whole device's telemetry, keyed `rx1`…`rx4`.
 *
 * The `rx` prefix is a Sennheiser artefact that reached the channel ids, and
 * through them the browser and the control commands that come back. Renaming it
 * would be a migration rather than a rename, so a Shure client emits `rx1` for
 * its channel 1 too.
 */
export interface DeviceStateTree {
  [rx: string]: ReceiverState | undefined;
}

export interface DeviceMetadata {
  deviceName?: string;
  firmware?: string;
  serial?: string;
  mac?: string;
  model?: string;
}

/**
 * The events every client may emit. A client that never fires an optional one
 * is not broken — a G3 has no concept of authentication, and says nothing
 * about it rather than reporting success.
 */
export interface HardwareClientEvents {
  /** The device answered. */
  connected: () => void;
  /** It stopped answering, with a reason worth showing an operator. */
  disconnected: (reason: string) => void;
  /** Telemetry. The payload above is the contract. */
  state: (tree: DeviceStateTree) => void;
  /**
   * The device is reachable, independent of whether telemetry is moving.
   *
   * Distinct from `state` on purpose: a mic nobody is talking into produces no
   * telemetry churn, and treating that as a dead device marked working
   * channels offline mid-show.
   */
  alive: () => void;
  metadata: (meta: DeviceMetadata) => void;
  'auth-failed': (info: { reason: string }) => void;
  'auth-ok': () => void;
}

export interface HardwareClient extends EventEmitter {
  readonly ip: string;
  readonly port: number;
  readonly isConnected: boolean;

  /** Begin talking to the device. The interval is a hint some clients ignore. */
  startPolling(intervalMs?: number): void;
  stopPolling(): void;

  /**
   * A control command by path, the escape hatch for anything not modelled
   * below. Paths are vendor-specific and the callers that use them know it.
   */
  sendControl(path: string, value: any): Promise<boolean>;

  /** Mute or unmute a channel. rxIndex is 1-based, as it is everywhere above. */
  setMute(rxIndex: number, muted: boolean): Promise<boolean>;

  /**
   * Make the device identify itself physically — flash its display.
   *
   * Returns false where the hardware has no such command, rather than throwing:
   * the button is offered and reports that nothing happened.
   */
  identify(): Promise<boolean>;

  // ── Optional capabilities ──
  //
  // Present only on clients whose hardware supports them. Callers check for
  // the method, which is the honest question — "can this device do it" — where
  // `instanceof SSCClient` was a proxy for it that a third vendor broke.

  setGain?(rxIndex: number, gain: number): Promise<boolean>;
  setFrequency?(rxIndex: number, frequencyHz: number): Promise<boolean>;
  setNetwork?(staticIp: string, subnet: string, gateway: string): Promise<boolean>;
  getPassword?(): string | null;
}

/** Does this client support a capability? Reads better than a truthiness check. */
export function canSet(
  client: HardwareClient | undefined,
  capability: 'setGain' | 'setFrequency' | 'setNetwork',
): boolean {
  return typeof client?.[capability] === 'function';
}
