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

test.setTimeout(600_000);
const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-10-31-241-faces');

interface RunSpan {
  a: number;
  from: number;
  to: number;
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

/** Door → the dowel starter → the wizard's step 4 on a rod in the chuck. */
async function toStep4(page: Page): Promise<void> {
  await page.getByTestId('welcome-starter-dowel').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · What are you cutting?');
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
  const run = s.runs.find((r) => Math.abs(r.a - a) < 1e-6);
  expect(run, `the program has a run at A ${a}°: ${JSON.stringify(s.runs)}`).toBeDefined();
  const at = Math.floor((run!.from + run!.to) / 2);
  await page.evaluate((step) => window.__caseMaker!.simSetStep(step), at);
  await page.waitForTimeout(400);
  return (await simState(page)).turningDeg;
}

test('a Flat turns the stock to its own angle and cuts a plane there', async ({ cm, page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await toStep4(page);

  await page.getByTestId('start-wizard-op-rotary-flat').click();
  await page.getByTestId('start-wizard-op-face-angle').fill('30');
  await page.getByTestId('start-wizard-op-face-depth').fill('1');
  await expect(page.getByTestId('start-wizard-create')).toBeEnabled();
  await page.getByTestId('start-wizard-create').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // The operation is a row of the job, in its own words.
  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Flat 1 mm deep at A 30°');
  await generateToTicks(page);

  const s = await simState(page);
  expect(s.status).toBe('ready');
  expect(s.runs).toHaveLength(1);
  expect(s.runs[0]!.a).toBeCloseTo(30, 6);
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
  await page.getByTestId('start-wizard-create').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('6 flats 17.32 mm across at A 0°');
  await generateToTicks(page);

  const s = await simState(page);
  expect(s.status).toBe('ready');
  expect(s.runs.map((r) => r.a)).toEqual([0, 60, 120, 180, 240, 300]);
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
  await page.getByTestId('start-wizard-create').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  await expect(page.getByTestId('engrave-face-summary-0')).toContainText('Cross-hole ⌀3.17 mm at A 90°');
  await generateToTicks(page);

  const s = await simState(page);
  expect(s.status).toBe('ready');
  expect(s.runs).toHaveLength(1);
  expect(s.runs[0]!.a).toBeCloseTo(90, 6);
  expect(await turnAt(page, 90)).toBeCloseTo(90, 3);

  await page.screenshot({ path: path.join(SHOTS, 'cross-hole-at-90.png') });
});
