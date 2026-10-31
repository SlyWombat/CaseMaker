// #520 — the preview draws the Makera Low-Profile Vise as it actually is, not the collision
// envelope. Two stepped soft jaws (a 10 mm land and a 1.9 mm ledge set 3.1 mm below the top), two
// rails, the screws and a provisional bed, all from `viseBody`.
//
// This spec is the eyeball half. It captures the shipped 12 mm blank and then a 50 mm cube — the
// case where the old picture differed most — and checks the seat still moves the blank. The
// numbers themselves are pinned in `tests/unit/cncFixture.spec.ts` and
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

/**
 * Set the job's stock — through the wizard's Stock step, which is the only place it is typed since
 * #686 made the panel's Stock one line with an `edit`. A re-entry opened at step 2 finishes with
 * Done, so the wizard is closed by the time this returns and the job's stock is written.
 */
async function setStockBox(
  page: Page,
  box: { length: number; width: number; thickness: number },
): Promise<void> {
  await page.getByTestId('engrave-stock-line').click();
  await page.getByTestId('engrave-stock-edit').click();
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  for (const key of ['length', 'width', 'thickness'] as const) {
    const field = page.getByTestId(`start-wizard-make-${key}`);
    await field.fill(String(box[key]));
    await expect(field).toHaveValue(String(box[key]));
  }
  // A re-entry at step 2 finishes with Done (#681's follow-up), which applies the stock and puts
  // the wizard away; Next would walk on to Holding instead.
  await page.getByTestId('start-wizard-done').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
}

test('the drawn vise is the real one, and the seat still moves the blank (#520)', async ({
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

  // The seat is an operator's choice on the vise row, and a default vise re-seats when it
  // changes: 12 − 3.1 on the ledge, 12 − 20 on the floor (negative is the truthful answer).
  // #523 — the vise row lives in the Hold group (closed by default), and the fields themselves
  // live behind the vise card's "Edit" (also closed). Open both before touching the seat.
  await page.getByTestId('engrave-group-hold-summary').click();
  await page.getByTestId('engrave-vise-card').locator('summary').click();
  const seat = page.getByTestId('engrave-vise-seat');
  await expect(seat).toBeVisible();
  const proud = page.getByTestId('engrave-vise-stockProud');
  await expect(seat).toHaveValue('ledge');
  await expect(proud).toHaveValue('8.9');
  await seat.selectOption('floor');
  await expect(proud).toHaveValue('-8');
  await seat.selectOption('ledge');
  await expect(proud).toHaveValue('8.9');

  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, '520-vise-12mm.png') });

  // A 50 mm cube. The design is moved and shrunk to fit it, so the picture is about the vise and
  // not about a refused layout.
  await setStockBox(page, { length: 50, width: 50, thickness: 50 });
  for (const [i, size] of [10, 8, 5].entries()) {
    // The size and position live behind the row's chevron.
    await page.getByTestId(`engrave-label-expand-${i}`).click();
    await page.getByTestId(`engrave-label-size-${i}`).fill(String(size));
    await page.getByTestId(`engrave-label-x-${i}`).fill('25');
  }
  await page.waitForTimeout(5000);

  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-preview-error')).toHaveCount(0);

  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, '520-vise-cube.png') });

  expect(errors).toEqual([]);
});
