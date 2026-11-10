/**
 * #1180 S2 — A GENERATED RUN, ONCE.
 *
 * The e2e walk that reaches the run panel is long and expensive: load a board, remember a machine,
 * open Design, pick a cutter, Generate (four ticks — up to three minutes), open Cut, give the one
 * statement, open step 3, and prepare the run entry through the store seam an upload ends on
 * (`machineRunPrepare`). `runStates.spec.ts` and `pauseResume.spec.ts` each carried an identical
 * copy of it; this is the one copy.
 *
 * `generateOnce` is the same walk stopped at the green gate — for a spec that needs a generated
 * program (the ticks, the plan, the program list) but not a run entry. `prepareFakeRun` is the
 * full walk and asserts the run entry exists.
 *
 * The entry is PREPARED, not uploaded: a spec that installs the fake console (`fakeConsole.ts`)
 * wants the run states, and the upload's own file protocol is a different subject.
 */
import type { Page } from '@playwright/test';
import { expect, openCutterGroup } from './caseMaker';
import { rememberMachine } from './rememberMachine';

/** A status line with the monitor fields the state popover reads, for the machine observation. */
export const RUN_STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** The built-in board, a remembered machine, Design open, and Generate green. */
export async function generateOnce(page: Page, opts: { tool?: string } = {}): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page, RUN_STATUS);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  if (opts.tool !== undefined) {
    await openCutterGroup(page);
    await page.getByTestId('engrave-tool').selectOption(opts.tool);
  }
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
}

/**
 * The job both run specs share: a generated program, Cut open with its ONE statement given
 * (#797), and the machine's run entry prepared through the store seam an upload ends on.
 */
export async function prepareFakeRun(page: Page): Promise<void> {
  await generateOnce(page, { tool: 'flat-1.0' });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();

  // The statement is step 1's; open the step only if it arrives folded.
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  await page.getByTestId('engrave-ack').check();
  const step3 = page.getByTestId('engrave-cut-step-3');
  if (!(await step3.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-3-summary').click();
  }
  await expect(page.getByTestId('engrave-cut-confirm')).toBeVisible({ timeout: 30_000 });

  const prepared = await page.evaluate(() =>
    window.__caseMaker!.machineRunPrepare('192.0.2.10', 2222, 'job.nc', 'M03\nM05\n'),
  );
  expect(prepared, 'the machine run entry is prepared').toBe(true);
}
