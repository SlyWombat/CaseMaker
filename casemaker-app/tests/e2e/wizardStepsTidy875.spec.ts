// #875 — slice 4 of #870's wizard review: steps 2 and 3 tidied, on a phone (400 × 900).
//
// Step 2: the seven form buttons are equal width in two rows, and every size field is on the
// screen with its `mm` (the old wrapping flex left "Printed blank" ragged and the thickness alone
// on a third line). Step 3: the picture comes FIRST — above the mount radios — the orientation
// fold opens CLOSED with the chosen hold in its summary, and the machine band no longer states
// "not read from a machine record" on every job without one.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.use({ viewport: { width: 400, height: 900 } });

/** Welcome → the stock step, with a plate of known numbers. */
async function toStock(page: Page): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  // #897 — the question comes before the blank; a pocket needs no field.
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('76.2');
  await page.getByTestId('start-wizard-make-width').fill('38.1');
  await page.getByTestId('start-wizard-make-thickness').fill('3.81');
}

test('#875 — phone step 2: equal form buttons in two rows, size fields whole with their mm', async ({ cm, page }) => {
  await cm.ready();
  await toStock(page);

  // Seven form buttons, one width, two rows (4 + 3 at 400 px).
  const buttons = page.getByTestId('start-wizard-make-form').locator('button');
  await expect(buttons).toHaveCount(7);
  const boxes = await Promise.all((await buttons.all()).map((b) => b.boundingBox()));
  const widths = boxes.map((b) => b!.width);
  expect(Math.max(...widths) - Math.min(...widths), 'equal widths').toBeLessThanOrEqual(1);
  const tops = boxes.map((b) => b!.y).sort((a, b) => a - b);
  const rows = 1 + tops.filter((y, i) => i > 0 && y - tops[i - 1]! > 20).length;
  expect(rows, 'two rows').toBe(2);

  // Each size field is on the screen with its `mm`, inside the sheet's width.
  for (const key of ['length', 'width', 'thickness'] as const) {
    const input = page.getByTestId(`start-wizard-make-${key}`);
    await input.scrollIntoViewIfNeeded();
    const box = (await input.boundingBox())!;
    expect(box.x, `${key} left`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${key} right`).toBeLessThanOrEqual(400);
    expect(box.y + box.height, `${key} bottom`).toBeLessThanOrEqual(900);
    // The unit is the field label's own line: the input's label contains it.
    await expect(input.locator('xpath=..')).toContainText('mm');
  }
});

test('#875 — phone step 3: the picture first, the hold fold shut with its answer, no empty machine band', async ({ cm, page }) => {
  await cm.ready();
  await toStock(page);
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();

  // The picture is the FIRST thing the step offers on a phone: above the mount radios.
  const picture = page.getByTestId('engrave-setup-holding-picture');
  const vise = page.getByTestId('engrave-setup-holding-vise');
  const pictureBox = (await picture.boundingBox())!;
  const viseBox = (await vise.boundingBox())!;
  expect(pictureBox.y, 'picture above the radios').toBeLessThan(viseBox.y);

  // The orientation fold opens CLOSED, and its summary carries the chosen hold's words.
  const fold = page.getByTestId('engrave-setup-hold-fold');
  await expect(fold).not.toHaveAttribute('open', '');
  await expect(fold.locator('summary')).toContainText('Which way round —');
  await expect(fold.locator('summary')).toContainText('mm');
  // The six cards are folded away until it is opened.
  await expect(page.getByTestId('engrave-setup-hold-length-width-thickness')).not.toBeVisible();
  await fold.locator('summary').click();
  await expect(page.getByTestId('engrave-setup-hold-length-width-thickness')).toBeVisible();

  // The line that said nothing on every job without a machine record is gone.
  await expect(page.getByTestId('engrave-setup-machine-none')).toHaveCount(0);
});
