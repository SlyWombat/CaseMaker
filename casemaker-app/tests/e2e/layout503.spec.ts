/**
 * Issue #503 — phone/tablet layout at the two widths the walkthrough used:
 * phone 390 × 844 (dpr 2 in the capture run; the CSS decisions here are width-based,
 * so this spec sets the width explicitly like `laptopLayout.spec.ts` does) and
 * tablet 768 × 1024.
 *
 * Four separate defects, all measured rather than eyeballed:
 *
 *   1. Export dialog — `minWidth: 480` inside a 390 px window put both sides and the ×
 *      off-screen; Escape was the only close.
 *   2. Engrave panel stock grid — each `1fr` column was floored at its content's
 *      min-content width (label + input + source tag), so the second column hung past
 *      the panel's right edge and the tags were cut to "compu". (#686 deleted the grid:
 *      the stock is one line now, and this spec measures that line, the file bar and the
 *      margins line inside Technical — the panel's widest surviving content.)
 *   3. Context-panel drawer handle — fixed to the window's right edge at mid-height,
 *      painted over the content column: the margin chip, stock prose, card borders.
 *   4. The compact ⋯ menu stayed open when one of its commands was chosen, over the
 *      Manage rail and behind the Export backdrop.
 *
 * The assertions read the same geometry the browser paints (bounding boxes, scroll
 * widths, computed padding, `aria-expanded`) so a layout that merely looks close does
 * not pass.
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load the committed badge template — the walkthrough's route to a real stock grid. */
async function loadBadgeTemplate(page: Page): Promise<void> {
  await page.getByTestId('welcome-template-badge-blank').click();
  await page.getByTestId('welcome-overlay').waitFor({ state: 'detached', timeout: 30_000 });
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
}

/**
 * Bring the left rail in (phone drawer) or leave it (tablet column), put away an open
 * context drawer first — it covers the sidebar's handle on a phone — then pick a section.
 */
async function openSection(page: Page, id: string): Promise<void> {
  const panel = page.getByTestId('context-panel');
  if (((await panel.getAttribute('class')) ?? '').includes('context-panel--open')) {
    await page.getByTestId('context-panel-handle').click();
    await expect(panel).toHaveClass(/context-panel--closed/);
  }
  const side = page.getByTestId('sidebar');
  if (((await side.boundingBox())?.x ?? 0) < 0) {
    await page.getByTestId('sidebar-handle').click();
    await expect.poll(async () => (await side.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  }
  await page.getByTestId(`sidebar-button-${id}`).click();
  await expect(page.getByTestId(`context-section-${id}`)).toBeVisible();
}

test('#503 — the Export dialog fits a phone, and its × is reachable', async ({ cm, page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await cm.ready();
  await loadBadgeTemplate(page);

  // The real route: the Export section's own button.
  await openSection(page, 'export');
  await page.getByTestId('export-open').click();
  await expect(page.getByTestId('export-modal-close')).toBeVisible();

  const g = await page.evaluate(() => {
    const modal = document.querySelector('.export-modal') as HTMLElement;
    const close = document.querySelector('[data-testid="export-modal-close"]') as HTMLElement;
    const r = modal.getBoundingClientRect();
    const c = close.getBoundingClientRect();
    const past = [...modal.querySelectorAll('*')]
      .map((el) => ({ el, b: el.getBoundingClientRect() }))
      .filter(({ b }) => b.width > 1 && b.height > 1 && b.right - r.right > 1)
      .slice(0, 6)
      .map(({ el, b }) => `${el.tagName.toLowerCase()}.${String(el.className)} +${(b.right - r.right).toFixed(1)}px`);
    return {
      win: { w: window.innerWidth, h: window.innerHeight },
      modal: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width },
      close: { x: c.x, y: c.y, right: c.right, bottom: c.bottom, width: c.width },
      scroll: { w: modal.scrollWidth, cw: modal.clientWidth },
      rows: [...modal.querySelectorAll('[data-testid^="export-row-"]')].map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.getAttribute('data-testid'), left: b.left, right: b.right };
      }),
      past,
    };
  });

  // The dialog itself is on the screen, both sides, and no row or control spills out.
  expect(g.modal.x, 'dialog left edge').toBeGreaterThanOrEqual(0);
  expect(g.modal.right, 'dialog right edge').toBeLessThanOrEqual(g.win.w + 0.5);
  expect(g.modal.y, 'dialog top edge').toBeGreaterThanOrEqual(0);
  expect(g.modal.bottom, 'dialog bottom edge').toBeLessThanOrEqual(g.win.h + 0.5);
  expect(g.scroll.w - g.scroll.cw, 'the dialog scrolls sideways').toBeLessThanOrEqual(1);
  expect(g.past, 'content past the dialog’s right edge').toEqual([]);
  expect(g.rows.length, 'the badge template exports rows').toBeGreaterThan(0);
  for (const row of g.rows) {
    expect(row.right, `${row.id} right edge`).toBeLessThanOrEqual(g.modal.right + 0.5);
  }

  // The × is not just present: it is inside the viewport, inside the dialog, and clickable
  // (Playwright's actionability check refuses a covered control).
  expect(g.close.x, '× left edge').toBeGreaterThanOrEqual(0);
  expect(g.close.right, '× right edge').toBeLessThanOrEqual(g.win.w + 0.5);
  expect(g.close.y, '× top edge').toBeGreaterThanOrEqual(0);
  expect(g.close.bottom, '× bottom edge').toBeLessThanOrEqual(g.win.h + 0.5);
  expect(g.close.right).toBeLessThanOrEqual(g.modal.right + 0.5);
  await page.getByTestId('export-modal-close').click();
  await expect(page.locator('.export-modal')).toHaveCount(0);

  // The compact ⋯ route, which is also defect 4 on a phone: Export must open the dialog
  // AND put the menu away (it used to sit visibly behind the translucent backdrop).
  await page.getByTestId('toolbar-overflow-toggle').click();
  await expect(page.getByTestId('toolbar-overflow-panel')).toBeVisible();
  await page.getByTestId('export-default').click();
  await expect(page.getByTestId('export-modal-close')).toBeVisible();
  await expect(page.getByTestId('toolbar-overflow-panel')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-overflow-toggle')).toHaveAttribute('aria-expanded', 'false');

  // A captured claim needs an eye: save the phone dialog for review.
  await page.screenshot({ path: 'test-results/503-phone-export-modal.png' });
});

