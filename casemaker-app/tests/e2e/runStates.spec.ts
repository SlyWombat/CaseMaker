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
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { prepareFakeRun } from './fixtures/generatedRun';

// #816/#867 — the console is reached only in a DESKTOP bundle (`loadMachineBridge` is behind
// `canReachMachine`): the spec runs against the desktop-mode dev server Playwright starts beside
// the web one (playwright.config.ts) — the desktop app served headless to a plain browser. The
// fake then sits exactly where the bench does, on the instance's HTTP relay at
// `/api/v1/machine/*`, behind `httpTransport`.
test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });

test.setTimeout(300_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-run-states');

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

test('#801/#806 — the run panel running, paused, and its Done card, on a fake console', async ({ cm, page }) => {
  // The fake is installed before any app code runs: every console call goes to it.
  const fake = await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await prepareFakeRun(page);
  // The run panel appears with the run the card's ONE Start prepares.
  const runPanel = page.getByTestId('engrave-run').first();

  // ── RUNNING: the verbs and the ONE caption (#801); no panel progress line. ──
  await page.getByTestId('engrave-cut-card-start').click();
  await expect(runPanel).toBeVisible({ timeout: 30_000 });
  await expect(runPanel.getByTestId('engrave-run-pause')).toHaveText('Pause');
  await expect(runPanel.getByTestId('engrave-run-stop')).toHaveText('Stop');
  await expect(runPanel.getByTestId('engrave-run-controls-caption')).toContainText(
    'Pause takes effect at the next status read.',
  );
  await expect(runPanel.getByTestId('engrave-run-progress')).toHaveCount(0);
  await expect.poll(() => fake.lines().filter((l) => l === '?').length, { timeout: 20_000 }).toBeGreaterThan(1);
  // #1123 item 8 — the card's ONE Start plays the RELEASE's own file, whose name the release
  // names; the run panel no longer carries a start, so the file is not the prepared 'job.nc'.
  await expect.poll(() => fake.lines().some((l) => l.startsWith('play /sd/gcodes/')), { timeout: 20_000 }).toBe(true);
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
  // answer (Idle), with no Stop and no finished program's bar. The run buttons and the one-screen
  // Go press are gone — a finished job cannot be started again by the same press. The THREE STEPS
  // themselves STAY above the end card (#1123 item 39 replaced the old done-screen takeover, so the
  // next program's press stays reachable on a multi-program job). The card is its title, ONE line
  // (the machine's end state) and ONE action.
  const stripState = page.getByTestId('machine-status-state');
  await expect.poll(() => stripState.getAttribute('data-state'), { timeout: 30_000 }).toBe('Idle');
  await expect(page.getByTestId('machine-status-stop')).toHaveCount(0);
  await expect(page.getByTestId('machine-status-progress')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-go')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-start')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-step-1')).toHaveCount(1);
  // #1123 item 41 — the output is the DIRECT command (M852), not the M331 auto mode, and the
  // sentence names the code it sent.
  // The release's own program states the vacuum and air directly (M852/M812), so the run's
  // outcome says exactly that; the old prepared-run bracket (M852; homed) is no longer the text.
  await expect(runPanel.getByTestId('engrave-run-outcome')).toHaveText(
    'The run switched the vacuum off (M852) and the air (M812); homed.',
  );
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
  await page.getByTestId('engrave-cut-card-start').click();
  // #1123 item 8 — the card's ONE Start plays the RELEASE's own file, whose name the release
  // names; the run panel no longer carries a start, so the file is not the prepared 'job.nc'.
  await expect.poll(() => fake.lines().some((l) => l.startsWith('play /sd/gcodes/')), { timeout: 20_000 }).toBe(true);

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
