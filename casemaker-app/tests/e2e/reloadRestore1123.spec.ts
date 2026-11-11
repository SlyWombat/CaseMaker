// #1123 items 10 and 11, in a real browser — the operator's Ctrl+Shift+R must not cost the job or
// a 12-minute Generate.
//
// Item 10: a job open in the CNC workspace comes back on the Job panel, not the door.
// Item 11: a generated run (programs, checks, simulation verdicts) is in durable storage keyed by
// (job sha, build, shop signature); the reload restores it, so Generate reads Cut… without a press.
import { test, expect, openCutterGroup, enterCnc } from './fixtures/caseMaker';

test.setTimeout(300_000);

async function openCncWithJob(cm: { ready(): Promise<void> }, page: import('@playwright/test').Page) {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  // Choose the built-in flat first: the bench jobs name their cutter, and an empty toolKey makes
  // the panel run the measured pick, whose job write lands during Generate (a stale run by design).
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
}

test('#1123 item 10 — a reload returns to the CNC job, not the door', async ({ cm, page }) => {
  await openCncWithJob(cm, page);
  // The job autosave and the workspace record are written on the same store changes.
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('welcome-start-cnc')).toHaveCount(0);
});

test('#1123 item 11 — a generated run survives the reload', async ({ cm, page }) => {
  await openCncWithJob(cm, page);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-rows')).toContainText('simulated');
  await expect(page.getByTestId('engrave-run-stale')).toHaveCount(0);
  // The run record's IndexedDB write lands just after the run settles.
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 30_000 });
  // Restored, not regenerated: the checklist ticks are back and the primary press is Cut…
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 30_000 });
  await expect(page.getByTestId('engrave-run-rows')).toContainText('simulated');
  await expect(page.getByTestId('engrave-run-stale')).toHaveCount(0);
  await expect(page.getByTestId('engrave-generate')).toHaveText('Cut…', { timeout: 30_000 });
});
