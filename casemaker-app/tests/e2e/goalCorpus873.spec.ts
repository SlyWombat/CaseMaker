// #873 — THE GOAL CORPUS THROUGH THE APP: the figure (an underside, undercuts, a tail over the
// bed) and the relief (a flat back), each picked in the real start wizard, at desktop and at phone
// width. What the tier pins is the OPERATOR-VISIBLE end state:
//
//   1. the pick shows the chosen file — the name is on the row, not "No file chosen" (#870);
//   2. Generate runs and the run reaches a VERDICT: the oracle row matches the design, or the
//      goal's own sentence states what the top setup leaves unreached (#872);
//   3. no dead-end message: whatever the verdict, the panel says what it cut and what is left.

import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const FIGURE = fileURLToPath(new URL('../fixtures/goals/figure.stl', import.meta.url));
const RELIEF = fileURLToPath(new URL('../fixtures/goals/relief-plate.stl', import.meta.url));

test.setTimeout(600_000);

/**
 * Walk the wizard to a goal job: the question first — Surface a mesh, with the file picked — then a
 * made blank sized for the part, then the vise hold. The last step's button creates the goal, so
 * the panel opens on it. #897 — the work comes before the blank it sizes.
 */
async function wizardGoal(page: import('@playwright/test').Page, file: string, stock: { length: number; width: number; thickness: number }): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toContainText('Machine');
  await page.getByTestId('start-wizard-next').click(); // machine → the question

  // What: Surface a mesh, and the file. The pick is shown by name, never "No file chosen" (#870).
  await expect(page.getByTestId('start-wizard-progress')).toContainText('What are you cutting?');
  await page.getByTestId('engrave-setup-what-surface').click();
  const name = file.split(/[\\/]/).pop()!;
  await page.getByTestId('start-wizard-op-surface-file').setInputFiles(file);
  await expect(page.getByTestId('start-wizard-op-field')).toContainText(name);
  await page.getByTestId('start-wizard-operation-next').click(); // the question → stock

  // Stock: a made blank sized for the part.
  await expect(page.getByTestId('start-wizard-progress')).toContainText('Stock');
  await page.getByTestId('start-wizard-make-length').fill(String(stock.length));
  await page.getByTestId('start-wizard-make-width').fill(String(stock.width));
  await page.getByTestId('start-wizard-make-thickness').fill(String(stock.thickness));
  await page.getByTestId('start-wizard-stock-next').click(); // → holding

  // Holding: the vise (the shipped default) is the mount; the last step's button creates the job.
  await expect(page.getByTestId('start-wizard-progress')).toContainText('Holding');
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

/** Open a `<details>` fold only if it is closed — a blind summary click toggles it shut. */
async function openFold(page: import('@playwright/test').Page, testid: string): Promise<void> {
  const fold = page.getByTestId(testid);
  if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
}

/** Generate, wait for the run to PASS, and open the folds its verdict is written behind. */
async function generateAndRead(page: import('@playwright/test').Page): Promise<void> {
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
  await page.getByTestId('engrave-generate').click();

  // #794 — a run that passed collapses to ONE line, the Ready card, with the four ticks and the
  // verdict behind its fold. The card appearing IS the verdict: every tick passed on it.
  await expect(page.getByTestId('engrave-run-ready')).toBeVisible({ timeout: 550_000 });
  await openFold(page, 'engrave-run-ready');
  const oracle = page.getByTestId('engrave-run-oracle');
  await expect(oracle).toHaveAttribute('data-state', 'tick');
  await expect(oracle).toContainText('matches the design');

  // The goal's own sentence lives in the findings fold (#872).
  if ((await page.getByTestId('engrave-findings').count()) > 0) await openFold(page, 'engrave-findings');
}

/** The split, when the run states one: a warning with the shares, and the plan when it has one. */
async function readSplit(page: import('@playwright/test').Page): Promise<string | null> {
  if ((await page.getByTestId('engrave-findings').count()) > 0) await openFold(page, 'engrave-findings');
  const rows = page.getByTestId(/^engrave-finding-\d+-goal-unreached$/);
  if ((await rows.count()) === 0) return null;
  return rows.first().innerText();
}

test.describe('the goal corpus, desktop', () => {
  test.beforeEach(async ({ cm, page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await cm.ready();
  });

  test('the figure: picked in the wizard, generated, and the panel states what the top leaves', async ({ page }) => {
    await wizardGoal(page, FIGURE, { length: 120, width: 80, thickness: 40 });
    await generateAndRead(page);
    const split = await readSplit(page);
    expect(split).not.toBeNull();
    expect(split!).toMatch(/The top setup reproduces \d/);
    expect(split!).toMatch(/faces away from the tool/);
  });

  test('the relief: picked in the wizard, generated, and no flip is proposed', async ({ page }) => {
    await wizardGoal(page, RELIEF, { length: 80, width: 50, thickness: 20 });
    await generateAndRead(page);
    const split = await readSplit(page);
    expect(split).not.toBeNull();
    expect(split!).toMatch(/flat face/);
    // No one-press offers a setup for a flat back.
    await expect(page.getByTestId('engrave-goal-add-flip')).toHaveCount(0);
  });
});

test.describe('the goal corpus, phone width', () => {
  test.beforeEach(async ({ cm, page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    await cm.ready();
  });

  test('the relief at 400 × 900: the same picker and the same sentence, nothing clipped away', async ({ page }) => {
    await wizardGoal(page, RELIEF, { length: 80, width: 50, thickness: 20 });
    await generateAndRead(page);
    const split = await readSplit(page);
    expect(split).not.toBeNull();
    expect(split!).toMatch(/The top setup reproduces \d/);
  });
});
