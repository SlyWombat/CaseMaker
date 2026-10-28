// #733 item 1 — A JOB WITH SEVERAL CUTTERS POSTS ONE PROGRAM PER CUTTER.
//
// The bench exercise (docs/bench/2026-10-27-z1-typical-jobs) had to split every multi-cutter job
// into one file per cutter because `casemaker cut <job>` wrote only the top-level adapter program
// (`generated.nc`, the first program) and dropped the rest of `generated.programs`. This spec drives
// the real command in process, with the fixture location so the owned cutters resolve, and holds
// that a two-cutter setup posts two files with the two cutters' headers.
//
// Why the two cutters are assigned separate items: the generator measures a later cutter as a REST
// pass over the material the first program's sweep left. Assigning the setup's two items to the two
// cutters (#472's `toolItems`) makes the second program's cut a measured region rather than a
// rest-of-everything prediction, which is the shape the faceplate and relief jobs have.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { runSheetFileName } from '../../src/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { toSetup } from '../../src/engine/cnc/engrave/jobSetup';
import { Z1 } from '../../src/engine/cnc/machine';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { entryFor } from '../../src/engine/cnc/toolRegistry';
import { bootstrap } from '../../src/platform/headless/bootstrap';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';
import { parseEngraveJob } from '../../src/store/engraveJobSchema';
import { createSimSession } from '../../src/workers/sim/session';
import type { EngraveDrill, EngraveJob, JobSetup } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve('tsx')).href;
/** The fixture location's two owned flat cutters: 2 mm and a 3.175 mm clone. */
const FIRST = 'user:1a2b3c4d5e';
const SECOND = 'user:6f7a8b9c0d';
const NOW = new Date('2026-10-28T12:00:00.000Z');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cut-programs-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface CutRun {
  code: number;
  receipt: Receipt | null;
  outDir: string;
  /** The human channel, captured instead of printed (#732's provenance line is read here). */
  progress: string[];
}

