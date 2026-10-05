import { test, expect } from './fixtures/caseMaker';

/**
 * Issue #134 — the workspace at phone width. The section rail must leave the
 * grid (a fixed 320px column left the 3D viewport a ~70px sliver and forced the
 * whole shell to ~620px inside a 390px window).
 *
 * The mobile viewport is set per-file rather than as a Playwright project:
 * playwright.config.ts belongs to the CNC batch while this lands. If a mobile
 * project is added there later, this `test.use` can drop away.
 */
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

test('the workspace is viewport-first and the rail hides in a drawer (#134)', async ({ cm, page }) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
  // Welcome at phone width: single column, no sideways page scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await page.getByTestId('welcome-search').fill('sht31');
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  // The shell matches the device width — nothing spills past it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // The 3D pane owns the screen; the rail is off-canvas behind its handle.
  const pane = await page.locator('.viewport-pane').boundingBox();
  expect(pane?.width ?? 0).toBeGreaterThanOrEqual(380);
  await expect(page.getByTestId('sidebar')).toHaveClass(/sidebar--drawer/);
  expect((await page.getByTestId('sidebar').boundingBox())?.x ?? 0).toBeLessThan(0);

  // The handle brings it in ...
  await page.getByTestId('sidebar-handle').click();
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);

  // ... and choosing a section puts it away while the editor drawer opens.
  await page.getByTestId('sidebar-button-case').click();
  await expect(page.getByTestId('sidebar')).toHaveClass(/sidebar--closed/);
  await expect(page.getByTestId('context-panel')).toHaveClass(/context-panel--open/);
});
