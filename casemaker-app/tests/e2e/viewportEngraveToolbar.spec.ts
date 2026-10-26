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

// #497 — the sacrificial route generates a real program in the worker. Under concurrent unit-test
// load this test measured 29.7 s against Playwright's 30 s default, so the 180 s expectation inside
// it could never actually be honoured. Give the file the same worker-backed budget `engrave.spec.ts`
// uses.
// This is a budget, not a wait: every assertion still has to reach its state.
test.setTimeout(240_000);

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
  // #516 item 5 — the default job starts tool-less; the recommendation lands on first load and the
  // preview rebuilds with the floors it names. Wait for those floors (the legend's depth swatches)
  // rather than a fixed delay, so the legend's box is the settled one before its position is read —
  // the same wait `engrave.spec.ts`'s #288 test uses for the default job's 2, 1 and 0.5 mm cuts.
  for (const d of ['2', '1', '0.5']) await expect(page.getByTestId(`engrave-legend-${d}`)).toBeVisible({ timeout: 60_000 });
  // Let the section-open AutoFrame settle.
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
// #361 — the DOM legends must CLEAR the toolbar, not sit on it.
//
// #349 put the depth legend in the pane's top-right corner at `top: 8`; the toolbar is a DOM row in
// the same corner and it WRAPS — one row at 1440, three at 1024 in the #355 rail layout — so at
// 1024 the legend covered the right end of the first two rows: "Fit" was hidden and "Side" was cut
// to "Si". Nothing was clickable-but-dead (the legend is `pointer-events: none`, so a click still
// reached the button, which is why #229's click test passes either way) — the buttons were simply
// unreadable, and only a geometry assertion can see that. Both legends share the anchor, so the
// swatch had the same fault with a sim scene up.
//
// `Viewport` measures the toolbar's bottom edge into `--cm-viewport-toolbar-bottom`; the assertions
// below are on the rendered rects, and the control step re-measures with that variable cleared —
// the pre-#361 layout — so a green run also proves the variable is what moved the legend.

interface Hits {
  legend: Box;
  toolbar: Box;
  bottom: string;
  hits: { el: string; box: Box }[];
}

/**
 * Every toolbar box the legend at `legendTestId` must not touch: the toolbar's own box (its border
 * and padding are chrome the legend should not sit on either) and each control inside it.
 *
 * `clearFix` removes the measured variable for the measurement and puts it back — the legend
 * computes back to `top: 8`, which is the layout the issue reports — so the caller can assert the
 * overlap was real before the fix and not merely absent from a toolbar that never wrapped.
 */
async function toolbarHits(page: Page, legendTestId: string, clearFix = false): Promise<Hits> {
  return page.evaluate(
    ({ id, clear }) => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const overlaps = (a: Box, b: Box): boolean =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

      const legend = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (!legend) throw new Error(`no [data-testid="${id}"] on screen`);
      const toolbar = document.querySelector('[data-testid="viewport-toolbar"]') as HTMLElement;
      const wrapper = document.querySelector('.viewport-wrapper') as HTMLElement;

      const saved = wrapper.style.getPropertyValue('--cm-viewport-toolbar-bottom');
      if (clear) wrapper.style.removeProperty('--cm-viewport-toolbar-bottom');

      const legendBox = box(legend);
      const toolbarBox = box(toolbar);
      const hits: { el: string; box: Box }[] = [];
      if (overlaps(legendBox, toolbarBox)) hits.push({ el: 'viewport-toolbar', box: toolbarBox });
      for (const el of Array.from(toolbar.querySelectorAll('[data-testid^="viewport-"]'))) {
        const b = box(el);
        // A collapsed box (the 0x0 markers a few controls render) is not a thing to be covering.
        if (b.width === 0 && b.height === 0) continue;
        if (overlaps(legendBox, b)) hits.push({ el: el.getAttribute('data-testid') ?? el.tagName, box: b });
      }

      const bottom = saved;
      if (clear) wrapper.style.setProperty('--cm-viewport-toolbar-bottom', saved);
      return { legend: legendBox, toolbar: toolbarBox, bottom, hits };
    },
    { id: legendTestId, clear: clearFix },
  );
}

/** Both widths the issue reports: the wrapped three-row toolbar, and the roomy single row. */
const WIDTHS: { width: number; height: number }[] = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];

/**
 * #497 — wait for the toolbar edge the legends are anchored to, rather than for a number of
 * milliseconds.
 *
 * `Viewport` publishes the toolbar's bottom edge into `--cm-viewport-toolbar-bottom` from a
 * `ResizeObserver`, asynchronously after the width change that makes the toolbar re-wrap. A font
 * swap moves the text metrics the same way. The old `waitForTimeout(600)` was a bet that both had
 * finished; under full-suite load that bet loses, and the rect read describes the previous width's
 * anchor. Poll the state instead: fonts settled, the published variable equal (within the whole-px
 * rounding `Viewport` writes) to the toolbar's bottom edge inside the wrapper, and the legend
 * already positioned by exactly that value plus its 8 px gutter. When this resolves, a synchronous
 * rect read describes the layout the app has published.
 */
