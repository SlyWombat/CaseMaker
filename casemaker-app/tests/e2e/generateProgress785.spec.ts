// #785 end to end, in a real browser — Generate says what it is doing, and Cancel stops it.
//
// The fixture is the same 20 × 20 × 6 mm chamfered block `surfaceGoal.spec.ts` uses, surfaced with
// the built-in 1 mm flat. Under swiftshader the surfacing run plus its column sweep lasts much
// longer than the assertion needs, which is what makes the Cancel deterministic: the progress line
// is visible while the worker is busy, and the press must return the panel to where it was.
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));

test.setTimeout(240_000);

test('#785 Generate shows its stage, and Cancel returns the panel to its pre-Generate state', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // An empty job, so Surface a mesh is offered (the shipped job starts with three demo labels).
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');

  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(STL);
  await expect(page.getByTestId('engrave-target-count')).toHaveText('1');

  await page.getByTestId('engrave-generate').click();

  // The stage is on screen while the run works: the goal CAM's own stages (sampling, roughing,
  // finishing, posting) and then the simulation. Any of them is a stage the run really reports.
  const progress = page.getByTestId('engrave-generate-progress');
  await expect(progress).toBeVisible({ timeout: 120_000 });
  await expect(progress).toContainText(
    /reading the job|sampling the goal|roughing level|finishing row|posting the program|done/i,
  );

  // Cancel terminates the worker and returns the panel to the phase it was in — the idle state the
  // page was in before the press — with the progress line gone and Generate available again.
  await page.getByTestId('engrave-generate-cancel').click();
  await expect(progress).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();
  await expect(page.getByTestId('engrave-generate')).toHaveText('Generate');
});
