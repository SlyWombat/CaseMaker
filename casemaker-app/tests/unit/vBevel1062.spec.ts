/**
 * #1062 (defect 1) — A FLOOR-CORRECT V POCKET PREDICTS ITS LIP BEVEL.
 *
 * When the V is the only cutter that fits a pocket, it cuts the floor correct and the 45° flank
 * bevelled the design's top face by `depth × tan(half)` per side. The plan used to call that "the
 * edge-break class, not cut-into" on every job — true only where the job states an edge break;
 * the M1 tray states none and the gate scored 0.523 mm. The plan now:
 *   - carries `predictedCutIntoMm = depth·tan(half)` on the V op's outcome and, as the max over
 *     its V ops, on `PlanOutcome.predictedCutIntoMm`;
 *   - states it in the plan's note, in outcome terms.
 *
 * The fixture is a two-pocket block whose openings are narrower than every flat in the house but
 * the V: with only the V able to enter, the V takes both pockets; adding a ⌀0.6 flat that fits
 * makes the flat win them (the V is the last resort it was ruled to be).
 *
 * RED at ee4ec1f75: no `predictedCutIntoMm` on the op or the outcome, and the note still says
 * "the land at the surface is the edge-break class, not cut-into".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { clearFeedCatalogue } from '@/engine/cnc/feeds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

const L = 40;
const W = 30;
const T = 6;
/** Two shallow pockets, each narrower than every flat except the V. */
const POCKETS = [
  { x0: 6, x1: 9, y0: 8, y1: 11, depth: 0.8 },
  { x0: 26, x1: 28.5, y0: 18, y1: 20.5, depth: 0.8 },
];
const V_DEPTH = 0.8; // tan(45°) = 1, so the land per side is the depth

function twoPocketBlock(): { positions: Float32Array; indices: Uint32Array; triangleCount: number } {
  const M = tl.Manifold;
  let solid = M.cube([L, W, T], true).translate([L / 2, W / 2, -T / 2]);
  for (const p of POCKETS) {
    const voidBox = M.cube([p.x1 - p.x0, p.y1 - p.y0, p.depth], true).translate([
      (p.x0 + p.x1) / 2,
      (p.y0 + p.y1) / 2,
      -p.depth / 2,
    ]);
    solid = solid.subtract(voidBox);
  }
  const mesh = solid.getMesh();
  const numProp = mesh.numProp;
  const numVert = mesh.vertProperties.length / numProp;
  const positions = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * numProp + k]!;
  const indices = new Uint32Array(mesh.triVerts);
  solid.delete();
  return { positions, indices, triangleCount: indices.length / 3 };
}

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const BALL2: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose' };
const V90: Tool = {
  ...flatEndMill(3.175, { number: 3, id: 'v-90', name: '90° V' }),
  shape: 'chamfer',
  typeText: 'Chamfer',
  tipDiameter: 0.1,
  angle: 90,
  halfAngle: 45,
  fluteLength: 1.6,
} as Tool;
const FLAT06: Tool = flatEndMill(0.6, { number: 4, id: 'flat-0.6', name: '0.6 mm flat' });

beforeEach(() => clearFeedCatalogue());
afterEach(() => clearFeedCatalogue());

function targetFor(mesh: ReturnType<typeof twoPocketBlock>): EngraveTargetObject {
  const bytes = new Uint8Array(84 + mesh.triangleCount * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, mesh.triangleCount, true);
  let off = 84;
  for (let t = 0; t < mesh.triangleCount; t++) {
    off += 12;
    for (let v = 0; v < 3; v++) {
      const i = mesh.indices[t * 3 + v]!;
      dv.setFloat32(off, mesh.positions[i * 3]!, true);
      dv.setFloat32(off + 4, mesh.positions[i * 3 + 1]!, true);
      dv.setFloat32(off + 8, mesh.positions[i * 3 + 2]!, true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return {
    id: 'goal-1062', name: 'two-pocket block', role: 'goal', enabled: true, format: 'stl',
    sha256: 'b'.repeat(64), data: Buffer.from(bytes).toString('base64'),
    position: { x: L / 2, y: W / 2, z: 0 }, rotation: 0,
    size: { x: L, y: W, z: T },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function jobFor(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL2, stock: { ...base.stock, length: L, width: W, thickness: T, material: 'hardwood' } };
}

function shopWith(tools: Tool[]): EngraveShopOpts {
  return { tools: tools.map((tool, i) => ({ key: `probe:${i}`, tool, provenance: 'test' })), feeds: null };
}

describe('#1062 (defect 1) the V floor pocket predicts its lip bevel', () => {
  it('RED: with only the V able to enter, the op and the plan carry depth·tan(half), stated as cut-into', async () => {
    const target = targetFor(twoPocketBlock());
    const input = await buildModelPlanInputForGoal(jobFor(target), target, BALL2, shopWith([FLAT6, BALL2, V90]));
    const plan = await planModelCam(input);
    const vOps = plan.perSetup.flatMap((s) => s.ops).filter((op) => op.outcome.ir.tool.shape === 'chamfer');
    expect(vOps.length, 'the V did not take the pockets').toBeGreaterThan(0);
    for (const op of vOps) {
      expect(op.outcome.predictedCutIntoMm ?? null, `${op.region.id}: the op does not predict its bevel`).toBeCloseTo(V_DEPTH, 6);
    }
    expect(plan.outcome?.predictedCutIntoMm ?? null, 'the outcome does not carry the bevel').toBeCloseTo(V_DEPTH, 6);
    const notes = plan.perSetup.flatMap((s) => s.notes).join(' | ');
    expect(notes).toContain(`lips are bevelled ${V_DEPTH} mm`);
    // The false clause is gone: nothing is called "the edge-break class, not cut-into".
    expect(notes).not.toContain('edge-break class');
  }, 240_000);

  it('with a ⌀0.6 flat that fits, the flat wins the pockets and no V floor is planned', async () => {
    const target = targetFor(twoPocketBlock());
    const input = await buildModelPlanInputForGoal(jobFor(target), target, BALL2, shopWith([FLAT6, BALL2, V90, FLAT06]));
    const plan = await planModelCam(input);
    const vOps = plan.perSetup.flatMap((s) => s.ops).filter((op) => op.outcome.ir.tool.shape === 'chamfer');
    expect(vOps.length, 'the V still took the pockets a flat fits').toBe(0);
    expect(plan.outcome?.predictedCutIntoMm ?? null, 'a plan with no V floor predicts no bevel').toBeNull();
  }, 240_000);
});
