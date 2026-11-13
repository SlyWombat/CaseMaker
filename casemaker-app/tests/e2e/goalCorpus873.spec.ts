// #873 — THE GOAL CORPUS THROUGH THE APP: the figure (an underside, undercuts, a tail over the
// bed) and the relief (a flat back), each picked in the real start wizard, at desktop and at phone
// width. What the tier pins is the OPERATOR-VISIBLE end state:
//
//   1. the pick shows the chosen file — the name is on the row, not "No file chosen" (#870);
//   2. Generate runs and the run reaches a VERDICT: the oracle row matches the design, or the
//      goal's own sentence states what the top setup leaves unreached (#872);
//   3. no dead-end message: whatever the verdict, the panel says what it cut and what is left.

import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup, openSomethingElse } from './fixtures/caseMaker';

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
  await expect(page.getByTestId('start-wizard-progress')).toContainText('What are you making?');
  await openSomethingElse(page);
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
  // #1180 — the fold's OWN summary is the first one: a nested `<details>` (the flip offer's “If you
  // add it:” under the findings) adds a second `<summary>`, and a bare locator matches both.
  if ((await fold.getAttribute('open')) === null) await fold.locator('summary').first().click();
}

/**
 * Generate, wait for the run's own verdict, and open the folds its words live behind.
 *
 * #794/#948 — A PASS COLLAPSES TO THE READY CARD; A GOAL THAT MISSES THE PASS LINE DOES NOT. Both
 * are truthful end states of this spec: the rows stay open and the oracle row crosses when the
 * goal check's top-surface coverage is under the shop's line (the figure today), and the Ready
 * card appears only when every tick passed (the relief). The card's presence is the pass; its
 * absence beside a crossed oracle is the goal check's own failure, not a dead end.
 */
/**
 * #1195 — THE FREEING CUT NEEDS A STATED FLUTE. The built-in `flat-1.0` states none, so a deep
 * profile is refused by name; the e2e shop holds the same ⌀1 flat with a stated 42 mm flute (the
 * figure's profile is 40.3 mm), which is what lets these goals plan.
 */
async function seedGoalShop(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.__caseMaker!.seedCutters([
      {
        key: 'inv:goal-flat-1',
        provenance: 'the e2e’s shop — #1195 states the flute so a corpus profile can be freed',
        tool: {
          number: 1,
          id: 'goal-flat-1-0',
          name: '1 mm flat end (e2e)',
          typeText: 'Flat End',
          shape: 'flat',
          handleDiameter: 3.175,
          tipDiameter: 1,
          diameter: 1,
          cornerRadius: 0,
          angle: 0,
          halfAngle: 0,
          fluteLength: 42,
          shoulderLength: 42,
          stickout: null,
          centreCutting: null,
        },
      },
    ], []);
  });
}

