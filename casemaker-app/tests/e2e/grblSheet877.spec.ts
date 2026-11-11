// #877 — THE END-TO-END WALK ON A STATED PRESET. A Shapeoko job generates, the 3D view draws the
// machine's stated WORK AREA instead of the Z1's bed and vise, and the run sheet speaks to the
// operator's own sender: zero in the sender at the stock's corner, G10 L20 P1 as the aside, none
// of the Z1's probe, M491 or PRB steps.
import type { Page } from '@playwright/test';
import { test, expect, openCutterGroup, enterCnc } from './fixtures/caseMaker';

test.setTimeout(240_000);

/** #792 — the panel's actions live under File ▾ now; open the menu when the item is not visible. */
async function menuItem(page: Page, testid: string) {
  const item = page.getByTestId(testid);
  if (!(await item.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  await expect(item).toBeVisible();
  return item;
}

test('#877 — a stated machine draws its work area, and its run sheet speaks the sender', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  // The machine the job will be planned for: a shipped stated preset, written the way the picker
  // writes it, and the job pointed at its profile.
  const seeded = await page.evaluate(() => window.__caseMaker!.statedMachineSeed('grbl:shapeoko-4'));
  expect(seeded).toHaveProperty('machineId');

  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // THE PICTURE, on the design screen before any run takes the viewport: the stated work area is
  // drawn, and the Z1's plate and jaws are not. The label is a DOM node (drei's Html), so it is
  // visible to this walk.
  await expect(page.getByTestId('engrave-work-area-label')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-work-area-label')).toContainText('work area (stated)');

  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // THE PAPER: the sheet is the sender's body.
  const sheetItem = await menuItem(page, 'engrave-run-sheet');
  await expect(sheetItem).toBeEnabled();
  await sheetItem.click();
  const sheet = page.getByTestId('run-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Zero X, Y and Z in your sender');
  await expect(sheet).toContainText('G10 L20 P1 X0 Y0 Z0');
  await expect(sheet).toContainText('front-left corner');
  // None of the Z1's vocabulary reaches the page.
  await expect(sheet).not.toContainText('M491');
  await expect(sheet).not.toContainText('PRB');
});
