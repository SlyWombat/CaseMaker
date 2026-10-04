// #199 — the simulation end to end in a real browser, on files WE authored. The vendor corpus
// (`reference-gcode/`) is fetched, never committed (#186), so a Playwright run has nothing to
// open; `three-strokes.nc` and its deliberate-gouge twin are ours.
//
// `tests/unit/simFixtures.spec.ts` pins the same numbers in-process through `createSimSession`;
// this drives those files through the worker, the store, the viewport and the transport. The
// fixture text is read with `fs` and passed into the page (the `asset-import.spec.ts` pattern).
//
// Assertions on the material go through `getSimState()` (deliverable 4), never pixel colours
// (#199 "Do not"). The one screenshot is of the viewport at the final step of the happy path.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** 472.097 mm³: `capsuleArea(40, 1.5875, segmentsForRadius(1.5875)) × (0.5 + 1 + 2)`. */
const EXPECTED_REMOVED_MM3 = 472.097;
const CLEAN = 'three-strokes.nc';
const GOUGE = 'three-strokes-gouge.nc';
/** The `TOOL_LIBRARY` key the file's 3.175 flat header tool matches (see `simSetupStore`). */
const HEADER_TOOL_KEY = 'flat-3.175x12-metal';

const readFixture = (testInfo: TestInfo, name: string): string =>
  readFileSync(join(dirname(testInfo.file), 'fixtures', name), 'utf8');

/**
 * Dismiss the welcome screen (a board load also makes the sidebar visible) and open the Simulate
 * panel, so its form mounts for the header-prefill assertions and the transport rides the viewport.
 */
async function openSimPanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
}

/** Open a fixture through the setup store and run it — the panel's own Simulate path. */
async function openAndRun(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(
    ({ n, t }) => window.__caseMaker!.simOpenText(n, t),
    { n: name, t: readFixture(testInfo, name) },
  );
  await page.evaluate(() => window.__caseMaker!.simRun());
}

const getSimState = (page: Page) => page.evaluate(() => window.__caseMaker!.getSimState());

test('happy path: the header prefills, and the run reports three clean checkpoints', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await openSimPanel(page);
  await page.evaluate(
    ({ n, t }) => window.__caseMaker!.simOpenText(n, t),
    { n: CLEAN, t: readFixture(testInfo, CLEAN) },
  );

  // The stock fields read 60 / 30 / 6, each tagged as coming from the file's header.
  await expect(page.getByTestId('sim-stock-length')).toHaveValue('60');
  await expect(page.getByTestId('sim-stock-width')).toHaveValue('30');
  await expect(page.getByTestId('sim-stock-thickness')).toHaveValue('6');
  await expect(page.getByText('from file header')).toHaveCount(3);
  // The header's 3.175 flat end mill preselects the matching library entry.
  await expect(page.getByTestId('sim-tool')).toHaveValue(HEADER_TOOL_KEY);

  await page.evaluate(() => window.__caseMaker!.simRun());

  const state = await getSimState(page);
  expect(state.status).toBe('ready');
  expect(state.count).toBe(3);
  expect(state.errorCodes).toEqual([]);
  expect(state.pathVertexCount).toBeGreaterThan(0);
});

test('scrub is monotone: the material rises three times, and step 0 is uncut (k === -1)', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await openSimPanel(page);
  await openAndRun(page, testInfo, CLEAN);

  // The scrubber's max is the last program step. Sweep every step: the checkpoint-derived k only
  // changes at a stroke, so `simSetStep` seeks a frame just three times.
  const lastStep = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));
  expect(lastStep).toBeGreaterThan(0);

  let previous = 0; // nothing is removed before the first cut
  let increases = 0;
  let finalVolume = 0;
  for (let step = 0; step <= lastStep; step++) {
    await page.evaluate((s) => window.__caseMaker!.simSetStep(s), step);
    const state = await getSimState(page);
    expect(state.step).toBe(step);
    if (state.removedVolume > previous) increases++;
    previous = state.removedVolume;
    finalVolume = Math.max(finalVolume, state.removedVolume);
  }
  // Three strokes, three checkpoints: the removed volume strictly increases exactly three times.
  expect(increases).toBe(3);
  // ... and matches the closed form at the end within 1%.
  expect(finalVolume).toBeGreaterThan(EXPECTED_REMOVED_MM3 * 0.99);
  expect(finalVolume).toBeLessThan(EXPECTED_REMOVED_MM3 * 1.01);

  // Back to the very start: no cut yet, so the shown checkpoint is the uncut k = -1.
  await page.evaluate(() => window.__caseMaker!.simSetStep(0));
  const atZero = await getSimState(page);
  expect(atZero.step).toBe(0);
  expect(atZero.k).toBe(-1);
  expect(atZero.removedVolume).toBe(0);
});

test('run to completion: ⏭ lands on the last step and the read-out shows the full time', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await openSimPanel(page);
  await openAndRun(page, testInfo, CLEAN);

  const lastStep = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));

  // Start it, then run it to completion with the transport's ⏭ (Run to completion) button.
  await page.getByTestId('sim-to-start').click();
  expect((await getSimState(page)).step).toBe(0);
  await page.getByTestId('sim-to-end').click();

  const state = await getSimState(page);
  expect(state.step).toBe(lastStep);

  // "m:ss / m:ss simulated" — at the end the position and the total are the same.
  const time = await page.getByTestId('sim-time').innerText();
  const halves = time.match(/^(\d+:\d{2}) \/ (\d+:\d{2}) simulated$/);
  expect(halves, `unexpected time read-out: ${time}`).not.toBeNull();
  expect(halves![1]).toBe(halves![2]);
});

test('the gouge is drawn, not cut: one error, one gouge, and the same removed volume', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await openSimPanel(page);
  await openAndRun(page, testInfo, GOUGE);

  const state = await getSimState(page);
  expect(state.status).toBe('ready');
  expect(state.errorCodes).toContain('rapid-through-stock');
  expect(state.gougeCount).toBe(1);
  // The rapid passed over uncut stock, so no material left — the clean file's total. The unit
  // spec pins this equality checkpoint-by-checkpoint; here the closed form is enough.
  expect(state.removedVolume).toBeGreaterThan(EXPECTED_REMOVED_MM3 * 0.99);
  expect(state.removedVolume).toBeLessThan(EXPECTED_REMOVED_MM3 * 1.01);
});

test('screenshot: the viewport at the final step, with the tool path visible', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await openSimPanel(page);
  await openAndRun(page, testInfo, CLEAN);

  // The path layer is on by default; assert it rather than trusting the image to say so.
  expect((await getSimState(page)).visibleLayers.path).toBe(true);

  // Deterministic: the load lands on the final step, `AutoFrame` has framed the sim stock, the
  // grid is hidden while a simulation owns the viewport, and e2e disables damping and forces dpr 1
  // (`Viewport.tsx`). Tolerance is the config's global `maxDiffPixelRatio` (0.005).
  await expect(page.locator('canvas').first()).toHaveScreenshot('simulation-final-step.png');
});
