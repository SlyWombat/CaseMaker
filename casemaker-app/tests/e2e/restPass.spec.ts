// #667 end to end, in a real browser — the rest pair is an operator choice now, not a hand-edited
// job file: a region row's "Finish the corners with a smaller cutter" pairs the rough cutter with
// a smaller flat one, and Generate posts TWO programs, the second cut from what the first LEFT.
//
// The rest measurement is the real one: the worker simulates program 1, measures each region's
// leftover at its floor, and writes program 2 from that. The dev/web build ships the two built-in
// flat cutters, so the pair is the 3.175 mm flat and the 1 mm flat.

import { test, expect, openCutterGroup } from './fixtures/caseMaker';

/** #792 — Save .nc… / Run sheet… / Open run record… are File ▾ items now; open the menu first. */
async function menuItem(page: import('@playwright/test').Page, testid: string) {
  const item = page.getByTestId(testid);
  if (!(await item.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  await expect(item).toBeVisible();
  return item;
}

test.setTimeout(240_000);

test('#667 — a region row pairs a rough and a rest cutter, and the run is two programs', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // A clean region job: the shipped job's three demo labels out, one rectangle pocket in.
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }
  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-rect').click();
  await expect(page.getByTestId('engrave-shape-row-0')).toBeVisible();

  // The rough cutter: the bigger built-in flat. It is Makera's METAL bit, and on the softwood
  // blank that pair is a blocking metal-line refusal until the operator says use it anyway — the
  // panel's own acknowledgement, exactly as a person answers it.
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-3.175x12-metal');
  const findings = page.getByTestId('engrave-findings');
  await expect(page.getByTestId('metal-line-use-anyway')).toHaveCount(1, { timeout: 60_000 });
  if ((await findings.getAttribute('open')) === null) {
    await findings.locator('summary').click();
  }
  await page.getByTestId('metal-line-use-anyway').click();
  await page.getByTestId('metal-line-confirm').click();
  await expect(page.getByTestId('metal-line-override-active')).toBeVisible();

  // The rest pair, from the row's own disclosure. A newly added row arrives OPEN, so the chevron
  // is only pressed when the body is not on screen — pressing it on an open row would close it.
  if ((await page.getByTestId('engrave-shape-rest-0').count()) === 0) {
    await page.getByTestId('engrave-shape-expand-0').click();
  }
  await expect(page.getByTestId('engrave-shape-rest-0')).toBeVisible();
  await page.getByTestId('engrave-shape-rest-0').locator('summary').click();
  await expect(page.getByTestId('engrave-shape-rest-note-0')).toContainText(
    'measured from the first program’s simulated stock',
  );
  await page.getByTestId('engrave-shape-rest-select-0').selectOption('flat-1.0');
  await expect(page.getByTestId('engrave-shape-rest-chip-0')).toHaveText('rest ⌀1 mm');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // TWO programs: the rough file and the measured rest file.
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.programs).toBe(2);

  // The run sheet names the pair, both files and the cutter change between them.
  await (await menuItem(page, 'engrave-run-sheet')).click();
  const sheet = page.getByTestId('run-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('TWO programs');
  await expect(sheet).toContainText('flat-3.175x12-metal');
  await expect(sheet).toContainText('flat-1.0');
});