async function cut(job: EngraveJob, name: string, location = LOCATION): Promise<CutRun> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = {
    json: true,
    now: NOW,
    sink: {
      progress: (line) => progress.push(line),
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', location], options);
  return { code, receipt, outDir, progress };
}

/** The fixture location, re-stating its drill point angle (its own document already has 118°). */
function locationWithPointAngle(deg: number): string {
  const doc = JSON.parse(readFileSync(LOCATION, 'utf8')) as {
    defaults: Record<string, { value: unknown }>;
  };
  doc.defaults['drill.pointAngleDeg']!.value = deg;
  const path = join(SCRATCH, `location-${deg}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return path;
}

/** A softwood job whose one setup names two cutters, each owning one of its two labels (#472). */
function twoCutterJob(): EngraveJob {
  const base = defaultEngraveJob();
  const labels = base.labels.slice(0, 2).map((label) => ({ ...label, depth: 0.5 }));
  const [a, b] = labels.map((label) => label.id);
  const setup: JobSetup = {
    id: 'setup-1',
    // A top-up vise setup is the identity record.
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'vise' },
    itemIds: [a!, b!],
    tools: [FIRST, SECOND],
    toolItems: { [FIRST]: [a!], [SECOND]: [b!] },
  };
  return {
    ...base,
    name: 'two-cutter bench job',
    toolKey: FIRST,
    labels,
    setups: [setup],
  };
}

describe('#733 a job posts one program per cutter', () => {
  it('writes the second cutter’s program, not only the first', async () => {
    const job = twoCutterJob();
    const stem = runSheetFileName(job.name);
    const stemNoExt = stem.replace(/\.nc$/, '');
    const run = await cut(job, 'two-cutter');

    expect(
      run.code,
      JSON.stringify({
        refusals: run.receipt?.refusals ?? null,
        diagnostics: run.receipt?.diagnostics ?? null,
      }),
    ).toBe(0);
    expect(run.receipt).not.toBeNull();
    expect(run.receipt!.ok).toBe(true);
    if (run.receipt!.command !== 'engrave') throw new Error('expected the engrave receipt');
    const details = run.receipt!.details;

    // Two programs, in cut order, named the way the run sheet and the release step name them: the
    // first keeps the job's own file name, a later one takes `-p<n>`.
    expect(details.programs.map((p) => p.ncFile)).toEqual([stem, `${stemNoExt}-p2.nc`]);
    for (const file of [stem, `${stemNoExt}-p2.nc`]) {
      expect(existsSync(join(run.outDir, file)), `${file} was written`).toBe(true);
    }

    // Each file names the cutter it was posted for, and the two are genuinely different programs.
    const first = readFileSync(join(run.outDir, stem), 'utf8');
    const second = readFileSync(join(run.outDir, `${stemNoExt}-p2.nc`), 'utf8');
    expect(first).toContain(`;@CM|TOOL|key=${FIRST}`);
    expect(second).toContain(`;@CM|TOOL|key=${SECOND}`);
    expect(second).not.toBe(first);

    // Each program's frame file is named after its own program, and the second one exists.
    expect(details.programs[1]!.frameFile).toBe(`${stemNoExt}-p2-frame.nc`);
    expect(existsSync(join(run.outDir, `${stemNoExt}-p2-frame.nc`))).toBe(true);

    // One sheet per job — the setup's one truth — carried by the program it names in its header.
    expect(details.programs[0]!.sheet?.file).toBe(`${stemNoExt}-run-sheet.md`);
    expect(details.programs[1]!.sheet).toBeNull();

    // #733 item 4 — EVERY program was swept, not only the first. `sim: null` on the second program
    // was the hole the manager refused: a rapid through stock there went unchecked.
    for (const program of details.programs) {
      expect(program.sim, `${program.ncFile} carries its own sweep`).not.toBeNull();
      expect(program.sim!.ok).toBe(true);
      expect(program.sim!.errorCount).toBe(0);
      expect(program.sim!.count).toBeGreaterThan(0);
      expect(program.sim!.removedVolumeMm3).not.toBeNull();
    }
  }, 120_000);
});

// #733 item 4 — EVERY PROGRAM IS SIMULATED ON THE STOCK THE LAST ONE LEFT.
//
// Writing every program is only half of item 1: posting the rest of the run without sweeping it is
// how a rapid through material goes unchecked (`sim: null` on every later entry). Each program is
// now swept in cut order, each seeded with the material the previous one left — the same
// `priorRemoval` the rest passes have always used. The second program of a rest pair is the test's
// witness: from the blank its paths cut 27 mm³; on the stock the rough cutter leaves they cut
// 2.2 mm³, so the receipt stating the smaller number is proof the seed was used.
//
// A rest pair (no `toolItems`) is the shape that makes the difference visible: the second cutter
// re-traverses the seam band the first one cleared, which is exactly what `priorRemoval` models.

/** A setup whose one item is rough-cut by 3.175 mm and cleaned up by 2 mm: a rest pair (#410). */
function restPairJob(): EngraveJob {
  const base = defaultEngraveJob();
  // Large enough for the 3.175 mm rough cutter to keep its characters; the rest pass is measured
  // against what that cutter really removed, not against a design it cannot reach.
  const label = { ...base.labels[0]!, text: 'AE', size: 24, position: { x: 50, y: 32 }, depth: 0.5 };
  const setup: JobSetup = {
    id: 'setup-1',
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'vise' },
    itemIds: [label.id],
    // No `toolItems`: the first cutter owns the item, the second is a rest pass (#472).
    tools: [SECOND, FIRST],
  };
  return { ...base, name: 'rest pair bench job', toolKey: SECOND, labels: [label], setups: [setup] };
}

describe('#733 every program is simulated on the stock the last one left', () => {
  it('sweeps the rest program from the first program’s material, and states its own result', async () => {
    const job = restPairJob();
    const run = await cut(job, 'rest-pair');
    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt).not.toBeNull();
    if (run.receipt!.command !== 'engrave') throw new Error('expected the engrave receipt');
    const programs = run.receipt!.details.programs;
    expect(programs.map((p) => p.ncFile)).toHaveLength(2);

    // Every entry carries its own sweep result — including the rest program.
    for (const program of programs) {
      expect(program.sim, `${program.ncFile} has its own sweep`).not.toBeNull();
      expect(program.sim!.ok).toBe(true);
      expect(program.sim!.count).toBeGreaterThan(0);
      expect(program.sim!.errorCount).toBe(0);
    }

    // Replay the two loads the CLI runs and require the receipt to state the SEEDED volume. This
    // is the difference between "a sweep ran" and "a sweep ran on the stock the last program left".
    const { manifold } = await bootstrap({ location: LOCATION });
    const session = createSimSession(manifold);
    try {
      const setup = toSetup(job, Z1);
      const rough = entryFor(SECOND)!.tool;
      const rest = entryFor(FIRST)!.tool;
      const ncRough = readFileSync(join(run.outDir, programs[0]!.ncFile), 'utf8');
      const ncRest = readFileSync(join(run.outDir, programs[1]!.ncFile), 'utf8');
      const first = session.load(ncRough, setup, rough, Z1.id, {});
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.diagnostics.map((d) => d.message).join('\n'));
      const seeded = session.load(ncRest, setup, rest, Z1.id, {
        ...(first.meshes.removal === null ? {} : { priorRemoval: first.meshes.removal }),
      });
      const blank = session.load(ncRest, setup, rest, Z1.id, {});
      expect(seeded.ok).toBe(true);
      expect(blank.ok).toBe(true);
      if (!seeded.ok || !blank.ok) throw new Error('the rest program did not sweep');
      // The pair's own numbers: the rest paths re-traverse cleared seam band, so the blank sweep
      // removes an order of magnitude more material than the seeded one.
      expect(blank.stats.removedVolume).toBeGreaterThan(seeded.stats.removedVolume * 2);
      const stated = programs[1]!.sim!.removedVolumeMm3!;
      expect(stated).toBeCloseTo(seeded.stats.removedVolume, 3);
      expect(stated).not.toBeCloseTo(blank.stats.removedVolume, 3);
    } finally {
      session.dispose();
    }
  }, 180_000);
});

// #733 item 2 — THE LOCATION'S DRILL POINT ANGLE IS NOT DROPPED ON THE CLI PATH.
//
// A drill-shaped cutter has no `angle` of its own (`angle: null`), so the included point angle comes
// from the shop: the browser's `engraveRunStore` passes `drill: drillSettings(shopDefaults)` (#434).
// The CLI passed no drill settings at all, so every hole was planned with the 118° fallback even
// when the location said otherwise. The tip goes `pointLength(⌀, angle)` below the full diameter:
// for a 3 mm drill that is 0.901 mm at 118° and 1.5 mm at 90°, so a 2 mm blind hole feeds to
// Z-2.901 or Z-3.5 — one number in the posted file that says which document the plan read.
const DRILL_KEY = 'inv:733-drill-3';
const DRILL = flatEndMill(3, {
  name: '3 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: 3,
  diameter: 3,
  cornerRadius: null,
  angle: null,
  centreCutting: null,
});

/** A job whose only work is a 2 mm blind hole, cut with the drill-shaped cutter above. */
function drilledJob(): EngraveJob {
  const base = defaultEngraveJob();
  const hole: EngraveDrill = {
    id: 'hole-2',
    kind: 'drill',
    name: '2 mm hole',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    through: false,
  };
  return {
    ...base,
    name: 'drill point angle bench job',
    labels: [],
    shapes: [],
    drills: [hole],
    toolKey: DRILL_KEY,
    tool: DRILL,
  };
}

describe('#733 the location’s drill point angle reaches the CLI', () => {
  it('posts the hole at the location’s 90° tip, not the built-in 118° fallback', async () => {
    const job = drilledJob();
    const ncFile = runSheetFileName(job.name);

    const ninety = await cut(job, 'drill-90', locationWithPointAngle(90));
    expect(
      ninety.code,
      JSON.stringify({ refusals: ninety.receipt?.refusals ?? null, diagnostics: ninety.receipt?.diagnostics ?? null }),
    ).toBe(0);
    const nc90 = readFileSync(join(ninety.outDir, ncFile), 'utf8');
    // pointLength(3 mm, 90°) = 1.5 mm → 2 + 1.5 = 3.5 mm below the top.
    expect(nc90).toMatch(/Z-3\.5\b/);
    expect(nc90).not.toContain('Z-2.901');

    // The same job against the fixture's own 118° document: the difference is the location's number,
    // not the cutter or the hole.
    const fallback = await cut(job, 'drill-118', LOCATION);
    expect(
      fallback.code,
      JSON.stringify({ refusals: fallback.receipt?.refusals ?? null, diagnostics: fallback.receipt?.diagnostics ?? null }),
    ).toBe(0);
    const nc118 = readFileSync(join(fallback.outDir, ncFile), 'utf8');
    expect(nc118).toContain('Z-2.901');
    expect(nc118).not.toMatch(/Z-3\.5\b/);
  }, 120_000);
});

// #732 — THE CLI READS THE HOUSE CATALOGUE (#308), NOT AN EMPTY LIST.
//
// The bench's j18 run was generated at the thread placeholders — 10000 RPM / 300 mm/min — while
// the manifest's own note says "Makera's catalogue says 15000 / 60 for this bit in 6061". The
// catalogue was the one tier a headless run could not reach (`scanReach` and `engraveGenerate` were
// handed `[]`). It is read now: `catalogue.json` beside the machine's document, validated, and each
// row joined to its cutter's geometry, so the same job posts the row's numbers — clamped by the
// machine (the Z1's 13000 RPM ceiling).
const J18 = join(APP, '..', 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs', 'j18-thread-b-mill.json');
/** Makera's `g_ID` the owned thread mill in this fixture confirms. */
const THREAD_ID = '112111313870';

/**
 * The owned M3 thread mill, and the catalogue's row for it — ONE geometry, so the catalogue's own
 * cutter agrees with the cutter in hand (a disagreement is the refusal #732's other test pins).
 */
function threadMill(id: string | null): Tool {
  return flatEndMill(2, {
    id,
    name: 'Thread Milling Bit - 1/8" Shank',
    typeText: 'Thread',
    shape: 'thread',
    tipDiameter: 2,
    diameter: 2,
    fluteLength: 12,
  });
}

/** A location carrying the owned thread mill, with the house catalogue in the same directory. */
function threadLocation(): string {
  const dir = join(SCRATCH, 'j18-catalogue');
  mkdirSync(dir, { recursive: true });
  const doc = JSON.parse(readFileSync(LOCATION, 'utf8')) as { inventory: unknown[] };
  doc.inventory.push({
    id: 'kz-thread-m3-9',
    tool: threadMill(THREAD_ID),
    origin: { id: '00000000-0000-4000-8000-0000000000c1', syncedAt: '2026-10-20T08:00:00.000Z' },
    quantity: 1,
    codes: [],
    addedAt: '2026-10-20T08:00:00.000Z',
    notes: null,
    copies: [],
    colletFits: null,
  });
  const path = join(dir, 'location.json');
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(
    join(dir, 'catalogue.json'),
    JSON.stringify(
      {
        kind: 'casemaker-catalogue',
        schemaVersion: 1,
        syncedAt: '2026-10-20T08:00:00.000Z',
        tools: [
          {
            key: 'cat:fixture-thread-m3',
            tool: threadMill(THREAD_ID),
            provenance: 'Makera Studio — fixture row for #732',
            contentHash: 'fixture-thread-m3',
          },
        ],
        feeds: [
          { cutterId: THREAD_ID, material: '6061 Aluminum', rpm: 15000, feed: 60, plungeFeed: 60, stepDown: 0.5 },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return path;
}

describe('#732 the CLI reads the house catalogue', () => {
  it('posts the catalogue row’s S/F for the owned thread mill, clamped by the machine (j18)', async () => {
    const parsed = parseEngraveJob(JSON.parse(readFileSync(J18, 'utf8')));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const job = parsed.job;
    const locationPath = threadLocation();
    const run = await cut(job, 'j18-catalogue', locationPath);
    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt).not.toBeNull();
    expect(run.receipt!.ok).toBe(true);
    if (run.receipt!.command !== 'engrave') throw new Error('expected the engrave receipt');

    // The run read the catalogue, and the receipt states the file with its hash (#478).
    const cataloguePath = join(dirname(locationPath), 'catalogue.json');
    expect(run.receipt!.inputs).toContainEqual(expect.objectContaining({ path: cataloguePath }));
    // The human channel names it and what it carried, before any program is posted.
    expect(run.progress.some((line) => line.includes(cataloguePath)), run.progress.join('\n')).toBe(true);
    expect(run.progress.some((line) => line.includes('1 feed row')), run.progress.join('\n')).toBe(true);

    // The file the machine would run carries Makera's numbers: 15000 RPM clamped to the Z1's
    // 13000 ceiling, and the row's 60 mm/min — NOT the thread placeholders (10000 / 300).
    const nc = readFileSync(join(run.outDir, runSheetFileName(job.name)), 'utf8');
    expect(nc).toMatch(/\bS13000\b/);
    expect(nc).toMatch(/\bF60\b/);
    expect(nc).not.toMatch(/\bS10000\b/);
    expect(nc).not.toMatch(/\bF300\b/);
  }, 120_000);
});

// #733 item 3 — AN INVALID JOB STILL PRINTS ITS RECEIPT.
//
// #478's contract: with `--json`, stdout is exactly one receipt — progress and diagnostics go to
// stderr. A job the schema refuses is a RESULT (the run stopped), not an exception, so it has to
// answer on stdout like every other stop. Spawn-based: the property is what a bench user's shell
// captures, and the in-process sink bypasses stdout by design.
describe('#733 an invalid job answers --json on stdout', () => {
  it('prints one parseable receipt naming the reason, not an empty stdout', () => {
    const dir = join(SCRATCH, 'invalid-job');
    mkdirSync(dir, { recursive: true });
    const jobPath = join(dir, 'job.json');
    // Valid JSON, invalid job: no schemaVersion/stock/tool/labels — `parseEngraveJob` refuses it.
    writeFileSync(jobPath, JSON.stringify({ name: 'broken bench job' }, null, 2) + '\n');

    const r = spawnSync(
      process.execPath,
      ['--import', TSX, join(APP, 'scripts', 'casemaker.ts'), 'cut', jobPath, '--json', '--location', LOCATION],
      {
        cwd: APP,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(APP, 'tsconfig.scripts.json') },
      },
    );

    expect(r.status, r.stderr).toBe(1);
    // stdout is exactly the receipt: JSON.parse of the whole stream, not a substring of it.
    expect(r.stdout.trim(), `stdout was ${r.stdout.length} bytes`).not.toBe('');
    const receipt = parseReceipt(JSON.parse(r.stdout));
    expect(receipt.ok).toBe(false);
    expect(receipt.command).toBe('engrave');
    // Stopped before any stage ran.
    expect(receipt.stage).toBeNull();
    expect(receipt.gate).toBeNull();
    expect(receipt.refusals.map((x) => x.code)).toEqual(['invalid-job']);
    expect(receipt.refusals[0]!.reason).toContain('is not a valid engrave job');
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-job', severity: 'error', source: 'findings' }),
    );
    // The operator's copy stays on stderr, in the words `fail` used.
    expect(r.stderr).toContain('casemaker cut:');
    expect(r.stderr).toContain('is not a valid engrave job');
  }, 120_000);
});
