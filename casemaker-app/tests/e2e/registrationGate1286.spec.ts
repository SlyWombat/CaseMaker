// #1179 B — RESTARTING A JOB ON A BLANK THAT HAS BEEN CUT, in the real UI against the fake machine.
//
// Today's tray is the UNKNOWN-CUTS case: the machine's finished hashes are not in the current
// package (the plan was regenerated), so the check points sit outside today's footprint at d = 0
// and the record says the earlier cuts are not recorded. The top is the highest implied level two
// touches agree on; a hidden floor under one candidate is out-voted, and a chip above three tops
// is named and not used. The origin is written from the accepted top.
//
// Screenshots: /mnt/house/casemaker/qa/2026-11-10/1179/.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse, stockNext } from './fixtures/caseMaker';
import { installFakeConsole, type FakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);


const SEAT_Z = -85.788;
const STOCK_MM = 25;
const TOP_READING = -60.788;

type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  machines: Array<Record<string, unknown> & { finishedPrograms?: string[]; bedProfiles?: Array<Record<string, unknown>> }>;
  accessories: Array<Record<string, unknown>>;
  stock?: unknown;
  inventory?: unknown;
  defaults?: Record<string, unknown>;
};

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as Doc;

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

/**
 * The bench's location: the machine has a finished program that is NOT in the package (the
 * unknown-cuts case), the active profile carries the measured seat, the bracket sits at anchor 1,
 * and the surface tolerance is the live shop's 0.7 (the fixture seeds 0.4).
 */
function locationView(machineOverride: Record<string, unknown> | null = null): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = doc.machines[0]!;
  machine.finishedPrograms = ['fake-finished-1'];
  const profile = machine.bedProfiles![0]! as {
    placements?: Array<{ where?: { kind?: string } }>;
    datums: Record<string, unknown>;
  };
  profile.datums['bracketSeatZ'] = {
    value: SEAT_Z,
    measuredAt: '2026-11-09T17:55:01.000Z',
    by: 'fx-probe-1',
    at: [-175, -35],
    restsOnStock: true,
    // #1189 — the probe's M491 when the seat was measured (the fake console's own reading).
    probeRefZ: -80,
  };
  profile.placements = (profile.placements ?? []).filter(
    (pl) => ((pl as { where?: { kind?: string } }).where?.kind ?? '') !== 'pins',
  );
  profile.placements.push({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'anchor', anchor: 1, pins: null },
    count: null,
    frame: null,
    provenance: {},
  } as never);
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    machines: machineOverride === null ? doc.machines : [machineOverride],
    accessories: doc.accessories,
  };
}

async function fakeHouse(page: Page): Promise<{
  /** The machine record the app last PUT (the mint's write), or null. */
  writtenMachine: () => Record<string, unknown> | null;
}> {
  // #1179 — the machine write is real in this walk: the "This is a new blank" press PUTs the
  // machine record and the next read serves it back, so `currentBlank` genuinely moves.
  let machineOverride: Record<string, unknown> | null = null;
  // #1179 — the ETag moves on EVERY machine write, as the service's does: its ETag is computed
  // over the served bytes (`src-tauri/src/etag.rs`), so two writes are two validators. The
  // location store refuses a read whose validator it already holds ("the same read without
  // churn"); a one-step ETag left the card reading the pre-mint record once #1202's completion
  // write made the mint the SECOND machine PUT of this walk.
  let etag = '"e1"';
  let writes = 0;
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag }, body: JSON.stringify(body) });
    if (p === '/health') return json(HEALTH);
    if (p === '/tools') return json([]);
    if (p === '/inventory') return json(DOC.inventory ?? []);
    if (p === '/stock') return json(DOC.stock ?? []);
    if (p === '/defaults') {
      const defaults = JSON.parse(JSON.stringify(DOC.defaults ?? {})) as Record<string, unknown>;
      // The live shop's tolerance (chosen 2026-10-23); the fixture seeds 0.4.
      defaults['registration.surfaceToleranceMm'] = { value: 0.7, source: 'chosen', setAt: '2026-10-23', unit: 'mm' };
      return json(defaults);
    }
    if (route.request().method() === 'PUT' && /^\/location\/machines\/[^/]+$/.test(p)) {
      machineOverride = route.request().postDataJSON() as Record<string, unknown>;
      writes += 1;
      etag = `"e${writes + 1}"`;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { etag }, body: '{}' });
    }
    if (p === '/location') return json(locationView(machineOverride));
    return route.fulfill({ status: 404, body: '' });
  });
  return { writtenMachine: () => machineOverride };
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

async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  // #1100 — the sixteen chips live under the Something else… card now.
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill(String(dims[0]));
  await page.getByTestId('start-wizard-make-width').fill(String(dims[1]));
  await page.getByTestId('start-wizard-make-thickness').fill(String(dims[2]));
  await stockNext(page);
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

