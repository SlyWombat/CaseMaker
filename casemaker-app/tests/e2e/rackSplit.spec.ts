// #266 — the rack's own parts, offered a split for the bed.
//
// The engine side (the straps, the seams, the keep-outs) is pinned by
// tests/unit/rackSplit.spec.ts. This is the UI half: the export modal must
// offer what the compiler can deliver, part by part — the four frame parts
// over a small bed are offered cut pieces, ticking the shared switch puts
// `<part>-split-a1` rows on the list, and the whole parts stay there.
//
// Screenshot under docs/bench/img/2026-11-01-rack-split/.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-11-01-rack-split');

test('#266 — the rack parts are offered a split, and the pieces join the list', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-template-mini-rack-10in').click();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  // A bed far smaller than the rack: every frame part overruns it.
  await page.getByTestId('export-default').click();
  await page.getByTestId('export-printer-preset').selectOption('custom');
  await page.getByTestId('export-printer-x').fill('130');
  await page.getByTestId('export-printer-y').fill('130');
  await page.getByTestId('export-printer-z').fill('200');
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  const offer = page.getByTestId('export-rack-split-offer');
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await expect(offer).toContainText('top plate');
  await expect(offer).toContainText('side panel');

  await page.getByTestId('export-rack-split-toggle').check();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  // The pieces are on the list, and the whole parts never leave it.
  await expect(page.getByTestId('export-row-rack-top-split-a1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('export-row-rack-top')).toBeVisible();
  await expect(page.getByTestId('export-row-rack-side-left')).toBeVisible();

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'export-offer.png') });
});
