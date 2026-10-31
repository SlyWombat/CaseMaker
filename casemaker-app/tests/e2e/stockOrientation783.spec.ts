// #783 — WHICH WAY ROUND is asked for every form, in Holding, beside the mount. This walk presses
// a non-shipped hold and reads the picture back: the job's box restates (100 × 60 becomes 60 × 100)
// and the choice stays pressed. A screenshot keeps the six block holds for the eye.
//
// Run (WSL, this checkout):
//   CASEMAKER_PORT=5403 npx playwright test tests/e2e/stockOrientation783.spec.ts

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

/** Door → a typed plate → Holding (the start wizard's own path). */
async function reachHolding(page: Page): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill('12');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

test('#783 the hold is asked, and a pressed hold restates the box', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await reachHolding(page);

  // The hold fold is open by default, with every block hold on offer.
  const fold = page.getByTestId('engrave-setup-hold-fold');
  await expect(fold).toBeVisible();
  const holds = page.getByTestId('engrave-setup-orientation-holds');
  await expect(holds).toBeVisible();
  await expect(holds.locator('button[aria-pressed]')).toHaveCount(6);
  await expect(page.getByTestId('engrave-setup-hold-length-width-thickness')).toHaveAttribute('aria-pressed', 'true');

  // The picture states the blank as 100 × 60; switching the length to run along the jaws makes it
  // 60 × 100, and the pressed card is the one that made it so.
  await expect(page.getByTestId('engrave-setup-holding-picture')).toContainText('100 × 60');
  await page.getByTestId('engrave-setup-hold-width-length-thickness').click();
  await expect(page.getByTestId('engrave-setup-hold-width-length-thickness')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-setup-hold-length-width-thickness')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('engrave-setup-holding-picture')).toContainText('60 × 100');

  await holds.screenshot({ path: testInfo.outputPath('783-hold-choice.png') });
});
