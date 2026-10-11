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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The other half of #229, reported as #349: the legend must stay where it is put. */
const within = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

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

// #349 — the legend used to be a drei `<Html fullscreen>`: its wrapper is translated to the scene
// ORIGIN's projected screen position and the inner div offset back, so it only sits where it looks
// like it sits while the origin projects inside the canvas. Orbit the camera past that and the
// label drifts off with it — the report that filed this had it over the header. As DOM beside the
// canvas it has no position in the scene to inherit, so an orbit that visibly moves the camera
// must leave its box exactly where it was, inside the pane.
test('the depth legend stays put and inside the pane while the camera orbits (#349)', async ({
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

  const legend = page.getByTestId('engrave-preview-legend');
  const pane = page.locator('.viewport-wrapper');
  const before = (await legend.boundingBox()) as Box;
  const paneBox = (await pane.boundingBox()) as Box;
  expect(before).not.toBeNull();
  expect(within(before, paneBox), 'the legend starts inside the viewport pane').toBe(true);

  const start = await axisRects(page);

  // An ordinary orbit drag across the canvas — no forced click; the legend is pointer-transparent
  // (that is the #229 half, asserted above).
  const canvas = (await page.getByTestId('viewport-canvas').boundingBox()) as Box;
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy + 90, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  // The drag must have moved the camera, or "the legend did not move" proves nothing. The axis
  // labels are placed by drei from the camera's matrix, so their projected positions are the
  // witness — the same evidence the toolbar test uses.
  const orbited = await axisRects(page);
  expect(
    Math.max(moved(start.x, orbited.x), moved(start.y, orbited.y)),
    'the orbit drag moved the camera',
  ).toBeGreaterThan(20);

  const after = (await legend.boundingBox()) as Box;
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(within(after, paneBox), 'the legend is still inside the viewport pane').toBe(true);
});
