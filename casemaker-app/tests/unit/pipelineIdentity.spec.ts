// #922 — ONE PIPELINE: the UI's Generate and `casemaker cut` post the same program.
//
// A simulated verdict is a verdict on the program the operator will run. Today the two doors do not
// agree: on 2026-11-02 `j13-tool-tray` against the same k3 catalogue + location posted
// 10000 rpm / F1000 / 300 plunge, 483 depth passes (2 h 49 m) from the app's Generate and
// 12000 / F500 / 200, 720 passes ≤ 0.5 mm (8 h 26 m) from `casemaker cut` — same cutter
// `inv:kz-o-flute-3-175-25`, same job file. This spec is the line that fails until they are one
// pipeline, and it stays as the regression guard after.
//
// HOW THE TWO PATHS ARE DRIVEN, on one job + one location:
//
//   * the CLI path is the real command: `engraveJobMain([job, '--out', …, '--location', …])`; the
//     `.nc` is read back from its own receipt.
//   * the worker path is the function the UI's Generate reaches, `engraveGenerate`, handed the shop
//     the app builds for that location (`engraveRunStore.ts`'s `shop` object — every field below
//     is one of its lines), the catalogue the house service serves (`loadCatalogue`, the same file
//     the CLI reads) and the worker's own tool resolution.
//
// The location is the committed fixture plus the house's 29 `kz-` cutters and their Makera feed
// rows (`fixtures/ball863/house-cutters.json`, the demo bench location as it was served); the
// catalogue `catalogue.json` is written beside it, which is the file the CLI looks for.
//
// WHAT IS NOT MODELLED, deliberately: `shop.mount` and `shop.bed` (obstacle and through-sentence
// facts that gate findings, not the program) and a calibrated machine (`null` on both paths). The
// catalogue, the location's feed table, the defaults and the finish allowance ARE modelled, because
// they decide the posted S/F/Z numbers — which is the defect.
//
// j13 IS COMMITTED SKIPPED: it is red today, and main stays green until Session B's fix lands
// against it. Unskip the j13 case in the same change that makes the two paths agree.
//
// THE FIVE SAMPLE JOBS (docs/bench/936-flagship-text, 938-stick-base, 939-pocket-bores,
// 940-two-cutter, 941-chamfer-slot) run the same comparison per program. Three of them name no
// cutter: the APP's measured search (`smartPick`, the function the panel's picker runs) chooses the
// plan and writes it into the job, exactly as the panel does before Generate; the CLI asks the same
// function (engrave.ts's `chooseCutters`) on its side. A pick difference is a #922 finding too — the
// two doors' shop objects feed the same search — and the failure message names the program and the
// key so B can see which side took a different cutter.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { bootstrap, loadCatalogue, type HeadlessBootstrap } from '@/platform/headless/bootstrap';
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { resolvedFeedsTable, setLocatedFeedTable, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { NO_TOOL_KEY, getTools, resetRegistry } from '@/engine/cnc/toolRegistry';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import { writeSetupPlan } from '@/engine/cnc/engrave/setupWork';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { engraveGenerate, supportingFloors, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { pickForEngrave } from '@/workers/sim/smartPickRun';
import type { EngraveJob } from '@/types/engraveJob';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const BADGE = join(HERE, 'fixtures', 'badge-2026-10-24-vbit.job.json');
const LOCATION_FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const HOUSE = join(HERE, 'fixtures', 'ball863', 'house-cutters.json');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-identity-922-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  resetRegistry();
});

interface HouseFixture {
  inventory: { key: string; tool: unknown }[];
  catalogue: unknown[];
  feeds: unknown[];
}

const house = JSON.parse(readFileSync(HOUSE, 'utf8')) as HouseFixture;

let locationPath: string | null = null;

/**
 * The bench's location: the committed fixture document with the house's cutters in its inventory,
 * and the Makera catalogue the same location served, written beside it as `catalogue.json`.
 */
function benchLocation(): string {
  if (locationPath !== null) return locationPath;
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as { inventory: unknown[] };
  for (const item of house.inventory) {
    doc.inventory.push({
      id: item.key.replace(/^inv:/, ''),
      tool: item.tool,
      origin: null,
      quantity: 1,
      codes: [],
      addedAt: '2026-11-01T00:00:00.000Z',
      notes: null,
    });
  }
  locationPath = join(SCRATCH, 'location.json');
  writeFileSync(locationPath, JSON.stringify(doc));
  writeFileSync(
    join(SCRATCH, 'catalogue.json'),
    JSON.stringify({
      kind: 'casemaker-catalogue',
      schemaVersion: 1,
      syncedAt: '2026-11-01T00:00:00.000Z',
      tools: house.catalogue.map((tool) => ({ ...(tool as object), provenance: 'fixture' })),
      feeds: house.feeds,
    }),
  );
  return locationPath;
}

