// #948 — THE MILESTONE'S OWN JOB, IN THE APP: the elephant on the stick, generated and judged
// against its goal. The job is the figure corpus job the demo page calls j29 — the house's
// 36 × 100 × 36 mm hardwood stick, the elephant turned 90° and scaled to fit — loaded through the
// panel's own file door. Generate runs the 3D goal program, the oracle compares its swept top with
// the goal, and the Cut card states the check in the page's words (D's `engrave-cut-goal`).
//
// WHAT TODAY'S RUN SAYS. The goal check passes on cut-into (no cell reaches into the part) and
// fails on COVERAGE: 83.86 % of the design's top surface against the shop's 95 % pass line — the
// demo page's own number, cell for cell. D's line states exactly that — state "coverage", "Covers
// 83.86 % of the design’s top surface (the pass line is 95 %)" — and the line below it prints the
// measured coverage as a fact. #945 is the work that lifts the last 16.14 points; the "Matches the
// design (goal)" case below is a `test.fixme` whose header names it, because a red acceptance test
// cannot land.
//
// MEASURED: Generate through the goal check takes about 30-35 s on an idle box (two programs,
// each judged against the goal's accumulated surface). A whole-suite run
// (the T3 window) can stretch that into minutes, so the waits here are 20 minutes and the test's
// own timeout is 25.
//
// THE MESH IS LOCAL-ONLY on purpose (samples/3d/lfs_elephant.stl is not committed): j29 carries its
// sha256, not its bytes. The spec injects the checkout's file when it is present and SKIPS on a
// machine without it — the job's own `targetObject.sha256` is checked against the file so a stale
// copy cannot masquerade as the corpus mesh.
//
// THE LOCATION IS THE DEMO'S FULL-LIBRARY ONE, not the owned set: `~/casemaker-manager/
// demo-build/location.json` (CASEMAKER_DEMO_LOCATION overrides), the same document the demo page's
// cards are judged on — 134 cutters, the full Makera library. It is local-only too, so the spec
// skips without it. The house also serves the catalogue's own `cat:` cutter definitions and its
// 1,328 feed rows (the app's real house), not just the location's 12 seeded rows. The app posts TWO
// programs — the job's `inv:lib-161032205031` (⌀2 ball) and the ⌀0.5 ball's rest — and the run's
// oracle walk judges EVERY program of a goal job against the goal's accumulated surface (C's
// 4d20e45b), so the Cut card reads the page's own 83.86 %, not the finish program's 51.87 %.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { test, expect } from './fixtures/caseMaker';
import { serveHouse } from './fixtures/fakeHouse';

test.setTimeout(1_500_000);

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOB = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs', 'j29-elephant-stick.json');
const MESH = join(REPO, 'samples', '3d', 'lfs_elephant.stl');
const LOCATION_FIXTURE = join(HERE, '..', 'unit', 'fixtures', 'location-doc.json');
/**
 * THE DEMO'S FULL-LIBRARY LOCATION — the same document the demo page's cards are judged on
 * (`--location`'s default in docs/bench/2026-10-28-z1-real-jobs/tools/build.py): the house's own
 * cutters plus the full Makera library, 134 entries. The maintainer's rule for the gate: a demo
 * job is validated against the full Makera catalogue, not the owned set. The file is local-only
 * (a fetched catalogue is never committed), so the spec skips when it is absent, like the mesh.
 */
const DEMO_LOCATION = process.env.CASEMAKER_DEMO_LOCATION ?? join(homedir(), 'casemaker-manager', 'demo-build', 'location.json');
const HAVE_LOCATION = existsSync(DEMO_LOCATION);
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-goal-card-'));

test.afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
};

interface JobFile {
  name: string;
  targetObject: { data?: string; sha256?: string; position: { x: number; y: number; z: number } };
}

/** j29 with the checkout's mesh injected; null when the local-only mesh is absent. */
function elephantJob(dx: number): { path: string; name: string } | null {
  if (!existsSync(MESH)) return null;
  const job = JSON.parse(readFileSync(JOB, 'utf8')) as JobFile;
  const bytes = readFileSync(MESH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (job.targetObject.sha256 !== undefined && job.targetObject.sha256 !== sha) return null;
  job.targetObject.sha256 = sha;
  job.targetObject.data = bytes.toString('base64');
  job.targetObject.position.x += dx;
  const path = join(SCRATCH, dx === 0 ? 'j29-elephant-stick.job.json' : 'j29-elephant-overhang.job.json');
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(path, JSON.stringify(job));
  return { path, name: job.name };
}

/** The fixture location with the demo cutter in its inventory, served as the house. */
async function fakeHouse(page: Page): Promise<void> {
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as {
    inventory: unknown[];
    accessories: unknown[];
    machines: unknown[];
    stock: unknown;
    defaults: unknown;
    kind: string;
    schemaVersion: number;
    id: string;
    name: string;
    createdAt: string;
  };
  const demo = JSON.parse(readFileSync(DEMO_LOCATION, 'utf8')) as {
    inventory: unknown[];
    stock: unknown;
    defaults: unknown;
  };
  // The catalogue beside the location is the shop's full Makera sync — the cutters the panel can
  // pick from (`cat:` rows) and the 1,328 feed rows. The house serves it on `/tools` and `/feeds`;
  // the location's own 12 seeded rows are what the CLI reads, not what the app's house holds.
  const catalogue = JSON.parse(readFileSync(join(dirname(DEMO_LOCATION), 'catalogue.json'), 'utf8')) as {
    tools: unknown[];
    feeds: unknown[];
  };
  // The fixture's machine and accessories stay: the vise mount rule (#930) reads them. Everything
  // the job is judged on — the cutters, their feeds, the stock and the defaults — is the demo's.
  const view = {
    kind: doc.kind,
    schemaVersion: 1,
    id: doc.id,
    name: 'House + full Makera library (demo)',
    createdAt: doc.createdAt,
    migratedFrom: null,
    machines: doc.machines,
    accessories: doc.accessories,
  };
  await serveHouse(page, {
    health: { ...HEALTH, feedRows: catalogue.feeds.length, hasCatalogue: true },
    tools: catalogue.tools,
    feeds: catalogue.feeds,
    inventory: demo.inventory,
    stock: demo.stock ?? [],
    defaults: demo.defaults ?? {},
    location: view,
    writes: 'ok',
  });
}

/** The panel's own file door: the job opened from disk. */
async function openJob(page: Page, file: string, name: string): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(file);
  await expect(page.getByTestId('engrave-job-file-name')).toContainText(name);
}

