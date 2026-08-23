import { describe, it, expect } from 'vitest';
import { bodyIdentifiesSennheiser } from './DiscoveryService';

// Discovery previously claimed any HTTPS host that returned 401, or any JSON
// object at all, as a Sennheiser EW-DX. On a venue network that produced a list
// full of routers, NAS boxes and printers. These cases pin the identification
// rule so that cannot come back.

describe('bodyIdentifiesSennheiser — genuine devices', () => {
  it('accepts an explicit vendor field', () => {
    expect(bodyIdentifiesSennheiser({
      vendor: 'Sennheiser', product: 'EW-DX EM 2', serial_number: 'X1',
    })).toBe(true);
  });

  it('accepts vendor regardless of case or spacing', () => {
    expect(bodyIdentifiesSennheiser({ vendor: 'SENNHEISER electronic' })).toBe(true);
    expect(bodyIdentifiesSennheiser({ manufacturer: 'sennheiser' })).toBe(true);
  });

  it('accepts a recognised product family without a vendor field', () => {
    expect(bodyIdentifiesSennheiser({ product: 'EW-DX EM 2' })).toBe(true);
    expect(bodyIdentifiesSennheiser({ model: 'EM 6000' })).toBe(true);
    expect(bodyIdentifiesSennheiser({ model: 'EWDX EM 4' })).toBe(true);
    expect(bodyIdentifiesSennheiser({ name: 'SKM 6000' })).toBe(true);
  });

  it('accepts the SSC version endpoint as the specification documents it', () => {
    // SSCv2 spec 2.3: /api/ssc/version returns {protocol, schema} and nothing
    // else — no vendor, no `ssc` key. This body was being rejected as "not
    // SSC", which is how a real EW-DX dropped out of discovery.
    expect(bodyIdentifiesSennheiser({ protocol: '2.0', schema: '1.5' })).toBe(true);
  });

  it('still accepts firmware that reports an `ssc` key', () => {
    expect(bodyIdentifiesSennheiser({ ssc: '1.2', version: '2.0' })).toBe(true);
  });

  it('accepts the identity endpoint as the specification documents it', () => {
    // Verbatim example from SSCv2 spec 2.3.
    expect(bodyIdentifiesSennheiser({
      product: 'TeamConnect Ceiling 2',
      hardwareRevision: 'DVT',
      serial: 'AB12DEF345',
      vendor: 'Sennheiser electronic GmbH & Co. KG',
    })).toBe(true);
  });

  it('looks inside nested device and identity objects', () => {
    expect(bodyIdentifiesSennheiser({ device: { vendor: 'Sennheiser' } })).toBe(true);
    expect(bodyIdentifiesSennheiser({ identity: { product: 'EW-DX EM 2' } })).toBe(true);
  });
});

describe('bodyIdentifiesSennheiser — things that are not Sennheiser', () => {
  it('rejects a bare JSON error body', () => {
    // The old rule accepted literally any object, so this was claimed.
    expect(bodyIdentifiesSennheiser({ error: 'Not found' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ status: 404, message: 'no route' })).toBe(false);
  });

  it('rejects other vendors answering the same paths', () => {
    expect(bodyIdentifiesSennheiser({ vendor: 'Ubiquiti', product: 'UDM Pro' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ manufacturer: 'Synology', model: 'DS920+' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ vendor: 'Shure', product: 'ULXD4' })).toBe(false);
  });

  it('rejects empty and non-object bodies', () => {
    expect(bodyIdentifiesSennheiser({})).toBe(false);
    expect(bodyIdentifiesSennheiser(null)).toBe(false);
    expect(bodyIdentifiesSennheiser(undefined)).toBe(false);
    expect(bodyIdentifiesSennheiser('EW-DX')).toBe(false);
    expect(bodyIdentifiesSennheiser([])).toBe(false);
  });

  it('does not match a product substring inside an unrelated word', () => {
    // "system" contains "sk"; "modem" contains "em" — neither is a device.
    expect(bodyIdentifiesSennheiser({ model: 'system controller' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ product: 'cable modem' })).toBe(false);
  });

  it('does not mistake any protocol/schema pair for the SSC version shape', () => {
    // The SSC version body holds version numbers; arbitrary strings under the
    // same keys are some other product's API.
    expect(bodyIdentifiesSennheiser({ protocol: 'http', schema: 'v1' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ protocol: 'mqtt', schema: 'sensor' })).toBe(false);
  });

  it('rejects a device whose name merely contains a digit', () => {
    expect(bodyIdentifiesSennheiser({ name: 'Camera 3' })).toBe(false);
    expect(bodyIdentifiesSennheiser({ name: 'Switch 24' })).toBe(false);
  });
});
