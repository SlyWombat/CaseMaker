// #782 — the Z1 4th-axis module drawn as it is: the T-slot extrusion on both pins, the L-shaped
// headstock with its motor out front, the four-jaw self-centring chuck facing +X, the tailstock
// on its rail with its dead-centre cone.
//
// The eyeball half, as the issue asks: the Machines card's bed scene at the module's place, and
// the Holding step's rotary front view for a rod, compared by eye with the manual's figures
// (`wiki.makera.com/z1-4th-axis-1.png` and `-4.png`, the clamped module). The numbers themselves
// are pinned in `tests/unit/drawnRotary.spec.ts` and `bedScene.spec.ts`.
//
// Run (WSL, this checkout):
//   CASEMAKER_PORT=5402 npx playwright test tests/e2e/rotaryGeometry782.spec.ts

import type { TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';
import { fakeRotaryHouse } from './fixtures/rotaryHouse';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const shot = (testInfo: TestInfo, name: string): string => testInfo.outputPath(name);

test('#782 the bed scene draws the module at its axis reading', async ({ cm, page }, testInfo) => {
  await fakeRotaryHouse(page);
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.openManage('machines'));
  await expect(page.getByTestId('manage-bed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('manage-bed-summary')).toContainText('4th axis on the pins', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shot(testInfo, '782-bed-scene.png'), fullPage: true });
});

test('#782 the Holding front view shows the module and a rod in the four-jaw chuck', async ({ cm, page }, testInfo) => {
  await fakeRotaryHouse(page);
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  // #897 — the question comes before the blank; a pocket needs no field and is the walk's stand-in.
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-rod').click();

  await page.getByTestId('start-wizard-make-diameter').fill('20');
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible({ timeout: 30_000 });
  // A round rod on a machine that carries the rotary: the chuck is the recommended mount.
  await expect(page.getByTestId('engrave-setup-mount-rotary')).toBeChecked();
  const slot = page.getByTestId('engrave-setup-holding-picture-slot');
  await expect(slot).toBeVisible();
  // The picture names the rod, the grip, the stick-out, the tailstock and the axis.
  const svg = page.getByTestId('engrave-setup-holding-picture');
  await expect(svg).toContainText('rod ⌀20');
  await expect(svg).toContainText('tailstock');
  await expect(svg).toContainText('A turns the rod about X');
  await slot.screenshot({ path: shot(testInfo, '782-rotary-front-view.png') });
});