async function generateAndRead(page: import('@playwright/test').Page): Promise<'pass' | 'cross'> {
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('inv:goal-flat-1');
  await page.getByTestId('engrave-generate').click();

  const oracle = page.getByTestId('engrave-run-oracle');
  await expect(oracle).toHaveAttribute('data-state', /^(tick|cross)$/, { timeout: 550_000 });
  const verdict = (await oracle.getAttribute('data-state')) === 'tick' ? 'pass' : 'cross';
  if (verdict === 'pass') {
    // #1123 item 51 — the fixed row states Ready; the ticks are rows, not a fold.
    await expect(page.getByTestId('engrave-progress-words')).toContainText('Program ready');
    await expect(page.getByTestId('engrave-run-rows')).toContainText('matches the design');
    await expect(oracle).toHaveAttribute('data-state', 'tick');
    await expect(oracle).toContainText('matches the design');
  } else {
    await expect(page.getByTestId('engrave-progress-words')).not.toContainText('Program ready');
    await expect(oracle).toContainText('does not match the design');
  }

  // The goal's own sentence lives in the findings fold (#872).
  if ((await page.getByTestId('engrave-findings').count()) > 0) await openFold(page, 'engrave-findings');
  return verdict;
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
    await seedGoalShop(page);
  });

  test('the figure: picked in the wizard, generated, and the panel states what the top leaves', async ({ page }) => {
    await wizardGoal(page, FIGURE, { length: 120, width: 80, thickness: 40 });
    const verdict = await generateAndRead(page);
    const split = await readSplit(page);
    expect(split).not.toBeNull();
    expect(split!).toMatch(/The top setup reproduces \d/);
    expect(split!).toMatch(/faces away from this setup/);

    // #948 — THE GOAL CHECK'S OWN VERDICT, IN D'S WORDS. The figure's sweep does leave a cell cut
    // 0.023 mm below the goal (at 65, 43.7) — but since #964/#1003 that cell is UN-ADJUDICABLE (a
    // wall region: a cell closes where design of any facing stands above the level), so the JUDGED
    // reading is 0 mm cut-into and the run is a cross on its coverage (88.41 % against the 95 %
    // line), not on a cut-into sentence. The raw reading is still printed beside the judged one,
    // and this spec asserts both: the exclusions hide nothing.
    expect(verdict, 'the figure fails its pass line — a cross, not a ready program').toBe('cross');
    // The findings fold leaves the Design panel scrolled and the sticky footer covers the mode
    // tab's click point at this window; switch on the element itself — the Cut card is what this
    // asserts, not the pointer.
    await page.getByTestId('cnc-mode-cut').evaluate((el) => (el as HTMLElement).click());
    await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
    await expect(page.getByTestId('engrave-cut-goal')).toHaveAttribute('data-state', 'coverage');
    // Measured 2026-11-06 on 966-collapse (88.64 %), re-measured on land15 2026-11-09 at 88.41 %
    // after #1129's derived sampler floor refined the measured surface. The judge states the
    // coverage it measured against the pass line it judged (#948), never a 0 mm cut-into that never
    // happened; this spec pins the judge's own measured value, not a target.
    await expect(page.getByTestId('engrave-cut-goal')).toHaveText(
      // #1251's stamp edge rule: the pocket's wall pass runs at the plain radius again and a cell
      // within one posted step of the cutter's edge is judged by the goal's own height, so the
      // wall-adjacent band that used to read as standing stock now counts as covering the design
      // (88.41 → 88.74 %, D's reason line).
      'Covers 88.74 % of the design’s top surface (the pass line is 95 %)',
    );
    // #964 — the raw reading beside the judged one. Under #1251's stamp edge rule (the wall pass
    // back at the plain radius, and edge cells judged by the goal's own height) NO cell is cut into
    // at all: max 0 mm, with the judged cut-into still 0. Its history: a 10 mm wall column at
    // (44.8, 26.8) through 966-collapse, 0.953 mm at (45.3, 44.8) from the tray-top group (#1227 +
    // #1223), and 0 from #1251; measured 2026-11-13 at e43f5dc13. The pre-#1003 spec pinned
    // 0.023 mm at (65, 43.7).
    await expect(page.getByTestId('engrave-cut-goal-raw')).toHaveText(
      'raw, before exclusions: 0 % cut-into, max 0 mm',
    );
    await expect(page.getByTestId('engrave-cut-goal-coverage')).toHaveText(
      /^Top-surface coverage: [\d.]+ % \(the pass line is 95 %\)$/,
    );

    // #1035 item 12 (C's and D's re-checks, measured) — A GOAL RUN'S CUT PAGE RENDERS NO
    // ONE-SCREEN CONFIRM, so no press — on either verdict: the confirm needs a machine AND a
    // single-program run (#656), and a goal job posts rough + finish. This pin is the UI SHAPE
    // only (the failed-gate press itself is pinned in tests/unit/engraveCutConfirm.spec.tsx); the
    // failed gate's real statements here are the verdict and goal rows asserted above. The goal
    // check's own finding still reaches the Cut details fold — that is the second half of this
    // block, and it is what the re-pinned surfaceGoal can no longer read.
    await expect(page.getByTestId('engrave-cut-go')).toHaveCount(0);
    const cutDetails = page.getByTestId('engrave-cut-details');
    if (!(await cutDetails.evaluate((el) => (el as HTMLDetailsElement).open))) {
      // #1180 — the fold's OWN summary is the first one (a nested details can add a second).
      await cutDetails.locator('summary').first().click();
    }
    await expect(cutDetails).toContainText(/The top setup reproduces \d+ % of the goal's surface/);
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
    await seedGoalShop(page);
  });

  test('the relief at 400 × 900: the same picker and the same sentence, nothing clipped away', async ({ page }) => {
    await wizardGoal(page, RELIEF, { length: 80, width: 50, thickness: 20 });
    await generateAndRead(page);
    const split = await readSplit(page);
    expect(split).not.toBeNull();
    expect(split!).toMatch(/The top setup reproduces \d/);
  });
});
