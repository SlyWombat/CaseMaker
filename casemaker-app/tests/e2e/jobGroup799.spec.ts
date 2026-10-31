// #799/#798 — the Job group's quiet first screen: the Stock fact line is the voids' disclosure,
// the Cutter verdict is one line above the fold, and the reference object is an entry of the one
// Add operation menu. The screenshots are the hand-in's record of the changed states.
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

test('#799 — the Job group: Stock disclosure, Cutter line, and the Add menu’s reference entry', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // 1. The closed Stock line: one fact, with the voids behind it, not a top-level row.
  await expect(page.getByTestId('engrave-stock-detail')).not.toHaveAttribute('open');
  await expect(page.getByTestId('engrave-voids-line')).toBeHidden();
  await page.getByTestId('engrave-cutter-line').screenshot({ path: testInfo.outputPath('job-cutter-line.png') });
  await page.getByTestId('engrave-group-job').screenshot({ path: testInfo.outputPath('job-group-closed.png') });

  // 2. The opened Stock detail: the voids line and its add controls inside it.
  await page.getByTestId('engrave-stock-line').click();
  await expect(page.getByTestId('engrave-stock-detail')).toHaveAttribute('open');
  await expect(page.getByTestId('engrave-add-keepout-circle')).toBeVisible();
  await page.getByTestId('engrave-stock-detail').screenshot({ path: testInfo.outputPath('job-stock-detail.png') });

  // 3. The one Add operation menu, with the reference object as an entry.
  await page.getByTestId('engrave-add-summary').click();
  await expect(page.getByTestId('engrave-target-import')).toBeVisible();
  await page.getByTestId('engrave-add-menu').screenshot({ path: testInfo.outputPath('job-add-menu.png') });
});
