import { describe, it, expect } from 'vitest';
import {
  buildConfigFile, parseConfigFile, describeRestore,
  ConfigFileError, CONFIG_FILE_VERSION,
} from './configFile';

// The install snapshot. Most of these guard the things that must *not* be in it:
// a backup that carried device passwords would turn one compromised cloud account
// into access to somebody's rack.

const input = () => ({
  settings: {
    aes67MulticastIp: '239.69.0.2', aes67Port: 5004,
    batteryWarningPct: 25, batteryCriticalPct: 5, dropoutSensitivity: 30,
    bindInterface: '10.0.1.9', discoveryIgnore: '10.0.2.0/24',
    audioInputDevice: 'hw:1,0',
    recordingEnabled: true, recordingMaxMb: 4096,
    recordingPreSec: 20, recordingPostSec: 10,
    authPinEnabled: true, authPinHash: '$2y$super$secret', authReauthHours: 12,
    venueLocation: '40.7128, -74.0060',
    defaultPassword: 'enc:should-not-travel',
    vapidPrivateKey: 'also-not', vapidPublicKey: 'nor-this',
    cloudRefreshToken: 'definitely-not',
  },
  devices: [
    {
      id: 'dev-b', name: 'Rack 2', manufacturer: 'Shure', model: 'ULXD4Q',
      ip: '10.0.1.21', port: 2202, location: 'SR', notes: '', deviceType: 'input',
      deviceTypeManual: true, active: true, disabledSlots: '3,4',
      mac: 'AA:BB', serial: 'S2', band: 'G50', bandSource: 'reported',
      dense: true, carrierMinKHz: null, carrierMaxKHz: null, carrierStepKHz: null,
      password: 'enc:hunter2',
    },
    {
      id: 'dev-a', name: 'Rack 1', manufacturer: 'Sennheiser', model: 'EW-DX EM 2',
      ip: '10.0.1.20', port: 443, location: null, notes: null, deviceType: 'input',
      deviceTypeManual: false, active: true, disabledSlots: '',
      mac: null, serial: 'S1', band: null, bandSource: null,
      dense: false, carrierMinKHz: 470000, carrierMaxKHz: 608000, carrierStepKHz: 25,
      password: null,
    },
  ],
  performers: [
    { id: 'p-2', name: 'Grace Hopper', notes: '', fitNotes: 'over the ear', photoPath: 'p2.jpg' },
    { id: 'p-1', name: 'Ada Lovelace', notes: 'allergic to tape', fitNotes: '', photoPath: null },
  ],
  audioPatch: [
    { channelKey: 'dev-b:2', deviceId: 'hw:1,0', inputChannel: 4 },
    { channelKey: 'dev-a:1', deviceId: 'hw:1,0', inputChannel: 1 },
  ],
  version: '1.4.0',
  edition: 'server',
});

describe('what the snapshot carries', () => {
  it('carries the inventory, the roster, the patch and the settings', () => {
    const file = buildConfigFile(input(), new Date('2026-09-26T09:00:00Z'));
    expect(file.configFile).toBe(CONFIG_FILE_VERSION);
    expect(file.devices).toHaveLength(2);
    expect(file.performers).toHaveLength(2);
    expect(file.audioPatch).toHaveLength(2);
    expect(file.settings).toMatchObject({
      batteryWarningPct: 25, bindInterface: '10.0.1.9', discoveryIgnore: '10.0.2.0/24',
      recordingMaxMb: 4096, venueLocation: '40.7128, -74.0060',
    });
  });

  it('keeps device ids, so a restored show still resolves its channels', () => {
    // Channel keys are "<device uuid>:<slot>". Without the ids a restored show's
    // cast would all show as unassigned.
    const file = buildConfigFile(input());
    expect(file.devices.map(d => d.id)).toEqual(['dev-a', 'dev-b']);
    expect(file.audioPatch[0].channelKey).toBe('dev-a:1');
  });

  it('orders everything, so the same install hashes identically', () => {
    const shuffled = input();
    shuffled.devices.reverse();
    shuffled.performers.reverse();
    shuffled.audioPatch.reverse();
    const a = JSON.stringify(buildConfigFile(input(), new Date('2026-09-26T09:00:00Z')));
    const b = JSON.stringify(buildConfigFile(shuffled, new Date('2026-09-26T09:00:00Z')));
    expect(b).toBe(a);
  });
});

