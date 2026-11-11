// #1124 — a 32-bit renderer is told at the Generate button, not by an "Array buffer allocation
// failed" mid-plan. The check reads `navigator.userAgentData` at app start, so the stub is
// installed before the fixture's first navigation; the probe never runs because bitness 32
// short-circuits it.
import { test, expect, enterCnc } from './fixtures/caseMaker';

test('#1124 — a 32-bit renderer sees the plain message and Generate is off', async ({ cm, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: {
        mobile: false,
        getHighEntropyValues: async () => ({ bitness: '32', architecture: 'x86' }),
      },
    });
  });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  await expect(page.getByTestId('engrave-generate-blocker')).toHaveText(
    'This browser is 32-bit; the planner needs a 64-bit browser',
  );
  await expect(page.getByTestId('engrave-generate')).toBeDisabled();
  // Nothing started: the refusal is at the button, before any worker exists.
  await expect(page.getByTestId('engrave-generate-progress')).toHaveCount(0);
});
