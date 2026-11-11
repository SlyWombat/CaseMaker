// #1098 — THE FILE COMES FIRST, in a real browser.
//
// The question step opens with one drop zone: the FORMAT chooses the operation. Two walks:
//   - an STL dropped on step 2 is read as the surface target and reaches Holding with two Nexts,
//     its blank proposed from the mesh (the design is not the blank);
//   - an SVG dropped on step 2 becomes the outline choice (Cut it out by default), proposes its
//     own plate, and the created job generates to the four ticks with the house cutters — the
//     #930 standard.
//
// The location is faked as `defaultJob930.spec.ts` fakes it: the shipped machine's measured vise,
// and `/tools` empty so the built-in house cutter is the recommendation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { test, expect, readJob } from './fixtures/caseMaker';

test.setTimeout(300_000);

const STL = fileURLToPath(new URL('../fixtures/goals/thin-wall-box.stl', import.meta.url));
const COASTER = fileURLToPath(new URL('../fixtures/outlines/coaster-60.svg', import.meta.url));

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

async function fakeLocation(page: Page): Promise<void> {
  const view = {
    kind: DOC.kind,
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    migratedFrom: null,
    machines: DOC.machines,
    accessories: DOC.accessories,
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

const TICKS = ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle'];

test('#1098 — an STL dropped on step 2 reaches Holding in two clicks', async ({ cm, page }) => {
  await fakeLocation(page);
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // Click 1 — the machine question to the file question.
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  await expect(page.getByTestId('start-wizard')).toHaveScreenshot('wizard-step2-empty.png');
  // The drop sets the operation from the format; no chip to find — and never changes the blank's kind.
  const stockKindBefore = (await readJob(page)).stockEntry?.kind;
  await page.getByTestId('start-wizard-drop-input').setInputFiles(STL);
  await expect(page.getByTestId('start-wizard-op-surface-name')).toHaveText('thin-wall-box.stl');
  expect((await readJob(page)).stockEntry?.kind).toBe(stockKindBefore);
  await expect(page.getByTestId('start-wizard')).toHaveScreenshot('wizard-step2-after-stl.png');

  // Click 2 — the blank the mesh proposed, never the mesh AS the blank.
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText('Sized from the mesh:');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
});

test('#1098 — an SVG dropped on step 2 becomes a cut-it-out job that generates', async ({ cm, page }) => {
  await fakeLocation(page);
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  const stockKindBeforeSvg = (await readJob(page)).stockEntry?.kind;
  await page.getByTestId('start-wizard-drop-input').setInputFiles(COASTER);
  await expect(page.getByTestId('start-wizard-op-outline-field')).toBeVisible();
  expect((await readJob(page)).stockEntry?.kind).toBe(stockKindBeforeSvg);
  await expect(page.getByTestId('start-wizard-op-outline-fact')).toContainText('60');
  await expect(page.getByTestId('start-wizard-op-outline-cut')).toBeChecked();
  await expect(page.getByTestId('start-wizard')).toHaveScreenshot('wizard-step2-after-svg.png');

  // The drawing sizes the blank: 60 × 60 plus 5 mm each side.
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText('From your shelf: aluminium-6061 plate, 100 × 100 × 5 mm.');
  await page.screenshot({ path: 'test-results/1098-stock-from-svg.png' });
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await page.screenshot({ path: 'test-results/1098-holding-from-svg.png' });
  // The one radio the cut-out adds: a through cut needs the waste board under the piece.
  await page.getByTestId('engrave-setup-mount-board').check();
  await expect(page.getByTestId('engrave-setup-next')).toBeEnabled();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // The #930 standard: the created job generates to the four ticks with the house cutters.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();
  await page.getByTestId('engrave-generate').click();
  for (const id of TICKS) {
    await expect(page.getByTestId(id), id).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  }
});