describe('what the snapshot must never carry', () => {
  it('carries no secret of any kind', () => {
    const json = JSON.stringify(buildConfigFile(input()));
    // A backup holding device passwords would turn one compromised cloud account
    // into access to a rack.
    for (const secret of [
      'hunter2', 'enc:', 'should-not-travel', 'super$secret',
      'vapid', 'cloudRefreshToken', 'authPinHash', 'defaultPassword',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('records only *that* a password existed, so a restore can say what to re-enter', () => {
    const file = buildConfigFile(input());
    expect(file.devices.find(d => d.id === 'dev-b')!.hadPassword).toBe(true);
    expect(file.devices.find(d => d.id === 'dev-a')!.hadPassword).toBe(false);
  });

  it('carries whether a PIN was required but never the PIN', () => {
    const file = buildConfigFile(input());
    expect(file.settings.authPinEnabled).toBe(true);
    expect(JSON.stringify(file)).not.toContain('secret');
  });

  it('carries no telemetry or anything time-varying', () => {
    const json = JSON.stringify(buildConfigFile(input())).toLowerCase();
    for (const forbidden of ['rflevel', 'battery' + 'percent', 'online', 'clip', 'afLevel'.toLowerCase()]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('notes a photo existed without carrying it', () => {
    const file = buildConfigFile(input());
    expect(file.performers.find(p => p.id === 'p-2')!.hadPhoto).toBe(true);
    expect(JSON.stringify(file)).not.toContain('p2.jpg');
  });
});

describe('the round trip', () => {
  it('build → parse → build is identical', () => {
    const at = new Date('2026-09-26T09:00:00Z');
    const first = buildConfigFile(input(), at);
    expect(parseConfigFile(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('refuses a newer format rather than dropping what it cannot read', () => {
    const file: any = buildConfigFile(input());
    file.configFile = CONFIG_FILE_VERSION + 1;
    expect(() => parseConfigFile(file)).toThrowError(/newer version/);
  });

  it('refuses something that is not a config backup', () => {
    for (const bad of [null, 7, 'backup', {}, { configFile: 0 }]) {
      expect(() => parseConfigFile(bad)).toThrowError(ConfigFileError);
    }
  });

  it('drops entries too broken to restore rather than failing the whole backup', () => {
    const parsed = parseConfigFile({
      configFile: 1,
      settings: {},
      devices: [{ id: 'ok', ip: '10.0.0.1' }, { name: 'no id' }, 'nonsense'],
      performers: [{ id: 'p' }, {}],
      audioPatch: [{ channelKey: 'a', deviceId: 'hw:1,0', inputChannel: 2 }, {}],
    });
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.performers).toHaveLength(1);
    expect(parsed.audioPatch).toHaveLength(1);
    // Missing settings fall back to the same defaults a fresh install has.
    expect(parsed.settings.batteryWarningPct).toBe(20);
  });
});

describe('describeRestore', () => {
  it('says what will come back', () => {
    const { brings } = describeRestore(buildConfigFile(input()));
    expect(brings.join(' ')).toMatch(/2 devices/);
    expect(brings.join(' ')).toMatch(/2 performers/);
  });

  it('says plainly what will not, because a restore replaces the inventory', () => {
    // "Are you sure?" does not convey that this overwrites the local rig, so the
    // UI gets a list to read instead of a shrug.
    const { needsAttention } = describeRestore(buildConfigFile(input()));
    const text = needsAttention.join(' ');
    expect(text).toMatch(/password/i);
    expect(text).toMatch(/photo/i);
    expect(text).toMatch(/PIN/);
  });

  it('says nothing when there is nothing to warn about', () => {
    const clean = buildConfigFile({
      settings: { authPinEnabled: false },
      devices: [{ id: 'd', ip: '1.1.1.1', password: null }],
      performers: [{ id: 'p', photoPath: null }],
      audioPatch: [],
    });
    expect(describeRestore(clean).needsAttention).toEqual([]);
  });
});
