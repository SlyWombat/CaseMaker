/**
 * #1013 — THE DEPTH BAND IS PER FACE. `bandMm` carries two meanings under one number: a REACH band
 * (#988, a cutter-length limit) is the same depth from every face; a PLANE — a stated band or the
 * underside/plinth floor — is one Z in the part, so a flipped face meets it at `T − b`, not `b`.
 * RED FIRST at the parent: `bandedSetups` gave every setup the same `b`, so a stated bottom side
 * of a 20 mm block with a 6 mm plinth band clamped at −6 on BOTH sides — pointing the floor outside
 * the flipped stock and letting that side cut through the plinth.
 *
 * The fixture is the issue's own picture: a 20 mm block, a plinth floor 6 mm below the top
 * (`plinthMm: 14` → floor −6 → band 6), a stated bottom side. Top floors clamp at −6, bottom at
 * −14; the same job on `cutWithinReach` (a 10 mm flute, band 9) clamps both faces at −9.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import { binaryStlBase64 } from './helpers/meshes';

type V = [number, number, number];
type Tri = [V, V, V];

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const c: V[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const q = (a: number, b: number, d: number, e: number): Tri[] => [
    [c[a]!, c[b]!, c[d]!],
    [c[a]!, c[d]!, c[e]!],
  ];
  return [...q(4, 5, 6, 7), ...q(0, 3, 2, 1), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)];
}

let serial = 0;
function goalOf(height: number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: `band-${serial}`,
    name: `band-${serial++}.stl`,
    format: 'stl',
    sha256: serial.toString(16).padStart(64, 'e'),
    data: binaryStlBase64(box(0, 20, 0, 20, -height, 0)),
    size: { x: 20, y: 20, z: height },
    position: { x: 20, y: 15, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function jobOf(target: EngraveTargetObject, thickness: number): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 40, width: 30, thickness },
    targetObject: target,
  };
}

// #1195 — this shop flat stays UNSTATED on purpose: the reach band must come from the CHOSEN
// cutter (10 mm), not from a shop flat's stated flute.
const FLAT: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
/** A 10 mm flute: `cutWithinReach` derives band 9 (reach less the 1 mm holder clearance). */
const REACH_TOOL: Tool = flatEndMill(6, { number: 1, id: 'flat-6-r10', name: 'flat-6 (10 mm flute)', fluteLength: 10 });
const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' });
const SHOP: EngraveShopOpts = { tools: [entry('inv:flat-6', FLAT)] };

/** The deepest Z any planned move reaches, across the plan's posted programs. */
function deepest(out: ModelPlanOutput): number {
  let z = 0;
  for (const setup of out.perSetup) for (const ir of setup.programs) for (const op of ir.operations) for (const m of op.moves) z = Math.min(z, m.z);
  return z;
}

/** The freeing contour's own deepest move — it must stop at the setup's floor. */
function contourMin(out: ModelPlanOutput): number {
  let z = 0;
  for (const setup of out.perSetup) for (const op of setup.ops) if (op.kind === 'contour') for (const o of op.outcome.ir.operations) for (const m of o.moves) z = Math.min(z, m.z);
  return z;
}

function notesOf(out: ModelPlanOutput): string {
  return out.perSetup.flatMap((s) => s.notes).join('\n');
}