/**
 * The shop `engraveRunStore.ts` sends the worker for this location — one line per field, in the
 * store's order. This is the reference the CLI path has to match; a field the CLI omits is a
 * number the operator reads in the panel and the machine does not run.
 */
function appShop(defaults: ShopDefaults | null): EngraveShopOpts {
  return {
    lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
    peckClearanceMm: readDefault(defaults, 'drill.peckClearanceMm').value,
    defaults,
    feeds: resolvedFeedsTable().table,
    tools: getTools(),
    conditions: inventoryConditions(),
    rest: {
      overlap: readDefault(defaults, 'rest.overlapMm'),
      thirdToolPct: readDefault(defaults, 'rest.thirdToolPct'),
      visibleDepth: readDefault(defaults, 'rest.visibleDepthMm'),
    },
    finish: { stockToLeaveMm: readDefault(defaults, 'finish.stockToLeaveMm') },
    drill: drillSettings(defaults),
    surfaceGrid: { pitchMm: readDefault(defaults, 'sim.columnFlatPitchYMm') },
  };
}

interface CliRun {
  code: number;
  receipt: Receipt;
  /** Every program the run wrote, in cut order. */
  ncs: string[];
}

/** Run `casemaker cut <job> --location <the bench location>` exactly as the CLI does. */
async function cut(name: string, jobPath: string): Promise<CliRun> {
  const outDir = join(SCRATCH, 'out', name);
  mkdirSync(outDir, { recursive: true });
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    ...HUMAN,
    sink: { progress: () => {}, receipt: (r) => (receipt = r) },
  };
  const code = await engraveJobMain(
    [relative(process.cwd(), jobPath), '--out', outDir, '--location', relative(process.cwd(), benchLocation())],
    options,
  );
  expect(receipt, 'the command must emit a receipt').not.toBeNull();
  const r = parseReceipt(receipt!);
  const details = r.command === 'engrave' && r.details !== null && 'programs' in r.details ? r.details : null;
  // A REFUSAL is an outcome the caller compares (both doors stopping at the same stage is identity
  // too — the stick base has nothing to cut). A successful run with no program is not.
  if (details === null || details.programs.length === 0) {
    if (code !== 0) return { code, receipt: r, ncs: [] };
    throw new Error(`${name}: the CLI exited 0 and wrote no program: ${JSON.stringify(r.refusals)}`);
  }
  return {
    code,
    receipt: r,
    ncs: details.programs.map((p) => readFileSync(join(outDir, p.ncFile), 'utf8')),
  };
}

/** One line per posted number that can differ, so a failure reads without a 200 kB diff. */
function summary(nc: string): string {
  const words = (re: RegExp): string[] => {
    const seen = new Set<string>();
    for (const line of nc.split('\n')) {
      if (line.startsWith(';')) continue;
      for (const m of line.matchAll(re)) seen.add(m[1]!);
    }
    return [...seen].sort();
  };
  const depths = words(/Z(-?\d+(?:\.\d+)?)/g).filter((z) => Number(z) < 0);
  return (
    `${nc.split('\n').length} lines, ${Buffer.byteLength(nc)} bytes; ` +
    `S ${words(/S(\d+(?:\.\d+)?)/g).join('/')}, F ${words(/F(\d+(?:\.\d+)?)/g).join('/')}, ` +
    `${depths.length} depths, Z ${depths[0]}..${depths[depths.length - 1]}`
  );
}

function firstDifference(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i < x.length && i < y.length
    ? `line ${i + 1}: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i])}`
    : `${x.length} lines vs ${y.length} lines`;
}

