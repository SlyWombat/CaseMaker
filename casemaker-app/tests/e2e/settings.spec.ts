import { test, expect } from './fixtures/caseMaker';

test('default port setting is 8000', async ({ cm, page }) => {
  await cm.ready();
  const settings = await page.evaluate(() => window.__caseMaker!.getSettings());
  expect(settings.port).toBe(8000);
  expect(settings.bindToAll).toBe(false);
});

test('setting a port updates the store and the UI', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.setPortSetting(9090));
  const after = await page.evaluate(() => window.__caseMaker!.getSettings());
  expect(after.port).toBe(9090);
  // The port UI lives inside the settings popover AND is desktop-only
  // (showServerControls) — in browser e2e assert the popover itself, and
  // the port readout only when the server-controls block is present.
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-menu')).toBeVisible();
  if ((await page.getByTestId('settings-port-active').count()) > 0) {
    await expect(page.getByTestId('settings-port-active')).toHaveText('9090');
  }
  await page.keyboard.press('Escape');
  // Reset for hygiene
  await page.evaluate(() => window.__caseMaker!.setPortSetting(8000));
});

test('out-of-range port falls back to default', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.setPortSetting(70000));
  const settings = await page.evaluate(() => window.__caseMaker!.getSettings());
  expect(settings.port).toBe(8000);
});
