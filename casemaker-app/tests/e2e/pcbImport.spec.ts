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
// and gives it copper's cap.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures/caseMaker';

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
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The shipped job still holds the demo lines; the board is a whole job and replaces them.
  const before = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(before).toContain('CASE');

  await page.getByTestId('engrave-pcb-input').setInputFiles([
    path.join(FIXTURES, 'tiny-F_Cu.gbr'),
    path.join(FIXTURES, 'tiny-Edge_Cuts.gbr'),
    path.join(FIXTURES, 'tiny.drl'),
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

  // The picture: fit the blank in the viewport and open the item rows, so the shot shows the
  // board's items as well as the panel's account of them.
  await page.getByTestId('viewport-fit').click();
  await page.getByTestId('engrave-item-expand-all').click();
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'board-imported.png') });
});
