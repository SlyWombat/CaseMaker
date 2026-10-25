// Issue #418, in a real browser: a new project starts with the material. New project → shelf stock
// → mount → an empty design, with the stock drawn in the viewport.
//
// The dev server serves the WEB target, which has no house service, so the shelf is answered here
// by `page.route` with the shared fixture's entries (`tests/unit/fixtures/location-doc.json`) — the
// app's own client, schema and store read it exactly as they read the service.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(180_000);

const doc = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as { stock: Array<Record<string, unknown>> };

// NON-SQUARE on purpose (#418 review): 120 long (X) × 60 wide (Y) × 8, so an X/Y swap anywhere between
// the shelf and the drawn part fails the bbox check below. Built from the fixture's own plate.
const LONG_PLATE = {
  ...doc.stock[0],
  id: 'stock-long1',
  size: { length: 120, width: 60, thickness: 8 },
  reservations: [],
};
const SHELF = [...doc.stock, LONG_PLATE];

test('new project → shelf stock → mount → empty design, the stock drawn', async ({ cm, page }) => {
  const writes: string[] = [];
  await page.route('**/api/v1/stock**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"s-1"' },
      body: JSON.stringify(SHELF),
    });
  });

  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();

  // Step 2 — the material first, then the shelf for it.
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await page.getByTestId('start-wizard-stock-material').selectOption('aluminium-6061');
  const plate = page.getByTestId('start-wizard-shelf-item-stock-long1');
  await expect(plate).toHaveAttribute('data-state', 'ok');
  await plate.click();
  await expect(page.getByTestId('start-wizard-stock-summary')).toContainText('120 × 60 × 8');
  await expect(page.getByTestId('start-wizard-stock-facing')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('start-wizard-stock-next').click();

  // Step 3 — the job wizard. A fresh job has nothing to cut, so it asks what to cut first (#662);
  // the mount question is the one the hand-off already knew it needed.
  await expect(page.getByTestId('engrave-setup-flow')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-step-what')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-progress')).toHaveText('1 / 2');
  await page.getByTestId('engrave-setup-what-pocket').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-progress')).toHaveText('2 / 2');
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('engrave-setup-flow')).toHaveCount(0);

  // The design: the panel on the shelf's piece, with the one pocket the wizard asked for and no
  // labels — the project supplied none.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-length')).toHaveValue('120');
  await expect(page.getByTestId('engrave-stock-width')).toHaveValue('60');
  await expect(page.getByTestId('engrave-stock-thickness')).toHaveValue('8');
  const job = await page.evaluate(() => JSON.parse(localStorage.getItem('casemaker.engraveJob.v3') ?? 'null'));
  expect(job.labels).toEqual([]);
  // The one operation the wizard's first question added, and nothing else.
  expect(job.shapes).toHaveLength(1);
  expect(job.stockEntry).toMatchObject({ kind: 'shelf', shelfId: 'stock-long1' });

  // The part is the plate: the blank's width is X, its height Y.
  const blank = await page.evaluate(() => window.__caseMaker!.getProject().case.blank);
  expect(blank).toMatchObject({ width: 120, height: 60, thickness: 8 });

  // The stock drawn: one part, and its geometry is the plate's 120 × 60 × 8.
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
  const graph = await page.evaluate(() => window.__caseMaker!.getSceneGraph());
  expect(graph.map((n) => n.id)).toEqual(['blank']);
  const { min, max } = graph[0]!.bbox;
  expect([max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => Math.round(v * 100) / 100)).toEqual([120, 60, 8]);
  // …and in the Engrave section the viewport is the engrave preview (the sim worker's slice of the
  // stock), so wait for it to land: nothing cut, on the plate.
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-preview-legend')).toContainText('nothing cut');
  await page.screenshot({ path: 'test-results/start-wizard-stock-418.png' });

  // Named, not reserved: nothing was written to the shelf (Cut mode, #419, reserves).
  expect(writes).toEqual([]);
});
