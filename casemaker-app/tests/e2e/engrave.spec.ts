// #206 end to end, in a real browser: the default job goes from a fresh page load to a saved
// `.nc` with four ticks, and editing the job after a Generate blocks Save until it is regenerated.
//
// The run itself (generate → verify → simulate → oracle) is exercised for real — the worker, the
// sweep and the oracle all run. Assertions read the panel's own words and the downloaded bytes,
// never pixel colours.

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load a board (which shows the sidebar) and open the Engrave panel on the deterministic job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

// The sweep and the oracle run in the worker; under swiftshader a full run takes tens of seconds,
// so these get well past Playwright's 30 s default.
test.setTimeout(240_000);

test('the default job generates, verifies, simulates and saves a .nc', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();

  // The four rows tick, one by one, as the pipeline advances.
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-verified')).toHaveAttribute('data-state', 'tick');
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.stage).toBe('done');
  expect(state.oracleOk).toBe(true);
  expect(state.verifyErrors).toBe(0);
  expect(state.canSave).toBe(false); // the acknowledgement is still required

  // Tick the clearance box, then Save.
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-save')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('engrave-save').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.nc$/);

  const path = await download.path();
  expect(path).not.toBeNull();
  const nc = readFileSync(path!, 'utf8');
  expect(nc.startsWith(';@MKR|BEGIN')).toBe(true);
  expect(nc.trimEnd().endsWith('M02')).toBe(true);
});

test('editing the job after Generate makes the result stale and blocks Save', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-save')).toBeEnabled();

  // Change a label's depth: the run no longer describes the job on screen.
  const depth = page.getByTestId('engrave-label-depth-0');
  await depth.fill('1.8');
  await depth.blur();

  await expect(page.getByTestId('engrave-save')).toBeDisabled();
  await expect(page.getByTestId('engrave-save-blocked')).toContainText('the job changed since it was generated');
});

test("the saved .nc, reloaded as a stranger's file, removes the same volume", async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // The in-app run's own simulation: what Generate loaded and swept.
  const inApp = await page.evaluate(() => window.__caseMaker!.getSimState());
  expect(inApp.status).toBe('ready');
  expect(inApp.errorCodes).toEqual([]);
  expect(inApp.removedVolume).toBeGreaterThan(0);

  // Save the exact bytes, then open them in "Simulate .nc" as though they came from someone else.
  await page.getByTestId('engrave-ack').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('engrave-save').click();
  const path = await (await downloadPromise).path();
  expect(path).not.toBeNull();
  const nc = readFileSync(path!, 'utf8');

  await page.evaluate((text) => window.__caseMaker!.simOpenText('stranger.nc', text), nc);
  await page.evaluate(() => window.__caseMaker!.simRun());

  const reloaded = await page.evaluate(() => window.__caseMaker!.getSimState());
  expect(reloaded.status).toBe('ready');
  expect(reloaded.errorCodes).toEqual([]);
  // Same bytes, same header-declared stock and tool ⇒ the same removed volume.
  expect(reloaded.removedVolume).toBeCloseTo(inApp.removedVolume, 3);
});

// #260 — the drill half of #220 is reachable from the panel, not only by hand-editing a job:
// a hole added in the Add menu is cut as an operation of its own beside the three labels.
test('a hole added in the panel is cut as its own operation', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-drill').click();
  await expect(page.getByTestId('engrave-drill-row-0')).toBeVisible();
  // The hole is exactly the cutter's — the row says so rather than offering a diameter.
  await expect(page.getByTestId('engrave-drill-row-0')).toContainText('the cutter’s diameter');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.stage).toBe('done');
  expect(state.verifyErrors).toBe(0);
  expect(state.operations).toBe(4); // three labels + the one hole
});

// #207's mount: "Run sheet" opens the printable operator sheet for a generated, verified job.
// The sheet is a DOCUMENT — it names the file Save writes, and under print media the app's
// chrome (the sheet's own toolbar included) is hidden so only the sheet reaches the paper.
test('the run sheet opens for a verified job, names the saved file, and prints without chrome', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  // Nothing generated yet: the sheet is not offered.
  await expect(page.getByTestId('engrave-run-sheet')).toBeDisabled();

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-run-sheet')).toBeEnabled();

  // The name Save writes…
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('engrave-save').click();
  const suggested = (await downloadPromise).suggestedFilename();
  expect(suggested).toMatch(/\.nc$/);

  // …is the name the sheet prints.
  await page.getByTestId('engrave-run-sheet').click();
  const sheet = page.getByTestId('run-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(suggested);

  // #244 — §6 names the generated frame file instead of telling the operator to raise Z by hand.
  await expect(sheet).toContainText('-frame.nc');
  await expect(sheet).not.toContainText('Raise the work Z');

  // The print preview shows the sheet and hides the app chrome (the sheet's own toolbar too).
  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('run-sheet-print')).toBeHidden();
  await expect(page.getByTestId('sidebar-button-cnc-engrave')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByTestId('sidebar-button-cnc-engrave')).toBeVisible();
});
