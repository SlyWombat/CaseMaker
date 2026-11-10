// #1169 — THE MACHINE'S WAITING AND STOPPED CARDS, on the fake machine.
//
// The waiting card: the controller parks in its firmware `Tool` state mid-run; the card names the
// wait and Continue sends `M490.2` ONCE, and the card clears when the controller leaves `Tool`.
// The stopped card: the controller alarms; the card states the stop, gates the four choices until
// Unlock and home, and "End the job here" dismisses it without touching the record.
//
// The console is reached only in a DESKTOP bundle (`canReachMachine`), so this spec runs on the
// desktop-mode dev server Playwright starts beside the web one (see runStates.spec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { lanServerPort } from '../../scripts/e2ePort';
import type { Page } from '@playwright/test';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(300_000);

const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** The cards as the operator sees them, for the hand-in. */
const OUT = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-11-10-1169-recovery');

async function rememberMachine(page: Page): Promise<void> {
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      { name: 'QA Z1', host: '192.0.2.10', port: 2222, busy: false, ip: null, mac: null, status: line, profileId: 'Z1', observedAt: '2026-10-25T00:00:00.000Z', notes: [] },
      line,
    );
  }, STATUS);
}

/** The default job generated and Cut open with its statement given, as runStates does. */
async function prepareFakeRun(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
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
  const prepared = await page.evaluate(() => window.__caseMaker!.machineRunPrepare('192.0.2.10', 2222, 'job.nc', 'M03\nM05\n'));
  expect(prepared, 'the machine run entry is prepared').toBe(true);
}

/**
 * Seed the failed release record the stopped card reads. The run panel does not plan one, so the
 * record must still be COMPLETE: the Job panel reads `record.job` (its `blowWithVacuum`), and a
 * record with a hole in it takes the whole context panel down with an error boundary — the cards
 * with it.
 */
async function seedFailedRelease(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const m = await import('/src/store/engraveReleaseStore.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    const key = '192.0.2.10:2222';
    const job = jobStore.useEngraveJobStore.getState().job;
    const state = m.useEngraveReleaseStore.getState();
    m.useEngraveReleaseStore.setState({
      records: {
        ...state.records,
        [key]: {
          target: { host: '192.0.2.10', port: 2222 },
          jobId: job.id,
          jobName: job.name,
          job,
          airOn: true,
          phase: 'failed',
          files: [
            {
              index: 1,
              total: 1,
              setupIndex: 1,
              setupId: 's1',
              toolKey: job.toolKey,
              filename: 'job.nc',
              hash: 'h1',
              nc: 'M03\nM05\n',
              verify: null,
              done: false,
              upload: 'uploaded',
              uploadNote: null,
            },
          ],
          walks: { airwalk: null, clean: null },
          airWalk: false,
          cleanAfter: false,
          airWalked: true,
          walk: null,
          active: 1,
          next: null,
          atMachine: false,
          operatorStep: null,
          retouchedFor: null,
          uploading: null,
          vacuum: 'unknown',
          spanClosing: false,
          stopAsked: false,
          stoppedBetween: false,
          notes: [],
          settled: true,
        },
      },
    } as never);
  });
}

test('#1169 — the Tool wait shows the card; Continue sends M490.2 once and the card clears', async ({ cm, page }) => {
  const fake = await installFakeConsole(page, { steps: 20, toolWaitAtLine: 2 });
  await cm.ready();
  await prepareFakeRun(page);
  const runPanel = page.getByTestId('engrave-run').first();
  await runPanel.getByTestId('engrave-run-start').click();

  const card = page.getByTestId('engrave-cut-recovery-waiting');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('The machine is waiting for you');
  await expect(card).toContainText('asked for tool');
  await expect(card).toContainText('waiting for a tool change to be confirmed');
  fs.mkdirSync(OUT, { recursive: true });
  await card.screenshot({ path: path.join(OUT, 'machine-waiting.png') });

  await page.getByTestId('engrave-cut-recovery-continue').click();
  await expect.poll(() => fake.lines().filter((l) => l === 'M490.2').length, { timeout: 30_000 }).toBe(1);
  // The controller leaves `Tool` on the next poll; the card clears with it.
  await expect(card).toHaveCount(0, { timeout: 30_000 });
});

test('#1169 — the stopped card gates its choices behind Unlock and home; End dismisses it', async ({ cm, page }) => {
  const fake = await installFakeConsole(page, { steps: 20, alarmAtLine: 2 });
  await cm.ready();
  await prepareFakeRun(page);
  const runPanel = page.getByTestId('engrave-run').first();
  await runPanel.getByTestId('engrave-run-start').click();
  // THE ALARM ENDS THE RUN FIRST — the product's own order. The card only exists after the stop,
  // and pressing Unlock while the run's console is still open made the card's own attach fail (no
  // `$X` ever reached the fake) while the run panel was still running.
  // The alarm's end records as the run store's own kind (its #819 mapping — an alarm changes
  // nothing, so it is not this card's to reclassify); what this walk needs is that the RUN IS
  // OVER, so its console is released before the card opens one of its own.
  await expect(runPanel.getByTestId('engrave-run-end')).toBeVisible({ timeout: 60_000 });
  // Then the release record the card reads (a real stop patches it; the run seam does not plan one).
  await seedFailedRelease(page);

  const card = page.getByTestId('engrave-cut-recovery-stopped');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('The machine stopped');
  // The machine's own words are quoted when the run watch has one (pinned in the unit spec); the
  // e2e's alarm path leaves no line for the card to quote, so only the stop sentence is asserted.
  await expect(card).toContainText('You pressed Stop or the red button');
  // Choices wait for `1 · Unlock and home`.
  await expect(page.getByTestId('engrave-cut-recovery-run-again')).toBeDisabled();
  await expect(page.getByTestId('engrave-cut-recovery-register-again')).toBeDisabled();
  await expect(page.getByTestId('engrave-cut-recovery-end')).toBeDisabled();
  // The bit-change choice is parked until #1168.
  await expect(page.getByTestId('engrave-cut-recovery-bit-broke')).toBeDisabled();
  await expect(page.getByTestId('engrave-cut-recovery-bit-broke')).toContainText('after #1168');
  fs.mkdirSync(OUT, { recursive: true });
  await card.screenshot({ path: path.join(OUT, 'machine-stopped.png') });

  await page.getByTestId('engrave-cut-recovery-unlock-home').click();
  await expect(page.getByTestId('engrave-cut-recovery-run-again')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => fake.lines().includes('$X'), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => fake.lines().includes('$H'), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('engrave-cut-recovery-end')).toBeEnabled();

  // End the job here: the card is dismissed; nothing else is written.
  await page.getByTestId('engrave-cut-recovery-end').click();
  await expect(card).toHaveCount(0);
});
