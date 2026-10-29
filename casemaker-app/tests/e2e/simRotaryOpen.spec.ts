// #761 — SIMULATE › OPEN .nc ON A ROD. The acceptance the issue asks for, driven through the
// panel's own door: the file chooser, the rod step, Simulate, the turning view and Unroll.
//
// Two files prove the door:
//   - docs/bench/2026-10-28-z1-real-jobs/jobs/j26-split-helix-A.nc (#753): a posted wrapped
//     helicoid, ⌀20 with the diameter prefilled from its own ;@CM|ROTARY record;
//   - reference-gcode/Rotation/NefertitiRough.nc: a vendor rotary file that states no radius, so
//     the form asks for the diameter (50 mm) and the column engine sweeps it.
// Both are optional on disk (#753 lands separately; the corpus is fetched, never committed), so the
// test SKIPS rather than failing on a checkout without them.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(600_000);
const ROOT = path.resolve(process.cwd(), '..');
const J26 = path.join(ROOT, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs', 'j26-split-helix-A.nc');
const VENDOR = path.join(process.cwd(), 'reference-gcode', 'Rotation', 'NefertitiRough.nc');
const OUT = path.join(process.cwd(), 'test-results', 'sim-rotary-open');

async function openInSimulate(page: Page, file: string): Promise<void> {
  // The welcome overlay owns a fresh app; the dowel starter puts the rod job behind it and takes
  // the wizard, so the sections are reachable (the file's own header decides the rod step).
  await page.getByTestId('welcome-starter-dowel').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('sim-open').click()]);
  await chooser.setFiles(file);
  await expect(page.getByTestId('sim-file-name')).toContainText(path.basename(file));
  await expect(page.getByTestId('sim-rotary-file')).toContainText('the stock is a rod in the rotary chuck');
}

async function simulateAndShoot(page: Page, stem: string): Promise<void> {
  await page.getByTestId('sim-simulate').click();
  await expect(page.getByTestId('sim-result')).toBeVisible({ timeout: 300_000 });
  // The session's own engine word: the column grid is what a wrapped program is swept on.
  await expect(page.getByTestId('sim-backend')).toContainText(/column/i);
  const max = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), Math.floor(max * 0.6));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${stem}-turning.png`) });

  await page.getByTestId('sim-view-unroll').click();
  await expect(page.getByTestId('sim-view-unroll')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewport-camera-top').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${stem}-unroll-mid.png`) });
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), max);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${stem}-unroll-end.png`) });
}

test('a posted helicoid opens as a rod and sweeps on the column engine (#753 file)', async ({ cm, page }) => {
  test.skip(!fs.existsSync(J26), 'docs/bench j26-split-helix-A.nc not present (lands with #753)');
  fs.mkdirSync(OUT, { recursive: true });
  await cm.ready();
  await openInSimulate(page, J26);

  // The file states the radius, so the diameter is prefilled; the Holding rule gives the stick-out.
  await expect(page.getByTestId('sim-stock-diameter')).toHaveValue('20');
  await expect(page.getByTestId('sim-rod-holding')).toContainText('stick-out 85 mm');
  await expect(page.getByTestId('sim-rod-holding')).toContainText('tailstock in');
  await expect(page.getByTestId('sim-tool')).toHaveValue('flat-3.175x12-metal');
  await expect(page.getByTestId('sim-rod-required')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, 'j26-rod-step.png') });
  await simulateAndShoot(page, 'j26');
});

test('a vendor rotary file asks for its diameter and sweeps on the column engine', async ({ cm, page }) => {
  test.skip(!fs.existsSync(VENDOR), 'reference-gcode/Rotation/NefertitiRough.nc not present (corpus not fetched)');
  fs.mkdirSync(OUT, { recursive: true });
  await cm.ready();
  await openInSimulate(page, VENDOR);

  // The vendor file states no radius: the form asks, and 50 mm is the rod the proof uses.
  await expect(page.getByTestId('sim-stock-diameter')).toHaveValue('0');
  await expect(page.getByTestId('sim-rod-required')).toBeVisible();
  await expect(page.getByTestId('sim-simulate')).toBeDisabled();
  await page.getByTestId('sim-stock-diameter').fill('50');
  await page.getByTestId('sim-tool').selectOption('flat-3.175x12-metal');
  await expect(page.getByTestId('sim-rod-required')).toHaveCount(0);
  await expect(page.getByTestId('sim-rod-holding')).toContainText('stick-out 85 mm');
  await page.screenshot({ path: path.join(OUT, 'vendor-rod-step.png') });
  await simulateAndShoot(page, 'vendor');
});