/** The run's goal report, read from the store that the Cut card renders from. */
async function goalReport(page: Page): Promise<{
  ran: boolean;
  ok: boolean;
  cutIntoFraction: number;
  cutIntoAreaMm2: number;
  maxCutIntoMm: number;
  leftoverFractions: number[];
} | null> {
  return page.evaluate(async () => {
    const m = await import('/src/store/engraveRunStore.ts' as string);
    const report = m.useEngraveRunStore.getState().oracle?.goalCutInto ?? null;
    return report === null
      ? null
      : {
          ran: report.ran,
          ok: report.ok,
          cutIntoFraction: report.cutIntoFraction,
          cutIntoAreaMm2: report.cutIntoAreaMm2,
          maxCutIntoMm: report.maxCutIntoMm,
          leftoverFractions: [...report.leftoverFractions],
        };
  });
}

test('#948 — the elephant on the stick states its goal check: zero cut-into, the coverage below the pass line', async ({ cm, page }) => {
  const job = elephantJob(0);
  test.skip(
    job === null || !HAVE_LOCATION,
    'the local-only elephant mesh or the demo full-library location is absent',
  );
  await fakeHouse(page);
  await cm.ready();
  await openJob(page, job!.path, job!.name);

  // The goal is the panel's own: a 3D job, its row enabled and aimed at the stick.
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();

  const started = Date.now();
  await page.getByTestId('engrave-generate').click();
  // The run ends with the oracle's verdict; today it is a cross on the coverage pass line.
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'cross', { timeout: 1_200_000 });
  const generateMs = Date.now() - started;
  console.log(`GOAL-CARD j29 generate+check ${generateMs} ms`);
  expect(generateMs, 'the run fits the spec budget').toBeLessThan(1_200_000);

  // The store's own numbers: the check ran, nothing was cut into the part, the top surface is
  // 83.86 % covered — the failure is the pass line, not a cut.
  const report = await goalReport(page);
  expect(report, 'the run carries a goal report').not.toBeNull();
  expect(report!.ran).toBe(true);
  expect(report!.ok).toBe(false);
  expect(report!.cutIntoFraction).toBe(0);
  expect(report!.cutIntoAreaMm2).toBe(0);
  expect(report!.maxCutIntoMm).toBe(0);

  // Cut's step 1: the gate failed, and D's goal line states the coverage failure in the page's
  // words — not a "0 mm" cut (the branch D fixed in 5ceeeb1e).
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('engrave-cut-goal')).toHaveAttribute('data-state', 'coverage');
  await expect(page.getByTestId('engrave-cut-goal')).toHaveText(
    'Covers 83.86 % of the design’s top surface (the pass line is 95 %)',
  );
  await expect(page.getByTestId('engrave-cut-goal-coverage')).toHaveText(
    'Top-surface coverage: 83.86 % (the pass line is 95 %)',
  );
});

// #945 — THE PASS CASE, WAITING ON B'S REST PASS. The shop's pass line asks 95 % of the design's
// top surface; today's run leaves 83.86 %. When #945 lands, this flips to a tick and the Cut card
// reads "Matches the design (goal)" (state "match"). A red acceptance test cannot land, so it is a
// fixme that names its blocker.
test.fixme('#945 — the elephant matches the design, in the page’s words', async ({ cm, page }) => {
  const job = elephantJob(0);
  test.skip(
    job === null || !HAVE_LOCATION,
    'the local-only elephant mesh or the demo full-library location is absent',
  );
  await fakeHouse(page);
  await cm.ready();
  await openJob(page, job!.path, job!.name);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 1_200_000 });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-goal')).toHaveAttribute('data-state', 'match');
  await expect(page.getByTestId('engrave-cut-goal')).toHaveText('Matches the design (goal)');
});

// #949 — THE OVERHANG CASE. The same job with the goal moved 8 mm past an edge: the CAM refuses
// it before a toolpath exists (e9713980) and the sentence reaches the run-error line (ede8b07d) —
// both are in this tree, so the case runs; on the pre-#949 set it was a fixme naming those two
// commits.
test('#949 — an elephant moved past the edge is refused at the CAM, and the line says so', async ({ cm, page }) => {
  const job = elephantJob(8);
  test.skip(
    job === null || !HAVE_LOCATION,
    'the local-only elephant mesh or the demo full-library location is absent',
  );
  await fakeHouse(page);
  await cm.ready();
  await openJob(page, job!.path, job!.name);

  await page.getByTestId('engrave-generate').click();
  const errors = page.getByTestId('engrave-run-errors');
  await expect(errors).toContainText('larger than the blank', { timeout: 120_000 });
  await expect(errors).toContainText(/mm past the (left|right|front|back) edge/);

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('engrave-cut-verdict-sentence')).toContainText('larger than the blank');
});
