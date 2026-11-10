// #786 slice 4b — A NAMED DRILL BIT WITH OTHER WORK IS SPLIT BY THE HEADLESS RUN.
//
// The app applies the measured search's split before Generate (4c): the drill keeps its holes and
// the search adds the flat for the rest. `casemaker engrave --job` asks the same question, because
// `drill-mixed-tools` would otherwise refuse a document the app cuts. This drives the real command
// in process with the fixture location, and holds that BOTH programs are written and the split is
// stated on the progress channel. #1180 split the two independent headless tests into parallel
// files; `helpers/casemakerEngrave.ts` is the plumbing both share.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runSheetFileName } from '../../src/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { flatEndMill } from '../../src/engine/cnc/tool';
import type { EngraveDrill, EngraveJob } from '../../src/types/engraveJob';
import { disposeScratch, engrave, scratchFor } from './helpers/casemakerEngrave';

const DRILL_KEY = 'engine:drill-3';

const SCRATCH = scratchFor('casemaker-mixed-split-');
afterAll(() => disposeScratch(SCRATCH));

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
    const stemNoExt = runSheetFileName(job.name).replace(/\.nc$/, '');
    const run = await engrave(SCRATCH, job, 'mixed');

    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt?.ok).toBe(true);
    if (run.receipt?.command !== 'engrave') throw new Error('expected the engrave receipt');

    // Two files: the drill's own program first, the flat's for the pocket second — and under
    // #1093 a multi-program run numbers program 1 too: `<job>-p1.nc`, `<job>-p2.nc`.
    const firstFile = `${stemNoExt}-p1.nc`;
    expect(run.receipt.details.programs.map((p) => p.ncFile)).toEqual([firstFile, `${stemNoExt}-p2.nc`]);
    for (const file of [firstFile, `${stemNoExt}-p2.nc`]) {
      expect(existsSync(join(run.outDir, file)), `${file} was written`).toBe(true);
    }
    const first = readFileSync(join(run.outDir, firstFile), 'utf8');
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
