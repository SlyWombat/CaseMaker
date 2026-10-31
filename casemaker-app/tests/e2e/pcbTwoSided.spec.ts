// #743 P-8 — A BOARD WITH COPPER ON BOTH FACES, through the panel's own door.
//
// The unit spec pins the planner, the two setups, the programs, the registration on the drilled
// holes and the per-face copper oracle. This is the DOOR in a real browser: the four files make a
// two-setup job, the panel says so in the operator's words, the Setups section carries the flip,
// and Generate posts and sweeps all five programs with the copper check passing on both faces.
//
// The library is seeded (a PCB bench): a 0.1 mm engraver, the two drill sizes the tiny board's
// holes are, and a 0.8 mm corn bit that reaches through the default plank.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures/caseMaker';

const FIXTURES = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'pcb');
const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-pcb-two-sided');

test('a two-layer Gerber set becomes a two-setup board that generates on both faces', async ({ cm, page }) => {
  test.setTimeout(420_000);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The PCB bench's library, as the e2e needs it: every role filled, each with a PCB row, so the
  // job arrives fully assigned. flutes are long enough for the door's default plank.
  await page.evaluate(() => {
    const tool = (
      key: string,
      id: string,
      name: string,
      shape: 'engraving' | 'flat' | 'drill',
      d: number,
      extra: Record<string, number> = {},
    ) => ({
      key,
      provenance: 'the e2e’s PCB bench',
      tool: {
        number: 1,
        id,
        name,
        typeText: shape === 'engraving' ? 'Engraving' : shape === 'drill' ? 'Drill' : 'Flat End',
        shape,
        handleDiameter: 3.175,
        tipDiameter: shape === 'engraving' ? 0.1 : d,
        diameter: d,
        cornerRadius: 0,
        angle: 0,
        halfAngle: 0,
        fluteLength: 20,
        shoulderLength: 20,
        stickout: null,
        centreCutting: null,
        ...extra,
      },
    });
    window.__caseMaker!.seedCutters(
      [
        tool('inv:e2e-engrave', 'e2e-engrave-0-1-60', 'PCB engraver 0.1 mm (e2e)', 'engraving', 3.175, {
          tipDiameter: 0.1,
          halfAngle: 30,
          angle: 60,
        }),
        tool('inv:e2e-d08', 'e2e-drill-0-8', 'PCB drill 0.8 mm (e2e)', 'drill', 0.8),
        tool('inv:e2e-d10', 'e2e-drill-1-0', 'PCB drill 1 mm (e2e)', 'drill', 1.0),
        tool('inv:e2e-corn', 'e2e-corn-0-8', 'PCB corn bit 0.8 mm (e2e)', 'flat', 0.8),
      ],
      [
        { cutterId: 'e2e-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
        { cutterId: 'e2e-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
        { cutterId: 'e2e-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
        { cutterId: 'e2e-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
      ],
    );
  });

  await page.getByTestId('engrave-pcb-input').setInputFiles([
    path.join(FIXTURES, 'tiny-F_Cu.gbr'),
    path.join(FIXTURES, 'tiny-B_Cu.gbr'),
    path.join(FIXTURES, 'tiny-Edge_Cuts.gbr'),
    path.join(FIXTURES, 'tiny-inside.drl'),
  ]);
  const message = page.getByTestId('engrave-pcb-message');
  await expect(message).toContainText(/Imported 4 files as the board/, { timeout: 120_000 });
  await expect(message).toContainText(/copper on both faces, two isolations/);
  await expect(message).toContainText(/setup 2 turns the board over/);
  // 2 + 2 copper/outline vectors, 2 isolations, 8 holes, 1 cut-out.
  await expect(message).toContainText(/15 items/);

  // A board on the shipped plank is STATED, with its one-click fix (the panel's Add menu).
  const notice = page.getByTestId('engrave-pcb-stock-notice');
  await expect(notice).toContainText(/a circuit board is cut from copper-clad PCB/);
  const menu = page.getByTestId('engrave-add-menu');
  if (!(await menu.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-add-summary').click();
  }
  await page.getByTestId('engrave-pcb-use-stock').click();
  await expect(notice).toHaveCount(0);

  // Both faces' items are in the document, and both setups are the operator's.
  const panel = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(panel).toContain('Isolate the top copper');
  expect(panel).toContain('Isolate the bottom copper');
  expect(panel).toContain('Cut out the board');
  // The Setups list lives in the Hold group, closed by default.
  const hold = page.getByTestId('engrave-group-hold');
  if (!(await hold.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-group-hold-summary').click();
  }
  await expect(page.getByTestId('engrave-setup-2')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-face-words-2')).toContainText(/bottom/i);
  // The row's body carries the flip as a derived remount to preview and approve.
  await page.getByTestId('engrave-setup-expand-2').click();
  await expect(page.getByTestId('engrave-setup-remount-2')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-remount-2')).toContainText(/Preview the remount/);
  // The board's own checks: the flip does not put the holes off the board, and every role has a
  // cutter, so nothing is refused or left unassigned.
  await expect(page.locator('[data-code="item-off-board"]')).toHaveCount(0);
  await expect(page.locator('[data-code="through-needs-board"]')).toHaveCount(0);
  await expect(page.locator('[data-code="setup-items-unassigned"]')).toHaveCount(0);
  // #743 P-8 — the board's holes are smaller than the probe reads: the import states the size it
  // needs (with the numbers) and its alignment-hole offer beside the board.
  await expect(page.getByTestId('engrave-pcb-alignment-notice')).toContainText(/needs holes of at least [\d.]+ mm/);
  await expect(page.getByTestId('engrave-pcb-alignment-notice')).toContainText(/the board's largest is 1 mm/);
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();

  // Generate: five programs, swept in cut order; the copper check reads each face in its own
  // setup's frame and passes on both.
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toContainText(/matches the design/, { timeout: 300_000 });
  await expect(page.getByTestId('engrave-run-verified')).toContainText(/checked/);
  await expect(page.getByTestId('engrave-run-simulated')).toContainText(/simulated/);

  await page.getByTestId('viewport-fit').click();
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'two-sided.png') });
});
