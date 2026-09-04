import { test, expect } from '@playwright/test';
import { open, expectNoCrash, clearShows, clearPerformers, standDown } from './helpers';

// Shows, the roster, and the round trip between them. These write through the
// API to the database and come back over the socket, which is exactly where a
// client and server can disagree about a payload and nothing notices.

test.describe('shows and the roster', () => {
  test.beforeEach(async ({ request }) => {
    await standDown(request);
    await clearShows(request);
    await clearPerformers(request);
  });

  test('a performer added to the roster persists on the server', async ({ page, request }) => {
    await open(page, '/performers');

    await page.getByPlaceholder('Name *').fill('Dana Whitfield');
    await page.getByRole('button', { name: /Add performer/ }).click();

    // .performers-input, not any input: the row also holds the hidden file
    // input behind the headshot button.
    await expect(page.locator('.performers-row .performers-input').first()).toHaveValue('Dana Whitfield');
    await expectNoCrash(page);

    // Present on the server, not just on screen.
    const roster = await (await request.get('/api/performers')).json();
    expect(roster.map((p: any) => p.name)).toContain('Dana Whitfield');
  });

  test('a show can be created and cast, and the casting reaches the server', async ({ page, request }) => {
    const show = await (await request.post('/api/shows', {
      data: { name: 'Our Town', environmentMode: 'THEATER' },
    })).json();

    await open(page, '/shows');
    await page.locator('.sm-show-item', { hasText: 'Our Town' }).click();
    await expectNoCrash(page);

    // The roster tab is where casting happens.
    await page.locator('.sm-tab', { hasText: 'Players' }).click();

    await page.getByPlaceholder(/Real Name/i).first().fill('Lee Okonkwo');
    await page.getByRole('button', { name: /Add Player/ }).click();

    // The casting's name is a recast <select>, so the visible assertion is
    // that a row exists; the name itself is checked on the server below.
    await expect(page.locator('.sm-player-row')).toHaveCount(1);

    // A name typed into a cast list joins the roster — that is the point of
    // having one, and it is server-side behaviour a UI test can miss.
    const roster = await (await request.get('/api/performers')).json();
    expect(roster.map((p: any) => p.name)).toContain('Lee Okonkwo');

    const shows = await (await request.get('/api/shows')).json();
    const cast = shows.find((s: any) => s.id === show.id).players;
    expect(cast).toHaveLength(1);
    expect(cast[0].realName).toBe('Lee Okonkwo');
    // Both channel assignments exist on a casting, and both start empty.
    expect(cast[0]).toHaveProperty('assignedChannelKey', null);
    expect(cast[0]).toHaveProperty('iemChannelKey', null);
    expect(cast[0]).toHaveProperty('quickChanges', []);
  });

  test('the show report downloads as CSV and as a printable page', async ({ request }) => {
    const show = await (await request.post('/api/shows', {
      data: { name: 'Report Night', environmentMode: 'THEATER' },
    })).json();

    const csv = await request.get(`/api/shows/${show.id}/report.csv`);
    expect(csv.ok()).toBeTruthy();
    const body = await csv.text();
    // Sectioned, and carrying the columns the notebook added.
    expect(body).toContain('# Show');
    expect(body).toContain('# Roster');
    expect(body).toContain('Mic,IEM');

    const html = await request.get(`/api/shows/${show.id}/report.html`);
    expect(html.ok()).toBeTruthy();
    expect(await html.text()).toContain('Report Night');
  });

  test('deleting a show reports failure rather than pretending', async ({ request }) => {
    // A delete that 404s must not come back as success — the client would drop
    // the show while the server kept it.
    const res = await request.delete('/api/shows/does-not-exist');
    expect(res.status()).toBe(404);
  });
});

test.describe('requests that carry no body', () => {
  // Every bodyless POST and DELETE broke at once when the API client set a
  // JSON content type on all of them, and nothing caught it because each
  // failure looked like a button that did nothing.
  test('clearing events and alerts succeeds', async ({ request }) => {
    expect((await request.delete('/api/events')).ok()).toBeTruthy();
    expect((await request.delete('/api/alerts')).ok()).toBeTruthy();
  });

  test('standing down succeeds with no body', async ({ request }) => {
    await request.post('/api/live', { data: { showId: null } });
    const res = await request.delete('/api/live');
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).live).toBe(false);
  });
});
