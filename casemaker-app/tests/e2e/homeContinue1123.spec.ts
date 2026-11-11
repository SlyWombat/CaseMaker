// #1123 item 48, in a real browser — HOME KEEPS THE WORK.
//
// The analyst's fields (issue #1123): Home leads the toolbar and nothing is discarded; the main
// page gains a Continue row naming the open thing; Continue returns to exactly where the operator
// was; a choice that would replace open work asks once in the app's own dialog, never
// window.confirm. Reload-restore (items 10/11) is its own spec and must stay green beside this one.
import type { Page } from '@playwright/test';
import { test, expect, enterCnc } from './fixtures/caseMaker';

test.setTimeout(420_000);

/** A CNC job open on the Job panel, marked as worked-on: a reload restores it (item 10). */
async function openCncWithJob(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(500);
}

test('#1123-48 — Home shows the four cards and a Continue row; a replacing card asks in the app’s dialog; Continue returns with the same run', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await openCncWithJob(page);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', {
    timeout: 300_000,
  });
  const before = await page.evaluate(() => window.__caseMaker!.engraveProgramText());
  expect(before, 'the run produced program text').not.toBeNull();

  await page.getByTestId('home').click();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
  // The front door is unchanged: its four ways in.
  for (const card of ['welcome-door-print', 'welcome-door-racks', 'welcome-door-toolboxes', 'welcome-door-cnc']) {
    await expect(page.getByTestId(card)).toBeVisible();
  }
  // Continue names the work that waits — the open CNC job.
  await expect(page.getByTestId('welcome-continue-what')).toContainText('Untitled job');
  await expect(page.getByTestId('welcome-continue-what')).toContainText('a CNC job');

  // A card that would replace the work asks once, in the app's own dialog — never window.confirm.
  await page.evaluate(() => {
    type Probe = Window & { __confirmCalls?: number };
    (window as Probe).__confirmCalls = 0;
    window.confirm = () => {
      (window as Probe).__confirmCalls = ((window as Probe).__confirmCalls ?? 0) + 1;
      return false;
    };
  });
  await page.getByTestId('welcome-door-racks').click();
  await expect(page.getByTestId('welcome-replace-confirm')).toBeVisible();
  await expect(page.getByTestId('welcome-replace-confirm-body')).toContainText('will be replaced');
  await page.getByTestId('welcome-replace-confirm-no').click();
  await expect(page.getByTestId('welcome-replace-confirm')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __confirmCalls?: number }).__confirmCalls ?? 0)).toBe(0);
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  // Continue: the same Job panel, still on Design, with the run's own bytes untouched.
  await page.getByTestId('welcome-continue-open').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__caseMaker!.engraveProgramText())).toBe(before);
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick');
  expect((await page.evaluate(() => window.__caseMaker!.getEngraveRunState())).oracleOk).toBe(true);
});

test('#1123-48 — Home during Generate: the run finishes behind the main page and Continue shows it', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await openCncWithJob(page);
  await page.getByTestId('engrave-generate').click();
  // Leave immediately, while the run is still going: Home is not a cancel.
  await page.getByTestId('home').click();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
  await expect(page.getByTestId('welcome-continue-what')).toContainText('a CNC job');

  // The run finishes with the workspace unmounted; Continue finds it settled, not restarted.
  await page.getByTestId('welcome-continue-open').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', {
    timeout: 300_000,
  });
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.oracleOk).toBe(true);
  expect(state.programs).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__caseMaker!.engraveProgramText())).not.toBeNull();
  // And the job is still the one that was left: Cut is the next step, not another Generate.
  await expect(page.getByTestId('engrave-generate')).toHaveAttribute('data-action', 'cut');
});
