// #832 — THE "TOO MANY MOVES" BUDGET IS A CHOICE, NOT A DEAD END.
//
// The maintainer saw a red blocker with a "▸ Fix" that did nothing. The budget is a limit, so it
// is drawn as INFORM, and every press is named by its action: "Generate at X mm" (the pitch the
// refusal suggests), "Raise the step-down to Y mm" (the other number that fits the same budget),
// and "Open the setups to split it". These drive the real panel against the chamfered-block goal,
// set the grid fine enough to exceed the app's move budget, and press each action in its own
// test (each press starts a Generate, so one press per run keeps the assertion deterministic):
// the plan visibly changes — the goal's own setting — and there is no bare "Fix".
import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));
test.setTimeout(240_000);

/** The empty job with the block as its goal and a grid fine enough to exceed the move budget. */
async function budgetBlocker(page: import('@playwright/test').Page): Promise<void> {
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

  // The goal's own grid: fine enough that the move estimate is over the app's budget.
  await page.getByTestId('engrave-target-technical-0').click();
  await page.getByTestId('engrave-target-surface-gridPitchMm-0').fill('0.02');

  await page.getByTestId('engrave-generate').click();

  // The inform line: the budget sentence, the three named presses, and no bare "Fix".
  const line = page.getByTestId('engrave-run-errors');
  await expect(line).toBeVisible({ timeout: 180_000 });
  await expect(line).toContainText('A budget limit, not a fault');
  await expect(line).not.toContainText('▸ Fix');
  await expect(page.getByTestId('engrave-generate-at-pitch')).toBeVisible();
  await expect(page.getByTestId('engrave-generate-at-stepdown')).toBeVisible();
  await expect(page.getByTestId('engrave-open-setups-to-split')).toBeVisible();
  // SEVERITY_COLOR.warning (#e0c07a), not the error red (#f0b4ad).
  await expect(line).toHaveCSS('color', 'rgb(224, 192, 122)');
}

test('#832 — the budget blocker names every press, and the pitch press changes the plan', async ({ cm, page }) => {
  await cm.ready();
  await budgetBlocker(page);
  const pitchText = (await page.getByTestId('engrave-generate-at-pitch').textContent()) ?? '';
  const pitchMm = Number(/at ([\d.]+) mm/.exec(pitchText)?.[1]);
  await page.getByTestId('engrave-generate-at-pitch').click();
  await expect(page.getByTestId('engrave-target-surface-gridPitchMm-0')).toHaveValue(String(pitchMm));
});

test('#832 — the step-down press writes the number it states onto the goal', async ({ cm, page }) => {
  await cm.ready();
  await budgetBlocker(page);
  const stepText = (await page.getByTestId('engrave-generate-at-stepdown').textContent()) ?? '';
  const stepMm = Number(/to ([\d.]+) mm/.exec(stepText)?.[1]);
  await page.getByTestId('engrave-generate-at-stepdown').click();
  await expect(page.getByTestId('engrave-target-surface-roughStepDownMm-0')).toHaveValue(String(stepMm));
});

test('#832 — the split press opens the Holding step, where setups are made', async ({ cm, page }) => {
  await cm.ready();
  await budgetBlocker(page);
  await page.getByTestId('engrave-open-setups-to-split').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toContainText('Holding');
});
