// #1109 §8 — THE FOUR STEPS, PHOTOGRAPHED. The copy pass's baselines for the maintainer's wording
// review: one screenshot per step, on the web build, from the shell's own walk (#870). The files land
// in `test-results/` and are posted on the issue; nothing here asserts pixels, it records the screen.
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(180_000);

test('#1109 — the four wizard steps, one screenshot each', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page).toHaveScreenshot('1109-step1-machine.png');

  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
  // #1100's preset grid is the step's face: the engine's chip list (and so the pocket chip) sits
  // behind Something else…, which is where the walk's pick lives now.
  await page.getByTestId('start-wizard-preset-something-else').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await expect(page).toHaveScreenshot('1109-step2-operation.png');

  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await expect(page).toHaveScreenshot('1109-step3-stock.png');

  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page).toHaveScreenshot('1109-step4-holding.png');
});
