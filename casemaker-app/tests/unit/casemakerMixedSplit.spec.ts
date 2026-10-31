// #786 slices 4b/6 — A NAMED DRILL BIT WITH OTHER WORK IS SPLIT BY THE HEADLESS RUN, AND A CUTTER
// THE LOCATION NO LONGER HOLDS IS REPLACED BY THE SEARCH'S CHOICE.
//
// The app applies the measured search's split before Generate (4c): the drill keeps its holes and
// the search adds the flat for the rest. `casemaker engrave --job` asks the same question, because
// `drill-mixed-tools` would otherwise refuse a document the app cuts. This drives the real command
// in process with the fixture location, and holds that BOTH programs are written and the split is
// stated on the progress channel.

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
import type { EngraveDrill, EngraveJob } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
const NOW = new Date('2026-10-31T12:00:00.000Z');
const DRILL_KEY = 'engine:drill-3';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-mixed-split-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Run {
  code: number;
  receipt: Receipt | null;
  outDir: string;
  progress: string[];
}

async function engrave(job: EngraveJob, name: string): Promise<Run> {
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
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], options);
  return { code, receipt, outDir, progress };
}

/** A saved job that names its own 3 mm drill and also draws a pocket the bit cannot cut. */
function mixedJob(): EngraveJob {
  const base = defaultEngraveJob();
  const drill: EngraveDrill = {
    kind: 'drill',
    id: 'hole',
    name: 'port',
    position: { x: 20, y: 20 },
    rotation: 0,
    depth: 2,
    enabled: true,
    through: false,
  };
  return {
    ...base,
    name: 'mixed drill job',
    labels: [],
    shapes: [
      { id: 'pocket', name: 'pocket', kind: 'circle', position: { x: 40, y: 25 }, rotation: 0, depth: 2, enabled: true, diameter: 10 },
    ],
    drills: [drill],
    toolKey: DRILL_KEY,
    tool: flatEndMill(3, {
      name: '3 mm drill',
      typeText: 'Drill',
      shape: 'drill',
      tipDiameter: 3,
      diameter: 3,
      cornerRadius: null,
      angle: 118,
      fluteLength: 20,
    }),
    sources: { tool: 'user' },
  };
}

describe('#786 4b the headless run splits a named drill', () => {
  it('posts the drill and the flat as two programs, and says the split', async () => {
    const job = mixedJob();
    const stem = runSheetFileName(job.name);
    const stemNoExt = stem.replace(/\.nc$/, '');
    const run = await engrave(job, 'mixed');

    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt?.ok).toBe(true);
    if (run.receipt?.command !== 'engrave') throw new Error('expected the engrave receipt');

    // Two files: the drill's own program first, the flat's for the pocket second.
    expect(run.receipt.details.programs.map((p) => p.ncFile)).toEqual([stem, `${stemNoExt}-p2.nc`]);
    for (const file of [stem, `${stemNoExt}-p2.nc`]) {
      expect(existsSync(join(run.outDir, file)), `${file} was written`).toBe(true);
    }
    const first = readFileSync(join(run.outDir, stem), 'utf8');
    const second = readFileSync(join(run.outDir, `${stemNoExt}-p2.nc`), 'utf8');
    expect(first).toContain(`;@CM|TOOL|key=${DRILL_KEY}`);
    expect(second).not.toContain(`;@CM|TOOL|key=${DRILL_KEY}`);
    // The drill's file descends to the hole's tip depth and the flat's does not.
    expect(first).toMatch(/Z-2\.[0-9]+/);
    expect(second).not.toMatch(/Z-2\.[0-9]+/);
    // The split is stated, not silent.
    expect(run.progress.some((line) => line.includes('split') && line.includes('one program per cutter'))).toBe(true);
  }, 180_000);
});

/** A saved job whose cutter key no longer resolves: the `tool-missing` the app substitutes for. */
function missingCutterJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'missing cutter job',
    toolKey: 'user:gone',
    tool: undefined,
    sources: { tool: 'user' },
  };
}

describe('#786 slice 6 the headless run answers a key the location does not hold', () => {
  it('chooses a cutter, posts the program, and says which key was replaced', async () => {
    const job = missingCutterJob();
    const run = await engrave(job, 'missing-cutter');

    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt?.ok).toBe(true);
    if (run.receipt?.command !== 'engrave') throw new Error('expected the engrave receipt');
    const written = run.receipt.details.programs[0]!;
    const nc = readFileSync(join(run.outDir, written.ncFile), 'utf8');
    // The program names a cutter the location holds — not the dead key.
    expect(nc).not.toContain('key=user:gone');
    // The substitution is stated, with both keys.
    expect(
      run.progress.some((line) => line.includes('substitute') && line.includes('user:gone') && line.includes('is not in the tool library')),
    ).toBe(true);
  }, 240_000);
});