async function waitForToolbarMeasurement(page: Page, legendTestId: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(
      () =>
        page.evaluate((id: string) => {
          const wrapper = document.querySelector('.viewport-wrapper') as HTMLElement | null;
          const toolbar = document.querySelector('[data-testid="viewport-toolbar"]') as HTMLElement | null;
          const legend = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
          if (!wrapper || !toolbar || !legend) return false;
          const wrapperTop = wrapper.getBoundingClientRect().top;
          const toolbarBottom = toolbar.getBoundingClientRect().bottom - wrapperTop;
          const legendTop = legend.getBoundingClientRect().top - wrapperTop;
          const published = Number.parseFloat(
            wrapper.style.getPropertyValue('--cm-viewport-toolbar-bottom'),
          );
          if (!Number.isFinite(published)) return false;
          return (
            Math.abs(published - toolbarBottom) <= 1 &&
            Math.abs(legendTop - (published + 8)) <= 1
          );
        }, legendTestId),
      {
        message: `${legendTestId} should be positioned by the toolbar edge the app measured`,
        timeout: 30_000,
      },
    )
    .toBe(true);
}

/** Clear of the toolbar AND still inside the pane — the fix must not push the legend off an edge. */
async function expectCleared(page: Page, legendTestId: string, label: string): Promise<void> {
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await waitForToolbarMeasurement(page, legendTestId);
    const m = await toolbarHits(page, legendTestId);
    console.log(
      '#361 %s %dx%d legend=%j toolbar=%j --cm-viewport-toolbar-bottom=%s hits=%j',
      label, size.width, size.height, m.legend, m.toolbar, m.bottom || '(unset)', m.hits,
    );
    expect(m.hits, `${label} at ${size.width}x${size.height} must clear the toolbar`).toEqual([]);
    const pane = (await page.locator('.viewport-wrapper').boundingBox()) as Box;
    expect(within(m.legend, pane), `${label} at ${size.width}x${size.height} stays in the pane`).toBe(true);
  }
}

test('#361 — the depth legend clears the toolbar at both widths', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });

  await expectCleared(page, 'engrave-preview-legend', 'engrave');

  // The control: at the wrapped width, the PRE-#361 layout really does overlap what the assertion
  // above just proved clear. Without this, the check would pass on a toolbar that never wraps.
  await page.setViewportSize({ width: 1024, height: 700 });
  await waitForToolbarMeasurement(page, 'engrave-preview-legend');
  const before = await toolbarHits(page, 'engrave-preview-legend', true);
  console.log('#361 engrave 1024x700 WITHOUT the measured variable: hits=%j', before.hits);
  expect(
    before.hits.length,
    'the pre-#361 layout overlapped the toolbar here — the fix is what cleared it',
  ).toBeGreaterThan(0);
});

test('#361 — the sacrificial swatch clears the toolbar at both widths', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 60_000 });

  // The swatch reads the SIM store, so a sim scene has to be up for it to render at all — and the
  // only route in the app that puts a sacrificial body into that store is the engrave job's own:
  // the strips, then Generate, which loads the program it generated into `simStore`.
  // #523 — the sacrificial presets live in the Hold group, closed by default.
  await page.getByTestId('engrave-group-hold-summary').click();
  await page.getByTestId('engrave-sac-preset-strips').click();
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('sim-legend-sacrificial')).toBeVisible({ timeout: 180_000 });

  await expectCleared(page, 'sim-legend-sacrificial', 'sim swatch');
});

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

  // The reported screen: the cutting-job wizard open on its holding step, with the preview still
  // mounted behind it — the report was '…asured defaults' printed over "What is it made of?".
  // Since #681 it is ONE wizard: the panel's edit opens it at the step it names. #686 moved that
  // edit onto the Hold line, which is the row that lands on the holding step.
  await page.getByTestId('engrave-hold-edit').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();

  const stack = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="start-wizard"]') as HTMLElement;
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

    // A stacking context is created by MORE than a z-index: a non-`none` `transform`, `filter`
    // (and `backdrop-filter`) or `perspective`, an `opacity` below 1, and `isolation: isolate` all
    // create one on their own. A z-index-only walk would miss a trap any of those set, which is
    // exactly the class of bug the walk exists to catch, so the predicate names what did it or
    // returns null.
    const stacking = (el: Element): string | null => {
      const cs = getComputedStyle(el);
      if (cs.zIndex !== 'auto') return `z=${cs.zIndex}`;
      if (cs.transform !== 'none') return 'transform';
      if (cs.filter !== 'none') return 'filter';
      if (cs.backdropFilter !== 'none') return 'backdrop-filter';
      if (cs.perspective !== 'none') return 'perspective';
      if (cs.opacity !== '1') return `opacity=${cs.opacity}`;
      if (cs.isolation === 'isolate') return 'isolation';
      return null;
    };

    // Would anything between a label and the body trap it in a stacking context of its own? The
    // wrapper's two own divs are the label itself (drei renders an inner div inside the wrapper),
    // so the walk starts at the wrapper's parent.
    //
    // The wrapper is found by its Z-INDEX, not by the broad predicate below: `labelZ` is the number
    // the pane's arithmetic compares against, so the wrapper must be the element that carries one.
    // (drei's own transform div sits below it and carries no z-index; finding THAT would leave
    // `labelZ` undefined and the check below nothing to compare.) The walk that hunts for a TRAP is
    // the one that must see every way a stacking context is created, and it starts above the
    // wrapper, so the wrapper itself is never reported.
    const span = document.querySelector('[data-testid="engrave-axis-x"]') as HTMLElement;
    let wrapper: HTMLElement | null = span;
    while (wrapper && getComputedStyle(wrapper).zIndex === 'auto') wrapper = wrapper.parentElement;
    const trappedBy: string[] = [];
    for (let n = wrapper?.parentElement ?? null; n && n !== document.body; n = n.parentElement) {
      const why = stacking(n);
      if (why !== null) trappedBy.push(`${named(n)} ${why}`);
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
