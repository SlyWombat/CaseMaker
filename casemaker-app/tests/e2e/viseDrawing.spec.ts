// #508 — the preview draws the VISE, not the collision envelope.
//
// The envelope's boxes run `VISE_BODY_DEPTH` below the stock's underside and grow with the stock,
// which is right for the sweep and wrong for a picture: drawn from them, a thick blank made the
// jaws appear to grow with it. `viseBody` draws fixed-height bars instead, and its source label
// says the bar height is PROVISIONAL until the bench calipers it.
//
// This spec is the eyeball half. It captures the shipped 12 mm blank and then a 50 mm cube — the
// case where the old picture differed most — and asserts the label carries the PROVISIONAL note.
// The heights themselves are pinned in `tests/unit/cncFixture.spec.ts` and
// `tests/unit/engravePreview.spec.ts`; a screenshot is a claim someone has to LOOK at, so the
// captures land in Playwright's gitignored output dir (`test-results/`).
//
// Run (Windows, Playwright starts its own dev server):
//   npx playwright test tests/e2e/viseDrawing.spec.ts

import { test, expect } from './fixtures/caseMaker';
import type { Page, TestInfo } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const shot = (testInfo: TestInfo, name: string): string => testInfo.outputPath(name);

async function openEngrave(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const btn = page.getByTestId('sidebar-button-cnc-engrave');
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(700);
}

/** Set a stock field and let the worker rebuild before the next edit is judged. */
async function setStock(page: Page, key: 'length' | 'width' | 'thickness', value: number): Promise<void> {
  await page.getByTestId(`engrave-stock-${key}`).fill(String(value));
  await expect(page.getByTestId(`engrave-stock-${key}`)).toHaveValue(String(value));
}

test('the drawn vise does not grow with the stock — looked at on a 50 mm cube (#508)', async ({
  cm,
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // A 404 for a dev-server asset (a favicon, a lazily probed file) is noise, not a breakage.
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(`console: ${m.text()}`);
  });

  await cm.ready();
  await openEngrave(page);

  // The source label says where the numbers came from AND that the drawn bar height is not one of
  // the measured numbers yet.
  const source = page.getByTestId('engrave-jaw-source');
  await expect(source).toContainText('bar height 20 mm PROVISIONAL');

  // #508 — the seat is an operator's choice on the vise row, and a default vise re-seats when it
  // changes: 12 − 3.1 on the ledge, 12 − 20 on the floor (negative is the truthful answer).
  const seat = page.getByTestId('engrave-vise-seat');
  const proud = page.getByTestId('engrave-vise-stockProud');
  await expect(seat).toHaveValue('ledge');
  await expect(proud).toHaveValue('8.9');
  await seat.selectOption('floor');
  await expect(proud).toHaveValue('-8');
  await seat.selectOption('ledge');
  await expect(proud).toHaveValue('8.9');

  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, '508-vise-12mm.png') });

  // A 50 mm cube. The design is moved and shrunk to fit it, so the picture is about the vise and
  // not about a refused layout.
  await setStock(page, 'length', 50);
  await setStock(page, 'width', 50);
  await setStock(page, 'thickness', 50);
  for (const [i, size] of [10, 8, 5].entries()) {
    // The size and position live behind the row's chevron.
    await page.getByTestId(`engrave-label-expand-${i}`).click();
    await page.getByTestId(`engrave-label-size-${i}`).fill(String(size));
    await page.getByTestId(`engrave-label-x-${i}`).fill('25');
  }
  await page.waitForTimeout(5000);

  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-preview-error')).toHaveCount(0);
  await expect(source).toContainText('bar height 20 mm PROVISIONAL');

  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, '508-vise-cube.png') });

  expect(errors).toEqual([]);
});
