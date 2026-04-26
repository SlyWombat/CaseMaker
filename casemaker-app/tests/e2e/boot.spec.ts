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
  await expect(page.getByTestId('viewport-canvas')).toBeVisible();
});
