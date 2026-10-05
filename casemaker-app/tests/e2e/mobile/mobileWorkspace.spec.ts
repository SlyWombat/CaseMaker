import { test, expect } from '../fixtures/caseMaker';

/**
 * Issue #134 — the workspace at phone width. The section rail must leave the
 * grid (a fixed 320px column left the 3D viewport a ~70px sliver and forced the
 * whole shell to ~620px inside a 390px window).
 *
 * The viewport comes from the `mobile-chromium` Playwright project (#134),
 * which matches this `mobile/` directory — the per-file `test.use` this file
 * used to carry was the placeholder for exactly that project.
 */

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

/**
 * The header carried 848px of content in a 390px scroll container: Save / Save
 * as / Load / Export / Parts / Docs / settings all sat off the right edge,
 * reachable only by a silent horizontal swipe. Below 640px they must be
 * reachable from the ⋯ overflow menu instead — and the ⋯ menu, the parts panel
 * and the settings popover must not be clipped by the header box.
 */
test('the phone header exposes every control without a hidden swipe (#134)', async ({ cm, page }) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  // The header no longer scrolls: its content fits the window exactly.
  const headerFit = await page.evaluate(() => {
    const h = document.querySelector('.app-header') as HTMLElement;
    return { clientW: h.clientWidth, scrollW: h.scrollWidth };
  });
  expect(headerFit.scrollW - headerFit.clientW).toBeLessThanOrEqual(0);

  // The primary controls are all on-screen ...
  for (const id of ['undo-btn', 'redo-btn', 'save-project', 'parts-menu-toggle', 'toolbar-overflow-toggle']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x + box!.width, `${id} right edge`).toBeLessThanOrEqual(390);
  }

  // ... and the secondary controls live behind ⋯, fully on-screen.
  await page.getByTestId('toolbar-overflow-toggle').click();
  await expect(page.getByTestId('toolbar-overflow-panel')).toBeVisible();
  const panel = await page.getByTestId('toolbar-overflow-panel').boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  for (const id of ['new-project', 'load-project', 'export-default', 'docs-open', 'settings-open']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
});
