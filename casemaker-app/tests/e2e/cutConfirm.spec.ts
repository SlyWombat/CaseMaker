// #656/#659 end to end — the two surfaces the unit specs prove and the other e2e specs never
// reach: the Cut step's ONE SCREEN (#656) and the status strip's state popover (#659).
//
// E2E has no controller, and both surfaces are gated on a connected machine, so the spec puts the
// observation a probe would have written on the machine store (`setMachine`) and asks the app for
// the frozen cutter's own words (`getFrozenProgram`) — the first Generate recommends a cutter from
// the preview, so a spec cannot know its name any other way.
//
// WHAT THE ONE SCREEN NEEDS IS A MACHINE, NOT A BUILD TARGET (#656 review). The bench runs this
// bundle in a plain browser at http://<host>:8000, driving through `/api/v1/machine/*`; the public
// web target is the one place a machine can never be reached, and `machine !== null` already
// excludes it. So this spec runs in the DEFAULT (web-target) e2e build like every other spec:
//
//   npx playwright test tests/e2e/cutConfirm.spec.ts

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** A status line with the monitor fields the popover reads: `S:` temperatures. */
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** Put a machine on screen without one — the observation a probe would have written. */
async function rememberMachine(page: Page, line: string = STATUS): Promise<void> {
  await page.evaluate((text) => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: text,
        profileId: 'Z1',
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      text,
    );
  }, line);
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
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  // #726 W20 — step 1 is ONE line, and its details are the operator's. This job opens Cut blocked
  // (the clearance tick is not done), which is exactly the state that used to latch the fold open:
  // the browser fires `toggle` for the `open` prop at mount, and jsdom never fires it at all, so
  // only a real browser proves the auto-open is not recorded as a choice. Ticking folds it back.
  const details = page.getByTestId('engrave-cut-details');
  const ack = page.getByTestId('engrave-ack');
  await expect(ack).toHaveCount(1);
  await expect(details).toHaveAttribute('open');
  await ack.check();
  await expect(details).not.toHaveAttribute('open');
  // The tick completes step 1, so its body folds with it; the operator's own look at the gate rows
  // is two clicks — the step, then its details — and both are theirs to make.
  await page.getByTestId('engrave-cut-step-1-summary').click();
  await details.locator('summary').first().click();
  await expect(details).toHaveAttribute('open');
  await details.locator('summary').first().click();
  await expect(details).not.toHaveAttribute('open');
  await page.getByTestId('engrave-cut-step-4-summary').click();
  await expect(page.getByTestId('engrave-cut-confirm')).toBeVisible({ timeout: 30_000 });

  const frozen = await page.evaluate(() => window.__caseMaker!.getFrozenProgram());
  expect(frozen).not.toBeNull();

  // The screen names the program the freeze holds and the cutter the FROZEN package runs.
  await expect(page.getByTestId('engrave-cut-confirm-program')).toContainText(frozen!.filename);
  await expect(page.getByTestId('engrave-cut-confirm-cutter')).toContainText(frozen!.cutterName);

  // ONE statement arms the press: disabled until it is ticked, enabled after. Clearance was step 1.
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

// #769 — THE REST OF THE FRAME ON THE DRO. The line is a recorded cutting frame from the bench
// (docs/bench/traces/2026-10-12-cut-rowA.log), so this proves the real bytes reach the strip.
test('#769 — the strip shows the frame’s feed, spindle and tool, and dashes for what is absent', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await rememberMachine(
    page,
    '<Run|MPos:-162.0500,-162.2000,-5.7381,0.0000,0.0000|WPos:18.4500,20.0000,50.8059,0.0000,0.0000|F:600.0,2000.0,100.0|S:11677.9,12000.0,100.0,1,37.6,24.9,0,0,0,0|T:1,0.000,1|L:0, 0, 0, 0.0,100.0|P:0,17,10|C:3,1,0,1|E:0,0,0,692,7610|OTA:0,0>',
  );

  await expect(page.getByTestId('machine-status')).toBeVisible();
  await expect(page.getByTestId('machine-status-feed')).toHaveText('F600');
  await expect(page.getByTestId('machine-status-spindle')).toHaveText('S11678');
  // The frame's `T:1` always reaches the slot; the name joins it only when the tool catalogue in
  // this page knows tool 1. This page has no catalogue, so the bare number is the right answer —
  // the joined `T1 · ⌀ 1 mm flat end` form is pinned in the unit strip test instead.
  await expect(page.getByTestId('machine-status-tool')).toHaveText(/^T1(?: · .+)?$/);
  // No recorded frame carries A: (the Z1 has no ATC), so the cell is absent, not a dash.
  await expect(page.getByTestId('machine-status-atc')).toHaveCount(0);

  // …and a line with none of them prints dashes: the strip never breaks on an absent field.
  await rememberMachine(page, '<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
  await expect(page.getByTestId('machine-status-feed')).toHaveText('F—');
  await expect(page.getByTestId('machine-status-spindle')).toHaveText('S—');
  await expect(page.getByTestId('machine-status-tool')).toHaveText('no cutter');
});
