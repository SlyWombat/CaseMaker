// #1099 — the same part drawn on steps 2, 3 and 4: the file's thumbnail, the part on the blank,
// and the footprint in the Holding step's top view.

import { fileURLToPath } from 'node:url';

import { test, expect } from './fixtures/caseMaker';

test.setTimeout(240_000);

const STL = fileURLToPath(new URL('../fixtures/goals/thin-wall-box.stl', import.meta.url));

test('#1099 — the file is drawn, then the part on the blank, then in the hold', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  // Step 2 — pick the mesh chip, choose the file, and the read state draws it.
  await page.getByTestId('engrave-setup-what-surface').click();
  await page.getByTestId('start-wizard-op-surface-file').setInputFiles(STL);
  await expect(page.getByTestId('start-wizard-op-surface-name')).toHaveText('thin-wall-box.stl');
  await expect(page.getByTestId('wizard-thumbnail-canvas')).toBeVisible();
  await expect(page.getByTestId('wizard-thumbnail-facts')).toContainText('from thin-wall-box.stl');
  await page.screenshot({ path: 'test-results/1099-question-thumbnail.png' });
  await page.getByTestId('start-wizard-operation-next').click();

  // Step 3 — the proposed blank, with the part's footprint and its margins drawn beside the numbers.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('blank-with-part')).toBeVisible();
  await expect(page.getByTestId('blank-part-footprint')).toBeVisible();
  await page.screenshot({ path: 'test-results/1099-stock-part.png' });
  await page.getByTestId('start-wizard-stock-next').click();

  // Step 4 — the same footprint inside the blank in the hold.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-holding-part-footprint')).toBeVisible();
  await page.screenshot({ path: 'test-results/1099-holding-part.png' });
});
