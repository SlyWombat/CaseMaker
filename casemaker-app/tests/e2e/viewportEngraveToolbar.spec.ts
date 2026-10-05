// #229 — regression: in the Engrave section the preview's fullscreen drei <Html> legend covered
// the whole viewport at the toolbar's own z-index, so Playwright refused an ordinary click on
// Top/Fit/zoom ("subtree intercepts pointer events") and a forced click changed nothing. The
// overlay wrappers now carry `pointer-events: none`, so every camera button takes an ordinary
// click.
//
// Why the assertions watch `engrave-axis-x/y`: the camera is a three object with no test hook, and
// `aria-checked` alone would also pass under a forced click that never reached the camera. The two
// axis labels are placed by drei from the camera's matrix, so if their projected positions move,
// the camera moved. That is the evidence the acceptance asks for ("click without force and assert
// the camera changed").
//
// Run (Windows side, Vite started by hand on 127.0.0.1 per #226):
//   npx playwright test tests/e2e/viewportEngraveToolbar.spec.ts

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.use({ viewport: { width: 1440, height: 900 } });

interface Rect {
  x: number;
  y: number;
}

const readRect = (id: string): Rect | null => {
  const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y };
};

/** Both projected axis labels — the engrave preview's witness that the camera moved. */
async function axisRects(page: Page): Promise<{ x: Rect; y: Rect }> {
  const x = await page.evaluate(readRect, 'engrave-axis-x');
  const y = await page.evaluate(readRect, 'engrave-axis-y');
  expect(x, 'engrave-axis-x must be mounted with the preview').not.toBeNull();
  expect(y, 'engrave-axis-y must be mounted with the preview').not.toBeNull();
  return { x: x as Rect, y: y as Rect };
}

const moved = (a: Rect, b: Rect): number => Math.hypot(a.x - b.x, a.y - b.y);

test('engrave section: Top, Fit and the zoom buttons take ordinary clicks and move the camera', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  // Let the preview build and the section-open AutoFrame settle.
  await page.waitForTimeout(700);

  // The regression in one line: the button is the topmost element at its own centre, so an
  // ordinary click reaches it instead of the (pointer-transparent) preview overlay.
  const topmost = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="viewport-camera-top"]') as HTMLElement;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement;
    return el?.getAttribute('data-testid') ?? el?.tagName ?? null;
  });
  expect(topmost).toBe('viewport-camera-top');

  const start = await axisRects(page);

  // Top — an ordinary click (no `force`); under the bug this call itself threw.
  await page.getByTestId('viewport-camera-top').click();
  await expect(page.getByTestId('viewport-camera-top')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(700);
  const top = await axisRects(page);
  expect(moved(start.x, top.x)).toBeGreaterThan(20);

  // Zoom in / out change the camera's distance to what is on screen.
  await page.getByTestId('viewport-zoom-in').click();
  await page.waitForTimeout(500);
  const zoomed = await axisRects(page);
  expect(moved(top.x, zoomed.x)).toBeGreaterThan(5);

  await page.getByTestId('viewport-zoom-out').click();
  await page.getByTestId('viewport-zoom-out').click();
  await page.waitForTimeout(500);
  const zoomedOut = await axisRects(page);
  expect(moved(zoomed.x, zoomedOut.x)).toBeGreaterThan(5);

  // Fit re-runs the framing maths on the ENGRAVE scene (its stock + jaws), from any distance and
  // direction. Assert from the zoomed-out state — fitting an already-framed view is a no-op.
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  const afterFit = await axisRects(page);
  expect(moved(zoomedOut.x, afterFit.x)).toBeGreaterThan(5);
});