/** The worker's own path for the same job and location, byte-compared with the CLI's. */
async function expectSameProgram(name: string, jobPath: string): Promise<void> {
  const boot = await bootstrap({ location: benchLocation() });
  const catalogue = loadCatalogue(join(SCRATCH, 'catalogue.json'));
  setLocatedFeedTable((JSON.parse(readFileSync(benchLocation(), 'utf8')) as { feeds: [] }).feeds);
  const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join('; ')}`);
  const job = parsed.job;
  const tool = jobTool(job);
  if (tool === null) throw new Error(`${name}: the job's cutter ${job.toolKey} is not in the location's registry`);

  const worker = await engraveGenerate(
    boot.manifold,
    job,
    tool,
    catalogue?.rows ?? [],
    null,
    undefined,
    appShop(boot.location?.defaults ?? null),
  );
  if (!worker.ok || worker.nc === null) {
    throw new Error(`${name}: the worker stopped at ${worker.stage}: ${worker.errors.map((e) => e.message).join('; ')}`);
  }
  const cli = await cut(name, jobPath);
  expect(cli.code, `${name}: casemaker cut exited ${cli.code}: ${JSON.stringify(cli.receipt.refusals)}`).toBe(0);
  expect(cli.ncs, `${name}: both paths post the same number of programs`).toHaveLength(1);
  const cliNc = cli.ncs[0]!;
  if (worker.nc !== cliNc) {
    throw new Error(
      `${name}: the app and the CLI post different programs — worker ${summary(worker.nc)} | ` +
        `CLI ${summary(cliNc)}; first difference at ${firstDifference(worker.nc, cliNc)}`,
    );
  }
}

/**
 * The five committed samples — all identical from both doors since #922's pick was factored into
 * `smartPickRun.ts`'s `pickForEngrave` (the app's worker and the CLI now build the conditions map,
 * the feed table, the five-argument candidate list and the evaluator context in one place).
 *
 * Before that change, three picked different cutters (936 flat-1.0 vs inv:kz-engrave-m-60-0-1;
 * 940 25 mm vs 42 mm o-flute; 941 o-flute vs flat-3.175x12) — the divergence was pinned as
 * `it.fails` from ce6c15c2 and these cases are the flip.
 *
 * 938-stick-base is the BASE document the coupons are built from (no items, facing off): neither
 * door posts a program, and the case asserts they stop together at `findings` — both refusing is
 * identity as much as both posting.
 */
const SAMPLES = [
  { name: '936-flagship-text' },
  { name: '938-stick-base' },
  { name: '939-pocket-bores' },
  { name: '940-two-cutter' },
  { name: '941-chamfer-slot' },
] as const;

/**
 * The shop the app's PICKER hands the search (`engravePreviewStore.ts`'s `previewInputs`): the run
 * shop without the finish allowance (the picker has never seen it — C's #947 note), with the
 * tool-change cost, and without the fields only Generate reads. The bed facts are omitted here
 * (they gate findings, not the score) as are the mount facts.
 */
function appPickShop(defaults: ShopDefaults | null): EngraveShopOpts {
  return {
    tools: getTools(),
    lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
    toolChangeSeconds: readDefault(defaults, 'toolChange.seconds').value,
    drill: drillSettings(defaults),
    feeds: resolvedFeedsTable().table,
    defaults,
  };
}

/**
 * The job the APP hands the worker when a sample names no cutter: the panel's own measured search,
 * with the same library, catalogue and shop the app sends, written into the document exactly as
 * the panel writes its plan before Generate. The CLI asks the same `smartPick` on its side
 * (engrave.ts's `chooseCutters`), so a pick difference is a #922 finding, not a spec bug.
 */
async function appPrepared(
  job: EngraveJob,
  shop: EngraveShopOpts,
  tl: HeadlessBootstrap['manifold'],
  catalogue: readonly FeedCatalogueRow[],
): Promise<EngraveJob> {
  if (job.toolKey !== NO_TOOL_KEY) return job;
  const tools = getTools();
  // #922 — THE SHARED SEARCH: `pickForEngrave` is the function the app's worker and the CLI both
  // call; its inputs (conditions, feed table, evaluator context) have one home now. The catalogue
  // rows are the house's — the panel's picker reads them too (feedCatalogueRows).
  const pick = await pickForEngrave({
    tl,
    job,
    tools,
    catalogue,
    conditions: inventoryConditions(),
    shop,
    // #940 — the document's supporting floors, exactly as the app's worker and the CLI both
    // compute them where a Manifold toplevel is in hand: sample 4's initials are V-carved into a
    // 6 mm pocket floor, and a cone's reach is measured from that floor, not the stock's top.
    floors: supportingFloors(tl, toPartPlan(job)),
  });
  if (!('runnable' in pick) || pick.runnable === null) {
    throw new Error(`${job.name}: the app's search refuses the job: ${'reason' in pick ? pick.reason : 'no runnable plan'}`);
  }
  return writeSetupPlan(job, tools, 0, pick.runnable.plan.cutters);
}

