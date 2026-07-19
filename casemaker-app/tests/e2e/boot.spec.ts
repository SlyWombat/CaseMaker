import { test, expect } from './fixtures/caseMaker';

test('boot: app loads and exposes test API v1', async ({ cm, page }) => {
  await cm.ready();
  const info = await page.evaluate(() => ({
    apiVersion: window.__caseMaker!.apiVersion,
    isTestMode: window.__caseMaker!.isTestMode(),
    isZUp: window.__caseMaker!.isZUp(),
  }));
  expect(info.apiVersion).toBe(1);
  expect(info.isTestMode).toBe(true);
  expect(info.isZUp).toBe(true);
  // First load boots into the welcome board picker (#69) — the viewport
  // canvas only mounts after a board is chosen. (The old assertion checked
  // viewport-canvas straight away, which can't pass in welcome mode.)
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await expect(page.getByTestId('viewport-canvas')).toBeVisible();
});
