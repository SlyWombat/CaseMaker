// #656/#659 end to end — the two surfaces the unit specs prove and the other e2e specs never
// reach: the Cut step's ONE SCREEN (#656) and the status strip's state popover (#659).
//
// E2E has no controller, and both surfaces are gated on a connected machine, so the spec puts the
// observation a probe would have written on the machine store (`setMachine`) and asks the app for
// the frozen cutter's own words (`getFrozenProgram`) — the first Generate recommends a cutter from
// the preview, so a spec cannot know its name any other way.
//
// THE ONE SCREEN IS THE DESKTOP BUILD'S. #656's comment says the expert path stays the default when
// the one screen is not offered — "a multi-program job, the web build, or no machine". So this
// spec runs against the desktop target and skips elsewhere:
//
//   BUILD_TARGET=desktop npx playwright test tests/e2e/cutConfirm.spec.ts

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.skip(
  process.env.BUILD_TARGET !== 'desktop',
  'the Cut one screen renders only in the desktop build (the web build keeps the expert path)',
);

/** A status line with the monitor fields the popover reads: `S:` temperatures. */
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** Put a machine on screen without one — the observation a probe would have written. */
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

test('#656 — the one screen names the frozen program and cutter, and ONE statement arms the press', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // Generate: the ordinary path's four ticks, and the freeze that follows a green gate.
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // Cut freezes the plan on green; the confirm appearing IS the package being current, so the
  // frozen program is read afterwards — there is nothing to name before the freeze.
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-confirm')).toBeVisible({ timeout: 30_000 });

  const frozen = await page.evaluate(() => window.__caseMaker!.getFrozenProgram());
  expect(frozen).not.toBeNull();

  // The screen names the program the freeze holds and the cutter the FROZEN package runs.
  await expect(page.getByTestId('engrave-cut-confirm-program')).toContainText(frozen!.filename);
  await expect(page.getByTestId('engrave-cut-confirm-cutter')).toContainText(frozen!.cutterName);

  // ONE statement is the whole gate on the press: disabled until it is ticked, enabled after.
  const go = page.getByTestId('engrave-cut-go');
  await expect(go).toBeDisabled();
  await page.getByTestId('engrave-cut-statement').check();
  await expect(go).toBeEnabled();
  // NOT pressed: the press uploads and starts a run, and e2e has no machine.
});

test('#659 — the strip’s state element opens its popover, and Escape closes it', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await rememberMachine(page);

  await expect(page.getByTestId('machine-status')).toBeVisible();
  await expect(page.getByTestId('machine-status-monitor')).toHaveCount(0);

  await page.getByTestId('machine-status-state').click();
  const monitor = page.getByTestId('machine-status-monitor');
  await expect(monitor).toBeVisible();
  await expect(page.getByTestId('machine-status-monitor-spindle')).toHaveText('Spindle 25.8 °C');
  await expect(page.getByTestId('machine-status-monitor-power')).toHaveText('Power board 24.0 °C');

  await page.keyboard.press('Escape');
  await expect(monitor).toHaveCount(0);
});
