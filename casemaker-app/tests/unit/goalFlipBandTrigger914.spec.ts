/**
 * #914 review — THE BAND-FLOOR TRIGGER MUST USE THE SIDE'S OWN NEED, not the goal's raw height.
 *
 * `engraveGenerate.ts`'s `cutWithinReach` band (#785) decided whether to float a floor by
 * comparing `placedSize(goal).z` — the goal's own HEIGHT, the same number for every side of a
 * flipped goal regardless of where it sits — against the chosen cutter's reach. A side whose own
 * placement is NOT flush with its own work-Z = 0 (a flipped setup's goal: on a real stick figure
 * #914's own report measured this at `position.z ≈ -(stockThickness - depth)`) can need MORE
 * depth than its own height states, up to the full stock thickness. The trigger never saw that,
 * so a flipped side whose real need exceeded the cutter's reach was silently asked to cut past
 * it — BEFORE this fix, side 2's posted program cut to the full −14 mm; AFTER it, it floors at
 * −11 mm (12 mm reach − 1 mm clearance), exactly what `goalReachFindings`'s own `goalSideNeedMm`
 * read already said it should.
 *
 * A SEPARATE, PRE-EXISTING BUG (found while building this spec, NOT fixed here): the multi-setup
 * goal dispatcher (`generateGoalPrograms`, #723 P2-1b) returns `{ ...first, programs }` on
 * success — it keeps only setup 1's OWN findings and silently drops every later side's. Side 2's
 * `goal-cut-top-band` finding is computed correctly (which is why its program floors correctly
 * below) but never reaches the job's merged `findings`, so the operator never reads it. This spec
 * therefore asserts on the PROGRAM'S OWN posted depth directly, not on the finding's presence —
 * reported separately, not fixed in this stack.
 *
 * THE SHAPE: `relief-plate.stl` (a real ~7 mm-deep goal, not synthetic) on a 14 mm stock with the
 * bench's own `inv:kz-ball-nose-2-12` (12 mm flute — a real, committed house tool). Side 1's need
 * (7 mm) is comfortably under 12 mm: no band, no change. Side 2 (flipped) needs the FULL stock
 * thickness (14 mm) — over the 12 mm reach — with `cutWithinReach: true` carried through the flip
 * (the design note's own mechanism, #914's report confirmed it propagates).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planFlipSetups, programIndexesFor } from '@/engine/cnc/engrave/goalFlipSetups';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

/** The bench's own `inv:kz-ball-nose-2-12` — a real, committed house tool, 12 mm flute. Handed in
 *  directly (`job.tool` wins over the registry, #305) so this test needs no location document. */
const BALL_12: Tool = {
  number: 1,
  id: 'test-ball-nose-2-12',
  name: '2mm Ball Nose',
  typeText: 'Ball Nose Engraving',
  shape: 'ball',
  handleDiameter: 3.175,
  tipDiameter: 2,
  diameter: 3.175,
  cornerRadius: 1,
  angle: null,
  halfAngle: null,
  fluteLength: 12,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
};

const STOCK = { length: 60, width: 50, thickness: 14, material: 'pla' as const };

/** The two-setup flip job: relief-plate.stl, `cutWithinReach: true`, the 12 mm ball. */
async function flipJob(): Promise<{ job: EngraveJob; setup2Id: string; goal2Id: string }> {
  const bytes = readFileSync(here('relief-plate.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'relief-plate.stl'), 'goal-relief-914-band');
  if (!read.ok) throw new Error(read.error);
  const target: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: STOCK.length / 2, y: STOCK.width / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    cutWithinReach: true,
  };
  const base = defaultEngraveJob();
  const seed: EngraveJob = {
    ...base,
    name: 'band-trigger-914',
    labels: [],
    shapes: [],
    drills: [],
    stock: STOCK,
    toolKey: 'user:test-ball-nose-2-12',
    tool: BALL_12,
    targetObject: target,
  };
  const plan = planFlipSetups(seed, target, ['top', 'bottom']);
  if (!plan.ok) throw new Error(`band-trigger-914: planFlipSetups refused: ${plan.reason}`);
  const { targetObject: _t, ...rest } = seed;
  const job: EngraveJob = { ...rest, setups: plan.setups, targetObjects: plan.goals };
  return { job, setup2Id: plan.setups[1]!.id, goal2Id: plan.goals[1]!.id };
}

/** The deepest Z (most negative) move in a program's own text. */
function deepestZ(nc: string): number {
  let min = 0;
  for (const m of nc.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) {
    const z = Number(m[1]);
    if (z < min) min = z;
  }
  return min;
}

describe('#914 review — the band-floor trigger uses the side’s own need', () => {
  it('side 2 (flipped) needs the full 14 mm stock, over the 12 mm ball’s reach — the premise', async () => {
    const { job } = await flipJob();
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
  });

  it('side 2’s program floors at the cutter’s own band (11 mm), not the full 14 mm need', async () => {
    const { job, setup2Id } = await flipJob();
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);

    // side 2's own posted program(s), read off the generator's REAL list (#898 part 2) — this is
    // its first exercise against real generator output in this stack, not a synthetic array.
    const idx = programIndexesFor(setup2Id, g.programs);
    expect(idx.length, `setup 2 must own at least one posted program: ${JSON.stringify(g.programs.map((p) => p.setupId))}`).toBeGreaterThanOrEqual(1);
    const deepest = Math.min(...idx.map((i) => deepestZ(g.programs[i]!.nc)));

    // THE RED-FIRST ASSERTION: before the fix, the raw-height trigger never fired for this
    // goal/cutter pair (the goal's own height, 7 mm, is under the 12 mm reach even though side
    // 2's REAL need, 14 mm, is not), so the program cut the full −14 mm. After the fix it floors
    // at −11 mm (12 mm reach − 1 mm GOAL_BAND_CLEARANCE_MM) — exactly what `goalReachFindings`'s
    // own `goalSideNeedMm` already says this side should be limited to (confirmed separately: the
    // finding itself is computed correctly but never reaches the job's merged `findings` today —
    // a different, pre-existing bug in `generateGoalPrograms`, reported, not fixed here).
    expect(deepest).toBeCloseTo(-11, 1);
    expect(deepest).not.toBeCloseTo(-14, 1);
  }, 60_000);

  it('side 1 (7 mm, well under 12 mm) needs no band at all — unaffected by the fix', async () => {
    const { job, setup2Id: _s2 } = await flipJob();
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    const setup1Id = job.setups![0]!.id;
    const goal1Id = job.targetObjects![0]!.id;
    expect(g.findings.find((f) => f.targetId === goal1Id && (f.code === 'goal-cut-top-band' || f.code === 'goal-reach-short'))).toBeUndefined();
    const idx = programIndexesFor(setup1Id, g.programs);
    expect(idx.length).toBeGreaterThanOrEqual(1);
    const deepest = Math.min(...idx.map((i) => deepestZ(g.programs[i]!.nc)));
    // The relief's own ~7 mm depth, not floored at all.
    expect(deepest).toBeLessThan(-6);
    expect(deepest).toBeGreaterThan(-8);
  }, 60_000);
});
