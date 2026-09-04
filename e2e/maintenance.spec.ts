import { test, expect, APIRequestContext } from '@playwright/test';
import { open, expectNoCrash } from './helpers';

// The device maintenance log: what has been done to a piece of hardware.
//
// Worth end-to-end coverage rather than unit coverage because the interesting
// parts are the seams — a log scoped to one device and refusing to be read
// through another, an entry surviving the round trip to the database, and the
// cascade that takes the history with the device.

async function addDevice(request: APIRequestContext, name: string) {
  const res = await request.post('/api/inventory', {
    data: {
      name,
      manufacturer: 'Sennheiser',
      model: 'EW-DX EM 2',
      ip: `10.77.0.${Math.floor(Math.random() * 200) + 20}`,
      port: 443,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function removeDevice(request: APIRequestContext, id: string) {
  await request.delete(`/api/inventory/${id}`);
}

test.describe('device maintenance log', () => {
  test('an entry survives the round trip and comes back newest first', async ({ request }) => {
    const device = await addDevice(request, 'Maint RX A');

    try {
      // Deliberately out of order, and dated rather than "now" — the whole
      // point of a separate `at` is that work is logged after the fact.
      await request.post(`/api/inventory/${device.id}/maintenance`, {
        data: { kind: 'ELEMENT', summary: 'MKE-1 replaced', at: '2026-01-10T12:00:00Z' },
      });
      await request.post(`/api/inventory/${device.id}/maintenance`, {
        data: { kind: 'REPAIR', summary: 'Sent to service', detail: 'RMA 41822', at: '2026-03-02T12:00:00Z' },
      });

      const { entries } = await (await request.get(`/api/inventory/${device.id}/maintenance`)).json();
      expect(entries).toHaveLength(2);
      expect(entries[0].summary).toBe('Sent to service');
      expect(entries[0].detail).toBe('RMA 41822');
      expect(entries[1].summary).toBe('MKE-1 replaced');
      // Typed by a person, so not marked as something RFDeck observed.
      expect(entries[0].automatic).toBe(false);
    } finally {
      await removeDevice(request, device.id);
    }
  });

  test('an entry without a summary is refused', async ({ request }) => {
    const device = await addDevice(request, 'Maint RX B');
    try {
      const res = await request.post(`/api/inventory/${device.id}/maintenance`, {
        data: { kind: 'NOTE', detail: 'detail but no summary' },
      });
      expect(res.status()).toBe(400);

      // Whitespace is not a summary either.
      const blank = await request.post(`/api/inventory/${device.id}/maintenance`, {
        data: { kind: 'NOTE', summary: '   ' },
      });
      expect(blank.status()).toBe(400);
    } finally {
      await removeDevice(request, device.id);
    }
  });

  test('an unknown kind falls back to NOTE rather than being stored verbatim', async ({ request }) => {
    const device = await addDevice(request, 'Maint RX C');
    try {
      await request.post(`/api/inventory/${device.id}/maintenance`, {
        data: { kind: 'DROP_TABLE', summary: 'odd kind' },
      });
      const { entries } = await (await request.get(`/api/inventory/${device.id}/maintenance`)).json();
      expect(entries[0].kind).toBe('NOTE');
    } finally {
      await removeDevice(request, device.id);
    }
  });

  test('a log cannot be read or edited through the wrong device', async ({ request }) => {
    const a = await addDevice(request, 'Maint RX D');
    const b = await addDevice(request, 'Maint RX E');
    try {
      const entry = await (await request.post(`/api/inventory/${a.id}/maintenance`, {
        data: { kind: 'SERVICE', summary: 'Connectors reseated' },
      })).json();

      // B's log is its own, and does not contain A's entry.
      const { entries } = await (await request.get(`/api/inventory/${b.id}/maintenance`)).json();
      expect(entries).toHaveLength(0);

      // Nor can A's entry be edited or deleted by addressing it through B.
      const patched = await request.patch(`/api/inventory/${b.id}/maintenance/${entry.id}`, {
        data: { summary: 'hijacked' },
      });
      expect(patched.status()).toBe(404);

      const deleted = await request.delete(`/api/inventory/${b.id}/maintenance/${entry.id}`);
      expect(deleted.status()).toBe(404);

      // Still intact.
      const after = await (await request.get(`/api/inventory/${a.id}/maintenance`)).json();
      expect(after.entries[0].summary).toBe('Connectors reseated');
    } finally {
      await removeDevice(request, a.id);
      await removeDevice(request, b.id);
    }
  });

  test('a missing device is a 404, not an empty log', async ({ request }) => {
    // An empty list here would have a client cheerfully display "no
    // maintenance recorded" for a device that does not exist.
    const res = await request.get('/api/inventory/00000000-0000-0000-0000-000000000000/maintenance');
    expect(res.status()).toBe(404);
  });

  test('removing a device takes its log with it', async ({ request }) => {
    const device = await addDevice(request, 'Maint RX F');
    await request.post(`/api/inventory/${device.id}/maintenance`, {
      data: { kind: 'BATTERY', summary: 'Cells replaced' },
    });

    await removeDevice(request, device.id);

    const res = await request.get(`/api/inventory/${device.id}/maintenance`);
    expect(res.status()).toBe(404);
  });

  test('an entry logged in the drawer appears in the list and on the server', async ({ page, request }) => {
    const device = await addDevice(request, 'Drawer Maint RX');

    try {
      await open(page, '/inventory');
      await page.locator('.hardware-card', { hasText: 'Drawer Maint RX' }).click();
      await expectNoCrash(page);

      await page.getByRole('button', { name: /Log maintenance/ }).click();
      await page.getByLabel('Kind of work').selectOption('BATTERY');
      await page.getByLabel('Summary').fill('Pack held 40% for a week');
      await page.getByRole('button', { name: /Add entry/ }).click();

      await expect(page.locator('.maint-entry')).toHaveCount(1);
      await expect(page.locator('.maint-summary')).toHaveText('Pack held 40% for a week');
      await expect(page.locator('.maint-kind')).toHaveText(/Battery/i);
      await expectNoCrash(page);

      const { entries } = await (await request.get(`/api/inventory/${device.id}/maintenance`)).json();
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('BATTERY');
      expect(entries[0].summary).toBe('Pack held 40% for a week');
    } finally {
      await removeDevice(request, device.id);
    }
  });
});
