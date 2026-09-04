import { describe, it, expect } from 'vitest';
import {
  rfByteToDbm, afByteToDbfs, lqiToPercent, parseBattery, parseMetering,
  applyMessage, subscriptionMessages, isDigital6000,
  SSC_PORT, METER_INTERVAL_MS,
} from './protocol';

// Fixtures are quoted from Sennheiser's own "Sound Control Protocol — Digital
// 6000" developer's guide (TI 1109 v2.2), including its worked example of the
// metering array. There is no EM 6000 on this machine, so the document is the
// closest thing to hardware.

describe('transport constants', () => {
  it('uses the documented SSC port', () => {
    // "The default port number is 45." A Companion module defaults to 6970,
    // which appears nowhere in Sennheiser's specification — the document wins.
    expect(SSC_PORT).toBe(45);
  });
});

describe('conversions', () => {
  it('converts an RF byte to dBm by the documented formula', () => {
    // "RF1/2: RF level for antenna 1/2. Value in dBm=(Value-255)/2"
    expect(rfByteToDbm(255)).toBe(0);
    expect(rfByteToDbm(0)).toBe(-127.5);
    // From the specification's own example row: 83 and 53.
    expect(rfByteToDbm(83)).toBe(-86);
    expect(rfByteToDbm(53)).toBe(-101);
  });

  it('converts an AF byte to dBFS by its own documented formula', () => {
    // "AF: AF level (full scale audio level). dBFS = (Value+1)/2-128"
    expect(afByteToDbfs(255)).toBe(0);
    expect(afByteToDbfs(165)).toBe(-45);
    expect(afByteToDbfs(0)).toBe(-127.5);
  });

  it('is algebraically the same arithmetic as the RF formula', () => {
    // The specification writes them differently — (Value+1)/2-128 against
    // (Value-255)/2 — and they expand to the same thing. Worth pinning: this
    // assertion was originally written the other way round, asserting they
    // differ, and it failed. They are kept as separate functions because they
    // convert different quantities, not because the arithmetic differs.
    for (const v of [0, 1, 83, 100, 165, 254, 255]) {
      expect(afByteToDbfs(v)).toBe(rfByteToDbm(v));
    }
  });

  it('converts link quality, where 255 is best', () => {
    expect(lqiToPercent(255)).toBe(100);
    expect(lqiToPercent(0)).toBe(0);
    expect(lqiToPercent(128)).toBe(50);
  });
});

describe('parseBattery', () => {
  it('reads the four states the protocol actually has', () => {
    // Digital 6000 reports no percentage — only {"100%","70%","30%","low"}.
    expect(parseBattery(['100%', '5:12'])!.percent).toBe(100);
    expect(parseBattery(['70%', '5:12'])!.percent).toBe(70);
    expect(parseBattery(['30%', '1:05'])!.percent).toBe(30);
  });

  it('puts "low" under the warning threshold but above the critical one', () => {
    // The one number here that is RFDeck's choice rather than Sennheiser's:
    // "low" names no percentage, and a pack the receiver calls low should
    // raise a warning rather than a crisis.
    const low = parseBattery(['low', '-:--'])!;
    expect(low.percent).toBeLessThanOrEqual(20);
    expect(low.percent).toBeGreaterThan(5);
  });

  it('reads the remaining time as minutes', () => {
    expect(parseBattery(['70%', '5:12'])!.minutesRemaining).toBe(312);
    expect(parseBattery(['100%', '0:45'])!.minutesRemaining).toBe(45);
  });

  it('treats an unavailable time as absent rather than zero', () => {
    // "'-:--' if time information is not available."
    expect(parseBattery(['low', '-:--'])!.minutesRemaining).toBeUndefined();
  });

  it('returns nothing at all for an empty array', () => {
    // "An empty array indicates that the transmitter is not present." No pack
    // is not a flat pack, and reporting 0% would raise a critical alert on a
    // receiver nobody has switched a transmitter on for.
    expect(parseBattery([])).toBeNull();
    expect(parseBattery(null)).toBeNull();
    expect(parseBattery(undefined)).toBeNull();
  });
});

describe('parseMetering', () => {
  // The specification's own example:
  //   {"mm":[[0,0,0,0,0,0,0,0,0],[83,0,53,0,1,1,128,165,0]]}
  const MM = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [83, 0, 53, 0, 1, 1, 128, 165, 0]];

  it('reads the documented example row', () => {
    const rows = parseMetering(MM);
    expect(rows).toHaveLength(2);

    const ch2 = rows[1];
    expect(ch2.rfDbmA).toBe(-86);
    expect(ch2.rfDbmB).toBe(-101);
    expect(ch2.antennaA).toBe(true);
    expect(ch2.antennaB).toBe(true);
    expect(ch2.linkQuality).toBe(50);
    expect(ch2.afDbfs).toBe(-45);
    expect(ch2.afPeak).toBe(false);
  });

  it('maps RF onto the same 0-100 window every other vendor uses', () => {
    const ch2 = parseMetering(MM)[1];
    // -86 dBm is poor but not silent; -101 is below the floor.
    expect(ch2.rfPercentA).toBeGreaterThan(0);
    expect(ch2.rfPercentA).toBeLessThan(20);
    expect(ch2.rfPercentB).toBe(0);
  });

  it('reads the peak flags, which are a clip and not a level', () => {
    const clipping = parseMetering([[200, 1, 200, 0, 1, 0, 255, 250, 1]])[0];
    expect(clipping.rfPeakA).toBe(true);
    expect(clipping.rfPeakB).toBe(false);
    expect(clipping.afPeak).toBe(true);
  });

  it('refuses a short row rather than reading missing fields as zero', () => {
    // A truncated datagram must not report a dead link on a working channel.
    const rows = parseMetering([[83, 0, 53]]);
    expect(rows[0]).toBeNull();
  });

  it('returns nothing for a non-array', () => {
    expect(parseMetering(null)).toEqual([]);
    expect(parseMetering('mm')).toEqual([]);
  });
});