describe('#1013 the depth band is per face', () => {
  it('a 6 mm plinth band on a 20 mm block: top floors clamp at −6, the stated bottom side at −14', async () => {
    const goal = goalOf(20, { underside: { kind: 'plinth', plinthMm: 14 } });
    const job = jobOf(goal, 20);

    // #1195 — the chosen cutter states a 16 mm flute: the BOTTOM face's band is 14 mm, so that is
    // the freeing contour's actual posted depth on that side and the cutter must prove it reaches
    // it. The stated plinth floor sets the band; the reach does not.
    const BAND_TOOL: Tool = flatEndMill(6, { number: 1, id: 'flat-6-b16', name: 'flat-6 (16 mm flute)', fluteLength: 16 });
    const top = await buildModelPlanInputForGoal(job, goal, BAND_TOOL, SHOP, 'top');
    expect(top.setups).toHaveLength(1);
    expect(top.setups[0]!.bandMm).toBeCloseTo(6, 6);

    const bottom = await buildModelPlanInputForGoal(job, goal, BAND_TOOL, SHOP, 'bottom');
    expect(bottom.setups).toHaveLength(1);
    expect(bottom.setups[0]!.frame.up).toEqual([0, 0, -1]);
    // RED at the parent: 6 — the same top-face number on a face whose own top is the stock's bottom.
    expect(bottom.setups[0]!.bandMm).toBeCloseTo(14, 6);

    const topOut = await planModelCam(top);
    const bottomOut = await planModelCam(bottom);
    // The plan honours each face's own number: the cut reaches the floor and never passes it.
    expect(deepest(topOut)).toBeGreaterThanOrEqual(-6 - 1e-6);
    expect(deepest(topOut)).toBeLessThanOrEqual(-5.5);
    expect(deepest(bottomOut)).toBeGreaterThanOrEqual(-14 - 1e-6);
    expect(deepest(bottomOut)).toBeLessThanOrEqual(-13.5);
    // The freeing contour stops at its own floor, not at the other side's.
    expect(contourMin(topOut)).toBeCloseTo(-6, 3);
    expect(contourMin(bottomOut)).toBeCloseTo(-14, 3);
    // The note names the face the band cuts.
    expect(notesOf(topOut)).toContain("Cut only the stock's top 6 mm");
    expect(notesOf(bottomOut)).toContain("Cut only the stock's bottom 14 mm");
  }, 240_000);

  it('a reach band is the same depth on every face: a 10 mm flute clamps both at −9', async () => {
    const goal = goalOf(20, { cutWithinReach: true });
    const job = jobOf(goal, 20);
    const top = await buildModelPlanInputForGoal(job, goal, REACH_TOOL, SHOP, 'top');
    expect(top.setups[0]!.bandMm).toBeCloseTo(9, 6);
    const bottom = await buildModelPlanInputForGoal(job, goal, REACH_TOOL, SHOP, 'bottom');
    expect(bottom.setups[0]!.bandMm).toBeCloseTo(9, 6);

    const bottomOut = await planModelCam(bottom);
    expect(deepest(bottomOut)).toBeGreaterThanOrEqual(-9 - 1e-6);
    expect(deepest(bottomOut)).toBeLessThanOrEqual(-8.5);
    expect(notesOf(bottomOut)).toContain("Cut only the stock's bottom 9 mm");
  }, 240_000);

  it('#1075 under cutWithinReach the band follows the SHOP’s longest reach, not the finish pick’s', async () => {
    // The finish pick is a 10 mm-flute flat (band 9). The shop also owns a 14 mm-flute flat: the
    // goal is 20 mm deep, so the pick's reach would truncate 11 mm of it — the band must be the
    // shop's longest reach (13), not the pick's 9.
    const goal = goalOf(20, { cutWithinReach: true });
    const job = jobOf(goal, 20);
    const LONG_FLAT: Tool = flatEndMill(6, { number: 2, id: 'flat-6-long', name: 'flat-6 (14 mm flute)', fluteLength: 14 });
    const shop: EngraveShopOpts = {
      tools: [entry('inv:flat-6', FLAT), entry('inv:flat-6-long', LONG_FLAT)],
    };
    const input = await buildModelPlanInputForGoal(job, goal, REACH_TOOL, shop, 'top');
    // RED at the parent: 9 — the picked finisher's own reach bounded the job.
    expect(input.setups[0]!.bandMm).toBeCloseTo(13, 6);
    const out = await planModelCam(input);
    expect(deepest(out)).toBeGreaterThanOrEqual(-13 - 1e-6);
    expect(deepest(out)).toBeLessThanOrEqual(-12.5);
  }, 240_000);

  it('#1075 a shop whose reach COVERS the goal needs no band at all', async () => {
    // The same job with a 22 mm-flute owned flat: the reach covers the goal, so no truncation and
    // no band (the plan cuts the goal's own 20 mm floor).
    const goal = goalOf(20, { cutWithinReach: true });
    const job = jobOf(goal, 20);
    const COVERING: Tool = flatEndMill(6, { number: 2, id: 'flat-6-cover', name: 'flat-6 (22 mm flute)', fluteLength: 22 });
    const shop: EngraveShopOpts = { tools: [entry('inv:flat-6', FLAT), entry('inv:flat-6-cover', COVERING)] };
    const input = await buildModelPlanInputForGoal(job, goal, REACH_TOOL, shop, 'top');
    expect(input.setups[0]!.bandMm).toBeUndefined();
    const out = await planModelCam(input);
    expect(deepest(out)).toBeLessThanOrEqual(-19.9);
    expect(deepest(out)).toBeGreaterThanOrEqual(-20 - 1e-6);
  }, 240_000);

  it('a plane that leaves the flipped side nothing to cut is refused by name', async () => {
    // The underside floor at the blank's own bottom: the flipped side has nothing left to remove.
    const plinthZero = goalOf(20, { underside: { kind: 'plinth', plinthMm: 0 } });
    await expect(
      buildModelPlanInputForGoal(jobOf(plinthZero, 20), plinthZero, FLAT, SHOP, 'bottom'),
    ).rejects.toThrow(/the underside floor leaves the bottom side nothing to cut on a 20 mm blank/);

    // A stated band deeper than the stock: 8 mm on a 5 mm blank.
    const small = goalOf(5, { bandMm: 8 });
    await expect(
      buildModelPlanInputForGoal(jobOf(small, 5), small, FLAT, SHOP, 'bottom'),
    ).rejects.toThrow(/the stated band leaves the bottom side nothing to cut on a 5 mm blank/);
  }, 60_000);

  it('the auto top setup keeps its own number — a single top side is unchanged by the fix', async () => {
    const goal = goalOf(20, { underside: { kind: 'plinth', plinthMm: 14 } });
    const auto = await buildModelPlanInputForGoal(jobOf(goal, 20), goal, FLAT, SHOP);
    expect(auto.setups[0]!.bandMm).toBeCloseTo(6, 6);
  }, 60_000);
});
