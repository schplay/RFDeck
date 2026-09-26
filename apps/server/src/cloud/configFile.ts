/**
 * The install snapshot: what it takes to rebuild *this rig* on replacement hardware.
 *
 * The other half of the split agreed with the show file. A show file is portable —
 * it carries a production to another venue and deliberately does not touch the
 * inventory, because two venues have different hardware and a restore that
 * overwrote the local rig would be a disaster dressed as a feature. This is the
 * opposite job: the box died, here is a new one, make it the old one.
 *
 * So the two are separate documents with separate purposes, which is also what the
 * cloud's own tiering implies — `rfdeck.backup.config` and
 * `rfdeck.backup.showfile` are distinct free flags.
 *
 * ── What is deliberately not in here ────────────────────────────────────────
 *
 *   • **Device passwords.** They unlock somebody's hardware. A snapshot that
 *     carried them would turn one compromised cloud account into access to a rack.
 *     A restore therefore leaves passwords to be re-entered, and says so.
 *   • **Audio, clips, rolling capture.** Never leaves the venue; also pointless in
 *     a config backup.
 *   • **Telemetry and anything time-varying.** RF levels, battery, online state:
 *     properties of a moment, not of a rig.
 *   • **The PIN hash, VAPID keys, the secret box key.** Credentials this server
 *     holds, and a new install should mint its own.
 *   • **Performer photos.** They are files rather than state, and a 1 MB document
 *     cap would not hold a cast's worth. Names and notes travel; faces do not.
 */

export const CONFIG_FILE_VERSION = 1;

/** The document key. One per install, so a restore has one obvious thing to take. */
export const CONFIG_KEY = 'instance';
export const CONFIG_COLLECTION = 'config';

export interface ConfigDevice {
  /** Kept so a restored show's channel assignments still resolve. */
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  ip: string;
  port: number;
  location: string | null;
  notes: string | null;
  deviceType: string;
  deviceTypeManual: boolean;
  active: boolean;
  disabledSlots: string;
  /** Identity the hardware reports. Useful for matching a unit after a move. */
  mac: string | null;
  serial: string | null;
  band: string | null;
  bandSource: string | null;
  dense: boolean;
  carrierMinKHz: number | null;
  carrierMaxKHz: number | null;
  carrierStepKHz: number | null;
  /** True when a password is stored here — so a restore can say what to re-enter. */
  hadPassword: boolean;
}

export interface ConfigPerformer {
  id: string;
  name: string;
  notes: string;
  fitNotes: string;
  /** Whether a photo existed, since the photo itself does not travel. */
  hadPhoto: boolean;
}

export interface ConfigAudioPatch {
  channelKey: string;
  deviceId: string;
  inputChannel: number;
}

