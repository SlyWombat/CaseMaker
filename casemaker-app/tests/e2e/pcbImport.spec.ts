// #743 P-4b — A CIRCUIT BOARD FROM GERBER FILES, through the panel's own door.
//
// The unit specs pin the planner, the glue, the store and the CLI; this is the DOOR in a real
// browser: the hidden file input takes the tiny board's copper, outline and drill files, the
// store's one `apply` turns them into items, the shipped demo lines make way, and the board is
// drawn on the blank. A real screenshot is committed under
// `docs/bench/img/2026-10-31-pcb-import/`.
//
// The stock is the default plank, not PCB, so the review's sentence and its one-click fix are
// exercised too: the import PROCEEDS, states the fact, and "Use PCB stock" restates the material
// and gives it copper's cap. #743 P-6 also pins the board's OWN holding (taped to the bed, so the
// through cuts are not blocked) and its own legend words once the stock is PCB.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect, enterCnc } from './fixtures/caseMaker';

const FIXTURES = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'pcb');
const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-pcb-import');

test('a Gerber set becomes the job’s board, stated and drawn', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    // Load a board so the sidebar (and the CNC section) exists, then put the deterministic
    // demo job back: the import is what makes this job.
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();


  // The shipped job still holds the demo lines; the board is a whole job and replaces them.
  const before = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(before).toContain('CASE');

  // #743 P-6 — the bench library, as the e2e needs it: ONE ⌀1 mm flat with a PCB row (a PCB has no
  // starting-table row, so nothing on it generates without a catalogue), and deliberately NO
  // engraver — the isolation must then be stated as not cut while everything else posts.
  await page.evaluate(() => {
    window.__caseMaker!.seedCutters(
      [
        {
          key: 'inv:e2e-flat',
          provenance: 'the e2e’s bench',
          tool: {
            number: 1,
            id: 'e2e-flat-1-0',
            name: 'PCB flat 1 mm (e2e)',
            typeText: 'Flat End',
            shape: 'flat',
            handleDiameter: 3.175,
            tipDiameter: 1,
            diameter: 1,
            cornerRadius: 0,
            angle: 0,
            halfAngle: 0,
            // The e2e's blank is the 12 mm plank the door starts on: a cutter that must cut it out
            // has to state a reach that covers it (a stated 12 mm flute is short of 12.3 mm).
            fluteLength: 20,
            shoulderLength: 20,
            stickout: null,
            centreCutting: null,
          },
        },
      ],
      [{ cutterId: 'e2e-flat-1-0', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 }],
    );
  });


  await page.getByTestId('engrave-pcb-input').setInputFiles([
    path.join(FIXTURES, 'tiny-F_Cu.gbr'),
    path.join(FIXTURES, 'tiny-Edge_Cuts.gbr'),
    path.join(FIXTURES, 'tiny-inside.drl'),
  ]);

  const message = page.getByTestId('engrave-pcb-message');
  await expect(message).toContainText(/Imported 3 files as the board/, { timeout: 120_000 });
  // 2 construction vectors + the isolation frame + 8 holes + the cut-out.
  await expect(message).toContainText(/12 items/);
  await expect(message).toContainText(/copper, isolation, holes, outline and the board cut-out/);

  // A board on the default plank is STATED, never refused. The Add menu holds the entry and its
  // notice, so open it as the operator would before pressing the fix.
  const notice = page.getByTestId('engrave-pcb-stock-notice');
  await expect(notice).toContainText(/a circuit board is cut from copper-clad PCB/);
  const menu = page.getByTestId('engrave-add-menu');
  if (!(await menu.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-add-summary').click();
  }
  await page.getByTestId('engrave-pcb-use-stock').click();
  await expect(notice).toHaveCount(0);

  // The demo lines are gone; the board's items are the job's.
  const panel = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(panel).not.toContain('CASE');
  expect(panel).toContain('Isolate the copper');
  expect(panel).toContain('Cut out the board');

  // #743 P-6 — a board on a fresh document is TAPED TO THE BED at import, so the through cuts are
  // not blocked by the vise's under-board rule; and every hole of the coherent set is on the board.
  await expect(page.locator('[data-code="through-needs-board"]')).toHaveCount(0);
  await expect(page.locator('[data-code="item-off-board"]')).toHaveCount(0);

  // #743 P-6 — and once the stock is a copper-clad board, the colour legend says so in the stock's
  // own words: the copper's thickness and the FR-4 under it, never the laminate stand-ins.
  await expect(page.getByTestId('engrave-legend-top')).toContainText('copper 0.035 mm', { timeout: 120_000 });
  await expect(page.getByTestId('engrave-legend-bottom')).toContainText('FR-4 below');

  // #743 P-6 review — the bench library holds no engraving bit, so the isolation cannot be cut:
  // the fact is a WARNING in the operator's words (no internal ids), and Generate posts what it
  // can. (The full-library run posting all four programs is pinned in casemakerPcbJob.spec.)
  const unassigned = page.locator('[data-code="setup-items-unassigned"]');
  await expect(unassigned).toHaveCount(1);
  await expect(unassigned).toContainText('The isolation is not cut');
  await expect(unassigned).toContainText('no engraving bit (a cone with a stated flute)');
  await expect(unassigned).toContainText('Manage › Tools');
  await expect(unassigned).not.toContainText('shp-');
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();

  // The picture: fit the blank in the viewport and open the item rows, so the shot shows the
  // board's items as well as the panel's account of them.
  await page.getByTestId('viewport-fit').click();
  await page.getByTestId('engrave-item-expand-all').click();
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'board-imported.png') });
});
