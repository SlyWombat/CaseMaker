/**
 * #507 — Manage and Docs across the tablet band (641–900px, plus the laptop boundary at 1023).
 *
 * Found in the #500 visual walkthrough at 768 × 1024: Manage's `220px 1fr 360px` left the centre
 * column ~188px, so the no-service card was cut off and the machine printer list drew one
 * character per line. The fixed grids are a function of width, so the band edges are swept rather
 * than trusting a single 768 run — and 1024 is included to pin the width where the desktop layout
 * is supposed to still be in force.
 *
 * The shared probes in `fixtures/manageLayout.ts` are the same ones the phone spec uses.
 */

import { test, expect } from '../fixtures/caseMaker';
import {
  expectStacked,
  openDocs,
  openManage,
  readDocsLayout,
  readManageLayout,
  type ManageLayout,
} from '../fixtures/manageLayout';

const BAND = [641, 768, 900, 1023];

test('Manage stacks across the tablet band and returns to three columns at 1024 (#507)', async ({
  cm,
  page,
}) => {
  // The project starts at 768; pin it before opening so the compact toolbar is the one we use.
  await page.setViewportSize({ width: 768, height: 1024 });
  await cm.ready();
  await openManage(page);

  for (const width of BAND) {
    await page.setViewportSize({ width, height: 1024 });
    const l: ManageLayout = await readManageLayout(page);
    expectStacked(l);
    // The machine scope's printer value column was the one-character-per-line symptom. Check it
    // at the narrowest point in the band, not just at 768.
    if (width === 641) {
      await page.getByTestId('manage-scope-machines').click();
      const machines = await readManageLayout(page);
      expectStacked(machines);
      expect(machines.printerValueW, 'printer profiles value column at 641px').toBeGreaterThan(150);
    }
    if (width === 768) {
      await page.screenshot({ path: 'test-results/507-tablet-manage-768.png' });
    }
  }

  // 1024 is the first width where the three-column grid is still the right layout.
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.getByTestId('manage-scope-tools').click();
  const desktop = await readManageLayout(page);
  const cols = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-testid="manage-mode"]')!).gridTemplateColumns,
  );
  expect(cols.split(' '), 'three columns at 1024').toHaveLength(3);
  expect(desktop.rail!.y, 'rail and pane share a row').toBeCloseTo(desktop.main!.y, 0);
  expect(desktop.main!.x, 'pane starts after the rail').toBeGreaterThanOrEqual(
    desktop.rail!.right - 1,
  );
  expect(desktop.detail!.x, 'detail is the third column').toBeGreaterThanOrEqual(
    desktop.main!.right - 1,
  );
  expect(desktop.manageOverflowX, 'desktop manage fits').toBeLessThanOrEqual(0);
  expect(desktop.pageOverflowX, 'desktop page fits').toBeLessThanOrEqual(0);
});

test('Docs keeps a readable article column across the tablet band (#507)', async ({ cm, page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await cm.ready();
  await openDocs(page);

  // At 768 the original two-column dialog is not the problem the phone capture showed: the nav
  // stays beside the article and the article keeps a readable width.
  const tablet = await readDocsLayout(page);
  expect(tablet.nav!.right, 'nav is the left column').toBeLessThanOrEqual(tablet.content!.x + 1);
  expect(tablet.content!.w, 'article width at 768px').toBeGreaterThanOrEqual(450);
  expect(tablet.navRowCount, 'nav buttons are one vertical column (one x, many rows)').toBeGreaterThan(1);
  expect(tablet.pageOverflowX, 'page scrolls sideways').toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/507-tablet-docs-768.png' });

  // Down to the bottom of the band: 641 still has ~409px of article beside the 200px nav, so the
  // dialog does not need to stack until the phone breakpoint.
  await page.setViewportSize({ width: 641, height: 1024 });
  const edge = await readDocsLayout(page);
  expect(edge.content!.w, 'article width at 641px').toBeGreaterThanOrEqual(380);
  expect(edge.pageOverflowX, 'page scrolls sideways at 641px').toBeLessThanOrEqual(0);
});
