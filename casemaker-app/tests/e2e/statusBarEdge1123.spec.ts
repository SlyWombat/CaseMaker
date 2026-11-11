// #1123 (analyst's ruling on the land18 walk, row 4) — THE STATUS BAR ENDS WHERE THE RIGHT PANEL
// BEGINS, and nothing of it is covered. Walked on land18 42bc22f03: the right rail was a
// content-box `height: 100%` plus 32 px of padding, 32 px taller than its grid row, so it ran over
// the 28 px status bar and hid the engine stats ("Ready  tris: …") behind it.
import { test, expect } from './fixtures/caseMaker';

test('#1123 row 4 — the right panel stays inside its row; every part of the status bar is uncovered', async ({
  cm,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.locator('.status-bar__stats')).toBeVisible();

  const m = await page.evaluate(() => {
    const rect = (e: Element) => e.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="status-bar"]')!;
    const panel = document.querySelector('[data-testid="context-panel"]')!;
    const main = document.querySelector('.app-main')!;
    // The point at the middle of each piece of the bar must hit the bar itself, not the panel.
    const covered = [...bar.querySelectorAll('.status-bar__engine > *, .status-bar__version')].map((el) => {
      const r = rect(el);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: (el.textContent ?? '').slice(0, 20), covered: hit === null || !bar.contains(hit) };
    });
    return { panelBottom: rect(panel).bottom, mainBottom: rect(main).bottom, barTop: rect(bar).top, covered };
  });
  expect(m.panelBottom, 'the panel ends at its row').toBeLessThanOrEqual(m.mainBottom + 0.5);
  expect(m.mainBottom).toBeLessThanOrEqual(m.barTop + 0.5);
  expect(m.covered.length).toBeGreaterThan(1);
  for (const c of m.covered) expect(c.covered, `status bar text "${c.text}" is covered`).toBe(false);
});
