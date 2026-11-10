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
// THE STICK GOAL JOB (j29-elephant-stick, the demo page's elephant) is the same comparison on the
// demo's full-library location (the same document the demo page's cards are judged on, local-only,
// so the case skips without it), with the programme COUNT as the first fact and the house's own
// tool list on the app's side — the catalogue's `cat:` definitions ahead of the inventory. It is
// RED on one line today (the rest program's tool key: `cat:` vs `inv:` of the same cutter) and is
// committed as `it.fails`; see the case's own header for the exact registry difference.
//
// THE FIVE SAMPLE JOBS (docs/bench/936-flagship-text, 938-stick-base, 939-pocket-bores,
// 940-two-cutter, 941-chamfer-slot) run the same comparison per program. Three of them name no
// cutter: the APP's measured search (`smartPick`, the function the panel's picker runs) chooses the
// plan and writes it into the job, exactly as the panel does before Generate; the CLI asks the same
// function (engrave.ts's `chooseCutters`) on its side. A pick difference is a #922 finding too — the
// two doors' shop objects feed the same search — and the failure message names the program and the
// key so B can see which side took a different cutter.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { bootstrap, loadCatalogue, type HeadlessBootstrap } from '@/platform/headless/bootstrap';
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { resolvedFeedsTable, setLocatedFeedTable, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { NO_TOOL_KEY, getTools, resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import { writeSetupPlan } from '@/engine/cnc/engrave/setupWork';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { engraveGenerate, supportingFloors, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { pickForEngrave } from '@/workers/sim/smartPickRun';
import type { EngraveJob } from '@/types/engraveJob';
import { engraveJobMain } from '../../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../../scripts/lib/casemaker/output';
import { parseReceipt, type Receipt } from '../../../src/platform/headless/receipt';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = join(HERE, '..', '..', '..');
export const REPO = join(APP, '..');
export const JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
export const BADGE = join(HERE, '..', 'fixtures', 'badge-2026-10-24-vbit.job.json');
export const LOCATION_FIXTURE = join(HERE, '..', 'fixtures', 'location-doc.json');
export const HOUSE = join(HERE, '..', 'fixtures', 'ball863', 'house-cutters.json');
/** The demo page's full-library location beside its catalogue (the same pair the bench builds on). */
export const DEMO_LOCATION = process.env.CASEMAKER_DEMO_LOCATION ?? join(homedir(), 'casemaker-manager', 'demo-build', 'location.json');
/** The elephant mesh is shop-owned (never committed); j29 carries its sha256, not its bytes. */
export const ELEPHANT = join(REPO, 'samples', '3d', 'lfs_elephant.stl');
export const HAVE_STICK = existsSync(DEMO_LOCATION) && existsSync(ELEPHANT);

export const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-identity-922-'));

/** Each split spec calls this in `afterAll` — the scratch tree and the tool registry. */
export function cleanupIdentity(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
  resetRegistry();
}

export interface HouseFixture {
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
export function benchLocation(): string {
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
 * The shop the app's Generate sends the worker — THE ONE BUILDER (#922 review), not a
 * transcription of it: `engraveShopOpts` (`engine/cnc/engrave/feeds.ts`) is the same call
 * `engraveRunStore.ts` now makes and the CLI's door builds, so this spec compares the two doors'
 * arguments, not the CLI against a hand copy that can drift.
 */
function appShop(defaults: ShopDefaults | null): EngraveShopOpts {
  return engraveShopOpts(defaults);
}

interface CliRun {
  code: number;
  receipt: Receipt;
  /** Every program the run wrote, in cut order. */
  ncs: string[];
}

/** Run `casemaker cut <job> --location <location>` exactly as the CLI does. */
async function cut(name: string, jobPath: string, location: string = benchLocation()): Promise<CliRun> {
  const outDir = join(SCRATCH, 'out', name);
  mkdirSync(outDir, { recursive: true });
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    ...HUMAN,
    sink: { progress: () => {}, receipt: (r) => (receipt = r) },
  };
  const code = await engraveJobMain(
    [relative(process.cwd(), jobPath), '--out', outDir, '--location', relative(process.cwd(), location)],
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
export async function expectSameProgram(name: string, jobPath: string): Promise<void> {
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
export const SAMPLES = [
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
export async function expectSameSample(name: string): Promise<void> {
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


/** j29 with the checkout's local-only elephant mesh injected; throws when the copy is stale. */
export function stickJobPath(): string {
  const job = JSON.parse(readFileSync(join(JOBS, 'j29-elephant-stick.json'), 'utf8')) as {
    targetObject: { sha256?: string; data?: string };
  };
  const bytes = readFileSync(ELEPHANT);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (job.targetObject.sha256 !== undefined && job.targetObject.sha256 !== sha) {
    throw new Error('j29: samples/3d/lfs_elephant.stl is not the mesh the job names (sha256 differs)');
  }
  job.targetObject.sha256 = sha;
  job.targetObject.data = bytes.toString('base64');
  const path = join(SCRATCH, 'j29-elephant-stick.job.json');
  writeFileSync(path, JSON.stringify(job));
  return path;
}

/**
 * j29 on the demo's full-library location, both doors program by program — COUNT first, then bytes.
 *
 * WHAT THE TWO DOORS SEE (measured 2026-11-03, cand/wave2). Both post TWO programs — the ⌀2 ball
 * `inv:lib-161032205031` and the ⌀0.5 ball of the same family — so the count agrees. The REST
 * cutter is chosen from each side's own registry, and the registries are not the same document:
 *
 *   * the app's house serves `/tools`, which carries the catalogue's own `cat:` definitions, and
 *     the inventory's `inv:` possessions are appended after them. Two entries describe the same
 *     physical cutter (id 161032055031, the 6 × 0.5 × 30.5 ball), and the rest pick takes the
 *     FIRST of the equal-geometry candidates — the `cat:` one.
 *   * the CLI's `--location` registry holds only the inventory, so its pick names
 *     `inv:lib-161032055031`.
 *
 * The programs are otherwise identical: this failure is one line — the `;@CM|TOOL|key=` header
 * (line 11) — with the same 111 997 lines and the same S/F/Z. The order sensitivity is what makes
 * it the registry, not the generator: with the `cat:` rows appended after the inventory the two
 * doors post byte-identical files (the same run, checked on 2026-11-03). So the fix is one cutter
 * identity across the two doors (dedupe by physical cutter, or load the catalogue's `cat:` rows on
 * the CLI side too), not a rest-planner change.
 */
export async function expectSameStickGoal(): Promise<void> {
  const jobPath = stickJobPath();
  const boot = await bootstrap({ location: DEMO_LOCATION });
  const catalogue = loadCatalogue(join(dirname(DEMO_LOCATION), 'catalogue.json'));
  setLocatedFeedTable((JSON.parse(readFileSync(DEMO_LOCATION, 'utf8')) as { feeds: [] }).feeds);
  const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (!parsed.ok) throw new Error(`j29: ${parsed.errors.join('; ')}`);
  const defaults = boot.location?.defaults ?? null;
  // THE APP'S HOUSE: the service's tool list carries the catalogue's own `cat:` definitions beside
  // the location's inventory (the demo house serves both), so the app's picker sees them. The
  // CLI's `--location` registry has only the inventory.
  if (catalogue !== null) {
    const cat = (JSON.parse(readFileSync(join(dirname(DEMO_LOCATION), 'catalogue.json'), 'utf8')) as {
      tools: Parameters<typeof setRegistry>[0];
    }).tools;
    setRegistry([...cat, ...getTools()]);
  }
  const shop = appShop(defaults);
  // The app's door: the job as the panel holds it (a named cutter, no measured setup written back).
  const job = await appPrepared(parsed.job, appPickShop(defaults), boot.manifold, catalogue?.rows ?? []);
  const tool = jobTool(job);
  if (tool === null) throw new Error(`j29: the job's cutter ${job.toolKey} is not in the location's registry`);

  const cli = await cut('j29', jobPath, DEMO_LOCATION);
  const worker = await engraveGenerate(boot.manifold, job, tool, catalogue?.rows ?? [], null, undefined, shop);
  if (!worker.ok || worker.programs.length === 0) {
    throw new Error(
      `j29: the app's path stopped at ${worker.stage} (${worker.errors.map((e) => e.message).join('; ') || 'no error message'}) ` +
        `while the CLI ${cli.code === 0 ? `posted ${cli.ncs.length} program(s)` : `refused: ${JSON.stringify(cli.receipt.refusals)}`}`,
    );
  }
  expect(cli.code, `j29: casemaker cut exited ${cli.code}: ${JSON.stringify(cli.receipt.refusals)}`).toBe(0);
  const cliKeys = cli.ncs.map((nc) => /^;@CM\|TOOL\|key=(.+)$/m.exec(nc)?.[1] ?? 'no key');
  expect(
    worker.programs.length,
    `the app posts ${worker.programs.length} program(s) (${worker.programs.map((p) => p.toolKey).join(', ')}); ` +
      `the CLI posts ${cli.ncs.length} (${cliKeys.join(', ')})`,
  ).toBe(cli.ncs.length);
  expect(cli.ncs, 'j29: the goal job is two programs — the ⌀2 ball and the ⌀0.5 rest').toHaveLength(2);
  worker.programs.forEach((program, i) => {
    const cliNc = cli.ncs[i]!;
    if (program.nc === cliNc) return;
    const key = /^;@CM\|TOOL\|key=(.+)$/m.exec(program.nc)?.[1] ?? 'no key';
    throw new Error(
      `j29 program ${i + 1}: the app (${key}) and the CLI (${cliKeys[i]}) post different programs — ` +
        `worker ${summary(program.nc)} | CLI ${summary(cliNc)}; first difference at ${firstDifference(program.nc, cliNc)}`,
    );
  });
}

