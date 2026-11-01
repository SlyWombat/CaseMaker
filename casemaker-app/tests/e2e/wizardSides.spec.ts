// #723 P2-3 — the WIZARD'S SIDES SURFACE, in a real browser.
//
// The 4-step wizard used to describe one holding for a job that is cut from several sides. This
// walk opens the same two-side mouse shell the run acceptance uses, re-enters the wizard from
// Design › Hold, and reads the two surfaces: the holding step's sides block (each side's goal,
// mount and turn), and the operation step's side choice (the mesh goes on the side selected).
//
// The screenshots it writes are the hand-in's record of the two changed states.

import { writeFileSync } from 'node:fs';

import { test, expect } from './fixtures/caseMaker';
import { routeHouse, twoSideJob } from './fixtures/twoSideMouseShell';

test.setTimeout(180_000);

test('#723 P2-3 — the wizard names the sides of a two-side job, and the operation picks one', async ({
  cm,
  page,
}, testInfo) => {
  await routeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const jobPath = testInfo.outputPath('mouse-shell-two-sides.cutjob.json');
  writeFileSync(jobPath, JSON.stringify(twoSideJob()));
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened mouse-shell-two-sides.cutjob.json.');

  // Design › Hold edit opens the same 4-step wizard at Holding; its sides are named there too.
  await page.getByTestId('engrave-hold-edit').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-sides')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-side-0')).toContainText('mouse-shell.stl');
  await expect(page.getByTestId('engrave-setup-holding-side-1')).toContainText('mouse-shell-inside.stl');
  await expect(page.getByTestId('engrave-setup-holding-side-1')).toContainText('turned over about X on the two pins');
  await page.screenshot({ path: testInfo.outputPath('wizard-holding-sides.png'), fullPage: true });

  // #897 — the question is before the blank: Back through the stock step reaches it, and the
  // sides are a choice there; Side 2 can be selected.
  await page.getByTestId('start-wizard-back').click();
  await page.getByTestId('start-wizard-back').click();
  await expect(page.getByTestId('engrave-setup-step-what')).toBeVisible();
  await expect(page.getByTestId('start-wizard-op-sides')).toBeVisible();
  await expect(page.getByTestId('start-wizard-op-side-0')).toContainText('mouse-shell.stl');
  await expect(page.getByTestId('start-wizard-op-side-1')).toContainText('mouse-shell-inside.stl');
  await page.getByTestId('start-wizard-op-side-1').click();
  await expect(page.getByTestId('start-wizard-op-side-1')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('wizard-operation-sides.png'), fullPage: true });
});
