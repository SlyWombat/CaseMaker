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
    const defaults = await import('/src/engine/cnc/engrave/defaults.ts' as string);
    const pkgMod = await import('/src/engine/cnc/engrave/package.ts' as string);
    const tools = await import('/src/engine/cnc/tool.ts' as string);
    const registry = await import('/src/engine/cnc/toolRegistry.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    // A USER-DEFINED bit, registered so its operator name resolves: the card must never print an
    // internal key (`user:`/`inv:`/`lib:`) in a row.
    registry.setRegistry([
      { key: 'user:flat-0.6', tool: tools.flatEndMill(0.6, { name: '0.6 mm flat end' }), provenance: 'e2e' },
    ]);
    const release = await import('/src/store/engraveReleaseStore.ts' as string);
    const run = await import('/src/store/machineRunStore.ts' as string);
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

/**
 * #1123 item 8 follow-up — the run store's half of a PRESSABLE card: this package is the design's
 * (the input stamps match), every program carries a passing report, and the statement is given.
 * The READY seed alone leaves `programBlocker`/the release gate refusing (no reports, no stamps),
 * which is how a permanently disabled multi-program Start once slipped past a text-only assertion.
 */
async function seedVerifiedRun(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const runStore = await import('/src/store/engraveRunStore.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    const job = jobStore.useEngraveJobStore.getState().job as {
      package?: { hash: string; programs: { setupIndex: number; setupId: string; toolKey: string; nc: string; hash: string }[] };
    };
    const pkg = job.package;
    if (pkg === undefined) throw new Error('the seed did not freeze a package');
    const VERIFY = { ok: true, findings: [], stats: { lines: 3, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, -0], max: [1, 1, 0] } } };
    const generated = {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      threadMachining: null,
      cam: null,
      nc: pkg.programs[0]?.nc ?? null,
      verify: VERIFY,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      predicted: [],
      errors: [],
      programs: pkg.programs.map((p) => ({
        setupIndex: p.setupIndex,
        setupId: p.setupId,
        toolKey: p.toolKey,
        nc: p.nc,
        verify: VERIFY,
        frameNc: null,
        frameVerify: null,
        programHash: p.hash,
        cam: null,
      })),
    };
    runStore.useEngraveRunStore.setState({
      generated,
      inputs: runStore.currentRunInputStamps(),
      shopSignature: runStore.runShopSignature(),
      phase: 'ready',
      acknowledged: true,
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
      simStatus: 'ready',
      simDiagnostics: [],
    } as never);
    // #1127 — every cutter row settled, through the job's own action (the same write a tick makes).
    for (const key of [...new Set(pkg.programs.map((p) => p.toolKey))]) {
      jobStore.useEngraveJobStore.getState().setCutterChecklistEntry(pkg.hash, key, { state: 'located', at: new Date().toISOString() });
    }
  });
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

test('#1167 — a 20-program two-sided job is one card: every program, the flip, and ONE Start', async ({ cm, page }) => {
  await fakeHouse(page);

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
  // NO INTERNAL KEY IN A ROW: the operator reads the cutter's name, user-defined bits included.
  const rowTexts = await page.locator('[data-testid^="engrave-cut-card-row-"]').allTextContents();
  expect(rowTexts.length).toBe(20);
  for (const text of rowTexts) expect(text, text).not.toMatch(/\b(user|inv|lib):/);
  expect(await page.getByTestId('engrave-cut-card-running').textContent()).not.toMatch(/\b(user|inv|lib):/);
  await expect(page.getByTestId('engrave-cut-card-row-2')).toContainText('0.6 mm flat end');
  await expect(page.getByTestId('engrave-cut-card-running')).toContainText('Program 2 of 20');
  await expect(page.getByTestId('engrave-cut-card-running')).toContainText('62 %');
  fs.mkdirSync(OUT, { recursive: true });
  await page.getByTestId('engrave-cut-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'cut-card-20.png') });

  // #1123 item 8 — RUNNING: the Start is gone and the card's controls are Pause/Stop.
  await expect(page.getByTestId('engrave-cut-card-controls')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-card-start')).toHaveCount(0);

  // #1123 item 8 — READY: ONE Start with the ready line, and NO Pause/Stop; the old step-3 block
  // ("Cut <job>" / "Run <file>.nc") is not rendered while the card is present.
  await page.goto('/');
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await seed(page, { count: 20, phase: 'ready', active: null });
  await seedVerifiedRun(page);
  await openCutStep3(page);
  // #1123 item 8 follow-up — THE STATEMENT, given in step 1 where it lives, so the card below is
  // in its PRESSABLE state: the only remaining gate would be a real refusal.
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  const ack = page.getByTestId('engrave-ack');
  if (!(await ack.isChecked())) {
    await page.evaluate(() => document.querySelector<HTMLInputElement>('[data-testid="engrave-ack"]')?.click());
  }
  await expect(ack).toBeChecked();
  // The seed's program 1 is already done, so READY names program 2 and the bit it needs.
  await expect(page.getByTestId('engrave-cut-card-ready')).toContainText('Ready · program 2 of 20 · next: ');
  await expect(page.getByTestId('engrave-cut-card-start')).toContainText('Start program 2 of 20');
  // #1123 item 8 — AND IT IS PRESSABLE. The count sentence this card used to carry ("this job is
  // 20 programs; the app plays one") was a permanently disabled Start on the card's own flow; a
  // text-only pin let it through. The release gate is the card's, and it passes here.
  await expect(page.getByTestId('engrave-cut-card-start-reason')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-card-start')).toBeEnabled();
  await expect(page.getByTestId('engrave-cut-card-pause')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-card-stop')).toHaveCount(0);
  await expect(page.getByTestId('engrave-cut-card-running-slot')).toHaveCount(0);
  // The 150 px reserved block is gone; the card's height is its content.
  await expect(page.getByTestId('engrave-cut-go')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-start')).toHaveCount(0);
  await expect(page.getByTestId('engrave-release-start')).toHaveCount(0);
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
  // #1123 item 8 — the one-program job's card is the ONE Start, not a control row.
  await expect(page.getByTestId('engrave-cut-card-start')).toContainText('Start program 1 of 1');
  await expect(page.getByTestId('engrave-cut-card-controls')).toHaveCount(0);
});
