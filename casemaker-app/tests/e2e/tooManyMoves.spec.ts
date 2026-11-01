// #832/#888 — THE "TOO MANY MOVES" BUDGET IS A CHOICE, NOT A DEAD END.
//
// The maintainer saw a red blocker with a "▸ Fix" that did nothing. The budget is a limit, so it
// is drawn as INFORM, and every press is named by what it does: "Coarser detail (X mm)", "Thicker
// layers (Y mm step-down, rougher walls)", and — only when a two-band depth split actually fits —
// "Split into two setups". These drive the real panel against the chamfered-block goal, set the
// goal's grid and finishing fine enough to exceed the app's MEMORY budget (#889 — a roughing level
// costs what it removes, so it is the finish and the cell count that blow it), and press each
// action in its own test. The split press BUILDS the two setups (its bands read back through the
// test API) and its run is cancelled at once: a program at the budget edge is the one thing an e2e
// must not actually cut.
import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));
test.setTimeout(240_000);

/**
 * The empty job with the block as its goal and a grid and finish fine enough to exceed the app's
 * memory budget. `stepDown` writes the goal's own step-down; a fine step makes even half the depth
 * too big, which is the "no split possible" case.
 */
async function budgetBlocker(page: import('@playwright/test').Page, stepDown?: string): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }

  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');

  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(STL);
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();

  // The goal's own roughing: fine enough that the estimate is over the app's budget.
  await page.getByTestId('engrave-target-technical-0').click();
  await page.getByTestId('engrave-target-surface-gridPitchMm-0').fill('0.02');
  await page.getByTestId('engrave-target-surface-finishStepOverMm-0').fill('0.02');
  if (stepDown !== undefined) await page.getByTestId('engrave-target-surface-roughStepDownMm-0').fill(stepDown);

  await page.getByTestId('engrave-generate').click();

  // The inform line: ONE plain sentence, the named presses, and no bare "Fix". The numbers that
  // made the decision are under Technical.
  const line = page.getByTestId('engrave-run-errors');
  await expect(line).toBeVisible({ timeout: 180_000 });
  await expect(line).toContainText('This goal is too detailed to plan at 0.02 mm in one go');
  await expect(line).toContainText('Choose one:');
  await expect(line).not.toContainText('▸ Fix');
  await expect(page.getByTestId('engrave-run-refused')).toHaveText('Not generated: the goal is over the planning budget.');
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-budget-technical')).toContainText('12,000,000');
  await expect(page.getByTestId('engrave-generate-at-pitch')).toBeVisible();
  await expect(page.getByTestId('engrave-generate-at-stepdown')).toBeVisible();
  // SEVERITY_COLOR.warning (#e0c07a), not the error red (#f0b4ad).
  await expect(line).toHaveCSS('color', 'rgb(224, 192, 122)');
}

test('#832/#888 — the budget blocker names every press, and the pitch press changes the plan', async ({ cm, page }) => {
  await cm.ready();
  await budgetBlocker(page);
  const pitchText = (await page.getByTestId('engrave-generate-at-pitch').textContent()) ?? '';
  const pitchMm = Number(/\(([\d.]+) mm\)/.exec(pitchText)?.[1]);
  await page.getByTestId('engrave-generate-at-pitch').click();
  await expect(page.getByTestId('engrave-target-surface-gridPitchMm-0')).toHaveValue(String(pitchMm));
});

test('#832/#888 — the step-down press writes the number it states onto the goal', async ({ cm, page }) => {
  await cm.ready();
  await budgetBlocker(page);
  const stepText = (await page.getByTestId('engrave-generate-at-stepdown').textContent()) ?? '';
  const stepMm = Number(/\(([\d.]+) mm step-down/.exec(stepText)?.[1]);
  await page.getByTestId('engrave-generate-at-stepdown').click();
  await expect(page.getByTestId('engrave-target-surface-roughStepDownMm-0')).toHaveValue(String(stepMm));
});

test('#888 — the split press BUILDS two setups, each side with its own depth band', async ({ cm, page }) => {
  await cm.ready();
  // The step-down is PINNED: the split's numbers are the point, and the feeds row follows the
  // default blank's material (#879 moved it to hardwood, whose 0.3 mm step leaves no split).
  await budgetBlocker(page, '0.5');
  const press = page.getByTestId('engrave-split-goal');
  await expect(press).toBeVisible();
  await expect(press).toHaveText('Split into two setups');
  await press.click();

  // The press writes the job's setups before the run starts: two sides, one goal each, each with
  // half the 6 mm depth as its band.
  const setups = await page.evaluate(() => window.__caseMaker!.engraveSetups());
  expect(setups).toHaveLength(2);
  expect(setups.every((s) => s.goalId !== null)).toBe(true);
  for (const setup of setups) {
    expect(setup.bandMm ?? 0).toBeGreaterThan(2.5);
    expect(setup.bandMm ?? 0).toBeLessThan(3.5);
  }
  expect(setups[0]!.bandMm).toBeCloseTo(setups[1]!.bandMm ?? 0, 1);
  // The press also pressed Generate. The page closes with this test, taking the worker (and the
  // budget-edge program it would build) with it — a test never waits for that cut.
});

test('#888 — no split is offered when two bands would not fit the budget', async ({ cm, page }) => {
  await cm.ready();
  // A finer step-down doubles the levels: half the depth is still over the budget, so there is
  // no split to make and the press is not drawn.
  await budgetBlocker(page, '0.2');
  await expect(page.getByTestId('engrave-generate-at-pitch')).toBeVisible();
  await expect(page.getByTestId('engrave-split-goal')).toHaveCount(0);
});
