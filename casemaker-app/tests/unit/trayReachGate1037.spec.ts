/**
 * #1037 — THE WIZARD'S REACH GATE JUDGES THE BALL BY THE GOAL'S FULL DEPTH. On the M1 tray
 * (110 × 140 × 27.2 hardwood, vise) the owned k3 set reaches every surface: the ball finishes the
 * curved remainder (1.2 → 4.2 mm, its deepest op at −4.199) and the ⌀3.175 × 42 flat frees the
 * 27.2 mm contour. The gate compares the CHOSEN cutter's known reach against the goal's whole
 * depth instead, so it refuses the job the engine plans.
 *
 * RED at 9d371549f: `goal-reach-short` (the ball's 22 mm flute against the goal's 26 mm).
 *
 * The engine's own per-feature rule is `cam/model/sequence.ts depthRefusal` — a cutter is judged
 * against each feature it is ASSIGNED (the ball: the curved features at 4.2 mm; the flat: the
 * contour at 27.2). The gate must agree with it, and 6b's constraint holds: reach resolves from
 * the stated `fluteLength` only (the owned cutters carry no ids, and no catalogue row is read).
 */

import { describe, expect, it } from 'vitest';
import { placedTarget } from './helpers/trayAcceptance';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const TRAY = process.env.CM_959_TRAY_STEP;

/** The k3 owned set, as the issue's table states it — id null, reach stated by fluteLength only. */
const flat = (flute: number, name: string): Tool => ({ ...flatEndMill(3.175), name, fluteLength: flute });
const OWNED: Tool[] = [
  flat(42, '3.175 x 42 flat'),
  flat(25, '3.175 x 25 flat'),
  { ...flatEndMill(3.175), name: '3.175 x 22 ball nose', shape: 'ball', typeText: 'Ball Nose', fluteLength: 22 },
  { ...flatEndMill(3.175), name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', halfAngle: 45, angle: 90 },
  { ...flatEndMill(1), name: '1 x 7 corn', fluteLength: 7 },
];
const entry = (tool: Tool, i: number): ToolLibraryEntry => ({ key: `inv:owned-${i}`, tool, provenance: 'test' });

function trayJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'M1 tray',
    labels: [],
    shapes: [],
    drills: [],
    stock: { length: 110, width: 140, thickness: 27.2, material: 'hardwood' },
    // #1117 — THE MOUNT IS INCIDENTAL TO WHAT THIS CASE PROVES: the reach gate and the contour's
    // ×42 assignment on the real tray. Tape keeps the tray, the blank and the program; the vise's
    // jaw was never part of the proof, and the #1117 check rightly refuses a 0.4 mm rim on it.
    workholding: { kind: 'tape', tape: { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' } },
    toolKey: 'inv:owned-2',
    targetObject: target,
  } as EngraveJob;
}

describe.skipIf(TRAY === undefined)('#1037 the M1 tray reaches Generate with the owned set', () => {
  it('the ⌀3.175 x 22 ball is not refused by the goal’s whole depth, and its plan cuts ≤ 4.2 mm', async () => {
    const target = await placedTarget(TRAY!, [110, 140], -1.2);
    const job = trayJob(target);
    const ball = OWNED[2]!;
    const out = await generateGoalProgram(job, target, ball, null, {
      shop: { tools: OWNED.map(entry) },
    });
    expect(out.errors.map((e) => e.message).join('; ')).not.toContain('reach');
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
    // The engine's own assignment: the ball's ops stop at the curved remainder's floor.
    const plan = out.plan;
    expect(plan, 'the model plan ran').toBeDefined();
    const ops = plan!.perSetup.flatMap((s) => s.ops);
    let ballDeepest = 0;
    let flatDeepest = 0;
    for (const op of ops) {
      let deepest = 0;
      for (const ir of op.outcome.ir.operations) for (const m of ir.moves) deepest = Math.min(deepest, m.z);
      if (op.outcome.cutter.includes('ball')) ballDeepest = Math.min(ballDeepest, deepest);
      else flatDeepest = Math.min(flatDeepest, deepest);
    }
    expect(ballDeepest, 'the ball never runs below the curved remainder').toBeGreaterThanOrEqual(-4.21);
    expect(flatDeepest, 'the flat frees the 27.2 mm contour').toBeLessThanOrEqual(-27.0);
    // The inverse pin: the contour op is the ×42's, specifically — the one cutter that reaches.
    const contourOps = ops.filter((o) => o.kind === 'contour');
    expect(contourOps.length, 'one freeing contour is posted').toBe(1);
    expect(contourOps[0]!.outcome.cutter).toContain('42');
    expect(out.findings.some((f) => f.code === 'goal-not-freed')).toBe(false);
    // #1037 — the finisher reaches the curved remainder's floor: no skip is stated.
    expect(out.findings.some((f) => f.code === 'goal-finish-unreachable')).toBe(false);
  }, 600_000);

  it('a house flat whose stated flute reaches but is not in the chain says so, never "longest is 42 mm" contradicting itself', async () => {
    const target = await placedTarget(TRAY!, [110, 140], -1.2);
    const job = trayJob(target);
    // The 42-flute flat is in the HOUSE but cannot enter the chain (it states no cutting diameter),
    // so no step of the chosen chain covers the profile — the warning's cause is the CHAIN, not a
    // short set, and the sentence must name the reaching flat rather than call the set short.
    const blind = { ...flat(42, '42 x blind flat'), diameter: null, tipDiameter: null } as Tool;
    const set = OWNED.filter((_, i) => i !== 0).concat(blind);
    const out = await generateGoalProgram(job, target, OWNED[2]!, null, { shop: { tools: set.map(entry) } });
    // #1195 (the analyst's field) SUPERSEDES the #1037 statement here too: the blind flat states a
    // 42 mm flute but cannot CUT (no diameter), so no chain can prove the 27.2 mm profile and the
    // plan refuses with the named sentence rather than posting an unfreed part.
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(false);
    const said = out.errors.map((e) => e.message).join('; ');
    expect(said).toContain('nothing can free this part');
    expect(said).toContain('27.2 mm');
    expect(out.findings.some((f) => f.code === 'goal-not-freed')).toBe(false);
  }, 600_000);

  it('with the ×42 flat removed the run REFUSES, naming the reach and the unstated cutters (#1195)', async () => {
    const target = await placedTarget(TRAY!, [110, 140], -1.2);
    const job = trayJob(target);
    const set = OWNED.filter((_, i) => i !== 0);
    const out = await generateGoalProgram(job, target, OWNED[2]!, null, { shop: { tools: set.map(entry) } });
    // #1195 (the analyst's field) SUPERSEDES #1037's "an unfreed part is a statement" ruling: the
    // freeing contour's reach is a HARD CONSTRAINT on the pick, so a job with no stated-reaching
    // cutter must not post a part it cannot free. The sentence names the profile and the way out.
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(false);
    const said = out.errors.map((e) => e.message).join('; ');
    expect(said).toContain('nothing can free this part');
    expect(said).toContain('27.2 mm');
    expect(said).toContain('state a flute length on');
    // The old warning is not how this is stated any more.
    expect(out.findings.some((f) => f.code === 'goal-not-freed')).toBe(false);
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
  }, 600_000);
});
