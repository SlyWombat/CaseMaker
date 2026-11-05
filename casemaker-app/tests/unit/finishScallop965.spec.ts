/**
 * #965 — THE JOB'S FINISH TOLERANCE IS THE BALL'S SCALLOP (the review session's ruling, 2026-11-05).
 *
 * The 960 merge floored the tolerance at the vendor's default —
 * `Math.max(tolerances.finishMm, DEFAULT_FINISH_SCALLOP_MM)` — so a job that stated 0.01 mm still
 * finished at 0.027 mm, and the figure card reported a surface the job never asked for. The rule
 * now is `tolerances.finishMm ?? DEFAULT_FINISH_SCALLOP_MM`: no max, no floor; the default applies
 * only when the job states no tolerance.
 *
 * RED FIRST, and written against the behaviour rather than the sentence: the plan's own notes must
 * state the scallop it used, and the ball's raster must really be finer at 0.01 mm. At the parent
 * both plans state 0.027 and the two rasters are identical.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import { DEFAULT_FINISH_SCALLOP_MM } from '../../src/engine/cnc/cam/model/ops/finish';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball6: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const v90: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });

/** The `sloped` random part (seed 1) — the same closed synthetic mesh the #959/#961 plan specs
 * use, so the ball really has a curved remainder to finish. */
function input(tolerances: ModelPlanInput['tolerances']): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [flat6, ball6, v90], catalogue: [] },
    tolerances,
    edgeBreak: { legMm: 0 },
  };
}

type PlanOutput = Awaited<ReturnType<typeof planModelCam>>;

/** The plan's own notes (the card's), joined. */
function notesOf(output: PlanOutput): string {
  return output.perSetup.flatMap((setup) => setup.notes).join('\n');
}

/** Every move the ball emitted, across the setup's programs. */
function ballMoves(output: PlanOutput): number {
  return output.perSetup
    .flatMap((setup) => setup.programs)
    .filter((ir) => ir.tool.shape === 'ball')
    .reduce((n, ir) => n + ir.operations.reduce((k, op) => k + op.moves.length, 0), 0);
}

describe('#965 the job’s finish tolerance is the scallop', () => {
  it('a job that states 0.01 mm finishes at 0.01 mm — and the card says so', async () => {
    const fine = await planModelCam(input({ finishMm: 0.01 }));
    expect(ballMoves(fine), 'the fixture planned no ball moves').toBeGreaterThan(0);
    expect(notesOf(fine)).toContain('0.010 mm scallop');
    expect(notesOf(fine)).not.toContain('0.027 mm scallop');
  }, 120_000);

  it('a job that states no tolerance keeps the vendor’s 0.027 mm default', async () => {
    const byDefault = await planModelCam(input({}));
    expect(notesOf(byDefault)).toContain(`${DEFAULT_FINISH_SCALLOP_MM.toFixed(3)} mm scallop`);
    expect(DEFAULT_FINISH_SCALLOP_MM).toBe(0.027);
  }, 120_000);

  it('the ball’s raster is really finer at 0.01 — 0.49 mm rows against 0.80 mm', async () => {
    // Equal-cusp step-over on a ⌀6 ball: s = 2·√(2Rh − h²).
    const step = (h: number): number => 2 * Math.sqrt(2 * 3 * h - h * h);
    expect(step(0.01)).toBeCloseTo(0.49, 2);
    expect(step(0.027)).toBeCloseTo(0.80, 2);
    const fine = await planModelCam(input({ finishMm: 0.01 }));
    const coarse = await planModelCam(input({}));
    // The ball's moves at 0.01 against the default: 6,164 vs 5,251 (1.17×) on the sloped part.
    // The row ratio itself is 1.63× (0.80/0.49); the rest and linking moves the scallop does not
    // touch dilute it, so the assertion is the direction — a finer stated tolerance really does
    // emit a finer raster — with the numbers stated here.
    expect(ballMoves(fine), `${ballMoves(fine)} ball moves at 0.01 vs ${ballMoves(coarse)} at the 0.027 default`).toBeGreaterThan(ballMoves(coarse));
  }, 240_000);
});
