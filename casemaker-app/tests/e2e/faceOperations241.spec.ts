// #241 slice 2 — THE 'ON A FACE' OPERATIONS, through the wizard's own door.
//
// Step 4 on a rod: Flat, Faces all round and Cross-hole are authorable, each carrying the index
// (A) it is cut at. Create makes the operation; Generate cuts it as ONE indexed program; the
// simulation turns the stock to the face being cut, and the scrubber keeps its step across the
// turn (the viewport turning is #241 slice 3's).
//
// Run (WSL, this checkout):
//   CASEMAKER_PORT=5403 npx playwright test tests/e2e/faceOperations241.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';
import { fakeRotaryHouse } from './fixtures/rotaryHouse';

test.setTimeout(600_000);
const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-10-31-241-faces');

interface RunSpan {
  a: number | null;
  firstStep: number;
  lastStep: number;
}
interface SimInfo {
  status: string;
  step: number;
  turningDeg: number;
  runs: RunSpan[];
}

const simState = (page: Page): Promise<SimInfo> =>
  page.evaluate(() => {
    const s = window.__caseMaker!.getSimState();
    return { status: s.status, step: s.step, turningDeg: s.turningDeg, runs: s.runs };
  });

/** Door → the dowel starter → the wizard's question on a rod in the chuck. */
async function toStep4(page: Page): Promise<void> {
  await page.getByTestId('welcome-starter-dowel').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  // #1107 — the starter ASKS ITS QUESTION: it lands on step 2 with the rotary picker and the text
  // field waiting (the rod stock and chuck are already seeded, so the blank and hold pass through).
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
}

/**
 * Make the face operation the question asked for: walk the blank (the job's own, passed through)
 * and the hold, then the last step's button — which is the create (#897).
 */
async function createOperation(page: Page): Promise<void> {
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-stock-next').click();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
}

/** Generate and wait for the four ticks: cut, verified, simulated, judged against the design. */
async function generateToTicks(page: Page): Promise<void> {
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  for (const id of ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  }
  await expect(page.getByTestId('engrave-run-oracle')).toContainText('matches the design');
}

/** The turning angle the viewport shows at a step inside the run whose A is `a`. */
async function turnAt(page: Page, a: number): Promise<number> {
  const s = await simState(page);
  const run = s.runs.find((r) => r.a !== null && Math.abs(r.a - a) < 1e-6);
  expect(run, `the program has a run at A ${a}°: ${JSON.stringify(s.runs)}`).toBeDefined();
  const at = Math.floor((run!.firstStep + run!.lastStep) / 2);
  await page.evaluate((step) => window.__caseMaker!.simSetStep(step), at);
  await page.waitForTimeout(600);
  const after = await simState(page);
  // The scrubber kept its step across the index turn, and the viewport turned to that face.
  expect(after.step).toBe(at);
  return after.turningDeg;
}