/**
 * The engrave panel's widest lines and the drawer handle, measured at both narrow widths.
 *
 * The panel is a drawer at tablet and phone alike, and the handle is fixed over its right
 * edge. #686 removed the stock field grid this test was written against; the stock is one
 * line now, so that line, the one file bar and the margins line inside Technical are what
 * stand in for it. The rule asserted for every line is the one the issue asks for: nothing
 * in the content column reaches into the handle's strip, and the panel itself never scrolls
 * sideways.
 */
test('#503 — engrave lines fit and the drawer handle covers nothing', async ({ cm, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await cm.ready();
  // #683/#686 — the badge's starter on the door is the one route that still seeds the badge blank
  // into the job: the wizard's step-2 card and the panel's own button are both gone. Closing the
  // wizard leaves the stock line printing the badge's 38.1 × 76.2 × 3.81 mm (turned a quarter turn
  // for the vise, #383) — the widest stock line the panel can hold, and the content that used to
  // push column two out.
  await page.getByTestId('welcome-starter-badge-blank').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  // The starter lands the app on the engrave section itself (`chooseJob` sets it), so the rail
  // entry must not be pressed again: on this rail a second press on the active section toggles it
  // off. What the phone layout may still have shut is the context drawer, and its own handle is
  // the way in (#355).
  const ctx = page.getByTestId('context-panel');
  if (!(((await ctx.getAttribute('class')) ?? '').includes('context-panel--open'))) {
    await page.getByTestId('context-panel-handle').click();
  }
  await expect(ctx).toHaveClass(/context-panel--open/);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
  await expect(page.getByTestId('engrave-stock-line')).toContainText('38.1 × 76.2 × 3.81');

  // The margins line is inside Technical now (#686). Open the fold before measuring so the
  // line is laid out, rather than a closed `<details>`'s zero-height box.
  await page.getByTestId('engrave-cutter-technical').locator('summary').click();
  await expect(page.getByTestId('engrave-margins-value')).toBeVisible();

  for (const viewport of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByTestId('context-panel')).toHaveClass(/context-panel--drawer/);

    // Bring the stock line into view; the panel is the scroll container.
    await page.getByTestId('engrave-stock-line').evaluate((el) => el.scrollIntoView({ block: 'center' }));

    const m = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="context-panel"]') as HTMLElement;
      const handle = document.querySelector('[data-testid="context-panel-handle"]') as HTMLElement;
      const pr = panel.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      // The file bar's three visible pieces (the menu itself is closed, so nothing to measure
      // there), and the stock's one line plus its edit.
      const ids = [
        'engrave-job-file-name',
        'engrave-job-saved-time',
        'engrave-file-menu-toggle',
        'engrave-stock-line',
        'engrave-stock-edit',
      ];
      const boxes = ids.flatMap((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        if (el === null) return [];
        const b = el.getBoundingClientRect();
        return [
          {
            id,
            left: b.left,
            right: b.right,
            width: b.width,
            clipped: el instanceof HTMLInputElement || el instanceof HTMLSelectElement
              ? el.scrollWidth > el.clientWidth + 1
              : false,
          },
        ];
      });
      return {
        panel: {
          left: pr.left,
          right: pr.right,
          scrollW: panel.scrollWidth,
          clientW: panel.clientWidth,
          padRight: parseFloat(getComputedStyle(panel).paddingRight),
        },
        handle: { left: hr.left, width: hr.width },
        boxes,
      };
    });

    // The drawer reserves the handle's own width: the content column ends left of the tab.
    expect(m.handle.width, `${viewport.name}: handle has a width`).toBeGreaterThan(0);
    expect(m.panel.padRight, `${viewport.name}: the drawer reserves the handle`).toBeGreaterThanOrEqual(
      m.handle.width,
    );
    expect(m.panel.scrollW - m.panel.clientW, `${viewport.name}: the panel scrolls sideways`).toBeLessThanOrEqual(0);

    // Every line and its control is inside the panel and clear of the handle.
    expect(m.boxes.length, `${viewport.name}: file bar and stock line found`).toBeGreaterThanOrEqual(5);
    for (const b of m.boxes) {
      expect(b.width, `${viewport.name}: ${b.id} has no width`).toBeGreaterThan(0);
      expect(b.left, `${viewport.name}: ${b.id} left edge`).toBeGreaterThanOrEqual(m.panel.left - 0.5);
      expect(b.right, `${viewport.name}: ${b.id} reaches under the handle`).toBeLessThanOrEqual(
        m.handle.left + 0.5,
      );
      expect(b.clipped, `${viewport.name}: ${b.id} clips its value`).toBe(false);
    }
    await page.screenshot({ path: `test-results/503-${viewport.name}-engrave-stock-line.png` });

    // The reported Cutting rows: feed/plunge values were the ones the handle cut to "500 mm/mi".
    for (const key of ['feed', 'plunge']) {
      const row = page.getByTestId(`engrave-feeds-${key}`);
      await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const geom = await row.evaluate((el) => {
        const rowBox = el.getBoundingClientRect();
        const value = el.querySelector('b')!.getBoundingClientRect();
        const handle = document.querySelector('[data-testid="context-panel-handle"]')!.getBoundingClientRect();
        return {
          text: el.textContent ?? '',
          rowRight: rowBox.right,
          valueRight: value.right,
          valueLeft: value.left,
          handleLeft: handle.left,
        };
      });
      expect(geom.text, `${viewport.name}: ${key} row shows mm/min`).toContain('mm/min');
      expect(geom.valueLeft, `${viewport.name}: ${key} value has room`).toBeGreaterThan(0);
      expect(geom.rowRight, `${viewport.name}: ${key} row under the handle`).toBeLessThanOrEqual(
        geom.handleLeft + 0.5,
      );
      expect(geom.valueRight, `${viewport.name}: ${key} value under the handle`).toBeLessThanOrEqual(
        geom.handleLeft + 0.5,
      );
    }
    await page.screenshot({ path: `test-results/503-${viewport.name}-engrave-cutting.png` });

    // The concrete line the issue names — the margin row, which used to sit at mid-height under
    // the tab. #686 folds it into Technical as one line, so that is what is measured.
    const marginLine = page.getByTestId('engrave-margins-value');
    await marginLine.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const marginGeom = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="engrave-margins-value"]')!.getBoundingClientRect();
      const h = document.querySelector('[data-testid="context-panel-handle"]')!.getBoundingClientRect();
      return { lineRight: c.right, lineTop: c.top, lineBottom: c.bottom, handleLeft: h.left, handleTop: h.top, handleBottom: h.bottom };
    });
    expect(marginGeom.lineRight, `${viewport.name}: margins line reaches under the handle`).toBeLessThanOrEqual(
      marginGeom.handleLeft + 0.5,
    );
    // The line has to clear the handle at EVERY scroll the drawer has, not only at the one it
    // happens to be painted at. (Before #686 the panel was long enough to scroll the line into the
    // handle's band; with the shorter panel the drawer scrolls 67 px at tablet width at most, so the
    // band check could not be met and proved nothing either way.)
    for (const where of ['top', 'bottom'] as const) {
      const gap = await page.evaluate((w) => {
        const panel = document.querySelector('[data-testid="context-panel"]') as HTMLElement;
        panel.scrollTop = w === 'top' ? 0 : panel.scrollHeight;
        const line = document.querySelector('[data-testid="engrave-margins-value"]')!.getBoundingClientRect();
        const handle = document.querySelector('[data-testid="context-panel-handle"]')!.getBoundingClientRect();
        return line.right - handle.left;
      }, where);
      expect(gap, `${viewport.name}: margins line reaches under the handle (${where})`).toBeLessThanOrEqual(0.5);
    }

    await page.screenshot({ path: `test-results/503-${viewport.name}-engrave-margins.png` });
  }
});

/**
 * Defect 4 in the place the report saw it: tablet ⋯ → Manage left the menu open over the
 * right rail; ⋯ → Export left it visibly behind the backdrop.
 */
test('#503 — a compact toolbar command dismisses the ⋯ menu', async ({ cm, page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await cm.ready();
  await loadBadgeTemplate(page);

  const toggle = page.getByTestId('toolbar-overflow-toggle');
  const panel = page.getByTestId('toolbar-overflow-panel');

  // Manage: the menu must be gone before/while the house surface is up.
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.getByTestId('manage-open').click();
  await expect(page.getByTestId('manage-mode')).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.__caseMaker!.closeManage());

  // Export: the menu used to show through the translucent backdrop.
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.getByTestId('export-default').click();
  await expect(page.getByTestId('export-modal-close')).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: 'test-results/503-tablet-export-modal.png' });
  await page.getByTestId('export-modal-close').click();

  // Docs: another command whose surface used to open under a menu that stayed up.
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.getByTestId('docs-open').click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
