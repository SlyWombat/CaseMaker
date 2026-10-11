// #355 — laptop width (1024 px), the width every desktop e2e run sees.
//
// Found in the UI review at 1024 × 700: the header buttons were 51 px tiles whose labels had
// wrapped inside a 48 px bar; the context panel was a fixed drawer over the viewport, so the
// viewport toolbar sat clipped under it ("FRO…", "FIXTUR…"), and the drawer's own × sat directly
// under the content's, reading as one control duplicated.
//
// Page widths are set explicitly rather than taken from the project's viewport so the band edges
// can be swept: the header wrap and the rail/drawer choice are both functions of width, and a
// single 1024 run cannot say where either one changes.
//
// Run (Windows, Vite started by hand per #226):
//   npx playwright test tests/e2e/laptopLayout.spec.ts

import { test, expect } from './fixtures/caseMaker';

/** Header height this layout must hold: `.app-shell`'s first grid row. */
const HEADER_MAX_H = 48;
/** A one-line toolbar button is 31–32 px; a wrapped one is 51+. */
const ROW_MAX_H = 40;

/** Load a board and open the engrave section. The section button TOGGLES, so the width sweep can
 *  call this repeatedly without closing what it just opened. */
async function openEngrave(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const btn = page.getByTestId('sidebar-button-cnc-engrave');
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await page.waitForSelector('[data-testid="engrave-preview-legend"]', { timeout: 60_000 });
  await page.waitForTimeout(500);
}

interface Layout {
  headerH: number;
  rowH: number;
  rowScrollW: number;
  rowClientW: number;
  panelClass: string;
  panelLeft: number;
  panelRight: number;
  toolbarRight: number;
  paneRight: number;
  mainW: number;
  innerW: number;
  closesInPanel: string[];
  handle: boolean;
}

async function readLayout(page: import('@playwright/test').Page): Promise<Layout> {
  return page.evaluate(() => {
    const el = (sel: string): HTMLElement | null => document.querySelector(sel);
    const box = (sel: string): DOMRect | null => el(sel)?.getBoundingClientRect() ?? null;
    const header = box('.app-header')!;
    const rowEl = el('.toolbar-buttons')!;
    const row = rowEl.getBoundingClientRect();
    const panelEl = el('[data-testid="context-panel"]')!;
    const panel = panelEl.getBoundingClientRect();
    const toolbar = box('[data-testid="viewport-toolbar"]');
    const pane = box('.viewport-pane')!;
    return {
      headerH: Math.round(header.height),
      rowH: Math.round(row.height),
      rowScrollW: Math.round(rowEl.scrollWidth),
      rowClientW: Math.round(rowEl.clientWidth),
      panelClass: panelEl.className,
      panelLeft: Math.round(panel.left),
      panelRight: Math.round(panel.right),
      toolbarRight: toolbar ? Math.round(toolbar.right) : -1,
      paneRight: Math.round(pane.right),
      mainW: Math.round(el('.app-main')!.getBoundingClientRect().width),
      innerW: window.innerWidth,
      closesInPanel: [...panelEl.querySelectorAll('[aria-label^="Close"]')].map(
        (el) => el.getAttribute('aria-label') ?? '',
      ),
      handle: document.querySelector('[data-testid="context-panel-handle"]') !== null,
    };
  });
}

test('at laptop width the header is one line and the panel shares the viewport (#355)', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await cm.ready();
  await openEngrave(page);
  const l = await readLayout(page);

  // 1 — the toolbar is a toolbar. `.app-shell` pins the header row at 48 px, so a button that
  // wraps its label inside it overflows the bar; the row's own height is the measurement that
  // catches that (51+ px when a label wraps, 31–32 when it does not).
  expect(l.headerH, 'header height').toBeLessThanOrEqual(HEADER_MAX_H);
  expect(l.rowH, 'toolbar row height').toBeLessThanOrEqual(ROW_MAX_H);
  expect(l.rowScrollW - l.rowClientW, 'toolbar horizontal overflow').toBeLessThanOrEqual(0);

  // 2 — the panel takes its column instead of covering the viewport, and carries ONE close.
  expect(l.panelClass).toContain('context-panel--rail');
  expect(l.toolbarRight, 'viewport toolbar right edge').toBeLessThanOrEqual(l.panelLeft);
  expect(l.toolbarRight).toBeLessThanOrEqual(l.paneRight);
  expect(l.handle, 'rail mode draws no drawer handle').toBe(false);
  expect(l.closesInPanel).toHaveLength(1);

  // 3 — "sharing the width" has to mean the shell still FITS the window. A `1fr` grid item whose
  // content is a <canvas> is floored at the canvas's intrinsic width unless it declares
  // `min-width: 0`, and then the rail is pushed past the clipped edge: measured 1440 -> 1024 on a
  // resize, `.app-main` stayed 1440 wide and the panel was simply gone.
  expect(l.mainW, 'app-main width vs window').toBeLessThanOrEqual(l.innerW);
  expect(l.panelRight, 'panel right edge').toBeLessThanOrEqual(l.innerW);

  await page.screenshot({ path: 'test-results/355-laptop-1024x700.png', fullPage: false });
});

test('the panel is a drawer only where the column would starve the canvas (#355)', async ({ cm, page }) => {
  await cm.ready();

  // 1024 is the narrowest shared width: 320 + 344 + 360.
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await openEngrave(page);
    const l = await readLayout(page);
    expect(l.panelClass, `panel at ${width}px`).toContain('context-panel--rail');
    expect(l.closesInPanel.length, `closes at ${width}px`).toBeLessThanOrEqual(1);
    expect(l.toolbarRight, `toolbar right edge at ${width}px`).toBeLessThanOrEqual(l.panelLeft);
    // Resized DOWN to here: the canvas's intrinsic width used to floor the column, so this is the
    // step that catches the pane refusing to shrink.
    expect(l.mainW, `app-main width at ${width}px`).toBeLessThanOrEqual(l.innerW);
    expect(l.panelRight, `panel right edge at ${width}px`).toBeLessThanOrEqual(l.innerW);
  }

  // Below it the overlay is back, and a drawer carries the handle tab that closes it.
  for (const width of [1023, 900, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const l = await readLayout(page);
    expect(l.panelClass, `panel at ${width}px`).toContain('context-panel--drawer');
    expect(l.handle, `handle at ${width}px`).toBe(true);
    // The drawer's own × is gone: the handle is the only control that closes the drawer, and the
    // content keeps its own ×, so the panel body never shows two.
    const inBody = l.closesInPanel.filter((a) => a !== 'Close context panel');
    expect(inBody.length, `closes inside the panel body at ${width}px`).toBeLessThanOrEqual(1);
  }
});
