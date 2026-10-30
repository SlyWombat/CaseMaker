// #766 REGRESSION GUARD — the classes the measured pick broke on the demo set, each pinned on the
// real bench job that carried it:
//   - a PURE GOAL job (j06 wolf, j07 photo relief, j27 mouse shell): writing a setup made the
//     generator validate the goal as an ordinary item — "Setup 1 assigns an item that is not in
//     it: g1" — and every plan was refused;
//   - a variable-depth V-CARVE VECTOR (j21-b coaster inlay): it was classified flat, so the search
//     handed a V-carve to a flat end mill and the generator refused it;
//   - an INLAY cutaway that arrives as another program's construction copy (j11 male plug): the
//     copy lost its own outer ring — "references … which is not in the job" — and refused every
//     plan;
//   - the demo-set sweep itself is slice E's; these are the three CONTRACTS (setup shape, work
//     kind, reference closure) and they are cheap — no Manifold, no generator.
// #768's empty-rest class is an end-to-end shape (j21-a: the generator re-settles the run's
// vacuum words after the drop, and the top-level `nc` used to be the PRE-settle attempt) — the fix
// is in `engraveGenerate`'s `first = posted[0]?.one ?? attempts[0]`, and the demo rerun plus
// slice E's sweep are its evidence.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { kindedWork } from '@/engine/cnc/engrave/cutterPlan';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';
import { jobForSetup } from '@/engine/cnc/engrave/programs';
import { jobSetups, pureGoalObject, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

const JOBS = join(__dirname, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

function load(name: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, name), 'utf8')));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join('; ')}`);
  return parsed.job;
}


/** A ball cutter, as the goal-size candidates read it. */
function ballEntry(key: string, tip: number): ToolLibraryEntry {
  return {
    key,
    provenance: 'test',
    tool: {
      number: null,
      id: null,
      name: key,
      typeText: '',
      shape: 'ball',
      handleDiameter: 3.175,
      tipDiameter: tip,
      diameter: tip,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
  };
}

describe('#766 regressions — jobs that generated under #762 must still generate', () => {
  it('a pure goal plan is written WITHOUT a setup, so the goal keeps its one program', () => {
    const job = load('j06-wolf-1mm-ball.json');
    expect(pureGoalObject(job)).not.toBeNull();

    const applied = applyCutterPlanToJob(job, { cutters: [{ key: 'inv:ball-2.5', items: ['g1'] }] });
    expect(applied.toolKey).toBe('inv:ball-2.5');
    expect(applied.setups).toBeUndefined();
    expect(pureGoalObject(applied)).not.toBeNull();
    // The refusal the demo hit: "Setup 1 assigns an item that is not in it: g1". (The goal's mesh
    // bytes and the fake cutter key raise their own findings in a headless test; the CLASS under
    // test is the setup-assignment one.)
    const errors = validateJob(applied).filter((f) => f.code === 'setup-tool-unknown');
    expect(errors).toEqual([]);
  });


  it('a goal job tries balls by size, so the finish budget always has a fitting candidate', () => {
    // `planCutters` can only apply #540's finish budget when it can sample the goal heightfield;
    // a job whose mesh is attached later (the CLI's store, the panel's worker) samples as null and
    // the rule names the LARGEST ball, which the generator refuses at cam. The search must offer
    // the smaller balls too — j06 wolf needed the ⌀2 mm ball.
    const job = load('j06-wolf-1mm-ball.json');
    const balls = [4, 2.5, 2, 1, 0.5].map((d) => ballEntry(`inv:ball-${d}`, d));
    const plans = candidatePlans(job, balls, []);
    const goalPlans = plans.filter((p) => p.cutters.length === 1 && p.cutters[0]!.items.includes('g1'));
    expect(goalPlans.length).toBeGreaterThanOrEqual(4);
    // The smaller balls — the ones the finish budget accepts — are all candidates.
    const keys = goalPlans.map((p) => p.cutters[0]!.key);
    expect(keys).toEqual(expect.arrayContaining(['inv:ball-2', 'inv:ball-1', 'inv:ball-0.5']));
  });

  it('a variable-depth V-carve VECTOR is cone work, not flat', () => {
    // j21-b's coaster: two imported outlines marked `vCarveDepth: 'variable'` plus one flat.
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.combined = [];
    job.vectors = [
      { id: 'outline', kind: 'vector', sourceName: 'x.svg', name: 'outline', position: { x: 50, y: 30 }, rotation: 0, depth: 2, enabled: true, contours: [], fillRule: 'NonZero', width: 20, height: 20 },
      { id: 'initial', kind: 'vector', sourceName: 'x.svg', name: 'initial', position: { x: 50, y: 30 }, rotation: 0, depth: 14, vCarveDepth: 'variable', enabled: true, contours: [], fillRule: 'NonZero', width: 20, height: 20 },
      { id: 'script', kind: 'vector', sourceName: 'x.svg', name: 'script', position: { x: 50, y: 30 }, rotation: 0, depth: 14, vCarveDepth: 'variable', enabled: true, contours: [], fillRule: 'NonZero', width: 20, height: 20 },
    ];
    const kinds = new Map(kindedWork(job).map((w) => [w.id, w.kind] as const));
    expect(kinds.get('initial')).toBe('cone');
    expect(kinds.get('script')).toBe('cone');
    expect(kinds.get('outline')).toBe('flat');
  });

  it('a cutaway that arrives as a construction copy keeps its own references', () => {
    const job = load('j11-inlay-female-30v-male.json');
    const setup = jobSetups(job)[0]!;
    // The male blank's program owns `inlay-male-1`, whose islands name the male plug cutaway; the
    // plug itself must arrive as a reference copy WITH its own outer ring and island rings.
    const sub = jobForSetup(job, { setupIndex: 1, setupId: setup.id, toolKey: 'flat-1.0', itemIds: ['inlay-male-1'] }, resolveTool('flat-1.0'));
    expect(sub.combined?.map((c) => c.id)).toContain('inlay-plug-2');
    expect(sub.shapes?.map((s) => s.id)).toEqual(
      expect.arrayContaining(['inlay-blank', 'inlay-plug-2-ref-ring-outer', 'inlay-plug-2-ref-ring-inner']),
    );
    expect(validateJob(sub).filter((f) => f.code === 'item-reference')).toEqual([]);
  });

});
