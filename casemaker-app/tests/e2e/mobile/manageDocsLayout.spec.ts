/**
 * #507 — Manage and Docs at phone width (390 × 844, the `mobile-chromium` project).
 *
 * Both surfaces kept their desktop grids at every width. Manage's `220px 1fr 360px` put 580px of
 * rails on a 390px screen, so the centre column was a few pixels wide: "Tools" clipped to "To",
 * the no-service card ran under the detail rail, and the machine printer list drew one character
 * per line. Docs kept `200px 1fr` inside a 95vw dialog, leaving the article ~114px.
 *
 * The viewport is the project's own (the issue's phone case), and the shared probes in
 * `fixtures/manageLayout.ts` measure the columns rather than comparing screenshots.
 */

import { test, expect } from '../fixtures/caseMaker';
import { expectStacked, openDocs, openManage, readDocsLayout, readManageLayout } from '../fixtures/manageLayout';

test('Manage stacks at phone width and every pane keeps a readable width (#507)', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await openManage(page);

  // Tools (no house service in the web build, which is the issue's own capture).
  expectStacked(await readManageLayout(page));
  await page.screenshot({ path: 'test-results/507-phone-manage-tools.png' });

  // Machines: the printer list was the clearest symptom — one character per line beside a 360px
  // rail. Its value column now has the pane's width, not a sliver.
  await page.getByTestId('manage-scope-machines').click();
  const machines = await readManageLayout(page);
  expectStacked(machines);
  expect(machines.printerValueW, 'printer profiles value column width').toBeGreaterThan(150);
  await page.screenshot({ path: 'test-results/507-phone-manage-machines.png' });

  // The detail rail is below the fold by design; scroll the surface to it and prove it moves —
  // "below the list" must mean the surface scrolls, not that the detail becomes a letterbox that
  // scrolls internally.
  const manage = page.getByTestId('manage-mode');
  const scrollTop = await manage.evaluate((el) => {
    el.scrollTo(0, el.scrollHeight);
    return el.scrollTop;
  });
  expect(scrollTop, 'the detail is reachable by scrolling the surface').toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/507-phone-manage-machines-detail.png' });

  // Materials, the third scope, obeys the same rule.
  await page.getByTestId('manage-scope-materials').click();
  expectStacked(await readManageLayout(page));
});

test('Docs puts its nav above the article at phone width (#507)', async ({ cm, page }) => {
  await cm.ready();
  await openDocs(page);
  const d = await readDocsLayout(page);

  expect(d.modal, 'docs dialog').not.toBeNull();
  expect(d.nav, 'docs nav').not.toBeNull();
  expect(d.content, 'docs article').not.toBeNull();

  // The nav is a strip ABOVE the article, not a 200px column beside it.
  expect(d.nav!.bottom, 'nav is above the article').toBeLessThanOrEqual(d.content!.y + 1);
  // The dialog is border-box: its two 1px borders are outside the body's grid.
  expect(d.nav!.w, 'nav spans the dialog').toBeGreaterThanOrEqual(d.modal!.w - 2.5);
  // The article gets essentially all of the dialog's width (only its own padding is spent).
  expect(d.content!.w, 'article width vs dialog width').toBeGreaterThanOrEqual(d.modal!.w * 0.95);
  expect(d.paragraphW, 'a paragraph’s reading width').toBeGreaterThan(250);
  // The titles wrap into rows above the article — every doc button is visible without a sideways
  // swipe, and the block stays shallow enough to leave the article the dialog's height.
  expect(d.navRowCount, 'nav wraps into rows').toBeGreaterThanOrEqual(1);
  expect(d.nav!.h, 'nav block height').toBeLessThan(d.modal!.h * 0.35);
  expect(d.navOverflowX, 'nav hides no button sideways').toBeLessThanOrEqual(0);
  expect(d.pageOverflowX, 'page scrolls sideways').toBeLessThanOrEqual(0);

  await page.screenshot({ path: 'test-results/507-phone-docs.png' });
});
