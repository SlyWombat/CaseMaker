import { test, expect } from '../fixtures/caseMaker';

/**
 * Issue #134 — the tablet band (641–900px). Too wide to be a phone, too narrow
 * for the full toolbar: the row plus the wordmark needs ~848px to stop
 * overflowing and ~900px to stop wrapping its button labels.
 *
 * Before this was fixed the header carried `overflow-x: auto` across the band.
 * `overflow-x: auto` computes `overflow-y: auto` as well, so the header became
 * a scroll container in both axes: Save as / Load / Export / Docs / settings
 * sat off the right edge behind a silent swipe, and the 267px settings popover
 * was clipped to the 48px bar — it opened to nothing at all.
 *
 * The viewport comes from the `tablet-chromium` Playwright project (#134),
 * which matches this `tablet/` directory. The band edges are swept explicitly
 * because a single 768px viewport cannot tell you where the breakpoint is.
 */

const BAND = [641, 700, 768, 820, 900];

/** Every toolbar control's right edge — anything past the window is hidden. */
async function toolbarFit(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.app-header') as HTMLElement;
    const controls = [...document.querySelectorAll('.toolbar-buttons > *')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: (el.getAttribute('data-testid') || el.className || '?').toString().slice(0, 28), x: r.x, right: r.right, w: r.width, h: r.height };
    });
    const cs = getComputedStyle(header);
    return {
      clientW: header.clientWidth,
      scrollW: header.scrollWidth,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      innerW: window.innerWidth,
      controls,
    };
  });
}

test('the tablet header scrolls in neither axis and hides no control (#134)', async ({ cm, page }) => {
  await cm.ready();
  for (const width of BAND) {
    await page.setViewportSize({ width, height: 1024 });
    const fit = await toolbarFit(page);
    expect(fit.scrollW - fit.clientW, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    // The header must not be a scroll container in EITHER axis. `overflow-x:
    // auto` used to drag `overflow-y` to auto with it, which clipped the
    // settings popover to the 48px bar. scrollHeight alone cannot tell you
    // this: the toolbar buttons are ~52px in a 48px row, so it overflows
    // visibly at every width by design.
    expect(fit.overflowX, `overflow-x at ${width}px`).toBe('visible');
    expect(fit.overflowY, `overflow-y at ${width}px`).toBe('visible');
    for (const c of fit.controls) {
      expect(c.right, `${c.id} right edge at ${width}px`).toBeLessThanOrEqual(fit.innerW + 0.5);
      expect(c.x, `${c.id} left edge at ${width}px`).toBeGreaterThanOrEqual(-0.5);
    }
    // The secondary controls are behind ⋯ at every width in the band.
    await expect(page.getByTestId('toolbar-overflow-toggle'), `⋯ toggle at ${width}px`).toBeVisible();
  }
});

test('the tablet ⋯ menu and the settings popover are fully on-screen (#134)', async ({ cm, page }) => {
  await cm.ready();
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.getByTestId('toolbar-overflow-toggle').click();
  const panel = page.getByTestId('toolbar-overflow-panel');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(768.5);

  // Every secondary control is reachable from it.
  for (const id of ['new-project', 'load-project', 'export-default', 'docs-open', 'settings-open']) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }

  // The popover that used to be clipped to the 48px header bar.
  await page.getByTestId('settings-open').click();
  const menu = page.getByTestId('settings-menu');
  await expect(menu).toBeVisible();
  const m = (await menu.boundingBox())!;
  expect(m.height, 'settings popover collapsed to the header box').toBeGreaterThan(200);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(768.5);
  expect(m.y + m.height).toBeLessThanOrEqual(1024);
});

test('above the band the full labelled toolbar comes back (#134)', async ({ cm, page }) => {
  await cm.ready();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('toolbar-overflow-toggle')).toHaveCount(0);
  const fit = await toolbarFit(page);
  expect(fit.scrollW - fit.clientW).toBeLessThanOrEqual(0);
  expect(fit.overflowY).toBe('visible');
  for (const c of fit.controls) {
    expect(c.right, `${c.id} right edge at 1024px`).toBeLessThanOrEqual(fit.innerW + 0.5);
  }
});
