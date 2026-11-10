// #1173A — Manage > one machine, in its four states, against a fake controller.
//
// THE FAKE IS THE MACHINE. `fixtures/fakeConsole.ts` serves the LAN bridge's own machine API; its
// `setPhase` flips what the controller answers (idle / a steady run / its alarm / silence), and the
// page's own heartbeat does the polling. One walk through idle → run → alarm → silent pins:
//
//   - the state card's words at each state (and its `data-state`, which the colour follows);
//   - the enabled set of Stop, Unlock and the switches at each state;
//   - Unlock disabled out of alarm, live and primary in alarm;
//   - the switch rows' wording: what this app last sent, never a machine-state claim;
//   - the discovery tag stops reading "found" after a missed poll;
//   - the page's text carries none of the internal words the issue names.
//
// This is the gate the Manager set for #1173A: it goes in today only with this walk green.
import { mkdirSync } from 'node:fs';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });

const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:0,0,0>';

/** The machine the wizard's check would have recorded — the fake console answers for it. */
async function plantMachine(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
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
        observedAt: new Date().toISOString(),
        notes: [],
      },
      line,
    );
  }, IDLE);
}

test('#1173A — one machine: idle → run → alarm → silent', async ({ cm, page }) => {
  const fake = await installFakeConsole(page);
  await cm.ready();
  await page.setViewportSize({ width: 1280, height: 800 });
  await plantMachine(page);
  await page.getByTestId('machine-pin-open').click();
  await expect(page.getByTestId('manage-machine-card')).toBeVisible();

  const card = page.getByTestId('manage-state-card');
  const headline = page.getByTestId('manage-state-headline');
  const stop = page.getByTestId('manage-stop-button');
  const unlock = page.getByTestId('manage-unlock-press');
  const vacuumOn = page.getByTestId('manage-vacuum-on');
  const lightOn = page.getByTestId('manage-light-on');

  // ── idle: ready, nothing running, no alarm, switches live and claiming nothing.
  await expect(card).toHaveAttribute('data-state', 'ready');
  await expect(headline).toContainText('QA Z1 is ready — Idle');
  await expect(headline).toContainText('Makera Z1 at 192.0.2.10');
  await expect(page.getByTestId('manage-machine-found')).toHaveText('found');
  await expect(stop).toBeDisabled();
  await expect(stop).toContainText('nothing running');
  await expect(unlock).toBeDisabled();
  await expect(unlock).toContainText('no alarm');
  await expect(vacuumOn).toBeEnabled();
  await expect(lightOn).toBeEnabled();
  await expect(page.getByTestId('manage-vacuum-state')).toHaveText('not sent this session');
  await expect(page.getByTestId('manage-light-state')).toHaveText('not sent this session');

  // A clean press says what this app sent and when — never what the machine reports.
  await lightOn.click();
  await expect(page.getByTestId('manage-light-state')).toHaveText(
    /^last sent from this app: on · \d{2}:\d{2}$/,
  );

  // ── run: the card says what it is doing, Stop is live, the switches lock.
  fake.setPhase('run');
  await expect(card).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  await expect(headline).toContainText('Cutting program');
  await expect(stop).toBeEnabled();
  await expect(stop).toContainText('stops now');
  await expect(unlock).toBeDisabled();
  await expect(vacuumOn).toBeDisabled();
  await expect(lightOn).toBeDisabled();

  // ── alarm: the machine's own words, Unlock live and primary, Stop off.
  fake.setPhase('alarm');
  await expect(card).toHaveAttribute('data-state', 'alarm', { timeout: 15_000 });
  await expect(headline).toHaveText('In alarm — “ALARM: Probe fail”');
  await expect(unlock).toBeEnabled();
  await expect(unlock).toHaveText('Unlock');
  await expect(unlock).toHaveClass(/btn--primary/);
  await expect(stop).toBeDisabled();
  await expect(vacuumOn).toBeDisabled();

  // ── silent: the missed poll beats the last line, and the page says how to bring it back.
  fake.setPhase('silent');
  await expect(card).toHaveAttribute('data-state', 'silent', { timeout: 15_000 });
  await expect(headline).toHaveText(/^Not answering since \d{2}:\d{2}$/);
  await expect(page.getByTestId('manage-machine-found')).toHaveText(/^Not answering since \d{2}:\d{2}$/);
  await expect(page.getByTestId('manage-state-recheck')).toBeVisible();
  await expect(page.getByTestId('manage-state-plug')).toContainText('Switch it on at the plug');
  await expect(stop).toBeDisabled();
  await expect(unlock).toBeDisabled();
  await expect(vacuumOn).toBeDisabled();
  await expect(lightOn).toBeDisabled();

  // ── destructive actions still ask twice: the first press only opens the question.
  await page.getByTestId('manage-machine-forget').click();
  await expect(page.getByTestId('manage-machine-forget-confirming')).toBeVisible();
  await expect(page.getByTestId('manage-machine-forget-confirm')).toBeVisible();
  await expect(page.getByTestId('manage-machine-card')).toBeVisible();
  await page.getByTestId('manage-machine-forget-cancel').click();

  // ── the operator's page carries none of the internal words the issue names.
  const body = page.locator('body');
  for (const internal of ['location.json', 'config-get', 'margins.', 'profile Z1']) {
    await expect(body).not.toContainText(internal);
  }

  mkdirSync('/mnt/house/casemaker/qa/2026-11-10/1173', { recursive: true });
  await page.screenshot({ path: '/mnt/house/casemaker/qa/2026-11-10/1173/manage-machine.png' });
});
