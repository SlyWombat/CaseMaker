/**
 * #961 (the gate on 961-wiring-r) — A V THAT CANNOT MAKE A CL SURFACE MUST NOT THROW THE JOB.
 *
 * The crease pass (`planCurvedForTree` step 3c) builds the V's own CL with
 * `clSurface(geometry, roughRegion, vTool, …)`. A chamfer/engraving row whose cone the catalogue
 * does not state — the organizer's house V is one — makes `profileOf` return null, and `clSurface`
 * throws `cam/model/clsurface: chamfer has no drop-cutter profile for a CL surface`. That throw sat
 * OUTSIDE the `attempt('pencil', vTool, …)` that is supposed to state an unreachable crease in
 * `unplanned`, so the whole job refused instead of the crease being stated.
 *
 * The fixture is the seeded `sloped` part (seed 1): its `curved-0` remainder carries a crease cell
 * at the pipeline's own gate pitch, so the V's CL is really built. RED at the parent (the plan
 * throws); GREEN with the CL inside the attempt (the plan posts and the crease is stated).
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const BALL2: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose' };
// A chamfer whose cone the house does not state: `profileOf` returns null and `clSurface` throws.
// The organizer's own catalogue V is this class (the gate's "chamfer has no drop-cutter profile").
const V_NO_CONE: Tool = flatEndMill(3.175, { number: 3, id: 'v-no-cone', name: '', shape: 'chamfer', typeText: 'Chamfer' });

function input(house: Tool[]): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

describe('#961 a V with no CL profile — the crease is stated, never thrown', () => {
  it('plans the part and names the crease pass in `unplanned` instead of refusing the job', async () => {
    const output = await planModelCam(input([FLAT6, BALL2, V_NO_CONE]));
    expect(output.perSetup.length).toBeGreaterThan(0);
    const stated = output.perSetup.flatMap((s) => s.unplanned).filter((u) => u.kind === 'pencil');
    expect(stated.length, 'the crease pass was not stated in `unplanned`').toBeGreaterThan(0);
    expect(stated.map((u) => u.reason).join('\n')).toMatch(/drop-cutter profile for a CL surface/);
  }, 240_000);
});
