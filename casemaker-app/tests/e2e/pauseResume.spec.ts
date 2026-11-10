// #618 — PAUSE AND RESUME FROM THE CUT STEP, end to end on the desktop bundle served headless, with #816's fake
// console. The engine sends the firmware's own bare `suspend` / `resume` at the run's poll
// boundary (Studio's words, RE 05). This proves what the operator sees: the strip reads Paused,
// the run card is the same panel with Resume and Stop and the transcript names the paused line,
// resume continues at or past that line, and Stop while paused ends the job as STOPPED — never
// Finished (a suspended machine reads Idle with no `P:`, which is the finish rule otherwise).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { prepareFakeRun } from './fixtures/generatedRun';

// #821/#867 — the machine console is reached in a bundle that carries the bridge: the desktop bundle served to a browser.
test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(300_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-pause-resume');

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
