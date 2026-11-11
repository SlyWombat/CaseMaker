// #1099 — the same part drawn on steps 2, 3 and 4: the file's thumbnail, the part on the blank,
// and the footprint in the Holding step's top view. Two files, one walk: a mesh (its shaded box)
// and a drawing (its filled rings), each photographed on the three steps — the baselines the
// maintainer reviews the wording against.
import { fileURLToPath } from 'node:url';

import { test, expect, openSomethingElse } from './fixtures/caseMaker';

test.setTimeout(240_000);

const STL = fileURLToPath(new URL('../fixtures/goals/thin-wall-box.stl', import.meta.url));
const COASTER = fileURLToPath(new URL('../fixtures/outlines/coaster-60.svg', import.meta.url));

test('#1099 — the mesh is drawn on the question, the blank and the hold', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you making?');

  // Step 2 — #1100's cards open the step; the mesh chip lives behind *Something else…*.
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-surface').click();
  await page.getByTestId('start-wizard-op-surface-file').setInputFiles(STL);
  await expect(page.getByTestId('start-wizard-op-surface-name')).toHaveText('thin-wall-box.stl');
  await expect(page.getByTestId('wizard-thumbnail-canvas')).toBeVisible();
  await expect(page.getByTestId('wizard-thumbnail-facts')).toContainText('from thin-wall-box.stl');
  await expect(page).toHaveScreenshot('1099-step2-mesh.png');
  await page.getByTestId('start-wizard-operation-next').click();

  // Step 3 — the proposed blank, with the part's footprint and its margins drawn beside the numbers.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('blank-with-part')).toBeVisible();
  await expect(page.getByTestId('blank-part-footprint')).toBeVisible();
  await expect(page).toHaveScreenshot('1099-step3-mesh.png');
  await page.getByTestId('start-wizard-stock-next').click();

  // Step 4 — the same footprint inside the blank in the hold.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-holding-part-footprint')).toBeVisible();
  await expect(page).toHaveScreenshot('1099-step4-mesh.png');
});

test('#1099 — a drawing walks the same three steps, its rings on the blank and in the hold', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  // The drawing is read by the step's own drop zone and takes the drawing's door (#1098).
  await page.getByTestId('start-wizard-drop-input').setInputFiles(COASTER);
  await expect(page.getByTestId('start-wizard-op-outline-field')).toBeVisible();
  await expect(page.getByTestId('wizard-thumbnail-facts')).toContainText('shape');
  await expect(page).toHaveScreenshot('1099-step2-drawing.png');
  await page.getByTestId('start-wizard-operation-next').click();

  // #1099 item 1 — the drawing answers a footprint, so steps 3 and 4 draw it like a mesh's.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('blank-part-footprint')).toBeVisible();
  await expect(page).toHaveScreenshot('1099-step3-drawing.png');
  await page.getByTestId('start-wizard-stock-next').click();

  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-holding-part-footprint')).toBeVisible();
  await expect(page).toHaveScreenshot('1099-step4-drawing.png');
});
