import { describe, it, expect } from 'vitest';
import {
  buildConfigFile, parseConfigFile, describeRestore,
  ConfigFileError, CONFIG_FILE_VERSION,
} from './configFile';

// The install snapshot.
//
// Credentials deliberately travel: a restore that dropped device passwords would
// leave devices falling out of a rig that looked restored, which is the failure a
// backup exists to prevent. So these assert that they *do* come back, and that the
// few things still excluded are excluded for the reason that copying them onto a
// second install breaks the first.

const input = () => ({
  settings: {
    aes67MulticastIp: '239.69.0.2', aes67Port: 5004,
    batteryWarningPct: 25, batteryCriticalPct: 5, dropoutSensitivity: 30,
    bindInterface: '10.0.1.9', discoveryIgnore: '10.0.2.0/24',
    audioInputDevice: 'hw:1,0',
    recordingEnabled: true, recordingMaxMb: 4096,
    recordingPreSec: 20, recordingPostSec: 10,
    authPinEnabled: true, authPinHash: '$2y$10$hashed-pin', authReauthHours: 12,
    venueLocation: '40.7128, -74.0060',
    // Excluded because copying them breaks the install they came from, not for
    // secrecy. Present here so the tests below can prove they are dropped.
    vapidPrivateKey: 'vapid-private', vapidPublicKey: 'vapid-public',
    cloudRefreshToken: 'rotating-refresh-token',
    eventInstanceId: 'instance-uuid', eventSeq: 4211,
  },
  devices: [
    {
      id: 'dev-b', name: 'Rack 2', manufacturer: 'Shure', model: 'ULXD4Q',
      ip: '10.0.1.21', port: 2202, location: 'SR', notes: '', deviceType: 'input',
      deviceTypeManual: true, active: true, disabledSlots: '3,4',
      mac: 'AA:BB', serial: 'S2', band: 'G50', bandSource: 'reported',
      dense: true, carrierMinKHz: null, carrierMaxKHz: null, carrierStepKHz: null,
      // Unsealed by `configBackup.build()` before the builder sees it.
      password: 'rack-two-access',
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
  webhooks: [
    {
      id: 'wh-2', name: 'Slack', url: 'https://hooks.example/abc',
      secret: 'signing-key-2', enabled: true, minSeverity: 'CRITICAL',
      // Delivery history, which describes the install that was running.
      lastAt: new Date('2026-09-25T20:00:00Z'), lastStatus: 200, failures: 3,
    },
    {
      id: 'wh-1', name: 'Home automation', url: 'http://10.0.1.5/hook',
      secret: null, enabled: false, minSeverity: 'WARNING',
    },
  ],
  version: '1.4.0',
  edition: 'server',
});

describe('what the snapshot carries', () => {
  it('carries the inventory, the roster, the patch, the webhooks and the settings', () => {
    const file = buildConfigFile(input(), new Date('2026-09-26T09:00:00Z'));
    expect(file.configFile).toBe(CONFIG_FILE_VERSION);
    expect(file.devices).toHaveLength(2);
    expect(file.performers).toHaveLength(2);
    expect(file.audioPatch).toHaveLength(2);
    expect(file.webhooks).toHaveLength(2);
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
    shuffled.webhooks.reverse();
    const a = JSON.stringify(buildConfigFile(input(), new Date('2026-09-26T09:00:00Z')));
    const b = JSON.stringify(buildConfigFile(shuffled, new Date('2026-09-26T09:00:00Z')));
    expect(b).toBe(a);
  });
});

describe('the credentials a restore needs', () => {
  it('carries device passwords, so restored devices actually connect', () => {
    // The whole point. A device whose password was dropped looks configured and
    // fails to connect, which is worse than not being restored at all.
    const file = buildConfigFile(input());
    expect(file.devices.find(d => d.id === 'dev-b')!.password).toBe('rack-two-access');
    expect(file.devices.find(d => d.id === 'dev-a')!.password).toBeNull();
  });

  it('carries webhook secrets, so a restored rig is still notifying', () => {
    const file = buildConfigFile(input());
    expect(file.webhooks.find(w => w.id === 'wh-2')!.secret).toBe('signing-key-2');
    expect(file.webhooks.find(w => w.id === 'wh-1')!.secret).toBeNull();
  });

  it('carries the PIN hash, so the same PIN opens the restored machine', () => {
    const file = buildConfigFile(input());
    expect(file.settings.authPinEnabled).toBe(true);
    expect(file.settings.authPinHash).toBe('$2y$10$hashed-pin');
  });
});

describe('what the snapshot must still never carry', () => {
  it('drops the values that would break the install they came from', () => {
    const json = JSON.stringify(buildConfigFile(input()));
    // Not secrecy. A replayed refresh token revokes the whole family and unlinks
    // both installs; shared VAPID keys give two servers a claim on the same
    // phones; a shared event instance id makes two rigs look like one.
    for (const excluded of [
      'rotating-refresh-token', 'vapid-private', 'vapid-public', 'instance-uuid', '4211',
    ]) {
      expect(json).not.toContain(excluded);
    }
  });

  it('drops webhook delivery history, which belongs to the install that was running', () => {
    const json = JSON.stringify(buildConfigFile(input()));
    for (const field of ['lastAt', 'lastStatus', 'failures']) {
      expect(json).not.toContain(field);
    }
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
      // A webhook with no URL has nowhere to post, so it is not a webhook.
      webhooks: [{ id: 'w', url: 'https://x.test/h' }, { id: 'no-url' }],
    });
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.performers).toHaveLength(1);
    expect(parsed.audioPatch).toHaveLength(1);
    expect(parsed.webhooks).toHaveLength(1);
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

  it('says that passwords come back, since the old behaviour was the opposite', () => {
    // An operator who learned to expect re-entering every password should be able
    // to see from the dialog that they no longer have to.
    const { brings } = describeRestore(buildConfigFile(input()));
    const text = brings.join(' ');
    expect(text).toMatch(/password/i);
    expect(text).toMatch(/signing secret/i);
    expect(text).toMatch(/PIN/);
  });

  it('says plainly what will not come back, because a restore rewrites the rig', () => {
    // "Are you sure?" does not convey that this overwrites the local rig, so the
    // UI gets a list to read instead of a shrug.
    const { needsAttention } = describeRestore(buildConfigFile(input()));
    const text = needsAttention.join(' ');
    expect(text).toMatch(/photo/i);
    expect(text).toMatch(/push subscriptions/i);
  });

  it('still names the per-install things even on an otherwise clean backup', () => {
    const clean = buildConfigFile({
      settings: { authPinEnabled: false },
      devices: [{ id: 'd', ip: '1.1.1.1', password: null }],
      performers: [{ id: 'p', photoPath: null }],
      audioPatch: [],
    });
    const { brings, needsAttention } = describeRestore(clean);
    // No photos to warn about, but the cloud link and push subscriptions are
    // always re-established on the restoring machine.
    expect(needsAttention).toHaveLength(1);
    expect(brings.join(' ')).not.toMatch(/password/i);
  });
});
