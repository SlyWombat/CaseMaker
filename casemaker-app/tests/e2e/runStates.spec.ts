// #816 — THE RUN PANEL'S STATES, WITH NO MACHINE: a fake controller serves the LAN bridge's
// `/api/v1/machine/tcp/*` in the page (tests/e2e/fixtures/fakeConsole.ts), so the run panel plays a
// real program and reaches running, paused and finished. REAL screenshots are committed under
// `docs/bench/img/2026-10-31-run-states/` — the record #801 (Pause/Resume/Stop and the one
// caption, no panel progress line), #806 (the Done card) and #819 (THE FINISHED SCREEN: the strip
// reads the machine, the steps and both run buttons are gone, and the card is one line plus one
// action) asked for.
//
// The program is prepared through the test surface (`machineRunPrepare`, the store seam the
// upload's last step uses) rather than uploaded: the fake answers the console, and the upload's
// own file protocol is not what these two states are about.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { machineServerPort } from '../../scripts/e2ePort';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

// #816 — the console is reached only in the DESKTOP target (`loadMachineBridge` is behind
// `canDriveMachine`): the spec runs against the desktop-mode dev server Playwright starts beside
// the web one (playwright.config.ts). The fake then sits exactly where the bench does — on the
// house HTTP bridge's `/api/v1/machine/*`, behind `httpTransport`.
test.use({ baseURL: `http://127.0.0.1:${machineServerPort()}` });

test.setTimeout(300_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-run-states');

/** A status line with the monitor fields the state popover reads, for the machine observation. */
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

async function rememberMachine(page: Page): Promise<void> {
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: line,
        profileId: 'Z1',
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      line,
    );
  }, STATUS);
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

/**
 * The job both tests share: a generated program, Cut open with its ONE statement given (#797),
 * and the machine's run entry prepared through the store seam an upload ends on. The run's entry
 * is prepared rather than uploaded: the fake answers the console, and the upload's own file
 * protocol is not what these states are about.
 */
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

test('#801/#806 — the run panel running, paused, and its Done card, on a fake console', async ({ cm, page }) => {
  // The fake is installed before any app code runs: every console call goes to it.
  const fake = await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await prepareFakeRun(page);
  // The one screen's run panel; the expert path's own copy sits folded behind its disclosure.
  const runPanel = page.getByTestId('engrave-run').first();
  await expect(runPanel).toBeVisible();

  // ── RUNNING: the verbs and the ONE caption (#801); no panel progress line. ──
  await runPanel.getByTestId('engrave-run-start').click();
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Pause');
  await expect(runPanel.getByTestId('engrave-run-stop')).toHaveText('Stop');
  await expect(runPanel.getByTestId('engrave-run-controls-caption')).toContainText(
    'Pause takes effect at the next status read.',
  );
  await expect(runPanel.getByTestId('engrave-run-progress')).toHaveCount(0);
  await expect.poll(() => fake.lines().filter((l) => l === '?').length, { timeout: 20_000 }).toBeGreaterThan(1);
  await expect.poll(() => fake.lines().includes('play /sd/gcodes/job.nc'), { timeout: 20_000 }).toBe(true);
  await shoot(page, 'running.png');

  // ── PAUSED: the same button is the Resume, and the suspend went out. ──
  await runPanel.getByTestId('engrave-run-pause').click();
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Resume', { timeout: 20_000 });
  await expect.poll(() => fake.lines().includes('suspend'), { timeout: 20_000 }).toBe(true);
  await shoot(page, 'paused.png');

  // ── DONE: the one card (#806) — "Finished · <time>", the end's lines, one next action. ──
  await runPanel.getByTestId('engrave-run-pause').click();
  await expect.poll(() => fake.lines().includes('resume'), { timeout: 20_000 }).toBe(true);
  const done = runPanel.getByTestId('engrave-run-end');
  await expect(done).toHaveAttribute('data-kind', 'finished', { timeout: 60_000 });
  await expect(runPanel.getByTestId('engrave-run-done-title')).toContainText(/^Finished · /);

  // #819 — THE FINISHED SCREEN. The strip speaks for the MACHINE: it settles on the fake's own last
  // answer (Idle), with no Stop and no finished program's bar. Both run buttons and the three steps
  // are gone, so step 2's "no saved setup" cannot sit under a Done card. The card is its title, ONE
  // line (the machine's end state) and ONE action.
  const stripState = page.getByTestId('machine-status-state');
  await expect.poll(() => stripState.getAttribute('data-state'), { timeout: 30_000 }).toBe('Idle');
  await expect(page.getByTestId('machine-status-stop')).toHaveCount(0);
  await expect(page.getByTestId('machine-status-progress')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-go')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-start')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-step-1')).toHaveCount(0);
  await expect(runPanel.getByTestId('engrave-run-outcome')).toHaveText('Vacuum off; homed.');
  await expect(done.locator('p')).toHaveCount(2); // the title and the one line
  await expect(done.locator('button')).toHaveCount(1); // Cut another
  await expect(runPanel.getByTestId('engrave-run-another')).toBeVisible();
  await shoot(page, 'done.png');

  // The card's one primary action returns to Design for the next part.
  await runPanel.getByTestId('engrave-run-another').click();
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
});

test('#801 — Stop aborts the job, and Home is offered only once the machine confirms it', async ({ cm, page }) => {
  const fake = await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await prepareFakeRun(page);
  const runPanel = page.getByTestId('engrave-run').first();
  await runPanel.getByTestId('engrave-run-start').click();
  await expect.poll(() => fake.lines().includes('play /sd/gcodes/job.nc'), { timeout: 20_000 }).toBe(true);

  // The verb sends `abort`; the machine answers Idle, so the card says Stopped — not Finished.
  await runPanel.getByTestId('engrave-run-stop').click();
  await expect.poll(() => fake.lines().includes('abort'), { timeout: 20_000 }).toBe(true);
  await expect(runPanel.getByTestId('engrave-run-end')).toHaveAttribute('data-kind', 'stopped', { timeout: 60_000 });
  await expect(runPanel.getByTestId('engrave-run-done-title')).toHaveText('Stopped');

  // Home is OFFERED, not sent: the press is the operator's, and it sends `$H`.
  const home = runPanel.getByTestId('engrave-run-home');
  await expect(home).toBeVisible();
  await home.click();
  await expect.poll(() => fake.lines().includes('$H'), { timeout: 10_000 }).toBe(true);
});
