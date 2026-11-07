// #723 P2-3 / #754 — THE ONE-JOB, TWO-SIDE ACCEPTANCE WALK, in a real browser.
//
// The unit acceptance (tests/unit/flipMouldShell.acceptance.spec.ts) proves the generator, the
// pins' datum and the app's carry transform on the closed form. This walk proves the SHIPPED ROUTE:
// a two-side .cutjob.json is opened through File ▾ → Open job… (there is no test API to load a
// job), Generate posts the model engine's programs — one per cutter per setup: a rough and a
// finish on each side, FOUR in all (#1032) — and the app's own run walk sweeps side 2 ON THE
// STOCK SIDE 1 LEFT — the carried field crosses the worker and seeds the column engine.
//
// THE PART IS THE REAL MOUSE SHELL (#754, "real resolution"): the fixture builds it from the demo
// job's 1.2 MB, 18,432-triangle STL; the inside goal is that same mesh lowered by the 2.5 mm wall.
// The wall time from Generate to a swept two-program run is REPORTED (console + test annotation).

import { writeFileSync } from 'node:fs';

import { test, expect } from './fixtures/caseMaker';
import { attachEngraveRunDiagnostics } from './fixtures/runDiagnostics';
import { routeHouse, twoSideJob } from './fixtures/twoSideMouseShell';

test.setTimeout(1_200_000);

// A red on this walk must diagnose itself: on any failure, the run state, the findings, the four
// run rows and the flight-recorder crumbs are attached to the test (the helper no-ops on a pass).
test.afterEach(async ({ page }, testInfo) => {
  await attachEngraveRunDiagnostics(page, testInfo);
});

test('#754/#723 — a two-side mouse shell opens, posts the model engine’s four programs, and side 2 is swept on the carried stock', async ({
  cm,
  page,
}, testInfo) => {
  // A real house service is not running in this web build; answer it as the app's own schemas read
  // it, with the cutters the bench job held (#1041): the demo long ball as a `user:` record and the
  // ⌀3.175 O-flute the shell was roughed with as an `inv:` one. Both are owned, so the plan's
  // house is the shop's own records — never the registry's built-in tier.
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
  console.log(`#754 walk: ${wallSeconds.toFixed(1)} s from Generate to a swept four-program run`);

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  // #1041/#1042 — THE FIXTURE'S SHOP OWNS BOTH CUTTERS (the long ball as `user:`, the bench's
  // O-flute as `inv:`), so the plan's own words carry neither the built-in fallback note nor a
  // chosen-cutter-not-owned statement. One assertion, both facts: a fixture that silently fell
  // back to the built-ins would fail here, not only at the program count.
  expect(
    { fallbackNote: state.planNotes.join(' | ').includes('built-in registry stands in'), notOwned: state.planStatementCodes.includes('goal-cutter-not-owned') },
  ).toEqual({ fallbackNote: false, notOwned: false });
  // #1032 — the model engine posts one program per cutter: rough + finish on each of the two
  // setups. The walk asserts the engine's real shape (the resolver path is what it exercises).
  expect(state.programs).toBe(4);
  expect(state.simStatus).toBe('ready');
  expect(state.stage).toBe('done');

  // THE APP'S OWN STATEMENT OF WHERE EACH PROGRAM STARTED. All four are checked in cut order; the
  // sampled column engine cannot start from another program's removal mesh, so side 2's programs
  // (3 and 4) restart from the blank — with the earlier setup's carried floor still applied — and
  // the Technical fold NAMES them and the carry (#1032: the old two-program shape never met this,
  // and asserted the line's absence rather than its content).
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  const checked = page.getByTestId('sim-job-checked');
  await expect(checked).toContainText('all 4 programs');
  await expect(checked).toContainText('program 2');
  await expect(checked).not.toContainText('Swept from the blank');
  const technical = page.getByTestId('sim-job-technical');
  if ((await technical.count()) > 0) {
    if ((await technical.getAttribute('open')) === null) await technical.locator('summary').click();
    await expect(page.getByTestId('sim-job-coverage')).toBeVisible();
    const coverage = page.getByTestId('sim-job-coverage');
    // #1034/#1050 — EVERY PROGRAM NAMES ITS SEED AND ITS ROUTE. Side 1's finish is seeded by a
    // column field from side 1's rough; side 2's programs are seeded by the earlier programs'
    // REMOVAL meshes (the exact route), which has no field to label — the carrier says which.
    expect(
      state.simPrograms.map((p) => ({ fromBlank: p.fromBlank, carried: p.carriedFloor, seed: p.seedFrom, route: p.seedRoute })),
    ).toEqual([
      { fromBlank: false, carried: false, seed: null, route: null },
      { fromBlank: false, carried: false, seed: 'program 1 (⌀ 3.175 mm flat end · 25 mm flute)', route: 'field' },
      // Side 2, with the bench's O-flute: both programs START from the material the earlier setup
      // left (the carried floor AND the prior removal) — they no longer restart from the blank as
      // the ⌀1 built-in's engine made them. The exact route is named by the panel below.
      { fromBlank: false, carried: true, seed: null, route: 'removal' },
      { fromBlank: false, carried: true, seed: null, route: 'removal' },
    ]);
    await expect(coverage).toContainText(
      "program 2 (⌀ 2 mm ball · 30 mm flute) starts from program 1 (⌀ 3.175 mm flat end · 25 mm flute)'s removal",
    );
    // #1050 — the exact-route seeds are named too, not silence.
    await expect(coverage).toContainText(
      'program 3 (⌀ 3.175 mm flat end · 25 mm flute) starts from the material the earlier programs left — their removal, with the earlier setup',
    );
    await expect(coverage).toContainText(
      'program 4 (⌀ 2 mm ball · 30 mm flute) starts from the material the earlier programs left — their removal, with the earlier setup',
    );
    // The old shape restarted side 2's programs from the blank; with the shop's own flat the sweep
    // seeds them instead, so the panel claims no blank restart at all.
    await expect(coverage).not.toContainText('Restarted from the blank');
  }
});
