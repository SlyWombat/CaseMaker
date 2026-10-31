// #723 P2-3 / #754 — THE ONE-JOB, TWO-SIDE ACCEPTANCE WALK, in a real browser.
//
// The unit acceptance (tests/unit/flipMouldShell.acceptance.spec.ts) proves the generator, the
// pins' datum and the app's carry transform on the closed form. This walk proves the SHIPPED ROUTE:
// a two-side .cutjob.json is opened through File ▾ → Open job… (there is no test API to load a
// job), Generate posts one job as TWO programs, and the app's own run walk sweeps side 2 ON THE
// STOCK SIDE 1 LEFT — the carried field crosses the worker and seeds the column engine.
//
// THE PART IS THE REAL MOUSE SHELL (#754, "real resolution"): the fixture builds it from the demo
// job's 1.2 MB, 18,432-triangle STL; the inside goal is that same mesh lowered by the 2.5 mm wall.
// The wall time from Generate to a swept two-program run is REPORTED (console + test annotation).

import { writeFileSync } from 'node:fs';

import { test, expect } from './fixtures/caseMaker';
import { routeHouse, twoSideJob } from './fixtures/twoSideMouseShell';

test.setTimeout(1_200_000);

test('#754/#723 — a two-side mouse shell opens, generates two programs, and side 2 sweeps the carried stock', async ({
  cm,
  page,
}, testInfo) => {
  // A real house service is not running in this web build; answer it as the app's own schemas read
  // it, with the demo long ball on the bench (#744's spec does the same for its facing cutter).
  await routeHouse(page);

  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const jobPath = testInfo.outputPath('mouse-shell-two-sides.cutjob.json');
  writeFileSync(jobPath, JSON.stringify(twoSideJob()));

  // File ▾ → Open job… — the shipped route, not a test API.
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened mouse-shell-two-sides.cutjob.json.');
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('mouse-shell-two-sides');

  // The document is the SIDES form: setup 1's goal is the outside, setup 2's the inside mold.
  // The sides list lives in the folded Hold group (#799); the chosen cutter is above the fold.
  await expect(page.getByTestId('engrave-cutter-line')).toContainText(/ball/);
  await expect(page.getByTestId('engrave-cutter-line')).toContainText('chosen by you');
  const hold = page.getByTestId('engrave-group-hold');
  if ((await hold.getAttribute('open')) === null) await page.getByTestId('engrave-group-hold-summary').click();
  await expect(page.getByTestId('engrave-setups')).toBeVisible();
  await expect(page.getByTestId('engrave-side-goal-0')).toContainText('mouse-shell.stl');
  await expect(page.getByTestId('engrave-side-goal-1')).toContainText('mouse-shell-inside.stl');

  // GENERATE — one job, two programs. The wall clock is the acceptance's own number.
  const started = Date.now();
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 1_100_000 });
  const wallSeconds = (Date.now() - started) / 1000;
  testInfo.annotations.push({ type: 'wall-time', description: `${wallSeconds.toFixed(1)} s` });
  console.log(`#754 walk: ${wallSeconds.toFixed(1)} s from Generate to a swept two-program run`);

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.programs).toBe(2);
  expect(state.simStatus).toBe('ready');
  expect(state.stage).toBe('done');

  // SIDE 2'S CARRIED SWEEP, as the app states it: both programs were checked in cut order on the
  // stock the earlier one left, and NOTHING was re-swept from the blank. The Simulate panel reads
  // the run store's own per-program summaries; its Technical fold holds the sentence that would
  // name a from-blank program if the carry had declined.
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  const checked = page.getByTestId('sim-job-checked');
  await expect(checked).toContainText('all 2 programs');
  await expect(checked).toContainText('program 2');
  await expect(checked).not.toContainText('Swept from the blank');
  const technical = page.getByTestId('sim-job-technical');
  if ((await technical.count()) > 0) {
    if ((await technical.getAttribute('open')) === null) await technical.locator('summary').click();
    await expect(page.getByTestId('sim-job-coverage')).toBeVisible();
    await expect(page.getByTestId('sim-job-coverage')).not.toContainText('Swept from the blank');
  }
});
