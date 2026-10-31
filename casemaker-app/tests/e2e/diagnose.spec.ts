// #826 — THE DIAGNOSTIC SWITCHES, LIVE. The house-served bundle's status monitor shows what the
// controller's `diagnose` line carries: the probe input (the live companion to #788's diagram),
// the cover, the endstops, the e-stop and the Wi-Fi signal. The heartbeat polls `?` and `diagnose`
// on one connection; the store keeps a CHANGED reading only, so the monitor follows a press
// instead of streaming identical polls. The fake console (fixtures/fakeConsole.ts) answers both.
import type { Page } from '@playwright/test';
import { houseServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { DIAGNOSE_TOUCHED, installFakeConsole } from './fixtures/fakeConsole';

// #821 — the diagnostic read is reachable in a machine-carrying bundle: the house target is the
// bundle a local instance serves to a LAN browser (the k3 path).
test.use({ baseURL: `http://127.0.0.1:${houseServerPort()}` });

test.setTimeout(120_000);

/** A status line for the machine observation the strip reads. */
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

test('#826 — the status monitor reads the controller’s switches and Wi-Fi, and follows a change', async ({ cm, page }) => {
  const fake = await installFakeConsole(page);
  await cm.ready();
  // The heartbeat is the rail's (MachinePin): it runs in the CNC workspace, so open it first.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('machine-status')).toBeVisible();

  // The heartbeat asks `?` and `diagnose` on one connection every 2 s.
  await expect.poll(() => fake.lines().includes('diagnose'), { timeout: 20_000 }).toBe(true);
  await page.getByTestId('machine-status-state').click();

  const probe = page.getByTestId('machine-status-probe');
  await expect(probe).toHaveText('Probe — open', { timeout: 15_000 });
  await expect(page.getByTestId('machine-status-cover')).toHaveText('Cover — closed');
  await expect(page.getByTestId('machine-status-estop')).toHaveText('E-stop — released');
  await expect(page.getByTestId('machine-status-limits')).toHaveText('Limits — all clear');
  await expect(page.getByTestId('machine-status-rssi')).toHaveText('Wi-Fi — -40 dBm');

  // A stylus press (the fake's next diagnostic line): the same row takes the new value — the
  // monitor shows the change, not a stream.
  fake.setDiagnose(DIAGNOSE_TOUCHED);
  await expect(probe).toHaveText('Probe — touched', { timeout: 15_000 });
  await expect(page.getByTestId('machine-status-rssi')).toHaveText('Wi-Fi — -41 dBm');
});
