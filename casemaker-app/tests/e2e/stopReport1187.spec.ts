// #1187 — A STOPPED REGISTER WRITES ITS OWN REPORT, on the fake machine.
//
// The 2026-11-10 bench: Register stopped with 'read failed: Connection reset by peer', and the only
// report the app could offer was the previous session's crash. Now the stop's own card carries
// 'Send a report of this stop', built from THAT press's transcript, the error, the machine's last
// status line, the build and the job/package — and nothing is posted until the press.
//
// The fake console kills the link AFTER the app writes `M491` (a line only a registration sends, so
// the shared status poller cannot trip it): the write goes out and its answer never comes.
import fs from 'node:fs';
import path from 'node:path';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { houseHealth, locationDocument, serveHouse, type Json } from './fixtures/fakeHouse';
import type { Page } from '@playwright/test';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

const OUT = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-11-10-1187-stop-report');

const SEAT_Z = -85.788;
const STOCK_MM = 25;

/**
 * The bench's location: the machine's active profile carries the measured bracket seat the plan's
 * expected top comes from, and the bracket sits at anchor 1 (the #1179 walk's own view of the
 * shared fixture; nothing here is specific to that issue).
 */
function benchLocation(): Json {
  const doc = locationDocument();
  const machine = doc.machines[0]!;
  const profile = (machine as { bedProfiles?: Json[] }).bedProfiles?.[0];
  if (profile === undefined) throw new Error('the location fixture has no bed profile');
  const datums = profile['datums'] as Json;
  datums['bracketSeatZ'] = {
    value: SEAT_Z,
    measuredAt: '2026-11-09T17:55:01.000Z',
    by: 'fx-probe-1',
    at: [-175, -35],
    restsOnStock: true,
    probeRefZ: -80,
  };
  profile['placements'] = ((profile['placements'] as Json[] | undefined) ?? []).filter(
    (pl) => ((pl['where'] as { kind?: string } | undefined)?.kind ?? '') !== 'pins',
  );
  (profile['placements'] as Json[]).push({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'anchor', anchor: 1, pins: null },
    count: null,
    frame: null,
    provenance: {},
  });
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    machines: doc.machines,
    accessories: doc.accessories,
  };
}

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

/** The shared walk up to the Register press: a plate, a pocket, Generate green, the plan approved. */
async function prepare(page: Page): Promise<void> {
  await rememberMachine(page);
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill(String(STOCK_MM));
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  await page.getByTestId('engrave-ack').check();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('then the top');
}

test('#1187 — a Register stop on a dead link offers its own report, and nothing is posted before the press', async ({
  cm,
  page,
}) => {
  const doc = locationDocument();
  await serveHouse(page, {
    location: benchLocation(),
    health: houseHealth(),
    defaults: doc.defaults,
    movingEtag: true,
    writes: 'applied',
  });
  // The house's crash-report route, captured: the LAST route matching a path wins, and neither
  // serveHouse nor the console route answers this one.
  const reports: Json[] = [];
  await page.route('**/api/v1/crash-reports', async (route) => {
    reports.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ path: 'crash-reports/stop-1794342073154-1.json' }),
    });
  });
  await installFakeConsole(page, { steps: 20, resetAfterWrite: 'M491' });
  await cm.ready();
  await prepare(page);

  // #1202 (later) — the first-run hold: the card's statement is ticked before the press.
  const firstRunTick = page.getByTestId('engrave-registration-first-run-tick');
  if ((await firstRunTick.count()) > 0) await firstRunTick.check();
  await page.getByTestId('engrave-registration-approve-start').click();

  // The run dies on its M491 read — BEFORE the operator's fit-probe confirm is ever asked, so
  // there is no Continue to press (the #1179 walk's prompt is for a run that gets past the length
  // read; this press never does). The card states the transport error…
  const failed = page.getByTestId('engrave-registration-failed');
  await expect(failed).toBeVisible({ timeout: 120_000 });
  await expect(failed).toContainText('read failed: Connection reset by peer (os error 104)');
  // …and offers the stop's OWN report. NOTHING has been posted: the action is the only door.
  await expect(page.getByTestId('stop-report-send')).toHaveText('Send a report of this stop');
  expect(reports).toHaveLength(0);

  fs.mkdirSync(OUT, { recursive: true });
  await failed.screenshot({ path: path.join(OUT, 'register-stopped.png') });

  await page.getByTestId('stop-report-send').click();
  await expect(page.getByTestId('stop-report-sent')).toContainText('crash-reports/stop-1794342073154-1.json');
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report['kind']).toBe('casemaker-machine-stop-report');
  expect(report['version']).toBe(1);
  expect(report['action']).toBe('register');
  expect(String(report['error'])).toContain('read failed: Connection reset by peer (os error 104)');
  // THIS press's transcript: the lines it sent, including the one whose answer never came.
  const transcript = report['transcript'] as { line: string; reply: string }[];
  const m491 = transcript.find((entry) => entry.line === 'M491');
  expect(m491, 'the transcript carries the M491 press').toBeTruthy();
  expect(m491!.reply).toContain('read failed');
  expect(transcript.some((entry) => entry.line === '?')).toBe(true);
  // The machine's last status line, the build and the job it was registering.
  expect(String(report['lastStatus'])).toMatch(/^</);
  const app = report['app'] as { version: string; desktop: boolean };
  expect(typeof app.version).toBe('string');
  expect(app.desktop).toBe(true);
  const job = report['job'] as { id: string; name: string; packageHash: string | null };
  expect(job.id.length).toBeGreaterThan(0);
  expect(typeof job.name).toBe('string');
});
