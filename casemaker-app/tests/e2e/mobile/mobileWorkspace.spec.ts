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

/**
 * The section panels at phone width — the item #134 left open ("the panels at
 * phone width remain unmeasured"). Each one fills the drawer (390px), so the
 * question is whether anything inside overflows it, and whether a field that
 * is meant to show its whole value actually does. The mounting-hole table was
 * the one that did not: the X input measured 46.7px for 50px of text, so
 * "22.86" painted as "22.8" against the Ø glyph beside it.
 */
test('every section panel fits the phone without clipping a field (#134)', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-search').fill('sht31');
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });

  const sections = ['board', 'case', 'ports', 'hats', 'features', 'assets', 'export'];
  for (const id of sections) {
    // The open context drawer covers the rail handle, so put it away first.
    // Read the class, not isVisible(): the closed drawer is translated off to
    // the right rather than hidden, so its close button still reports visible.
    const panel = page.getByTestId('context-panel');
    if ((await panel.getAttribute('class'))?.includes('context-panel--open')) {
      await page.locator('.context-panel__close').click();
      await expect(panel).toHaveClass(/context-panel--closed/);
    }
    const sideX = await page.getByTestId('sidebar').evaluate((el) => el.getBoundingClientRect().x);
    if (sideX < 0) await page.getByTestId('sidebar-handle').click();
    await page.getByTestId(`sidebar-button-${id}`).click();
    await expect(page.getByTestId(`context-section-${id}`)).toBeVisible();

    const r = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="context-panel"]') as HTMLElement;
      const pr = panel.getBoundingClientRect();
      const overflows: string[] = [];
      const clipped: string[] = [];
      for (const el of panel.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width <= 1 && b.height <= 1) continue; // screen-reader-only spans
        if (b.right - pr.right > 1 && !el.classList.contains('labelled-field__hint-sr')) {
          overflows.push(`${el.tagName.toLowerCase()}.${el.className} → +${(b.right - pr.right).toFixed(1)}px`);
        }
        // A numeric field the user is meant to READ: its value must fit.
        if (el instanceof HTMLInputElement && el.classList.contains('numeric-input') && el.scrollWidth > el.clientWidth) {
          clipped.push(`${el.getAttribute('data-testid') ?? el.className} "${el.value}" ${el.clientWidth}px for ${el.scrollWidth}px`);
        }
      }
      return {
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        overflows: overflows.slice(0, 8),
        clipped: clipped.slice(0, 8),
      };
    });

    expect(r.panelOverflow, `${id} panel scrolls sideways`).toBeLessThanOrEqual(0);
    expect(r.docOverflow, `${id} pushed the page sideways`).toBeLessThanOrEqual(0);
    expect(r.overflows, `${id} content past the panel's right edge`).toEqual([]);
    expect(r.clipped, `${id} numeric field clips its value`).toEqual([]);
  }
});

/**
 * #282 — the Part panel, in the same drawer as every other section, on the archetype that carries
 * the most controls. It is the newest panel and the only one whose rail section a shell project
 * cannot reach, so it is opened through the wizard rather than the board cards above; the same two
 * questions apply, and the same three-button preset row (#134's overflow, twice over) is in it.
 */
test('the Part panel fits the phone, and its numbers reach the part (#282)', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-check').click();
  await page.getByTestId('start-wizard-next').click();
  await page.waitForSelector('[data-testid="start-wizard-step-job"]');
  await page.getByTestId('start-wizard-job-badge-blank').click();
  await page.waitForTimeout(300);
  if ((await page.locator('[data-testid="engrave-setup-close"]').count()) > 0) {
    await page.getByTestId('engrave-setup-close').click();
  }
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });

  // The wizard can leave the right-hand drawer open, and an open drawer covers the rail handle.
  const panel = page.getByTestId('context-panel');
  if ((await panel.getAttribute('class'))?.includes('context-panel--open')) {
    await page.locator('.context-panel__close').click();
    await expect(panel).toHaveClass(/context-panel--closed/);
  }
  await page.getByTestId('sidebar-handle').click();
  await page.getByTestId('sidebar-button-part').click();
  await expect(page.getByTestId('context-section-part')).toBeVisible();

  const r = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="context-panel"]') as HTMLElement;
    const pr = p.getBoundingClientRect();
    const bad: string[] = [];
    for (const el of p.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.width <= 1 && b.height <= 1) continue;
      if (b.right - pr.right > 1) bad.push(`${el.tagName.toLowerCase()}.${el.className} → +${(b.right - pr.right).toFixed(1)}px`);
    }
    return { panelOverflow: p.scrollWidth - p.clientWidth, docOverflow: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 8) };
  });
  expect(r.panelOverflow, 'the Part panel scrolls sideways').toBeLessThanOrEqual(0);
  expect(r.docOverflow, 'the Part panel pushed the page sideways').toBeLessThanOrEqual(0);
  expect(r.bad, 'content past the panel’s right edge').toEqual([]);

  // ... and the phone is not a read-only view of it: the edit reaches the compiled part.
  await page.getByTestId('badge-width').fill('60');
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });
  const bbox = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!.bbox);
  expect(bbox.min[0]).toBeCloseTo(-30, 3);
  expect(bbox.max[0]).toBeCloseTo(30, 3);
});