/** The shared walk up to the Register press, with the pocket centred and Generate green. */
async function prepare(page: Page): Promise<void> {
  await rememberMachine(page);
  await typePlate(page, [100, 60, STOCK_MM]);
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
  // #1179 amendment (2026-11-10) — the card says WHERE the checks will touch, before the press,
  // so the operator can clear those spots: they sit inset from the stock's edges, not on the
  // corners where the bench's first touch met a pile.
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('in from the stock');
  // #1202 (later) — a routine whose first run this machine has never seen is held until the
  // card's own first-run statement is ticked.
  const firstRunTick = page.getByTestId('engrave-registration-first-run-tick');
  if ((await firstRunTick.count()) > 0) await firstRunTick.check();
}

/** The Cut step 2 fold may close itself after a run; the card's presses need it open. */
async function ensureStep2(page: Page): Promise<void> {
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
}

async function writeOriginAndExpect(page: Page, fake: FakeConsole, z: string): Promise<void> {
  // The approved plan changed the job, so Cut's step 1 has findings now and may have folded step 2;
  // the write press needs the card on screen.
  await ensureStep2(page);
  await page.getByTestId('engrave-registration-write').click();
  await page.getByTestId('engrave-registration-continue').click();
  await expect.poll(() => fake.lines().find((l) => l.startsWith('G10 L2 P1')) ?? null, { timeout: 60_000 }).not.toBeNull();
  expect(fake.lines().find((l) => l.startsWith('G10 L2 P1'))).toContain(`Z${z}`);
}


/** Step 3's cutter row, ticked with the card's own checkbox — a real press. */
async function locateCutter(page: Page): Promise<void> {
  const row = page.getByTestId('engrave-cutter-row').first();
  // Step 3 may be open already, or folded: give the row a moment, then open the step once.
  await row.waitFor({ state: 'visible', timeout: 8000 }).catch(async () => {
    const step3 = page.getByTestId('engrave-cut-step-3');
    if (!(await step3.evaluate((el) => (el as HTMLDetailsElement).open))) await page.getByTestId('engrave-cut-step-3-summary').click();
  });
  await expect(row).toBeVisible({ timeout: 60_000 });
  const box = row.locator('input[type=checkbox]').first();
  if (!(await box.isChecked())) await box.check();
}

const wireSent = (fake: FakeConsole): string[] => fake.lines().filter((l) => l.startsWith('upload') || l.startsWith('play'));

test('#1286 — NOT registered: ticking the cutter does not make Start live, it says why, and nothing is sent', async ({ cm, page }) => {
  page.setDefaultTimeout(30_000);
  await fakeHouse(page);
  const fake = await installFakeConsole(page);
  await cm.ready();
  await prepare(page);
  await locateCutter(page);
  await page.waitForTimeout(2500);
  const start = page.getByTestId('engrave-cut-card-start');
  await expect(start).toBeDisabled();
  await expect(page.getByTestId('engrave-cut-card-start-reason')).toContainText('Register this job first');
  // Even a forced press changes nothing: the gate is not only on the button.
  await start.click({ force: true, timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  expect(wireSent(fake), 'nothing uploaded or played').toEqual([]);
});

test('#1286 — a registration that was STOPPED part-way is not a registration', async ({ cm, page }) => {
  page.setDefaultTimeout(30_000);
  await fakeHouse(page);
  const fake = await installFakeConsole(page);
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: TOP_READING });
  await cm.ready();
  await prepare(page);
  await ensureStep2(page);
  const tick = page.getByTestId('engrave-registration-first-run-tick');
  if ((await tick.count()) > 0) await tick.check();
  await page.getByTestId('engrave-registration-approve-start').click();
  // Abandon it before the origin is written: Stop, if the card offers it at this point.
  const stop = page.getByTestId('engrave-registration-stop');
  if ((await stop.count()) > 0 && (await stop.isEnabled())) await stop.click();
  await locateCutter(page);
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('engrave-cut-card-start')).toBeDisabled();
  expect(wireSent(fake)).toEqual([]);
});

test('#1286 — REGISTERED (real presses): Start is live and sends the program as before', async ({ cm, page }) => {
  page.setDefaultTimeout(30_000);
  await fakeHouse(page);
  const fake = await installFakeConsole(page);
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: TOP_READING });
  await cm.ready();
  await prepare(page);
  await ensureStep2(page);
  const tick = page.getByTestId('engrave-registration-first-run-tick');
  if ((await tick.count()) > 0) await tick.check();
  await page.getByTestId('engrave-registration-approve-start').click();
  await page.getByTestId('engrave-registration-continue').click();
  await expect(page.getByTestId('engrave-registration-notes')).toContainText('the top was measured on a cut blank', { timeout: 120_000 });
  await writeOriginAndExpect(page, fake, '-60.788');
  // Approving the plan edited the job, so the frozen program is older than the design: regenerate it
  // (a real press), then the cutter row.
  const regen = page.getByTestId('engrave-package-generate');
  if ((await regen.count()) > 0 && (await regen.isVisible())) {
    await regen.click();
    await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  }
  await locateCutter(page);
  await expect(page.getByTestId('engrave-cut-card-start')).toBeEnabled({ timeout: 60_000 });
});
