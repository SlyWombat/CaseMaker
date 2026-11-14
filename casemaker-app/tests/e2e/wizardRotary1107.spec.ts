// #1107 — THE ROD PATH ON A NEW JOB, in a real browser.
//
// The house app serves its location with the rotary module on the machine's pins: the question
// step offers the On a rod intents, Name on a dowel proposes a ⌀20 × 100 rod, Holding arrives
// with the chuck selected, and Create writes a rotary text job — three clicks plus the text.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { MachineRecordSchema, type FixtureRecord } from '@/platform/locationClient';
import { test, expect, stockNext } from './fixtures/caseMaker';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

test.setTimeout(240_000);

type Json = Record<string, unknown>;
type Doc = {
  kind: string;
  id: string;
  name: string;
  createdAt: string;
  machines: Json[];
  inventory: Json[];
  stock: Json[];
  defaults: Json;
  accessories: Json[];
};

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as Doc;

const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' },
  history: [],
};

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
};

/** The shipped machine with the 4th axis on its pins, and the house's rotary accessory. */
async function fakeRotaryHouse(page: Page): Promise<void> {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-rotary',
      fixture: 'fx-rotary-1',
      where: { kind: 'pins', pins: 'rotary', anchor: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ];
  profile.surface = {
    kind: 'bare-bed',
    material: null,
    length: null,
    width: null,
    thickness: null,
    position: null,
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  };
  profile.consumables = null;
  const view = {
    kind: DOC.kind,
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    migratedFrom: null,
    machines: [machine],
    accessories: [...DOC.accessories, ROTARY],
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"e1"' }, body: JSON.stringify(body) });
    if (path === '/health') return json(HEALTH);
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(DOC.inventory ?? []);
    if (path === '/stock') return json(DOC.stock ?? []);
    if (path === '/defaults') return json(DOC.defaults ?? {});
    if (path === '/location' && req.method() === 'GET') return json(view);
    if (req.method() !== 'GET') return json({ ok: true });
    return route.fulfill({ status: 404, body: '' });
  });
}

test('#1107 — a new run reaches a rotary text job from the On a rod group', async ({ cm, page }) => {
  await fakeRotaryHouse(page);
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you making?');

  // The house owns the rotary: the rod intents are there, before the flat picker.
  await expect(page.getByTestId('start-wizard-rotary-intents')).toBeVisible();
  // The folded list: the rod cards sit in the SAME question as the eight flat intents.
  await expect(page.getByTestId('start-wizard-presets')).toBeVisible();
  // #1107 item 6 — step 2 WITH the rotary, pinned.
  await expect(page.getByTestId('engrave-setup-step-what')).toHaveScreenshot('step2-with-rotary.png');
  await page.screenshot({ path: 'test-results/1107-question-folded-cards.png' });
  await page.getByTestId('start-wizard-rotary-intent-dowel').click();
  await page.getByTestId('start-wizard-op-text').fill('Hello');
  await page.screenshot({ path: 'test-results/1107-question-on-a-rod.png' });
  await page.getByTestId('start-wizard-operation-next').click();

  // The blank is the rod the chuck takes.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('start-wizard-form-rod')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('start-wizard-make-diameter')).toHaveValue('20');
  await page.screenshot({ path: 'test-results/1107-stock-rod.png' });
  await stockNext(page);

  // Holding arrives in the chuck.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-mount-rotary')).toBeChecked();
  await page.screenshot({ path: 'test-results/1107-holding-chuck.png' });
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // A rotary text job: the panel's stock line is the rod.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-line')).toContainText('20');
  await page.screenshot({ path: 'test-results/1107-rotary-job.png' });
});

// #1107 item 6 — the other half of the baseline: a house with NO rotary never sees the rod intents.
test('#1107 — step 2 without the rotary: no rod intents, and the step pinned', async ({ cm, page }) => {
  await serveHouse(page, { location: locationView(locationDocument()), fromSharedDocument: true });
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you making?');

  await expect(page.getByTestId('start-wizard-presets')).toBeVisible();
  await expect(page.getByTestId('start-wizard-rotary-intents')).toHaveCount(0);
  await expect(page.getByTestId('engrave-setup-step-what')).toHaveScreenshot('step2-without-rotary.png');
});
