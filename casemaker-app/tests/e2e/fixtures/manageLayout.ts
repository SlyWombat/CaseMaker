/**
 * Layout probes for #507 — Manage and Docs at phone/tablet widths.
 *
 * The bug was not a clipped element but columns sharing out a width that could not hold their
 * minimum content, so the specs measure the columns themselves. Both the phone and tablet specs
 * use these helpers: the rule under test is the same at 390 and at 768, and it should not be
 * possible for the two suites to drift into asserting slightly different things.
 */

import { expect, type Page } from '@playwright/test';

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
}

export interface ManageLayout {
  vw: number;
  vh: number;
  rail: Region | null;
  main: Region | null;
  detail: Region | null;
  scopes: { id: string; x: number; y: number; w: number; right: number }[];
  h3: { w: number; text: string | null; clipped: boolean } | null;
  printerValueW: number;
  detailScrollH: number;
  manageOverflowX: number;
  pageOverflowX: number;
}

/** Open Manage from wherever the toolbar puts it at this width.
 *
 * Below 900px the toolbar is the compact bar (#134) and Manage lives behind ⋯; at laptop width it
 * is an inline button. The mode is entered through the real control in both cases — the tests are
 * about what a user sees, not about the store. */
export async function openManage(page: Page): Promise<void> {
  const direct = page.getByTestId('manage-open');
  if ((await direct.count()) === 0) {
    await page.getByTestId('toolbar-overflow-toggle').click();
    await page.getByTestId('manage-open').click();
    // #503 — choosing a command now dismisses the ⋯ panel. Before that fix the panel stayed open
    // over the surface and had to be toggled shut here; toggling unconditionally would now REOPEN
    // it, and its New button would intercept the scope click below. Close it only if it is still
    // there, so the measurement sees the surface either way.
    const panel = page.getByTestId('toolbar-overflow-panel');
    if ((await panel.count()) > 0) await page.getByTestId('toolbar-overflow-toggle').click();
  } else {
    await direct.click();
  }
  await expect(page.getByTestId('manage-mode')).toBeVisible();
  // The surface is text-heavy and the fonts are `font-display: swap`; measure after the swap.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export async function readManageLayout(page: Page): Promise<ManageLayout> {
  return page.evaluate(() => {
    const rect = (sel: string): Region | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const manage = document.querySelector('[data-testid="manage-mode"]') as HTMLElement;
    const h3 = document.querySelector('.manage .mhead h3') as HTMLElement | null;
    const printerValue = document.querySelector(
      '[data-testid="manage-printers"] .kv b',
    ) as HTMLElement | null;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      rail: rect('[data-testid="manage-rail"]'),
      main: rect('.manage .mmain'),
      detail: rect('.manage .context-panel'),
      scopes: [...document.querySelectorAll('[data-testid^="manage-scope-"]')].map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          id: el.getAttribute('data-testid') ?? '',
          x: r.x,
          y: r.y,
          w: r.width,
          right: r.right,
        };
      }),
      h3:
        h3 === null
          ? null
          : {
              w: h3.getBoundingClientRect().width,
              text: h3.textContent,
              clipped: h3.scrollWidth > h3.clientWidth + 1,
            },
      printerValueW: printerValue?.getBoundingClientRect().width ?? 0,
      detailScrollH: (document.querySelector('.manage .context-panel') as HTMLElement | null)
        ?.scrollHeight ?? 0,
      manageOverflowX: manage.scrollWidth - manage.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** The stacked rule (#507): rail on top, full-width pane, detail BELOW the list, nothing sideways. */
export function expectStacked(l: ManageLayout): void {
  expect(l.rail, 'manage rail').not.toBeNull();
  expect(l.main, 'manage main pane').not.toBeNull();
  expect(l.detail, 'manage detail rail').not.toBeNull();

  expect(l.rail!.y, 'rail is above the pane').toBeLessThan(l.main!.y);
  expect(l.rail!.bottom, 'rail does not overlap the pane').toBeLessThanOrEqual(l.main!.y + 1);

  // The pane owns the screen width — the whole point of dropping the fixed rails.
  expect(l.main!.x, 'pane left edge').toBeGreaterThanOrEqual(0);
  expect(l.main!.right, 'pane right edge').toBeLessThanOrEqual(l.vw + 0.5);
  expect(l.main!.w, 'pane width vs window').toBeGreaterThanOrEqual(l.vw - 1);

  // The detail is a row BELOW the list, at the same full width.
  expect(l.detail!.y, 'detail is below the list').toBeGreaterThanOrEqual(l.main!.bottom - 1);
  expect(l.detail!.w, 'detail width vs window').toBeGreaterThanOrEqual(l.vw - 1);
  // ... and the whole detail belongs to the surface's scroll, not to a letterbox of its own.
  expect(l.detailScrollH, 'detail is not internally clipped').toBeLessThanOrEqual(
    l.detail!.h + 1,
  );

  // No column may be narrower than a readable width, and nothing spills sideways.
  expect(l.manageOverflowX, 'manage scrolls sideways').toBeLessThanOrEqual(0);
  expect(l.pageOverflowX, 'page scrolls sideways').toBeLessThanOrEqual(0);

  // FOUR scope tabs (Tools, Materials, Machines, Jobs — Machines since #601) on ONE row, each a
  // real touch target, all on-screen: the row has to hold all four at the narrowest width.
  expect(l.scopes).toHaveLength(4);
  expect(new Set(l.scopes.map((s) => Math.round(s.y))).size, 'scope tabs share one row').toBe(1);
  for (const s of l.scopes) {
    expect(s.w, `${s.id} width`).toBeGreaterThanOrEqual(60);
    expect(s.right, `${s.id} right edge`).toBeLessThanOrEqual(l.vw + 0.5);
  }

  // The heading that used to clip to "To" has the pane's width.
  expect(l.h3, 'main heading').not.toBeNull();
  expect(l.h3!.w, 'heading width').toBeGreaterThan(40);
  expect(l.h3!.clipped, 'heading is clipped').toBe(false);
}

export interface DocsLayout {
  modal: Region | null;
  nav: Region | null;
  content: Region | null;
  paragraphW: number;
  navRowCount: number;
  navOverflowX: number;
  pageOverflowX: number;
}

export async function openDocs(page: Page): Promise<void> {
  const direct = page.getByTestId('docs-open');
  if ((await direct.count()) === 0) {
    await page.getByTestId('toolbar-overflow-toggle').click();
    await page.getByTestId('docs-open').click();
  } else {
    await direct.click();
  }
  await expect(page.getByTestId('docs-modal')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export async function readDocsLayout(page: Page): Promise<DocsLayout> {
  return page.evaluate(() => {
    const rect = (sel: string): Region | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const navButtons = [...document.querySelectorAll('.docs-modal-nav button')].map(
      (el) => (el as HTMLElement).getBoundingClientRect().y,
    );
    const paragraph = document.querySelector('.docs-modal-content p') as HTMLElement | null;
    const nav = document.querySelector('.docs-modal-nav') as HTMLElement | null;
    return {
      modal: rect('.docs-modal'),
      nav: rect('.docs-modal-nav'),
      content: rect('.docs-modal-content'),
      paragraphW: paragraph?.getBoundingClientRect().width ?? 0,
      navRowCount: new Set(navButtons.map((y) => Math.round(y))).size,
      navOverflowX: nav === null ? 0 : nav.scrollWidth - nav.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}
