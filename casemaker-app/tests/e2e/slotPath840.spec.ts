// #840 — A SLOT ALONG AN IMPORTED PATH, end to end in a real browser. An SVG's stroke-only open
// S-curve imports as a line row (#664); typing a slot width wider than the cutter turns it into a
// region the pocket clears. The row states the region and its passes, Generate runs the whole
// pipeline (CAM, verify, sim, oracle); the preview's depth legend names the slot's floor. Screenshots are
// committed under `docs/bench/img/2026-10-31-slot-path/`.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { test, expect, openCutterGroup } from './fixtures/caseMaker';

test.setTimeout(240_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-slot-path');

/** An S-curve 40 mm wide, drawn as a stroke only — an open path, so it imports as a line. */
const S_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
  '<path d="M0 10 C 10 -6, 10 -6, 20 10 S 30 26, 40 10" fill="none" stroke="black" stroke-width="0.5"/></svg>';

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

test('#840 — an imported path with a slot width wider than the cutter is pocketed as a slot', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // A clean job: the shipped job's three demo labels out.
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }

  // The 3.175 mm built-in flat first: a 3 mm slot is NOT wider than it.
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-3.175x12-metal');

  // The imported path: the app's own import (the e2e build answers with the plain file input).
  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-import-outline').click();
  await (await chooser).setFiles({ name: 's-curve.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(S_SVG) });
  await expect(page.getByTestId('engrave-import-dialog')).toBeVisible();
  await page.getByTestId('engrave-import-accept').click();
  const row = page.getByTestId('engrave-trace-row-0');
  await expect(row).toBeVisible();
  if ((await page.getByTestId('engrave-trace-slot-width-0').count()) === 0) {
    await page.getByTestId('engrave-trace-expand-0').click();
  }

  // Not wider than the cutter: it stays a trace, the row says so, and it offers the owned flat
  // that would cut the slot (inform, don't refuse).
  await page.getByTestId('engrave-trace-depth-0').fill('1.5');
  await page.getByTestId('engrave-trace-slot-width-0').fill('3');
  const note = page.getByTestId('engrave-trace-slot-note-0');
  await expect(note).toContainText('is not narrower than the 3 mm slot, so the line is traced one cutter wide (3.175 mm)');
  await expect(note).toContainText('1 mm flat end would cut it 3 mm wide');
  await expect(page.getByTestId('engrave-trace-type-0')).toHaveText('Engrave');
  fs.mkdirSync(OUT, { recursive: true });
  await note.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await note.screenshot({ path: path.join(OUT, 'slot-offer.png') });
  await page.getByTestId('engrave-trace-slot-use-0').click();

  // With the 1 mm flat it is a slot. The row names it a pocket and states the region and the
  // passes, with units.
  await expect(note).toContainText('A 3 mm slot along');
  await expect(note).toContainText('grows 1.5 mm to each side with round ends');
  await expect(note).toContainText('pocketed by the ⌀1 mm cutter in');
  await expect(note).toContainText('mm step-over');
  await expect(page.getByTestId('engrave-trace-type-0')).toHaveText('Pocket');
  // The preview's depth legend names the region's floor: the slot is cut at its own depth.
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-legend-1.5')).toHaveText(/1\.5 mm/, { timeout: 60_000 });
  // The row on its own (the sticky Generate footer covers its last line in a page shot), then
  // the preview from the top, framed on the blank, with the legend.
  fs.mkdirSync(OUT, { recursive: true });
  await note.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await row.boundingBox();
  const noteBox = await note.boundingBox();
  if (box === null || noteBox === null) throw new Error('the slot row is not laid out');
  const top = Math.max(0, box.y);
  await page.screenshot({
    path: path.join(OUT, 'slot-row.png'),
    clip: { x: box.x, y: top, width: box.width, height: noteBox.y + noteBox.height + 4 - top },
  });
  await page.getByTestId('viewport-camera-top').click();
  await page.getByTestId('viewport-fit').click();
  for (let i = 0; i < 2; i++) await page.getByTestId('viewport-zoom-in').click();
  await page.waitForTimeout(600);
  await shoot(page, 'slot-preview-legend.png');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-verified')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.oracleOk).toBe(true);

  // The program is a pocket named for the slot, not a trace.
  const nc = await page.evaluate(() => window.__caseMaker!.engraveProgramText());
  expect(nc).toContain('Slot 3 mm along line');
  expect(nc).not.toContain('Trace line');

  // The simulated cut: the S-shaped slot in the blank.
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);
  await shoot(page, 'slot-generated.png');
});
