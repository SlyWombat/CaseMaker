// #830 — THE RUN MUST NOT SIT ON "Working…" FOREVER.
//
// Generate's own stages are one half of the story; the SIMULATION is the other, and the progress
// line used to show a bare "Working…" for a whole multi-program sweep — the hang the maintainer saw
// before the tab crashed. This spec proves both: the sweep names its program and checkpoints, and a
// worker killed mid-sweep (not the app's Cancel) is reported with its own words and a Try again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));
const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-generate-progress');

test.setTimeout(240_000);

test('#830 — the sweep names its stage, and a worker killed mid-sweep is reported with a retry', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // An empty job, so Surface a mesh is offered, and the same fixture the #785 spec uses.
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
  const progress = page.getByTestId('engrave-generate-progress');
  await expect(progress).toBeVisible({ timeout: 120_000 });
  // The simulation's own stage: which program of the sweep, never a bare "Working…".
  await expect(progress).toContainText(/simulating program \d+ of \d+/i, { timeout: 120_000 });
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'simulating-stage.png') });

  // Kill the worker the way the browser would (a wasm trap, an OOM kill) — NOT the app's Cancel.
  await page.evaluate(async () => {
    // A variable, so TypeScript does not try to resolve a dev-server URL at compile time.
    const moduleUrl = '/src/engine/jobs/simClient.ts';
    const client = (await import(/* @vite-ignore */ moduleUrl)) as {
      killSimWorkerForTest: (message: string) => void;
    };
    client.killSimWorkerForTest('the simulation worker was killed by the test');
  });

  const error = page.getByTestId('engrave-generate-error');
  // #830 review — the worker's words sit inside the STOP frame, once, beside Generate.
  await expect(error).toContainText('The simulation stopped: the simulation worker was killed by the test', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('engrave-generate-retry')).toBeVisible();
  // The run is blocked with a reason, not still "Working".
  await expect(progress).toHaveCount(0);
  // A stop is not a failed check: the simulation row says it stopped before it finished, without
  // a cross. And the sentence is not repeated as a program finding or at the foot, nor given a Fix.
  const simulatedRow = page.getByTestId('engrave-run-simulated');
  await expect(simulatedRow).toContainText('the simulation stopped before it finished');
  await expect(simulatedRow).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('engrave-run-errors')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-error')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-blocker-fix')).toHaveCount(0);
  // …and the STOP sentence itself is on screen once, not mirrored anywhere else.
  await expect(page.getByText('The simulation stopped: the simulation worker was killed by the test.')).toHaveCount(1);
  await page.screenshot({ path: path.join(OUT, 'worker-stopped.png') });
});