/** Both paths for one committed sample, program by program. */
async function expectSameSample(name: string): Promise<void> {
  const jobPath = join(REPO, 'docs', 'bench', `${name}.job.json`);
  const boot = await bootstrap({ location: benchLocation() });
  const catalogue = loadCatalogue(join(SCRATCH, 'catalogue.json'));
  setLocatedFeedTable((JSON.parse(readFileSync(benchLocation(), 'utf8')) as { feeds: [] }).feeds);
  const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join('; ')}`);
  const defaults = boot.location?.defaults ?? null;
  const shop = appShop(defaults);
  const job = await appPrepared(parsed.job, appPickShop(defaults), boot.manifold, catalogue?.rows ?? []);
  const tool = jobTool(job);
  if (tool === null) throw new Error(`${name}: the job's cutter ${job.toolKey} is not in the location's registry`);

  // The CLI runs FIRST so its own outcome is in hand when the app's path stops: "the app refused,
  // the CLI posted" is a #922 finding of its own, and the message has to say both.
  const cli = await cut(name, jobPath);
  const worker = await engraveGenerate(boot.manifold, job, tool, catalogue?.rows ?? [], null, undefined, shop);
  if (!worker.ok || worker.programs.length === 0) {
    // BOTH DOORS STOPPING AT THE SAME STAGE IS IDENTITY TOO. `938-stick-base` is the samples' base
    // document — a 36 × 100 × 36 stick with no items and facing off — so neither door posts a
    // program; the case pins that they refuse together at `findings`, not one refusing and one posting.
    if (cli.code !== 0 && worker.stage === 'findings') {
      expect(cli.receipt.refusals[0]?.reason ?? '', `${name}: both doors stop at findings`).toContain('findings');
      return;
    }
    throw new Error(
      `${name}: the app's path stopped at ${worker.stage} (${worker.errors.map((e) => e.message).join('; ') || 'no error message'}) ` +
        `while the CLI ${cli.code === 0 ? `posted ${cli.ncs.length} program(s)` : `refused: ${JSON.stringify(cli.receipt.refusals)}`}`,
    );
  }
  expect(cli.code, `${name}: casemaker cut exited ${cli.code}: ${JSON.stringify(cli.receipt.refusals)}`).toBe(0);
  expect(cli.ncs, `${name}: both paths post the same number of programs`).toHaveLength(worker.programs.length);
  worker.programs.forEach((program, i) => {
    const cliNc = cli.ncs[i]!;
    if (program.nc === cliNc) return;
    const key = /^;@CM\|TOOL\|key=(.+)$/m.exec(program.nc)?.[1] ?? 'no key';
    const cliKey = /^;@CM\|TOOL\|key=(.+)$/m.exec(cliNc)?.[1] ?? 'no key';
    throw new Error(
      `${name} program ${i + 1}: the app (${key}) and the CLI (${cliKey}) post different programs — ` +
        `worker ${summary(program.nc)} | CLI ${summary(cliNc)}; first difference at ${firstDifference(program.nc, cliNc)}`,
    );
  });
}

describe('#922 one pipeline — the five bench samples', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.name} posts the same programs from both paths`,
      async () => {
        await expectSameSample(sample.name);
      },
      300_000,
    );
  }
});

describe('#922 one pipeline', () => {
  it('the committed 10-24 badge job posts the same program from both paths', async () => {
    await expectSameProgram('badge', BADGE);
  }, 120_000);

  it('j16-chamfer-a-bevel posts the same program from both paths', async () => {
    await expectSameProgram('j16', join(JOBS, 'j16-chamfer-a-bevel.json'));
  }, 120_000);

  // #922's reported divergence: red on 2026-11-02, kept as the fix's acceptance case. Session B
  // unskips this in the change that makes the two paths one.
  //
  // WHAT IT REPRODUCES with committed fixtures: the CLI's shop omits `finish.stockToLeaveMm`
  // (scripts/lib/casemaker/engrave.ts's `shop` literal), so j13's flat regions post a single pass
  // from the CLI and rough+finish from the app — 52194 lines / 2934 depths vs 56071 / 2932, and
  // the run-time header differs from line 12. The bench's feed divergence (10000/F1000/300 vs
  // 12000/F500/200) needs the k3 catalogue's PLA rows, which are not committed; it is the same
  // defect — the CLI hands the generator a thinner options object than the app does.
  it('j13-tool-tray posts the same program from both paths (red on 2026-11-02)', async () => {
    await expectSameProgram('j13', join(JOBS, 'j13-tool-tray.json'));
  }, 120_000);
});
