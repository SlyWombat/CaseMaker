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
 *
 * #1062 RE-PIN (2026-11-07, at 1a438a48b). The V is now PINNED in `cutters.pinned.chamfer`.
 * Before #1062 the fixture relied on an UNPINNED no-cone V reaching the plan at all: its feeds
 * refused (`cuttingForTrace` — a V trace needs a cone), and #669's diameter proxy stood in for it
 * because the proxy carried the cutter's id. #1062 made a proxy geometry-only and gated the
 * substitution to `no-feeds`: a shape refusal is no longer turned into a feed row, so an unpinned
 * no-cone V correctly leaves the candidate set (`goal-cutter-unfeedable`) and never reaches the
 * crease — `unplanned` had no pencil entry. The premise is unchanged; the ROUTE into the plan is
 * now the pinned cutter (the exception that keeps an operator's stated V in the set, exactly the
 * job this containment exists for). Numbers and the assertion are untouched.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const BALL2: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose' };
// A chamfer whose cone the house does not state: `profileOf` returns null and `clSurface` throws.
// The organizer's own catalogue V is this class (the gate's "chamfer has no drop-cutter profile").
const V_NO_CONE: Tool = flatEndMill(3.175, { number: 3, id: 'v-no-cone', name: '', shape: 'chamfer', typeText: 'Chamfer', fluteLength: 30 });

function input(house: Tool[]): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    // #1062 — the V reaches the plan as the job's PINNED cutter: an unpinned no-cone V is
    // unfeedable (a V trace needs a cone) and never enters the set.
    cutters: { house, catalogue: [], pinned: { chamfer: 'v-no-cone' } },
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
