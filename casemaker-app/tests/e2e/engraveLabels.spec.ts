// #359 — the engrave preview's SCENE-ANCHORED labels must stay inside the canvas.
//
// They are drei `<Html>`s anchored to a world point with `center`, so a label whose anchor lands
// near the canvas edge is half outside it, and the wrapper — canvas-sized — clips it mid-word.
// #355 made the context panel share the width at laptop sizes, which is what made the canvas
// narrow enough to see: measured at 1024 × 700 (canvas 344 px, left edge at x = 320) BEFORE this
// fix, `engrave-jaw-source` spanned −55 → 77 px from the canvas's left edge and read "…asured
// defaults" on screen, and the two axis labels were off it entirely (−10 → −2 and −17 → −9).
//
// The clip is not the labels' fault and not the canvas's: at that width the stock overflows the
// canvas, so the anchors themselves project outside it — the jaw at x ≈ 11, the +x axis end at
// x ≈ −6. That is why the fix clamps the box into the canvas (issue #359, option 1) instead of
// flipping the label to the other side of its anchor, and why the assertions here are about where
// the boxes END UP rather than about the arithmetic — that lives in `tests/unit/projectedLabel.spec.ts`.
//
// Run (Windows, Vite started by hand per #226):
//   npx playwright test tests/e2e/engraveLabels.spec.ts

import { test, expect } from './fixtures/caseMaker';
import { LABEL_PAD } from '../../src/components/viewport/projectedLabel';

/** The two axis labels the issue measured; the jaw-source floating label was removed in #520, and
 *  the void labels share the same mechanism but need a job with one. */
const LABELS = ['engrave-axis-x', 'engrave-axis-y'];

/** Load a board and open the engrave section (the section button TOGGLES). */
async function openEngrave(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const btn = page.getByTestId('sidebar-button-cnc-engrave');
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await page.waitForSelector('[data-testid="engrave-preview-legend"]', { timeout: 60_000 });
  await page.waitForTimeout(700);
}

/** The canvas box and each label's box, all in page coordinates. */
async function measure(page: import('@playwright/test').Page) {
  return page.evaluate((ids) => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    return {
      canvas: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, width: c.width },
      labels: ids.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return { id, box: null };
        const r = el.getBoundingClientRect();
        return { id, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
      }),
    };
  }, LABELS);
}

test('at laptop width every projected label is inside the canvas, clamped to the pad (#359)', async ({
  cm,
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await cm.ready();
  await openEngrave(page);
  const { canvas, labels } = await measure(page);

  // The canvas is the narrow one the issue measured, not a wider one that happens to fit.
  expect(canvas.width, 'canvas width at 1024').toBeLessThan(400);

  for (const { id, box } of labels) {
    expect(box, `${id} is mounted`).not.toBeNull();
    expect(box!.left, `${id} left edge`).toBeGreaterThanOrEqual(canvas.left);
    expect(box!.right, `${id} right edge`).toBeLessThanOrEqual(canvas.right);
    expect(box!.top, `${id} top edge`).toBeGreaterThanOrEqual(canvas.top);
    expect(box!.bottom, `${id} bottom edge`).toBeLessThanOrEqual(canvas.bottom);
  }

  // That the clamp PINS a label whose anchor projects outside the canvas to LABEL_PAD (rather than
  // clipping it) is checked directly on the arithmetic in tests/unit/projectedLabel.spec.ts. The
  // jaw-source label this e2e used to pin-check was the one whose anchor fell near the edge at this
  // width; #520 removed it, and the remaining axis labels project inside the narrow canvas — so the
  // end-to-end assertion kept here is the one in the loop above: every projected label lands inside.

  await page.screenshot({ path: 'test-results/359-labels-1024x700.png' });
});

test('and it is still inside on a wide canvas, where nothing needs clamping (#359)', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await cm.ready();
  await openEngrave(page);
  const { canvas, labels } = await measure(page);

  expect(canvas.width, 'canvas width at 1440').toBeGreaterThan(700);
  for (const { id, box } of labels) {
    expect(box, `${id} is mounted`).not.toBeNull();
    // Nothing is pinned here: the boxes sit where their anchors put them, which is the check that
    // the clamp did not start dragging labels around on a canvas with room to spare.
    expect(box!.left, `${id} left edge`).toBeGreaterThan(canvas.left + LABEL_PAD);
    expect(box!.right, `${id} right edge`).toBeLessThan(canvas.right - LABEL_PAD);
  }
});