describe('applyMessage', () => {
  it('folds a metering datagram into channel state', () => {
    const tree = applyMessage({ mm: [[200, 0, 190, 0, 1, 1, 255, 200, 0]] }, [1, 2]);
    expect(tree.rx1!.rf_quality).toBeGreaterThan(0);
    expect(tree.rx1!.af_level).toBe(-27.5);
  });

  it('reads the channel tree, with frequency already in kHz', () => {
    // "sets or returns the carrier Frequency in kHz"
    const tree = applyMessage({
      rx1: { name: 'Lead Vox', carrier: 470100, audio_mute: false },
    }, [1, 2]);
    expect(tree.rx1!.name).toBe('Lead Vox');
    expect(tree.rx1!.frequency).toBe(470100);
    expect(tree.rx1!.mute).toBe(false);
  });

  it('reports only what the message carried', () => {
    // A metering datagram says nothing about names and must not blank them,
    // because the caller merges these over what it already knows.
    const tree = applyMessage({ mm: [[200, 0, 190, 0, 1, 1, 255, 200, 0]] }, [1]);
    expect(tree.rx1!.name).toBeUndefined();
    expect(tree.rx1!.frequency).toBeUndefined();
  });

  it('reads the transmitter battery from under skx', () => {
    const tree = applyMessage({ rx1: { skx: { battery: ['70%', '5:12'] } } }, [1]);
    expect(tree.rx1!.battery).toEqual({ percent: 70, minutesRemaining: 312 });
  });

  it('leaves battery absent when no transmitter is paired', () => {
    const tree = applyMessage({ rx1: { skx: { battery: [] } } }, [1]);
    expect(tree.rx1!.battery).toBeUndefined();
  });

  it('reads NoLink as a squelch rather than an operator mute', () => {
    // The performer's transmitter being off is deliberate, not a fault — the
    // same distinction EW-DX draws with TX_Mute.
    const off = applyMessage({ rx1: { active_warnings: ['NoLink'] } }, [1]);
    expect(off.rx1!.squelch).toBe(true);

    const on = applyMessage({ rx1: { active_warnings: ['AFPeak'] } }, [1]);
    expect(on.rx1!.squelch).toBe(false);
  });

  it('ignores a channel the device was not asked about', () => {
    const tree = applyMessage({ rx3: { name: 'Nope' } }, [1, 2]);
    expect(tree.rx3).toBeUndefined();
  });

  it('survives a malformed datagram', () => {
    expect(applyMessage(null, [1])).toEqual({});
    expect(applyMessage('not json', [1])).toEqual({});
    expect(applyMessage({ rx1: 'not an object' }, [1])).toEqual({});
  });
});

describe('subscriptionMessages', () => {
  it('asks for metering at the rate the specification itself uses', () => {
    const [meter] = subscriptionMessages([1, 2]);
    const parsed = JSON.parse(meter);
    const req = parsed.osc.state.subscribe[0];
    expect(req.mm).toBeNull();
    expect(req['#'].min).toBe(METER_INTERVAL_MS);
    expect(req['#'].max).toBe(METER_INTERVAL_MS);
    expect(req['#'].lifetime).toBeGreaterThan(0);
  });

  it('subscribes the channel tree separately from metering', () => {
    // Asking for names and frequencies at the metering rate would be a
    // datagram twice a second for values that move when someone touches
    // something.
    const [, state] = subscriptionMessages([1, 2]);
    const req = JSON.parse(state).osc.state.subscribe[0];
    expect(req.rx1).toBeDefined();
    expect(req.rx2).toBeDefined();
    expect(req['#'].min).toBeUndefined();
    expect(req.rx1.skx.battery).toBeNull();
  });

  it('asks only about the channels the device has', () => {
    const [, state] = subscriptionMessages([1]);
    const req = JSON.parse(state).osc.state.subscribe[0];
    expect(req.rx1).toBeDefined();
    expect(req.rx2).toBeUndefined();
  });
});

describe('isDigital6000', () => {
  it('recognises the models this client drives', () => {
    expect(isDigital6000('EM 6000')).toBe(true);
    expect(isDigital6000('EM6000')).toBe(true);
    expect(isDigital6000('EM 6000 Dante')).toBe(true);
    expect(isDigital6000('L 6000')).toBe(true);
    expect(isDigital6000('Digital 6000')).toBe(true);
  });

  it('does not claim EW-DX or the Digital 9000, which are other protocols', () => {
    expect(isDigital6000('EW-DX EM 2')).toBe(false);
    expect(isDigital6000('EM 9046')).toBe(false);
    expect(isDigital6000('EW G3/G4')).toBe(false);
    expect(isDigital6000('')).toBe(false);
  });
});
