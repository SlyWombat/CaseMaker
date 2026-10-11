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
// #348 closed the same seam from the other side: those projected labels sat four orders of
// magnitude above every dialog, so they printed through the setup flow and the wizard. The test at
// the bottom of this file asserts the stacking, which is the only honest assertion available —
// see its comment for the two checks the issue suggested and the measurement that rules them out.
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

  // The unmoved box is the load-bearing check (the review of `ebf38c5` noted the `within` this
  // replaces was a tautology: the legend is an absolutely-positioned child of the pane, so its
  // box is inside the pane's by construction).
  const after = (await legend.boundingBox()) as Box;
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
});

// #348 — the projected labels printed THROUGH the setup flow and the wizard, because drei's `Html`
// defaults `zIndexRange` to `[16777271, 0]` and writes that onto a wrapper div beside the canvas:
// no dialog can out-stack four orders of magnitude. One stacking scale now owns every number
// (`src/styles/tokens.css`), and a projected label is pinned BELOW it.
//
// The issue asks for a bounding-box or `visibility` assertion; both are ruled out by measurement.
// The overlay is `inset: 0`, so it contains every label's box — a box-intersection assertion would
// fail on a correct fix and, worse, pass on a label hidden behind an opaque dialog. And a label is
// not hit-testable at all: `pointer-events: none` on the wrapper's inner div, and its own box is
// 0x0 (its content is absolutely positioned), so `elementFromPoint` at a label's centre returns the
// canvas with no dialog open and the dialog with one — identically before and after this fix.
//
// What the browser does expose is the arithmetic that decides the paint: the z-index on the drei
// wrapper, and the z-index of everything else in the pane, all resolved in the same stacking
// context as the portaled dialog. That is what is asserted here, plus the one structural condition
// that makes the comparison meaningful (nothing between the label and the body traps it in a
// stacking context of its own).
test('a dialog is above every element of the viewport pane (#348)', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(700);

  // With no dialog up: the projected label carries a numeric wrapper z-index BELOW the toolbar's,
  // so it is a member of the scale's bottom band rather than of drei's default range.
  const bare = await page.evaluate(() => {
    const span = document.querySelector('[data-testid="engrave-axis-x"]');
    if (!span) return null;
    let el: HTMLElement | null = span as HTMLElement;
    while (el && getComputedStyle(el).zIndex === 'auto') el = el.parentElement;
    const toolbar = document.querySelector('[data-testid="viewport-toolbar"]') as HTMLElement | null;
    return {
      label: el ? Number(getComputedStyle(el).zIndex) : null,
      toolbar: toolbar ? Number(getComputedStyle(toolbar).zIndex) : null,
    };
  });
  expect(bare, 'the projected axis label is mounted with its drei wrapper').not.toBeNull();
  expect(Number.isFinite(bare!.label), 'the wrapper carries a numeric z-index').toBe(true);
  expect(bare!.label!, 'a projected label sits under the viewport chrome').toBeLessThan(bare!.toolbar!);

  // The reported screen: the setup flow at step 2 (material), with the preview still mounted behind
  // it — the report was '…asured defaults' printed over "What is it made of?".
  await page.getByTestId('engrave-setup-open').click();
  await expect(page.getByTestId('engrave-setup-flow')).toBeVisible();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('engrave-setup-step-material')).toBeVisible();

  const stack = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="engrave-setup-flow"]') as HTMLElement;
    const pane = document.querySelector('.viewport-wrapper') as HTMLElement;
    const named = (el: Element): string => {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ').join('.')}` : '';
      return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls}`;
    };

    const inPane: Array<{ el: string; z: number }> = [];
    for (const el of Array.from(pane.querySelectorAll('*'))) {
      const z = getComputedStyle(el).zIndex;
      if (z !== 'auto') inPane.push({ el: named(el), z: Number(z) });
    }

    // Would anything between a label and the body trap it in a stacking context of its own? The
    // wrapper's two own divs are the label itself (drei renders an inner div inside the wrapper),
    // so the walk starts at the wrapper's parent.
    const span = document.querySelector('[data-testid="engrave-axis-x"]') as HTMLElement;
    let wrapper: HTMLElement | null = span;
    while (wrapper && getComputedStyle(wrapper).zIndex === 'auto') wrapper = wrapper.parentElement;
    const trappedBy: string[] = [];
    for (let n = wrapper?.parentElement ?? null; n && n !== document.body; n = n.parentElement) {
      const z = getComputedStyle(n).zIndex;
      if (z !== 'auto') trappedBy.push(`${named(n)} z=${z}`);
    }

    return {
      overlayZ: Number(getComputedStyle(overlay).zIndex),
      overlayParent: overlay.parentElement?.tagName ?? null,
      labelZ: wrapper ? Number(getComputedStyle(wrapper).zIndex) : null,
      inPane,
      trappedBy,
    };
  });

  // The check below is only worth something if the pane has elements in it to be below the dialog —
  // in particular the projected label, which is the whole point of the issue.
  expect(stack.inPane.length, 'the pane really has z-index-carrying chrome').toBeGreaterThan(2);
  expect(stack.inPane.some((e) => e.z === stack.labelZ), 'the projected label is one of them').toBe(true);

  expect(Number.isFinite(stack.overlayZ), 'the dialog carries a numeric z-index').toBe(true);
  expect(stack.trappedBy, 'no ancestor traps the label in its own stacking context').toEqual([]);
  expect(stack.overlayParent, 'the overlay is portaled to the body, as the scale assumes').toBe('BODY');
  const above = stack.inPane.filter((e) => e.z >= stack.overlayZ);
  expect(above, 'nothing in the viewport pane stacks at or above the open dialog').toEqual([]);
});
