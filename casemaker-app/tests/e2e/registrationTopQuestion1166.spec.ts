// #1179 B (supersedes #1166 c1's question) — A CUT BLANK MEASURES, on a bracket job, in the real UI.
//
// The unit specs prove the executor; these walks prove the card, against a fake controller: a
// bracket job on a bed whose profile carries a MEASURED bracket seat, the desktop bundle served
// headless (the bench's own path) with the fake console answering `/api/v1/machine/tcp/*`.
//
// Test 1 — the machine record has finished programs, and THIS package's hashes are not among them
// (the everyday restart: the package was regenerated). #1179 B treats the blank as cut with unknown
// earlier cuts: spread check points on uncut wood, touched and proved — the typed-Z QUESTION #1166
// c1 added is gone from the operator flow (B6). With a fake that finds nothing at any point, the
// proof stops and names every reading; a single reading is never taken as the top, and nothing is
// written. (The agreeing-pair success path is `restartRegistration1179.spec.ts`'s two walks.)
//
// Test 2 — no finished programs: no checks, the plain seek finds the fake's top, the origin is
// written from it.
//
// Screenshots: /mnt/house/casemaker/qa/2026-11-10/1166/.
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

const OUT = '/mnt/house/casemaker/qa/2026-11-10/1166';
/** The bench's own seat, carried on the profile and measured by the checked-out probe. */
const SEAT_Z = -85.788;
/** The job the wizard builds below. */
const STOCK_MM = 25;

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
 * The fixture location, made the bench's: the machine has FINISHED PROGRAMS (the machine-level
 * flag the question is guarded by), the active profile carries the measured bracket seat (taken by
 * the checked-out wired probe, so it is usable), and the bracket sits at anchor 1 so the wizard
 * defaults to the bracket hold.
 */
function locationView(finished: readonly string[]): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = doc.machines[0]!;
  machine.finishedPrograms = [...finished];
  const profile = machine.bedProfiles![0]! as {
    placements?: Array<{ where?: { kind?: string } }>;
    datums: Record<string, unknown>;
  };
  profile.datums['bracketSeatZ'] = {
    value: SEAT_Z,
    measuredAt: '2026-11-09T17:55:01.000Z',
    by: 'fx-probe-1',
    at: [-175, -35],
    // The seat IS the surface the stock rests on, so the under board is not added again.
    restsOnStock: true,
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
    machines: doc.machines,
    accessories: doc.accessories,
  };
}

/** The house the app reads: lists, defaults, and the location above. */
async function fakeHouse(page: Page, finished: readonly string[]): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });
    if (p === '/health') return json(HEALTH);
    if (p === '/tools') return json([]);
    if (p === '/inventory') return json(DOC.inventory ?? []);
    if (p === '/stock') return json(DOC.stock ?? []);
    if (p === '/defaults') return json(DOC.defaults ?? {});
    if (p === '/location') return json(locationView(finished));
    return route.fulfill({ status: 404, body: '' });
  });
}

/** A status line with the monitor fields the state popover reads. */
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

/** Door → stock/operation → the Holding step, with the wizard's own controls (the #725 walk). */
async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill(String(dims[0]));
  await page.getByTestId('start-wizard-make-width').fill(String(dims[1]));
  await page.getByTestId('start-wizard-make-thickness').fill(String(dims[2]));
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

test('#1179 B — with finished programs on the machine the run MEASURES a cut blank: no question, and a stop that names every reading', async ({
  cm,
  page,
}) => {
  // The house first, the fake machine second: Playwright runs the LAST route first, and the fake's
  // /api/v1/machine/** must win over the generic 404.
  await fakeHouse(page, ['fake-finished-1']);
  const fake = await installFakeConsole(page);
  await cm.ready();
  await rememberMachine(page);

  // A bracket job on the bench's own seat: the wizard's 100 × 60 plate at the bench's thickness,
  // the bed's bracket.
  await typePlate(page, [100, 60, STOCK_MM]);
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();

  // A pocket at the stock's centre (the shape's X/Y is its CENTRE), clear of the bracket's front
  // arm and back clamps; then Generate — the Cut statement (and so the Register press) is only
  // armed once a program exists.
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });

  // Cut: step 1's statement, then step 2's Register card and its one press.
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
  // The proposal is the MEASURED-SEAT bracket plan (one top touch), now carrying check points: the
  // machine record has finished programs and THIS package's hashes are not among them, so #1179 B
  // treats the blank as cut with unknown earlier cuts.
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('then the top');
  const approve = page.getByTestId('engrave-registration-approve-start');
  await expect(approve).toHaveText('Register');
  await approve.click();

  // The mount confirm comes first, as on the plain seek — and the typed-Z QUESTION #1166 c1 added
  // is gone from the operator flow (B6): a cut blank is MEASURED, never asked about.
  await page.getByTestId('engrave-registration-continue').click();
  await expect(page.getByTestId('engrave-registration-top-question')).toHaveCount(0);

  // The fake has no feature seeded, so every check reads no contact: the proof stops and names
  // every reading — a single reading is never taken as the top — and nothing is written.
  const failed = page.getByTestId('engrave-registration-failed');
  await expect(failed).toContainText('the top on this cut blank could not be proved', { timeout: 120_000 });
  await expect(failed).toContainText('found nothing at');
  await expect(failed).toContainText('no two implied tops agree');
  expect(fake.lines().filter((l) => l.startsWith('G38.3')).length, 'the check points were touched').toBeGreaterThanOrEqual(3);
  expect(fake.lines().filter((l) => l.startsWith('G10 L2 P1')), 'a stop writes nothing').toEqual([]);

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'cut-blank-stop.png') });
});

test('#1166 c1 — a job with NO finished programs takes the plain seek, and the origin is written', async ({
  cm,
  page,
}) => {
  // The same walk, but the machine record has no finished programs: no question; the seek runs and
  // finds a top the fake puts at the plan's expected surface.
  await fakeHouse(page, []);
  const fake = await installFakeConsole(page);
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: -60.788 });
  await cm.ready();
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
  await page.getByTestId('engrave-registration-approve-start').click();
  // The seek path keeps the #427 clamp confirm (the question's answers skip it): it asks before
  // the probe moves, so the walk answers it, then the seek runs.
  await page.getByTestId('engrave-registration-continue').click();

  // NO question: the plain seek probes, finds the fake's top, and the card records the reading.
  await expect(page.getByTestId('engrave-registration-notes')).toContainText('rim offset', { timeout: 120_000 });
  expect(await page.getByTestId('engrave-registration-top-question').count()).toBe(0);
  expect(fake.lines().filter((l) => l.startsWith('G38.3')).length).toBeGreaterThan(0);

  // The approval changed the job, so Cut's step 1 has findings now and may have folded step 2;
  // the write press needs the card on screen.
  const step2b = page.getByTestId('engrave-cut-step-2');
  if (!(await step2b.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  await page.getByTestId('engrave-registration-write').click();
  await page.getByTestId('engrave-registration-continue').click();
  await expect.poll(() => fake.lines().find((l) => l.startsWith('G10 L2 P1')) ?? null, { timeout: 60_000 }).not.toBeNull();
  expect(fake.lines().find((l) => l.startsWith('G10 L2 P1'))).toContain('Z-60.788');
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'plain-seek-result.png') });
});
