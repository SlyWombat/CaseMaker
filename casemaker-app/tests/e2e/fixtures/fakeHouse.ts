/**
 * #1172/#1173 — A HOUSE SERVICE SERVED FROM THE TEST.
 *
 * The real house is the desktop app's embedded service; the web e2e build has none, so Manage's
 * Tools page renders its "no house service here" state. This fixture intercepts the four read
 * endpoints the client asks for — `/api/v1/health`, `/tools`, `/feeds`, `/inventory` — and answers
 * with the same documents the service would, validated by the app's own schemas at parse time.
 *
 * The fixture intentionally serves an empty catalogue and feed table: these tests are about the
 * operator's OWN bits (the inventory) and the Manage surface around them. A write is answered with
 * an empty 204, the success the client already handles; nothing is persisted.
 */
import type { Page, Route } from '@playwright/test';
import { flatEndMill } from '../../../src/engine/cnc/tool';

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  build: 'v-test',
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  problems: [],
  warnings: [],
  lastSync: null,
};

const ADDED = '2026-11-01T09:00:00.000Z';

type Condition = 'new' | 'used' | 'worn' | 'broken' | 'lost' | null;

function copy(id: string, condition: Condition, colour?: string) {
  return {
    id,
    condition,
    whereabouts:
      colour === undefined
        ? { kind: 'box', case: null }
        : { kind: 'box', case: { colour, label: `${colour} base, clear tube` } },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  };
}

function item(opts: {
  id: string;
  tool: ReturnType<typeof flatEndMill>;
  quantity: number;
  copies: ReturnType<typeof copy>[];
  notes: string | null;
  code: string;
}) {
  return {
    id: opts.id,
    tool: opts.tool,
    origin: null,
    quantity: opts.quantity,
    codes: [{ symbology: 'qr', value: opts.code }],
    addedAt: ADDED,
    notes: opts.notes,
    copies: opts.copies,
    colletFits: null,
  };
}

/** Five owned bits, in the mockup's own kinds: two corn, a ball, a metal flat and a lost long flat. */
const INVENTORY = [
  item({
    id: 'bits-corn-06',
    tool: flatEndMill(0.6, { name: '0.6 mm corn', typeText: 'Corn Bit' }),
    quantity: 2,
    copies: [copy('bits-corn-06-1', 'new', 'yellow'), copy('bits-corn-06-2', 'used', 'yellow')],
    notes: 'box A · row 2',
    code: 'C1-BIT-CORN-0-6',
  }),
  item({
    id: 'bits-corn-09',
    tool: flatEndMill(0.9, { name: '0.9 mm corn', typeText: 'Corn Bit' }),
    quantity: 2,
    copies: [copy('bits-corn-09-1', 'used', 'red'), copy('bits-corn-09-2', 'broken', 'red')],
    notes: 'box B · row 2',
    code: 'C1-BIT-CORN-0-9',
  }),
  item({
    id: 'bits-ball-1',
    tool: flatEndMill(1, { name: '1 mm ball', typeText: 'Ball Nose', shape: 'ball' }),
    quantity: 2,
    copies: [copy('bits-ball-1-1', 'new', 'yellow'), copy('bits-ball-1-2', 'new', 'yellow')],
    notes: 'box A · row 1',
    code: 'C1-BIT-BALL-1-0',
  }),
  item({
    id: 'bits-flat-metal-1',
    tool: flatEndMill(1, { name: '1 mm flat, metal', typeText: 'Single Flute Bit for Metal' }),
    quantity: 1,
    copies: [copy('bits-flat-metal-1-1', 'worn', 'green')],
    notes: 'box A · row 5',
    code: 'C1-BIT-FLAT-1-0-M',
  }),
  item({
    id: 'bits-flat-3175-long',
    tool: flatEndMill(3.175, { name: '3.175 mm flat, long' }),
    quantity: 1,
    copies: [copy('bits-flat-3175-long-1', 'lost', 'yellow')],
    notes: 'box A · row 3',
    code: 'C1-BIT-FLAT-3-175-L',
  }),
];

function bodyFor(path: string): unknown | null {
  switch (path) {
    case '/health':
      return HEALTH;
    case '/tools':
      return [];
    case '/feeds':
      return [];
    case '/inventory':
      return INVENTORY;
    default:
      return null;
  }
}

/**
 * Answer the house reads from the fixture. Install BEFORE the page loads: the app probes the house
 * on start, and a probe that ran once against the dev server is not re-run by installing routes.
 */
export async function installFakeHouse(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, '');
    if (request.method() !== 'GET') {
      // The write path's success: an empty 204, exactly what the service answers.
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    const body = bodyFor(path);
    if (body === null) {
      // Not a document this fixture serves: let the dev server answer (a 404 the client handles
      // as an absent document), never a made-up one.
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ETag: '"fake-house-1"' },
      body: JSON.stringify(body),
    });
  });
}
