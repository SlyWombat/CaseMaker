// #618 — PAUSE AND RESUME FROM THE CUT STEP, end to end on the house bundle with #816's fake
// console. The engine sends the firmware's own bare `suspend` / `resume` at the run's poll
// boundary (Studio's words, RE 05). This proves what the operator sees: the strip reads Paused,
// the run card is the same panel with Resume and Stop and the transcript names the paused line,
// resume continues at or past that line, and Stop while paused ends the job as STOPPED — never
// Finished (a suspended machine reads Idle with no `P:`, which is the finish rule otherwise).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { houseServerPort } from '../../scripts/e2ePort';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

// #821 — the machine console is reached in a bundle that carries the bridge: the house target.
test.use({ baseURL: `http://127.0.0.1:${houseServerPort()}` });
test.setTimeout(300_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-pause-resume');
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

/** A generated program, Cut with its ONE statement given, and the run entry prepared. */
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
  const prepared = await page.evaluate(() =>
    window.__caseMaker!.machineRunPrepare('192.0.2.10', 2222, 'job.nc', 'M03\nM05\n'),
  );
  expect(prepared, 'the machine run entry is prepared').toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

test('#618 — pause, resume from the paused line, and Stop while paused', async ({ cm, page }) => {
  // A long enough program that every boundary lands mid-run: 40 status reads, 3 % each.
  const fake = await installFakeConsole(page, { steps: 40 });
  await cm.ready();
  await prepareFakeRun(page);
  const runPanel = page.getByTestId('engrave-run').first();
  await runPanel.getByTestId('engrave-run-start').click();
  await expect.poll(() => fake.lines().includes('play /sd/gcodes/job.nc'), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => fake.lines().filter((l) => l === '?').length, { timeout: 20_000 }).toBeGreaterThan(2);

  // ── PAUSED: `suspend` goes out; the strip reads Paused; the card is Resume + Stop; the
  // transcript names the line it paused at. ──
  await runPanel.getByTestId('engrave-run-pause').click();
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Resume', { timeout: 20_000 });
  await expect.poll(() => fake.lines().includes('suspend'), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('machine-status-state')).toHaveAttribute('data-state', 'Paused', { timeout: 10_000 });
  await expect(runPanel.getByTestId('engrave-run-stop')).toHaveText('Stop');
  await expect(runPanel.getByTestId('engrave-run-controls-caption')).toContainText(
    'Pause takes effect at the next status read.',
  );
  const log = page.getByTestId('engrave-run-lines');
  await expect(log).toContainText('Paused at line');
  const pausedText = (await log.textContent()) ?? '';
  const pausedAt = Number(/Paused at line (\d+)/.exec(pausedText)?.[1] ?? NaN);
  expect(Number.isFinite(pausedAt), `the paused line is named: ${pausedText}`).toBe(true);
  await shoot(page, 'paused.png');

  // ── RESUME: the same button sends `resume`; the run continues at or past the paused line. ──
  await runPanel.getByTestId('engrave-run-pause').click();
  await expect.poll(() => fake.lines().includes('resume'), { timeout: 20_000 }).toBe(true);
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Pause', { timeout: 20_000 });
  await expect(log).toContainText('Resumed at line');
  const resumedText = (await log.textContent()) ?? '';
  const resumedAt = Number(/Resumed at line (\d+)/.exec(resumedText)?.[1] ?? NaN);
  expect(Number.isFinite(resumedAt), `the resumed line is named: ${resumedText}`).toBe(true);
  expect(resumedAt, 'resume continues from the paused line').toBeGreaterThanOrEqual(pausedAt);
  await expect(page.getByTestId('machine-status-state')).not.toHaveAttribute('data-state', 'Paused');
  await shoot(page, 'resumed.png');

  // ── STOP WHILE PAUSED: abort from a suspended job. A suspended machine reads Idle with no `P:`,
  // which the run must not read as a finish: the card says Stopped, never Finished. ──
  await runPanel.getByTestId('engrave-run-pause').click();
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Resume', { timeout: 20_000 });
  await runPanel.getByTestId('engrave-run-stop').click();
  await expect.poll(() => fake.lines().includes('abort'), { timeout: 20_000 }).toBe(true);
  const end = runPanel.getByTestId('engrave-run-end');
  await expect(end).toHaveAttribute('data-kind', 'stopped', { timeout: 60_000 });
  await expect(runPanel.getByTestId('engrave-run-done-title')).toHaveText('Stopped');
  await expect(runPanel.getByTestId('engrave-run-done-title')).not.toContainText('Finished');
  // #618 — the strip belongs to the MACHINE again once the run is over: no Paused word, no Stop
  // under the Stopped card.
  await expect(page.getByTestId('machine-status-state')).not.toHaveAttribute('data-state', 'Paused');
  await expect(page.getByTestId('machine-status-stop')).toHaveCount(0);
  await shoot(page, 'stopped-while-paused.png');
});
