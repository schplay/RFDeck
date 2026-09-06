import { test, expect, APIRequestContext } from '@playwright/test';

// Whether a device is a microphone receiver or an IEM transmitter.
//
// It decides which column the device appears in during soundcheck, and whether
// RFDeck alerts on its RF at all — an IEM receives nothing, so treating one as
// a microphone means dropout alerts on a device that is working perfectly.
//
// RFDeck infers it from the model and name **when a device is added**, because
// the add form defaults to "input" and a device added from the discovery list
// is never asked at all. Nothing re-runs that guess afterwards: an existing
// device's type belongs to the operator, and a restart that rewrote it would
// mean a correction never stuck.

async function add(request: APIRequestContext, fields: Record<string, unknown>) {
  const res = await request.post('/api/inventory', {
    data: {
      manufacturer: 'Sennheiser',
      ip: `10.44.0.${Math.floor(Math.random() * 200) + 20}`,
      port: 443,
      ...fields,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function remove(request: APIRequestContext, id: string) {
  await request.delete(`/api/inventory/${id}`);
}

test.describe('device type inference', () => {
  test('files an IEM transmitter as an output from its model', async ({ request }) => {
    const d = await add(request, { name: 'Wedge Rack', model: 'SR 2050' });
    try {
      expect(d.deviceType).toBe('output');
      // Recorded as RFDeck's guess rather than a person's decision.
      expect(d.deviceTypeManual).toBe(false);
    } finally { await remove(request, d.id); }
  });

  test('reads the name when the model says nothing', async ({ request }) => {
    // The common case: a G3 IEM discovered over MCP has a vague model and a
    // name the operator chose.
    const d = await add(request, { name: 'IEM 1', model: 'EW G3/G4' });
    try {
      expect(d.deviceType).toBe('output');
    } finally { await remove(request, d.id); }
  });

  test('leaves a receiver alone', async ({ request }) => {
    const d = await add(request, { name: 'Vocal Rack', model: 'EW-DX EM 2' });
    try {
      expect(d.deviceType).toBe('input');
    } finally { await remove(request, d.id); }
  });

  test('does not reclassify a receiver that merely mentions IEM', async ({ request }) => {
    // A location label. Getting this wrong silences dropout alerting on a
    // working microphone, which is the worse direction to fail in.
    const d = await add(request, { name: 'Rack 2 next to IEM world', model: 'EW-DX EM 4' });
    try {
      expect(d.deviceType).toBe('input');
    } finally { await remove(request, d.id); }
  });

  test('defaults to input when nothing says otherwise', async ({ request }) => {
    const d = await add(request, { name: 'Rack 9', model: 'Unknown Model' });
    try {
      expect(d.deviceType).toBe('input');
      expect(d.deviceTypeManual).toBe(false);
    } finally { await remove(request, d.id); }
  });
});

test.describe('the operator overrules the guess', () => {
  test('a correction is recorded as deliberate, and survives', async ({ request }) => {
    // The invariant: inference runs once, at add time, and a person's decision
    // outranks it permanently. Naming conventions vary between users, so
    // RFDeck will not always guess right — and being wrong permanently is not
    // acceptable.
    const d = await add(request, { name: 'IEM 1', model: 'EW G3/G4' });
    try {
      expect(d.deviceType).toBe('output');
      expect(d.deviceTypeManual).toBe(false);

      const corrected = await (await request.put(`/api/inventory/${d.id}`, {
        data: { deviceType: 'input' },
      })).json();

      expect(corrected.deviceType).toBe('input');
      expect(corrected.deviceTypeManual).toBe(true);

      // And it survives a re-read, rather than being a response-only value.
      const all = await (await request.get('/api/inventory')).json();
      const stored = all.find((x: any) => x.id === d.id);
      expect(stored.deviceType).toBe('input');
      expect(stored.deviceTypeManual).toBe(true);
    } finally { await remove(request, d.id); }
  });

  test('choosing output on the add form is deliberate too', async ({ request }) => {
    // The form defaults to input, so nobody picks output by accident.
    const d = await add(request, { name: 'Rack 3', model: 'Unknown Model', deviceType: 'output' });
    try {
      expect(d.deviceType).toBe('output');
      expect(d.deviceTypeManual).toBe(true);
    } finally { await remove(request, d.id); }
  });

  test('editing another field does not claim the type was chosen', async ({ request }) => {
    // Provenance stays honest: renaming a device is not a statement about
    // what kind of device it is.
    const d = await add(request, { name: 'Rack 4', model: 'Unknown Model' });
    try {
      const renamed = await (await request.put(`/api/inventory/${d.id}`, {
        data: { name: 'Rack Four' },
      })).json();
      expect(renamed.name).toBe('Rack Four');
      expect(renamed.deviceTypeManual).toBe(false);
    } finally { await remove(request, d.id); }
  });
});
