// #770 — Camera to home, in a real browser: the button lives beside the Camera pane, it is
// offered only on an Idle machine with no job, and the pose it states is the machine's own
// clearance frame (`coordinate.clearance_x/y/z`). The move itself is proved against the fake
// console in `machineCameraHome.spec.ts`; this file pins the pane's wiring and its guard's words.

import { test, expect } from './fixtures/caseMaker';
import { rememberMachine } from './fixtures/rememberMachine';

const IDLE = '<Idle|MPos:0,0,0|WPos:0,0,0>';
const RUNNING = '<Run|MPos:1,2,-1|WPos:1,2,-1|P:120,40,88>';


test('#770 the camera pane offers one fixed move, only on an idle machine', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page, IDLE, false);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The pane is opened from the status strip's monitor popover.
  await page.getByTestId('machine-status-state').click();
  await page.getByTestId('machine-status-monitor-camera').click();
  await expect(page.getByTestId('camera-panel')).toBeVisible();

  // On an idle machine the move is offered, and the pose says which config keys it came from.
  const home = page.getByTestId('camera-home');
  await expect(home).toBeEnabled();
  await expect(home).toHaveText('Camera to home');
  await expect(page.getByTestId('camera-home-pose')).toContainText('coordinate.clearance_x/y/z');
  await expect(page.getByTestId('camera-home-pose')).toContainText('X -11.6, Y -14.6, Z -3');
  await expect(page.getByTestId('camera-home-refused')).toHaveCount(0);

  // A running machine — or one still finishing its program — is refused, with the reason shown.
  await rememberMachine(page, RUNNING, true);
  await expect(home).toBeDisabled();
  await expect(page.getByTestId('camera-home-refused')).toContainText('Run');
  await expect(page.getByTestId('camera-home-refused')).toContainText('40%');
});
