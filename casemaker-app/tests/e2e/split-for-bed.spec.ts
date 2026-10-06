// Issue #148 — the bed, and the offer to split the case body for it.
//
// The engine side (where the seams go, the laps, the screws) is pinned by
// `tests/unit/splitPart.spec.ts` against the real Manifold evaluator. This is
// the UI half, and it is about ONE property: the offer never promises a split
// the compiler will not build. That is not visible from the compiler, and it is
// not visible from a screenshot of a case that happens to fit:
//
//   • the default rpi-4b shell (93 × 64 mm) on a 60 × 60 bed is over the bed
//     but has NO legal seam — its board bosses leave no line across it. An
//     offer derived from the mesh bounds appears here and builds nothing,
//     which is exactly the bug this test was written to catch.
//   • on a 50 × 100 bed the same shell has one X seam, so the offer appears
//     WITH a toggle, and ticking it puts the pieces on the export list without
//     removing the whole body.
//   • a bed the shell fits offers nothing at all, and neither does a project
//     that never chose a bed.

import { test, expect } from './fixtures/caseMaker';
import type { Page } from '@playwright/test';

async function openExportWithBed(
  page: Page,
  bed: { x: number; y: number; z: number } | 'none',
): Promise<void> {
  await page.getByTestId('export-default').click();
  if (bed === 'none') return;
  await page.getByTestId('export-printer-preset').selectOption('custom');
  await page.getByTestId('export-printer-x').fill(String(bed.x));
  await page.getByTestId('export-printer-y').fill(String(bed.y));
  await page.getByTestId('export-printer-z').fill(String(bed.z));
}

test('a body with a legal seam is offered a split, and the pieces join the list', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.loadBuiltinBoard('rpi-4b'));

  // 50 × 100: one X seam cuts the 93 × 64 shell into two 46.5 × 64 halves, and
  // both halves sit on the bed. The seam has room on both sides of the board's
  // bosses, so the engine can actually deliver this.
  await openExportWithBed(page, { x: 50, y: 100, z: 200 });

  const offer = page.getByTestId('export-split-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('does not fit');
  await expect(offer).toContainText('M3×16 socket cap');

  await page.getByTestId('export-split-toggle').check();

  const pieces = page.locator('[data-testid^="export-row-shell-split-"]');
  await expect(pieces).toHaveCount(2);
  await expect(page.getByTestId('export-row-shell-split-a1')).toBeVisible();
  await expect(page.getByTestId('export-row-shell-split-b1')).toBeVisible();
  // The uncut body is still on the list: the split is an offer, not a
  // replacement. Handing the user pieces and no whole part would be the failure
  // this line exists to catch.
  await expect(page.getByTestId('export-row-shell')).toBeVisible();

  expect(await page.evaluate(() => window.__caseMaker!.getProject().case.splitForPrint)).toBe(
    true,
  );
});

test('a body over the bed but with no legal seam is not offered a toggle', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.loadBuiltinBoard('rpi-4b'));

  // The rpi-4b's board bosses span the middle of the case, so the 64 mm depth
  // cannot be cut on a 60 mm bed even though the 93 mm width can. The engine
  // says so, and the UI has to repeat it rather than offer a checkbox.
  await openExportWithBed(page, { x: 60, y: 60, z: 200 });

  const offer = page.getByTestId('export-split-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('no seam clears');
  await expect(page.getByTestId('export-split-toggle')).toHaveCount(0);
  await expect(page.locator('[data-testid^="export-row-shell-split-"]')).toHaveCount(0);
});

test('a bed the body fits is offered nothing, and builds no pieces', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.loadBuiltinBoard('rpi-4b'));

  // A real preset big enough for the whole body: no offer, no pieces.
  await page.getByTestId('export-default').click();
  await page.getByTestId('export-printer-preset').selectOption('prusa-mk4');
  await expect(page.getByTestId('export-split-offer')).toBeHidden();
  await expect(page.locator('[data-testid^="export-row-shell-split-"]')).toHaveCount(0);
});

test('a project that never chose a bed is not offered a split', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.loadBuiltinBoard('rpi-4b'));
  await openExportWithBed(page, 'none');
  await expect(page.getByTestId('export-split-offer')).toBeHidden();
});

test('a body that is over the bed HEIGHT is told so, not offered a seam', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.loadBuiltinBoard('rpi-4b'));

  // Wide enough in X and Y but 5 mm tall: a vertical seam cannot help, so the
  // offer must explain that instead of showing a checkbox that builds nothing.
  await openExportWithBed(page, { x: 200, y: 200, z: 5 });

  const offer = page.getByTestId('export-split-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('vertical');
  await expect(page.getByTestId('export-split-toggle')).toHaveCount(0);
});
