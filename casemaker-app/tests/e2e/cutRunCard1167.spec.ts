// #1167 — STEP 3 AS ONE CARD: every program in run order, the flip row between the sides, and the
// fixed Pause/Stop row that does not move between states.
//
// The 20-program two-sided job is SEEDED through the app's own engine (a frozen package built by
// `freezePackage` from two setups and twenty program inputs) so this spec measures the card, not
// a 20-minute generate. The run states are the release store's and the machine-run store's own
// entries — the same fields the live watch writes — so the card reads what it reads at the bench.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(240_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-11-10-cut-card-1167');
const MACHINE = '192.0.2.10:2222';

function locationDoc(): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'unit', 'fixtures', 'location-doc.json'), 'utf8'));
}

async function fakeHouse(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"e1"' }, body: JSON.stringify(body) });
    if (p === '/health') {
      return json({ ok: true, schemaVersion: 1, build: 'e2e', hasCatalogue: false, feedRows: 0, materialSpecRows: 0, catalogueSyncedAt: null, lastSync: null, problems: [], warnings: [] });
    }
    if (p === '/tools') return json([]);
    if (p === '/inventory') return json((locationDoc() as { inventory?: unknown }).inventory ?? []);
    if (p === '/stock') return json((locationDoc() as { stock?: unknown }).stock ?? []);
    if (p === '/defaults') return json((locationDoc() as { defaults?: unknown }).defaults ?? {});
    if (p === '/location') return json(locationDoc());
    return route.fulfill({ status: 404, body: '' });
  });
}

const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

async function rememberMachine(page: Page): Promise<void> {
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      { name: 'QA Z1', host: '192.0.2.10', port: 2222, busy: false, ip: null, mac: null, status: line, profileId: 'Z1', observedAt: '2026-10-25T00:00:00.000Z', notes: [] },
      line,
    );
  }, STATUS);
}

