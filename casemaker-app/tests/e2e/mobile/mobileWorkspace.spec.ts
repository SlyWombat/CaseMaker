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
  // #355 — a budget this walk can actually meet. It opens and shuts two drawers and visits seven
  // sections on a phone viewport under swiftshader, and every click on a `position: fixed` element
  // there costs ~0.9 s in actionability waits; the run was measured at 32 s against the default
  // 30 s, so it timed out a line or two short on a loaded machine — on `main` as well, with the
  // #355 work stashed, so this is not a regression the layout brought with it. 60 s leaves the
  // same margin the other walkers in this directory have.
  test.setTimeout(60_000);
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
    // the right rather than hidden, so the handle still reports visible.
    // #355 — the drawer's own × is gone; the handle tab is the drawer's control.
    const panel = page.getByTestId('context-panel');
    if ((await panel.getAttribute('class'))?.includes('context-panel--open')) {
      await page.getByTestId('context-panel-handle').click();
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
 * #350 — a label's text field, at phone width. The Items row once held the text input on ONE flex
 * line with the font picker and the weight toggle: `flex: 1` gives the input a zero flex-basis, so
 * it was the first thing to give up its width and it collapsed to a sliver beside siblings that do
 * not shrink — the label's text was neither readable nor editable. #134's fit spec passed the whole
 * time because it samples the board sections (`sidebar-button-<id>` for board/case/ports/…), and the
 * engrave panel is not one of them.
 */
test('a label’s text field keeps a usable width at phone width (#350)', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });

  // The rail is off-canvas at phone width; bring it in the same way #134's test does.
  const sideX = await page.getByTestId('sidebar').evaluate((el) => el.getBoundingClientRect().x);
  if (sideX < 0) await page.getByTestId('sidebar-handle').click();
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  // #411 — the field lives in the row's body, behind the chevron.
  await page.getByTestId('engrave-label-expand-0').click();

  const m = await page.getByTestId('engrave-label-text-0').evaluate((el) => {
    const input = el as HTMLInputElement;
    const row = input.closest('[data-testid^="engrave-label-row-"]') as HTMLElement;
    // What shares the input's own flex line. This is the assertion that can only pass with the
    // fix: the width below could in principle come out large on some other layout, but a SELECT or
    // a BUTTON on this line is the bug itself — `flex: 1` gives the input a zero basis, so any
    // non-shrinking sibling takes its width and the input pays. #411 moved the field into the
    // body's own line, where nothing shares it at all (the font picker and the weight toggle are
    // the NEXT line, and the show/hide checkbox is up on the collapsed row).
    const line = Array.from(input.parentElement!.children).map(
      (c) => `${c.tagName}:${(c as HTMLElement).dataset.testid ?? ''}`,
    );
    return {
      line,
      width: input.getBoundingClientRect().width,
      rowWidth: row.getBoundingClientRect().width,
      text: input.value,
      // The field must show its whole value, not just be wide enough to be clickable.
      clipped: input.scrollWidth > input.clientWidth,
    };
  });
  expect(m.line, 'the text field has its line to itself').toEqual(['INPUT:engrave-label-text-0']);
  expect(m.text.length, 'the deterministic job’s first label').toBeGreaterThan(0);
  expect(m.width, 'the text field is a sliver').toBeGreaterThanOrEqual(120);
  expect(m.width / m.rowWidth, 'the text field is a minority of its own row').toBeGreaterThanOrEqual(0.5);
  expect(m.clipped, 'the text field clips its value').toBe(false);
});

/**
 * #411 — the remove control on the collapsed line, at phone width. The maintainer could not find it
 * on the desktop build at all, so on a phone — where the row is at its tightest and there is no
 * hover to reveal a tooltip — it has to be a real touch target, not the 12 px glyph the row would
 * otherwise give it. The rule is media-queried (`max-width: 1024px`), so it is only true at a
 * narrow width; this is the spec that can tell whether the query is doing anything.
 */
