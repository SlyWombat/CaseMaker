// #896 — switching panels during a goal simulation must not crash the tab.
//
// The maintainer's crash: Job → Simulate → Job during a goal simulation ended in "Aw, Snap" with
// Chrome reporting 1.2 GB while the window held 84 MB — the memory was in the workers. A panel
// that mounts while a run is in flight must only READ the run's state: its previews and the
// measured pick wait for the run, rather than starting a second heavy job beside the sweep.
//
// The fixture is the 20 × 20 × 6 mm chamfered block `surfaceGoal.spec.ts` and
// `generateProgress785.spec.ts` use, so the simulation is long enough to switch during it.
import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));

test.setTimeout(300_000);

test('#896 — Job ⇄ Simulate twice during a goal simulation, and the run survives', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // An empty job, so Surface a mesh is offered, with the built-in flat the other goal specs use.
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');

  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(STL);
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();

  await page.getByTestId('engrave-generate').click();
  // The simulation is the heavy phase: switch while the sweep is running.
  await expect(page.getByTestId('engrave-generate-progress')).toContainText(
    /simulating program|checking the result/i,
    { timeout: 240_000 },
  );

  for (let i = 0; i < 2; i++) {
    await page.getByTestId('sidebar-button-cnc-sim').click();
    await expect(page.getByTestId('sim-panel')).toBeVisible();
    await page.getByTestId('sidebar-button-cnc-engrave').click();
    await expect(page.getByTestId('engrave-panel')).toBeVisible();
  }

  // The page is still alive, and the run it was already running is still the run on screen.
  expect(await page.evaluate(() => 1)).toBe(1);
  expect(await page.evaluate(() => window.__caseMaker!.apiVersion)).toBe(1);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  // …and it finishes: the Generate press returns to its settled state (no "Working…").
  await expect(page.getByTestId('engrave-generate')).not.toHaveText('Working…', { timeout: 240_000 });
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
});
