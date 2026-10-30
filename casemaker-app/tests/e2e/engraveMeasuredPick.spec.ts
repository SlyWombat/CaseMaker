// #766 D end to end, in a real browser: the Design panel DRAWS AT ONCE with the #211 rule's answer,
// labelled `provisional — measuring…`, then the sim worker finishes the measured search in the
// background and the measured plan (with its explanation) replaces it. 'Use the recommendation'
// applies whichever answer is current — here the measured one.
//
// The job is the COIN from the bench corpus (raised "Software"/"CNX", a 30 mm disc): a real job in
// which the rule and the simulation disagree about which rest cutter separates the raised text
// (#765), so the search has something worth measuring. The search is real — Manifold, the
// generator and the oracle's program run in the worker — so this gets well past the default
// timeout.

import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

// The bench corpus lives at the repository root, one level above `casemaker-app`.
const COIN = fileURLToPath(
  new URL('../../../docs/bench/2026-10-28-z1-real-jobs/jobs/j04-coin-disc-faithful.json', import.meta.url),
);

/** Load a board (which shows the sidebar) and open Engrave on the deterministic default job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

/** #686 — every job-file command is the File menu's; Open is the `<input type="file">` fallback. */
async function openJobFile(page: Page, path: string): Promise<void> {
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  await expect(menu).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(path);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened');
}

test.setTimeout(300_000);

test('the coin: the rule answer shows as provisional, then the measured pick replaces it and applies', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await openEngravePanel(page);
  await openJobFile(page, COIN);

  // 1 — the rule's answer is on screen AT ONCE, labelled provisional while the search runs.
  await expect(page.getByTestId('engrave-pick-provisional')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-pick-provisional')).toHaveText(/provisional — measuring/);
  await expect(page.getByTestId('engrave-recommendation')).toBeVisible();

  // 2 — the measured answer replaces it, with its own numbers. The coin's raised text costs the
  // search real generator runs, hence the generous wait.
  await expect(page.getByTestId('engrave-pick-measured')).toBeVisible({ timeout: 240_000 });
  const measured = page.getByTestId('engrave-pick-measured');
  await expect(measured).toContainText('measured:');
  await expect(page.getByTestId('engrave-pick-measured-tag')).toHaveText('measured');
  await expect(page.getByTestId('engrave-pick-verdict')).toContainText(/Chosen by simulation|No plan the search tried posts/);
  // The provisional label is gone with the rule's box.
  await expect(page.getByTestId('engrave-pick-provisional')).toHaveCount(0);
  await expect(page.getByTestId('engrave-recommendation')).toHaveCount(0);

  // 3 — 'Use the recommendation' is the measured answer's, and applying it is a state the panel
  // recognises: the button does not offer to change the same plan again.
  await page.getByTestId('engrave-use-measured').click();
  await expect(page.getByTestId('engrave-use-measured')).toHaveCount(0);
  await expect(page.getByTestId('engrave-pick-measured')).toBeVisible();
});
