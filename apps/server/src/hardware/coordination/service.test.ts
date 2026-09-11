import { describe, it, expect } from 'vitest';
import { buildRig, rowIdOfChannel, type RigDeviceRow } from './service';
import type { Channel } from '@rfdeck/shared-types';

const row = (over: Partial<RigDeviceRow>): RigDeviceRow => ({
  id: 'r1', name: 'Rack 1', manufacturer: 'Shure', model: 'AD4Q', active: true,
  band: null, bandSource: null, dense: false,
  carrierMinKHz: null, carrierMaxKHz: null, carrierStepKHz: null, ...over,
});

const chan = (id: string, frequency: number, over: Partial<Channel> = {}): Channel => ({
  id, deviceId: '10.0.0.1:2202', channelIndex: Number(id.split(':').pop()), name: id, frequency,
  rfLevelA: 0, rfLevelB: 0, afLevel: 0, isMuted: false, role: 'mic', status: 'ACTIVE', ...over,
});

describe('buildRig', () => {
  it('finds the row from the stable channel id', () => {
    expect(rowIdOfChannel('abc-123:2')).toBe('abc-123');
    expect(rowIdOfChannel('10.0.0.1:53212-rx1')).toBe('10.0.0.1');
    expect(rowIdOfChannel('nocolon')).toBeNull();
  });

  it('turns a reported band into transmitters with the device mode', () => {
    const rig = buildRig(
      [row({ band: 'G57', bandSource: 'reported', dense: true })],
      [chan('r1:1', 500_000), chan('r1:2', 0)],
    );
    expect(rig.transmitters).toHaveLength(2);
    expect(rig.transmitters[0]).toMatchObject({ id: 'r1:1', currentKHz: 500_000, dense: true });
    expect(rig.transmitters[1].currentKHz).toBeUndefined();
    expect(rig.transmitters[0].profile.code).toBe('G57');
    expect(rig.devices[0]).toMatchObject({ ready: true, reason: null, bandReported: true, channelCount: 2 });
  });

  it('leaves out a device with no band, says why, and offers candidates', () => {
    const rig = buildRig([row({ model: 'ULXD4D' })], [chan('r1:1', 540_000)]);
    expect(rig.transmitters).toEqual([]);
    expect(rig.skipped).toEqual([{ id: 'r1:1', name: 'r1:1', deviceId: 'r1', reason: 'its band has not been declared' }]);
    const d = rig.devices[0];
    expect(d.ready).toBe(false);
    expect(d.bandReported).toBe(false);
    expect(d.candidates).toEqual(expect.arrayContaining(['H50', 'H52']));
    expect(d.codes.length).toBeGreaterThan(10);
  });

  it('words the wait differently for a family that will report', () => {
    const rig = buildRig([row({ model: 'AD4D' })], [chan('r1:1', 540_000)]);
    expect(rig.devices[0].reason).toBe('the receiver has not reported its band yet');
  });

  it('prefers limits the device published over any band code', () => {
    const rig = buildRig(
      [row({ manufacturer: 'Sennheiser', model: 'EM 6000', carrierMinKHz: 470_100, carrierMaxKHz: 713_900, carrierStepKHz: 25 })],
      [chan('r1:1', 600_000)],
    );
    expect(rig.transmitters[0].profile.segmentsKHz).toEqual([[470_100, 713_900]]);
    expect(rig.transmitters[0].profile.spacingKHz.standard).toBe(400);
  });

  it('refuses a model it cannot tune by name', () => {
    const rig = buildRig([row({ model: 'P10T' })], [chan('r1:1', 600_000, { role: 'iem' })]);
    expect(rig.devices[0]).toMatchObject({ family: null, ready: false, reason: 'RFDeck cannot tune this model' });
    expect(rig.skipped[0].reason).toBe('RFDeck cannot tune this model');
  });

  it('skips inactive devices and channels with no row, saying so', () => {
    const rig = buildRig(
      [row({ band: 'G57', active: false })],
      [chan('r1:1', 500_000), chan('ghost:1', 510_000)],
    );
    expect(rig.transmitters).toEqual([]);
    expect(rig.devices).toEqual([]);
    expect(rig.skipped.map(s => s.reason)).toEqual(['its device is inactive', 'not an inventory device']);
  });

  it('flags a band code the table does not know rather than guessing', () => {
    const rig = buildRig([row({ band: 'Q99', bandSource: 'declared' })], [chan('r1:1', 500_000)]);
    expect(rig.devices[0].reason).toContain('not in RFDeck\'s table');
  });
});
