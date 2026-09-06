import { describe, it, expect } from 'vitest';
import { inferDeviceRole, looksLikeIem, isSscModel, isPlaceholderModel } from './deviceRole';

// Filing an IEM transmitter as a microphone is not cosmetic: it has no RF to
// receive, so it reads as a channel permanently at 0% and clutters the
// soundcheck with rows nobody is speaking into. Filing a microphone as an IEM
// is worse — it suppresses that channel's dropout alerting.
//
// So this errs towards "I cannot tell" in both directions.

describe('inferDeviceRole — IEM transmitters', () => {
  it('recognises Sennheiser IEM transmitters', () => {
    expect(inferDeviceRole('ew IEM G4')).toBe('output');
    expect(inferDeviceRole('ew 300 IEM G3')).toBe('output');
    expect(inferDeviceRole('SR 2050')).toBe('output');
    expect(inferDeviceRole('SR 2000')).toBe('output');
    expect(inferDeviceRole('SR 300 G4')).toBe('output');
  });

  it('recognises Shure personal monitors', () => {
    expect(inferDeviceRole('PSM 1000')).toBe('output');
    expect(inferDeviceRole('PSM1000')).toBe('output');
    expect(inferDeviceRole('P10T')).toBe('output');
    expect(inferDeviceRole('P3T')).toBe('output');
  });

  it('reads the device name when the model says nothing', () => {
    // Discovery often has a name and a vague model.
    expect(inferDeviceRole('', 'Monitor IEM Rack')).toBe('output');
    expect(looksLikeIem(null, 'SR 2050')).toBe(true);
  });
});

describe('inferDeviceRole — receivers', () => {
  it('recognises Sennheiser receivers', () => {
    expect(inferDeviceRole('EW-DX EM 2')).toBe('input');
    expect(inferDeviceRole('EM 6000')).toBe('input');
    expect(inferDeviceRole('EM 9046')).toBe('input');
    expect(inferDeviceRole('EM 2050')).toBe('input');
  });

  it('recognises Shure receivers', () => {
    expect(inferDeviceRole('AD4D')).toBe('input');
    expect(inferDeviceRole('ULXD4Q')).toBe('input');
    expect(inferDeviceRole('QLXD4')).toBe('input');
    expect(inferDeviceRole('SLXD4D')).toBe('input');
  });

  it('never reclassifies a receiver that merely mentions IEM', () => {
    // A location label, or a system name carrying both halves. Getting this
    // wrong silences dropout alerting on a working microphone.
    expect(inferDeviceRole('EM 2050', 'Rack 2 — next to IEM rack')).toBe('input');
    expect(inferDeviceRole('EW-DX EM 4', 'IEM World')).toBe('input');
  });
});

describe('inferDeviceRole — refusing to guess', () => {
  it('returns null when the model says nothing either way', () => {
    // Null means "ask", not "input". The caller decides what to do with not
    // knowing rather than having that decision made here.
    expect(inferDeviceRole('Unknown Model')).toBeNull();
    expect(inferDeviceRole('EW G3/G4')).toBeNull();
    expect(inferDeviceRole('')).toBeNull();
    expect(inferDeviceRole(null, null)).toBeNull();
    expect(inferDeviceRole(undefined)).toBeNull();
  });

  it('is not fooled by a stray "sr" inside a word', () => {
    expect(inferDeviceRole('Ushers Booth Receiver')).toBeNull();
    expect(inferDeviceRole('SRX835')).toBeNull();
  });
});

describe('isSscModel — which devices may take the G3/G4 fallback', () => {
  // The fallback is a one-way door: it stops the SSC client and starts an MCP
  // one instead. For a G3 that is the whole point. For an EW-DX it is fatal —
  // MCP cannot reach one — and a single transient disconnect during the probe
  // was enough to walk an EW-DX through it and leave it there. Going live
  // again re-ran the same race, so the receiver never came back while the G3s
  // did.

  it('protects the SSC receivers, which must never be downgraded', () => {
    expect(isSscModel('EW-DX EM 2')).toBe(true);
    expect(isSscModel('EW-DX EM 4 DANTE')).toBe(true);
    expect(isSscModel('EWDX EM2')).toBe(true);
    expect(isSscModel('EM 6000')).toBe(true);
    expect(isSscModel('EM 2050')).toBe(true);
    expect(isSscModel('EM 9046')).toBe(true);
  });

  it('leaves the fallback available for the devices that need it', () => {
    // "EW G3/G4" is precisely the case the fallback exists to rescue: the SSC
    // probe fails and MCP is tried instead.
    expect(isSscModel('EW G3/G4')).toBe(false);
    expect(isSscModel('ew 500 G4')).toBe(false);
    // And an unknown device keeps both chances.
    expect(isSscModel('Unknown Model')).toBe(false);
    expect(isSscModel('')).toBe(false);
    expect(isSscModel(null)).toBe(false);
  });
});

describe('isPlaceholderModel', () => {
  // A model that names nothing still looks like data. Code that keys on the
  // model — which client to build, whether the G3/G4 fallback may claim a
  // device — is silently blinded by one, and the operator has no idea their
  // receiver is described as "Sennheiser Device".

  it('recognises what the add form writes when the field is blank', () => {
    expect(isPlaceholderModel('Sennheiser Device', 'Sennheiser')).toBe(true);
    expect(isPlaceholderModel('Shure Device', 'Shure')).toBe(true);
    // Even when the manufacturer is not passed for comparison.
    expect(isPlaceholderModel('Sennheiser Device')).toBe(true);
  });

  it('recognises the discovery fallbacks and blanks', () => {
    expect(isPlaceholderModel('Unknown Model')).toBe(true);
    expect(isPlaceholderModel('Unknown Shure model')).toBe(true);
    expect(isPlaceholderModel('')).toBe(true);
    expect(isPlaceholderModel(null)).toBe(true);
    expect(isPlaceholderModel('   ')).toBe(true);
  });

  it('never claims a real model is a placeholder', () => {
    // Overwriting one of these would replace something an operator typed.
    for (const m of ['EW-DX EM 2', 'EM 6000', 'AD4D', 'ULXD4D', 'EW G3/G4',
                     'SR 2050', 'P10T', 'IEM 2']) {
      expect(isPlaceholderModel(m, 'Sennheiser'), m).toBe(false);
    }
  });

  it('does not mistake a two-word model for the "<vendor> Device" pattern', () => {
    // "Digital 6000" is two words and a real model.
    expect(isPlaceholderModel('Digital 6000', 'Sennheiser')).toBe(false);
  });
});
