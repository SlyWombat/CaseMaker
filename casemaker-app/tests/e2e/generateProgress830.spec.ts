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

  // #889 — the sweep got much faster (levels cost what they remove and merge into packed moves),
  // so at the block's own size the run reaches "Program ready" before the kill lands, and the kill
  // then hits an idle worker. The goal is scaled to 3× and put on a 0.1 mm grid: about 410 000
  // moves, still under both budgets (the tip-field cap and 640 MB), and the large mesh makes the
  // sweep's own checkpoints heavy enough that it is reliably still running when the kill fires.
  await page.getByTestId('engrave-target-scale-0').fill('300');
  await page.getByTestId('engrave-target-technical-0').click();
  await page.getByTestId('engrave-target-surface-gridPitchMm-0').fill('0.1');

  // Kill the worker the way the browser would (a wasm trap, an OOM kill) — NOT the app's Cancel —
  // and do it IN THE PAGE, gated on the sweep's own stage text plus one settle tick. The stage
  // word is painted just before the load call, and a kill that beat the call is swallowed (the
  // sweep then runs on a fresh worker). A Playwright round trip after the stage is the #830 union
  // flake at the other end: #889 made the sweep fast enough that the kill could land in the ORACLE
  // that follows it, where the rejection is not a `SimulationStopped`, and the panel showed the raw
  // sentence with no "The simulation stopped:" frame. In-page + 750 ms is inside the sweep — the
  // 410 000-move goal it is scaled to runs for seconds — and never in the oracle.
  const killed = page.evaluate(async () => {
    // A variable, so TypeScript does not try to resolve a dev-server URL at compile time.
    const moduleUrl = '/src/engine/jobs/simClient.ts';
    const client = (await import(/* @vite-ignore */ moduleUrl)) as {
      killSimWorkerForTest: (message: string) => void;
    };
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('the sweep stage was never reported'));
      }, 120_000);
      const fire = (): void => {
        const text = document.querySelector('[data-testid="engrave-generate-progress"]')?.textContent ?? '';
        if (done || !/simulating program \d+ of \d+/i.test(text)) return;
        // The stage word is painted just before the load is CALLED, so killing on this very tick
        // can hit no pending call (the kill is then swallowed and the sweep runs on a fresh
        // worker). One settle tick lands inside the sweep — the 410 000-move goal runs for
        // seconds — and never in the oracle that follows it.
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        setTimeout(() => {
          client.killSimWorkerForTest('the simulation worker was killed by the test');
          resolve();
        }, 750);
      };
      const observer = new MutationObserver(fire);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      fire();
    });
  });

  await page.getByTestId('engrave-generate').click();
  const progress = page.getByTestId('engrave-generate-progress');
  await expect(progress).toBeVisible({ timeout: 120_000 });
  // The simulation's own stage: which program of the sweep, never a bare "Working…".
  await expect(progress).toContainText(/simulating program \d+ of \d+/i, { timeout: 120_000 });
  await killed;
  fs.mkdirSync(OUT, { recursive: true });

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