export interface ConfigFile {
  configFile: number;
  exportedAt: string;
  /** For a human reading a list of backups. */
  instance: { version: string | null; edition: string | null };
  settings: {
    aes67MulticastIp: string;
    aes67Port: number;
    batteryWarningPct: number;
    batteryCriticalPct: number;
    dropoutSensitivity: number;
    bindInterface: string;
    discoveryIgnore: string;
    audioInputDevice: string | null;
    recordingEnabled: boolean;
    recordingMaxMb: number;
    recordingPreSec: number;
    recordingPostSec: number;
    authPinEnabled: boolean;
    authReauthHours: number;
    venueLocation: string | null;
  };
  devices: ConfigDevice[];
  performers: ConfigPerformer[];
  audioPatch: ConfigAudioPatch[];
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function nullable(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function whole(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}
function flag(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Build the snapshot.
 *
 * Ordering is fixed throughout, for the same reason as the show file: the canonical
 * content hash is what tells a real conflict from the same install pushed twice, and
 * Prisma's row order is not guaranteed.
 */
export function buildConfigFile(input: {
  settings: any;
  devices: any[];
  performers: any[];
  audioPatch: any[];
  version?: string | null;
  edition?: string | null;
}, now: Date = new Date()): ConfigFile {
  const s = input.settings ?? {};
  return {
    configFile: CONFIG_FILE_VERSION,
    exportedAt: now.toISOString(),
    instance: {
      version: input.version ?? null,
      edition: input.edition ?? null,
    },
    settings: {
      aes67MulticastIp: text(s.aes67MulticastIp, '239.69.0.1'),
      aes67Port: whole(s.aes67Port, 5004),
      batteryWarningPct: whole(s.batteryWarningPct, 20),
      batteryCriticalPct: whole(s.batteryCriticalPct, 5),
      dropoutSensitivity: whole(s.dropoutSensitivity, 20),
      bindInterface: text(s.bindInterface, '0.0.0.0'),
      discoveryIgnore: text(s.discoveryIgnore, ''),
      audioInputDevice: nullable(s.audioInputDevice),
      recordingEnabled: flag(s.recordingEnabled, true),
      recordingMaxMb: whole(s.recordingMaxMb, 2048),
      recordingPreSec: whole(s.recordingPreSec, 15),
      recordingPostSec: whole(s.recordingPostSec, 10),
      // Whether a PIN is required travels; the hash does not.
      authPinEnabled: flag(s.authPinEnabled, false),
      authReauthHours: whole(s.authReauthHours, 0),
      venueLocation: nullable(s.venueLocation),
    },
    devices: [...(input.devices ?? [])]
      .map((d: any): ConfigDevice => ({
        id: text(d.id),
        name: text(d.name),
        manufacturer: text(d.manufacturer),
        model: text(d.model),
        ip: text(d.ip),
        port: whole(d.port, 443),
        location: nullable(d.location),
        notes: nullable(d.notes),
        deviceType: text(d.deviceType, 'input'),
        deviceTypeManual: flag(d.deviceTypeManual),
        active: flag(d.active, true),
        disabledSlots: text(d.disabledSlots),
        mac: nullable(d.mac),
        serial: nullable(d.serial),
        band: nullable(d.band),
        bandSource: nullable(d.bandSource),
        dense: flag(d.dense),
        carrierMinKHz: Number.isFinite(Number(d.carrierMinKHz)) ? Number(d.carrierMinKHz) : null,
        carrierMaxKHz: Number.isFinite(Number(d.carrierMaxKHz)) ? Number(d.carrierMaxKHz) : null,
        carrierStepKHz: Number.isFinite(Number(d.carrierStepKHz)) ? Number(d.carrierStepKHz) : null,
        // Either shape: a Prisma row carries `password`, and a parsed backup
        // carries only the boolean. Accepting both is what makes build → parse →
        // build identical, which the round-trip test asserts.
        hadPassword: !!d.password || d.hadPassword === true,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    performers: [...(input.performers ?? [])]
      .map((p: any): ConfigPerformer => ({
        id: text(p.id),
        name: text(p.name),
        notes: text(p.notes),
        fitNotes: text(p.fitNotes),
        hadPhoto: !!p.photoPath || p.hadPhoto === true,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    audioPatch: [...(input.audioPatch ?? [])]
      .map((a: any): ConfigAudioPatch => ({
        channelKey: text(a.channelKey),
        deviceId: text(a.deviceId),
        inputChannel: whole(a.inputChannel, 1),
      }))
      .sort((a, b) => a.channelKey.localeCompare(b.channelKey)),
  };
}

export class ConfigFileError extends Error {}

/** Validate and normalise a snapshot from the cloud. */
export function parseConfigFile(input: unknown): ConfigFile {
  if (!input || typeof input !== 'object') throw new ConfigFileError('That is not a config backup.');
  const raw = input as any;
  const version = whole(raw.configFile, 0);
  if (version < 1) throw new ConfigFileError('That file does not say which config-backup version it is.');
  if (version > CONFIG_FILE_VERSION) {
    throw new ConfigFileError(
      `That backup was written by a newer version of RFDeck (format ${version}; ` +
      `this build understands ${CONFIG_FILE_VERSION}). Update and try again.`,
    );
  }
  // Rebuilt through the builder so one set of coercions applies both ways, and a
  // parsed file is byte-identical to a built one.
  return buildConfigFile(
    {
      settings: raw.settings ?? {},
      devices: Array.isArray(raw.devices)
        ? raw.devices.filter((d: any) => d && typeof d === 'object' && text(d.id) && text(d.ip))
        : [],
      performers: Array.isArray(raw.performers)
        ? raw.performers.filter((p: any) => p && typeof p === 'object' && text(p.id))
        : [],
      audioPatch: Array.isArray(raw.audioPatch)
        ? raw.audioPatch.filter((a: any) => a && typeof a === 'object' && text(a.channelKey))
        : [],
      version: nullable(raw.instance?.version),
      edition: nullable(raw.instance?.edition),
    },
    nullable(raw.exportedAt) ? new Date(raw.exportedAt) : new Date(),
  );
}

/**
 * What a restore will and will not bring back, for the operator to read *before*
 * confirming.
 *
 * A whole-install restore replaces the inventory. On the wrong machine that is
 * destructive in a way "are you sure?" does not convey, so the UI gets a list
 * rather than a shrug.
 */
export function describeRestore(file: ConfigFile): {
  brings: string[];
  needsAttention: string[];
} {
  const withPasswords = file.devices.filter(d => d.hadPassword).length;
  const withPhotos = file.performers.filter(p => p.hadPhoto).length;
  return {
    brings: [
      `${file.devices.length} device${file.devices.length === 1 ? '' : 's'} in the inventory`,
      `${file.performers.length} performer${file.performers.length === 1 ? '' : 's'} on the roster`,
      `${file.audioPatch.length} audio patch assignment${file.audioPatch.length === 1 ? '' : 's'}`,
      'Alert thresholds, recording settings, network and discovery settings',
    ],
    needsAttention: [
      ...(withPasswords > 0
        ? [`${withPasswords} device${withPasswords === 1 ? '' : 's'} had a stored password — passwords are never backed up and must be re-entered`]
        : []),
      ...(withPhotos > 0
        ? [`${withPhotos} performer photo${withPhotos === 1 ? '' : 's'} will be missing — photos are files rather than settings and do not travel`]
        : []),
      ...(file.settings.authPinEnabled
        ? ['A remote-access PIN was enabled — the PIN itself is not backed up and must be set again']
        : []),
    ],
  };
}
