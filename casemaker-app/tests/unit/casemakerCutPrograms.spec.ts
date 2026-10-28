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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { runSheetFileName } from '../../src/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { flatEndMill } from '../../src/engine/cnc/tool';
import type { Receipt } from '../../src/platform/headless/receipt';
import type { EngraveDrill, EngraveJob, JobSetup } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
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
}

async function cut(job: EngraveJob, name: string, location = LOCATION): Promise<CutRun> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    json: true,
    now: NOW,
    sink: {
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', location], options);
  return { code, receipt, outDir };
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
  }, 120_000);
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
