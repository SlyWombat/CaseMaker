// #1169 — THE MACHINE'S WAITING AND STOPPED CARDS, on the fake machine.
//
// The waiting card: the controller parks in its firmware `Tool` state mid-run; the card names the
// wait and Continue sends `M490.2` ONCE, and the card clears when the controller leaves `Tool`.
// The stopped card: the controller alarms; the card states the stop, gates the four choices until
// Unlock and home, and "End the job here" dismisses it without touching the record.
//
// The console is reached only in a DESKTOP bundle (`canReachMachine`), so this spec runs on the
// desktop-mode dev server Playwright starts beside the web one (see runStates.spec.ts).
import { test, expect, openCutterGroup } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { lanServerPort } from '../../scripts/e2ePort';
import type { Page } from '@playwright/test';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(300_000);

const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

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

/** Seed the failed release record the stopped card reads (the run panel does not plan one). */
async function seedFailedRelease(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const m = await import('/src/store/engraveReleaseStore.ts');
    const key = '192.0.2.10:2222';
    const state = m.useEngraveReleaseStore.getState();
    const rec = state.records[key] ?? {};
    m.useEngraveReleaseStore.setState({
      records: {
        ...state.records,
        [key]: {
          ...rec,
          phase: 'failed',
          active: 1,
          vacuum: 'unknown',
          walks: { airwalk: null, clean: null },
          files: [{ index: 1, toolKey: 'flat-1.0', done: false, upload: 'uploaded', nc: 'M03\nM05\n' }],
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
  // The alarm ends the machine run; the release record the card reads is seeded failed.
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

  await page.getByTestId('engrave-cut-recovery-unlock-home').click();
  await expect(page.getByTestId('engrave-cut-recovery-run-again')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => fake.lines().includes('$X'), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => fake.lines().includes('$H'), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('engrave-cut-recovery-end')).toBeEnabled();

  // End the job here: the card is dismissed; nothing else is written.
  await page.getByTestId('engrave-cut-recovery-end').click();
  await expect(card).toHaveCount(0);
});