test('the remove control on an item line is a real touch target at phone width (#411)', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  const sideX = await page.getByTestId('sidebar').evaluate((el) => el.getBoundingClientRect().x);
  if (sideX < 0) await page.getByTestId('sidebar-handle').click();
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The row is FOLDED, which is the state the report was about and the state a phone opens on.
  const box = await page.getByTestId('engrave-label-remove-0').boundingBox();
  expect(box, 'there is no remove control on the line').not.toBeNull();
  expect(box!.width, 'the touch target is narrower than a fingertip').toBeGreaterThanOrEqual(24);
  expect(box!.height, 'the touch target is shorter than a fingertip').toBeGreaterThanOrEqual(24);

  // It is the FRONT of the line, beside the show/hide box — not wrapped away from the name.
  const [show, name] = await Promise.all([
    page.getByTestId('engrave-label-enabled-0').boundingBox(),
    page.getByTestId('engrave-label-expand-0').boundingBox(),
  ]);
  expect(box!.x).toBeLessThan(show!.x);
  expect(box!.x).toBeLessThan(name!.x);

  // And it works from the line, with the undo offered at the same place.
  await page.getByTestId('engrave-label-remove-0').tap();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('2');
  await page.getByTestId('engrave-undo').tap();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('3');

  // The rule is a media query, so it is the EDGE that can be wrong: 1024 is the top of the band it
  // covers, and one pixel over it is a desktop row again. Measured there rather than only at 390 so
  // the boundary is what is being checked, not just that some narrow width works.
  await page.setViewportSize({ width: 1024, height: 768 });
  const atEdge = await page.getByTestId('engrave-label-remove-0').boundingBox();
  expect(atEdge!.width, 'the touch target drops below 24 px at the top of the band').toBeGreaterThanOrEqual(24);
  expect(atEdge!.height, 'the touch target drops below 24 px at the top of the band').toBeGreaterThanOrEqual(24);
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
  // #346: the web build offers no check; Continue without a machine is the advancing button.
  await page.getByTestId('start-wizard-next').click();
  await page.waitForSelector('[data-testid="start-wizard-step-job"]');
  await page.getByTestId('start-wizard-job-badge-blank').click();
  // #681 — the blank route stays in the SAME wizard, on the holding step; its close is the one
  // control every step has.
  await page.waitForSelector('[data-testid="engrave-setup-step-holding"]');
  await page.getByTestId('start-wizard-close').click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });

  // The wizard can leave the right-hand drawer open, and an open drawer covers the rail handle.
  // #355 — closed with the drawer's own handle tab, the only close control the drawer has now.
  const panel = page.getByTestId('context-panel');
  if ((await panel.getAttribute('class'))?.includes('context-panel--open')) {
    await page.getByTestId('context-panel-handle').click();
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

/**
 * #360 — the export modal, on the phone, from the drawer it is opened inside.
 *
 * `ExportModal` was `position: fixed` with `--cm-z-modal-raised` (200) but NOT portaled, and it is
 * mounted from `ExportPanel`, which `ContextPanel` renders. Below 1024 px that panel is
 * `.context-panel--drawer`: `position: fixed` with `transform: translateX(-100% …)` and
 * `--cm-z-sidebar-drawer` (25). A transform makes it the CONTAINING BLOCK for a fixed descendant,
 * and its z-index makes it the stacking context — so the modal's "200" never left the drawer, and
 * its backdrop was positioned against a 360 px drawer rather than the window. (The issue names
 * `.sidebar--drawer`, which has the same shape; the export panel is in the context drawer, so the
 * exposure starts at 1024 px, not at the phone breakpoint. Measured here rather than assumed.)
 *
 * The #348 review's rule applies to a modal as much as to a viewport label, so this asserts the
 * arithmetic that decides the paint — parent, z-index, and the box the fixed element resolved to —
 * rather than a screenshot in which a correct fix and a modal that merely happens to be on top
 * look the same.
 */
test('the export modal belongs to the page, not the drawer it opens from (#360)', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-search').fill('sht31');
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });

  // The route in is the real one: the rail's drawer, then the Export section, then its button.
  const panel = page.getByTestId('context-panel');
  if ((await panel.getAttribute('class'))?.includes('context-panel--open')) {
    await page.getByTestId('context-panel-handle').click();
    await expect(panel).toHaveClass(/context-panel--closed/);
  }
  const sideX = await page.getByTestId('sidebar').evaluate((el) => el.getBoundingClientRect().x);
  if (sideX < 0) await page.getByTestId('sidebar-handle').click();
  await page.getByTestId('sidebar-button-export').click();
  await expect(page.getByTestId('context-section-export')).toBeVisible();
  await page.getByTestId('export-open').click();
  await expect(page.getByTestId('export-modal-close')).toBeVisible();
  await page.waitForTimeout(200);

  const stack = await page.evaluate(() => {
    const backdrop = document.querySelector('.export-modal-backdrop') as HTMLElement;
    const named = (el: Element): string => {
      const id = el.getAttribute('data-testid');
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ').join('.')}` : '';
      return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls}`;
    };
    const r = backdrop.getBoundingClientRect();

    // Every ancestor between the backdrop and the body, with EVERY property that makes a stacking
    // context or a containing block — not just `z-index`: `transform` is what traps this one, and a
    // check that named only z-index would report "nothing traps it" while the drawer did exactly
    // that. (#348's review flagged the narrow form of this walk in the toolbar spec.)
    const traps: string[] = [];
    for (let n = backdrop.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const why: string[] = [];
      if (cs.zIndex !== 'auto') why.push(`z=${cs.zIndex}`);
      if (cs.transform !== 'none') why.push(`transform=${cs.transform}`);
      if (cs.filter !== 'none') why.push('filter');
      if (cs.perspective !== 'none') why.push('perspective');
      if (cs.opacity !== '1') why.push(`opacity=${cs.opacity}`);
      if (cs.isolation === 'isolate') why.push('isolation');
      if (why.length > 0) traps.push(`${named(n)} ${why.join(' ')}`);
    }

    // Is the drawer really a drawer here? Without this the whole test could pass on a layout that
    // has no containing block to escape from.
    const drawer = document.querySelector('.context-panel--drawer') as HTMLElement | null;
    const inDrawer: Array<{ el: string; z: number }> = [];
    for (const el of Array.from(drawer?.querySelectorAll('*') ?? [])) {
      const z = getComputedStyle(el).zIndex;
      if (z !== 'auto') inDrawer.push({ el: named(el), z: Number(z) });
    }

    return {
      parent: backdrop.parentElement?.tagName ?? null,
      z: Number(getComputedStyle(backdrop).zIndex),
      token: getComputedStyle(document.documentElement).getPropertyValue('--cm-z-modal-raised').trim(),
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
      win: { w: window.innerWidth, h: window.innerHeight },
      drawerZ: drawer ? getComputedStyle(drawer).zIndex : null,
      drawerTransform: drawer ? getComputedStyle(drawer).transform : null,
      traps,
      inDrawer,
    };
  });

  // The premise: the modal was opened from inside a transformed, z-indexed drawer.
  expect(stack.drawerZ, 'the context panel is a drawer here, at its own token').toBe('25');
  expect(stack.drawerTransform, 'and it carries the transform that would trap a fixed child').not.toBe('none');

  // The fix: it is portaled to the body, so the drawer is neither its stacking context nor its
  // containing block, and nothing in between can become one.
  expect(stack.parent, 'the modal is portaled to the body').toBe('BODY');
  expect(stack.traps, 'nothing between the modal and the body traps it').toEqual([]);

  // The number is the scale's, compared against the token rather than a literal.
  expect(Number.isFinite(stack.z), 'the modal carries a numeric z-index').toBe(true);
  expect(stack.z, 'the raised-modal rung of the one scale').toBe(Number(stack.token));
  expect(stack.z, 'and it is above the drawer it was opened from').toBeGreaterThan(Number(stack.drawerZ));

  // The containing-block proof: `inset: 0` on a fixed element covers the WINDOW. Against the
  // drawer's box it would be ~360 px wide, starting at the drawer's right edge.
  expect(Math.abs(stack.box.x), 'the backdrop starts at the window’s left edge').toBeLessThanOrEqual(1);
  expect(Math.abs(stack.box.y), 'and at its top').toBeLessThanOrEqual(1);
  expect(Math.abs(stack.box.w - stack.win.w), 'and it is as wide as the window').toBeLessThanOrEqual(1);
  expect(Math.abs(stack.box.h - stack.win.h), 'and as tall').toBeLessThanOrEqual(1);

  // #348's rule, for the drawer this time: nothing in it stacks at or above the open modal.
  const above = stack.inDrawer.filter((e) => e.z >= stack.z);
  expect(above, 'nothing in the drawer stacks at or above the open modal').toEqual([]);
});