/** Seed the two-sided job, its 20-program frozen package, and a run state. */
async function seed(page: Page, input: { count: number; phase: string; active: number | null; paused?: boolean }): Promise<void> {
  await page.evaluate(async (opts) => {
    const defaults = await import('/src/engine/cnc/engrave/defaults.ts');
    const pkgMod = await import('/src/engine/cnc/engrave/package.ts');
    const jobStore = await import('/src/store/engraveJobStore.ts');
    const release = await import('/src/store/engraveReleaseStore.ts');
    const run = await import('/src/store/machineRunStore.ts');
    const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' };
    const job = defaults.defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    const ids = job.labels.map((l: { id: string }) => l.id);
    const twoSided = opts.count > 1;
    job.setups = [
      { id: 's1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: ids, tools: ['flat-1.0', 'user:flat-0.6'] },
      ...(twoSided ? [{ id: 's2', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: ids, tools: ['flat-1.0', 'user:flat-0.6'] }] : []),
    ];
    const half = twoSided ? opts.count / 2 : opts.count;
    const inputs = Array.from({ length: opts.count }, (_, i) => ({
      setupIndex: twoSided && i >= half ? 2 : 1,
      setupId: twoSided && i >= half ? 's2' : 's1',
      toolKey: i % 2 === 0 ? 'flat-1.0' : 'user:flat-0.6',
      nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
      frameNc: null,
      programHash: `h${i + 1}`,
    }));
    const made = pkgMod.freezePackage(job, inputs, '2026-11-10T08:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    job.package = made.package;
    job.runLog = [{ at: '2026-11-10T08:00:00.000Z', outcome: 'finished', programHash: 'h1' }];
    jobStore.useEngraveJobStore.setState({ job });
    release.useEngraveReleaseStore.setState({
      records: {
        [opts.machine]: {
          phase: opts.phase,
          active: opts.active,
          vacuum: 'on',
          atMachine: true,
          stopAsked: false,
          job,
          files: inputs.map((p, i) => ({ index: i + 1, toolKey: p.toolKey, done: i === 0, nc: p.nc })),
          walks: { airwalk: null, clean: null },
          next: null,
        },
      },
    } as never);
    run.useMachineRunStore.setState({
      runs: {
        [opts.machine]: {
          running: opts.phase === 'running',
          runId: 1,
          filename: `job-p${(opts.active ?? 0) + 1}.nc`,
          programHash: `h${opts.active ?? 1}`,
          paused: opts.paused === true,
          stopAsked: false,
          progress: opts.phase === 'running' ? { state: 'Run', line: 1972, percent: 62, elapsedS: null } : null,
          firstProgressAt: opts.phase === 'running' ? Date.now() - 120_000 : null,
          pausedMs: 0,
          lines: [],
          outcome: null,
          context: null,
          end: null,
          pendingStock: null,
        },
      },
    } as never);
  }, { ...input, machine: MACHINE });
}

async function openCutStep3(page: Page): Promise<void> {
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step3 = page.getByTestId('engrave-cut-step-3');
  if (!(await step3.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-3-summary').click();
  }
  await expect(page.getByTestId('engrave-cut-card')).toBeVisible();
}

test('#1167 — a 20-program two-sided job is one card: every program, the flip, a fixed control row', async ({ cm, page }) => {
  await fakeHouse(page);
  // Each state is seeded BEFORE the Cut surface mounts: the app's run watch owns a machine-run
  // entry once it is live, and mutating one underneath it starts the watch (a React update loop in
  // the e2e bundle). A fresh boot per state is the honest way to compare the control row's place.
  const measure = async (state: { count: number; phase: string; active: number | null; paused?: boolean }) => {
    await page.goto('/');
    await cm.ready();
    await page.evaluate(async () => {
      await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
      window.__caseMaker!.engraveReset();
    });
    await rememberMachine(page);
    await seed(page, state);
    await openCutStep3(page);
    const card = await page.getByTestId('engrave-cut-card').boundingBox();
    const controls = await page.getByTestId('engrave-cut-card-controls').boundingBox();
    if (card === null || controls === null) throw new Error(`the card is not laid out while ${state.phase}`);
    return { dx: controls.x - card.x, dy: controls.y - card.y, width: controls.width };
  };

  // THE RUNNING STATE, with the list and the running row.
  await page.goto('/');
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await seed(page, { count: 20, phase: 'running', active: 2 });
  await openCutStep3(page);
  await expect(page.getByTestId('engrave-cut-card').first()).toContainText('20 programs');
  await expect(page.getByTestId('engrave-cut-card').first()).toContainText('1 done');
  for (const n of [1, 2, 10, 11, 20]) {
    await expect(page.getByTestId(`engrave-cut-card-row-${n}`)).toBeAttached();
  }
  await expect(page.getByTestId('engrave-cut-card-flip')).toBeAttached();
  await expect(page.getByTestId('engrave-cut-card-row-1')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('engrave-cut-card-running')).toContainText('Program 2 of 20');
  await expect(page.getByTestId('engrave-cut-card-running')).toContainText('62 %');
  fs.mkdirSync(OUT, { recursive: true });
  await page.getByTestId('engrave-cut-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'cut-card-20.png') });

  // THE CONTROL ROW DOES NOT MOVE between idle, running, bit-change and waiting.
  const running = await measure({ count: 20, phase: 'running', active: 2 });
  const paused = await measure({ count: 20, phase: 'running', active: 2, paused: true });
  const idle = await measure({ count: 20, phase: 'ready', active: null });
  const bitChange = await measure({ count: 20, phase: 'bit-change', active: null });
  const waiting = await measure({ count: 20, phase: 'closing', active: null });
  for (const [at, box] of [['paused', paused], ['idle', idle], ['bit-change', bitChange], ['waiting', waiting]] as const) {
    expect(box, `the control row while ${at}`).toEqual(running);
  }
});

test('#1167 — a one-program job is one row and no flip row', async ({ cm, page }) => {
  await fakeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await seed(page, { count: 1, phase: 'idle', active: null });
  await openCutStep3(page);
  await expect(page.getByTestId('engrave-cut-card-row-1')).toBeAttached();
  await expect(page.getByTestId('engrave-cut-card-row-2')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-card-flip')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-card-controls')).toBeVisible();
});
