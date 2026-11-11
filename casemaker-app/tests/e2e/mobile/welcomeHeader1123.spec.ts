// #1123-48 (phone) — THE HOME PAGE'S TOOLBAR AT 390 px. Walked on land18 42bc22f03 (2026-11-11):
// the slim welcome bar's controls were 50 px tall in the 48 px header, so each button's top and
// bottom edge was clipped, and the brand was gone (the wordmark is hidden below 640 px to make
// room for the ⋯ menu, which the welcome bar does not have). The bar is now fully inside the
// header, one line per control, with the brand mark on its left, and nothing scrolls sideways.
import { test, expect } from '../fixtures/caseMaker';

test('#1123-48 — the Home bar fits the 390 px header: every control inside it, one line, brand visible', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  const m = await page.evaluate(() => {
    const box = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, height: b.height };
    };
    const header = document.querySelector('.app-header')!;
    const bar = document.querySelector('[data-testid="toolbar-welcome"]')!;
    const controls = [...bar.children].filter((c) => c instanceof HTMLElement && c.offsetParent !== null);
    const brand = document.querySelector('.app-header__logo');
    return {
      vw: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      header: box(header),
      brand: brand === null ? null : { ...box(brand), display: getComputedStyle(brand).display },
      controls: controls.map((c) => ({
        id: c.getAttribute('data-testid'),
        ...box(c),
        // the distinct line tops of the control's text: one line is one top
        lines: (() => {
          const r = document.createRange();
          r.selectNodeContents(c);
          return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
        })(),
      })),
    };
  });

  expect(m.scrollWidth, 'no sideways scroll').toBe(m.vw);
  expect(m.controls.length, 'Manage, Load, Open a job, Docs and settings').toBe(5);
  for (const c of m.controls) {
    expect(c.top, `${c.id} top inside the header`).toBeGreaterThanOrEqual(m.header.top);
    expect(c.bottom, `${c.id} bottom inside the header`).toBeLessThanOrEqual(m.header.bottom);
    expect(c.right, `${c.id} right edge on screen`).toBeLessThanOrEqual(m.vw);
    expect(c.left, `${c.id} left edge on screen`).toBeGreaterThanOrEqual(0);
    // (the settings control is a wrapper around a lone glyph and its popover: no text to wrap)
    if (c.id !== null) expect(c.lines, `${c.id} is one line`).toBeLessThanOrEqual(1);
  }
  expect(m.brand, 'the brand is drawn').not.toBeNull();
  expect(m.brand!.display).not.toBe('none');
  expect(m.brand!.right - m.brand!.left, 'the brand has width').toBeGreaterThan(16);
  expect(m.brand!.left).toBeGreaterThanOrEqual(0);
  expect(m.brand!.bottom).toBeLessThanOrEqual(m.header.bottom);
  // the brand does not run under the first control
  expect(m.brand!.right).toBeLessThanOrEqual(m.controls[0]!.left);
});