test('a Flat turns the stock to its own angle and cuts a plane there', async ({ cm, page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await toStep4(page);

  await page.getByTestId('start-wizard-op-rotary-flat').click();
  await page.getByTestId('start-wizard-op-face-angle').fill('30');
  await page.getByTestId('start-wizard-op-face-depth').fill('1');
  await expect(page.getByTestId('start-wizard-operation-next')).toBeEnabled();
  await createOperation(page);

  // The operation is a row of the job, in its own words.
  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Flat 1 mm deep at A 30°');
  await generateToTicks(page);

  let s = await simState(page);
  expect(s.status).toBe('ready');
  // A face is cut in several depth passes, so the sweep opens one checkpoint per pass — all at
  // the ONE angle the face was cut at.
  expect(s.runs.length).toBeGreaterThan(0);
  expect(s.runs.every((r) => r.a !== null && Math.abs(r.a - 30) < 1e-6)).toBe(true);
  expect(await turnAt(page, 30)).toBeCloseTo(30, 3);

  // #833 — A CUT ON THE FACE, from the face's own row: a pocket at the shipped size, cut in the
  // same program at the same index. Generate again and the face still matches the design.
  await page.getByTestId('engrave-face-summary-0').click();
  await page.getByTestId('engrave-face-add-pocket-0').click();
  await expect(page.locator('[data-testid^="engrave-face-item-0-"]')).toContainText('Pocket');
  await generateToTicks(page);
  s = await simState(page);
  expect(s.status).toBe('ready');
  expect(s.runs.every((r) => r.a !== null && Math.abs(r.a - 30) < 1e-6)).toBe(true);
  expect(await turnAt(page, 30)).toBeCloseTo(30, 3);

  await page.screenshot({ path: path.join(SHOTS, 'flat-at-30.png') });
});

test('Faces all round turns the stock at every index, one face each', async ({ cm, page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await toStep4(page);

  await page.getByTestId('start-wizard-op-rotary-faces-all-round').click();
  await expect(page.getByTestId('start-wizard-op-faces-count')).toHaveValue('6');
  await expect(page.getByTestId('start-wizard-op-faces-across')).toHaveValue('17.321');
  await createOperation(page);

  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('6 flats 17.32 mm across at A 0°');
  await generateToTicks(page);

  const s = await simState(page);
  expect(s.status).toBe('ready');
  // The stock turns to each face in turn; several passes at one index share that index.
  expect([...new Set(s.runs.map((r) => r.a))]).toEqual([0, 60, 120, 180, 240, 300]);
  // The stock is turned to the face each run cuts — 0° for the first, 120° for the third.
  expect(await turnAt(page, 0)).toBeCloseTo(0, 3);
  expect(await turnAt(page, 120)).toBeCloseTo(120, 3);
  expect(await turnAt(page, 300)).toBeCloseTo(300, 3);

  await page.screenshot({ path: path.join(SHOTS, 'hex-all-round.png') });
});

test('a Cross-hole is one plunge at its angle, turned to before it cuts', async ({ cm, page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await toStep4(page);

  await page.getByTestId('start-wizard-op-rotary-cross-hole').click();
  await page.getByTestId('start-wizard-op-face-angle').fill('90');
  await expect(page.getByTestId('start-wizard-op-hole-diameter')).toHaveValue('3.175');
  await createOperation(page);

  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Cross-hole ⌀3.17 mm at A 90°');
  await generateToTicks(page);

  const s = await simState(page);
  expect(s.status).toBe('ready');
  expect(s.runs.length).toBeGreaterThan(0);
  expect(s.runs.every((r) => r.a !== null && Math.abs(r.a - 90) < 1e-6)).toBe(true);
  expect(await turnAt(page, 90)).toBeCloseTo(90, 3);

  await page.screenshot({ path: path.join(SHOTS, 'cross-hole-at-90.png') });
});

// #849 — A MIXED JOB WITH A NECK FOR PARTING: an engraving on the map, a flat, and the neck. The
// run is three files — the map work, the face, then the neck alone — and a flat deep enough to
// cut into the neck's own section is refused by name.
test('a mixed job with a neck cuts the map work, the face, then the neck', async ({ cm, page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The neck is a field of the rotary chuck, which the Holding step offers on a machine carrying
  // the module.
  await fakeRotaryHouse(page);
  await cm.ready();
  await page.getByTestId('welcome-starter-dowel').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  // #1107 — the starter lands on the question; answer it, then walk the blank and the hold.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
  await page.getByTestId('start-wizard-op-text').fill('Zoomba');
  await expect(page.getByTestId('start-wizard-operation-next')).toBeEnabled();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-mount-rotary')).toBeChecked({ timeout: 30_000 });
  // The Holding step: leave the part on the default neck (chuck side, ⌀7 mm on the ⌀20 mm rod).
  await page.getByTestId('engrave-setup-rotary-neck').check();
  await expect(page.getByTestId('engrave-setup-rotary-neck-diameter')).toBeVisible();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // A flat on the stock's faces, from the panel's own add menu (A 0°, 1 mm deep).
  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-face-flat').click();
  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Flat 1 mm deep at A 0°');

  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  for (const id of ['engrave-run-toolpath', 'engrave-run-verified']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  }
  const run = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(run.ok, JSON.stringify(run)).toBe(true);
  // Items, the face, then the neck alone: three files (the unit spec pins their order and the
  // one-line statement of it).
  expect(run.programs).toBe(3);
  await page.screenshot({ path: path.join(SHOTS, 'mixed-neck-last.png') });

  // An 8 mm flat reaches below the neck's 6.5 mm floor across its span: refused by name.
  await page.getByTestId('engrave-face-summary-0').click();
  await page.getByTestId('engrave-face-depth-0').fill('8');
  await page.getByTestId('engrave-face-depth-0').press('Tab');
  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Flat 8 mm deep at A 0°');
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByText(/The flat at A 0° cuts into the neck for parting/).first()).toBeVisible({ timeout: 120_000 });
  const refused = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(refused.ok).toBe(false);
  expect(refused.programs).toBe(0);
});
