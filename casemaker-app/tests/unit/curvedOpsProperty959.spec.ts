/**
 * #964 — THE CURVED CUTTING OPS' PROPERTY TEST (#959/#960).
 *
 * The curved kinds of `randomParts.ts` — a sloped floor, a floor fillet, a spherical scoop and an
 * undercut-free figure — planned through `cam/model/plan.ts`'s ONE entry, `planModelCam`, and
 * judged the way #965 judges the figures:
 *
 *   - every program posts with the Z1 post and is stamped with its own Tool record on the goal
 *     heightfield, accumulated across programs (and unioned across setups, should the plan return
 *     more than one);
 *   - coverage of the goal's covered cells is at least 95 %;
 *   - cut-into is ZERO in `checkGoalCutInto`'s adjudicated set — the 0.1 mm floor after the wall
 *     cells and the wall shadow are excluded, with both excluded shares printed in a failure.
 *
 * RED TODAY, FOR A STATED REASON: `planModelCam` is still the #956 skeleton and throws its named
 * error. This spec is not allowed to crash in the harness — the first call raises that message, so
 * the run is red with the reason. When C wires the entry it plans these parts with no change here.
 *
 * Seeds are small and fixed; the kinds are the four this generator added for exactly this path.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind, type RandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { HOP_Z, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptField } from '@/workers/sim/sweptPoint';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
const HOUSE = [FLAT6, FLAT3175, BALL2];

const KINDS: PartKind[] = ['sloped', 'filletedFloor', 'scooped', 'figure'];
const SEEDS = [1, 2] as const;

function planInputFor(part: RandomPart): ModelPlanInput {
  return {
    geometry: { triangles: part.mesh },
    setups: [
      {
        frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness },
        underside: 'flatOnStockBottom',
      },
    ],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: HOUSE, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

function postContextFor(part: RandomPart): PostContext {
  return {
    jobName: `curved-${part.kind}-${part.seed}`,
    stock: { ...part.stock },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-964',
    toolKey: 'multi',
  };
}

/** The lower envelope of every posted program's cutter at each goal cell. */
function wholeSurfaceTop(programs: readonly { ir: ToolpathIR; text: string }[], field: GoalHeightfield): ResultTop {
  let acc: Float32Array | null = null;
  for (const program of programs) {
    const parsed = parseGcode(program.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('#964 curved property: a posted program carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamp = exactSweptField(field, buildTimeline(parsed, setup, Z1), program.ir.tool);
    if (stamp === null) continue;
    if (acc === null) acc = Float32Array.from(stamp);
    else for (let k = 0; k < acc.length; k++) if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
  }
  if (acc === null) throw new Error('#964 curved property: no posted program removed anything');
  const top = acc;
  return (x, y) => {
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
    return top[j * field.nx + i]!;
  };
}

describe('#964 the curved ops cut the design and leave the walls (#959/#960)', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: plans, posts, covers the surface, never cuts into it`, async () => {
        const part = buildRandomPart(seed, kind, tl);
        // RED TODAY: the #956 skeleton's named error is the failure — the harness itself is fine.
        const output = await planModelCam(planInputFor(part));
        expect(output.perSetup.length, `${kind} seed ${seed}: no setup planned`).toBeGreaterThanOrEqual(1);

        const ctx = postContextFor(part);
        const programs: { ir: ToolpathIR; text: string }[] = [];
        for (const setup of output.perSetup) {
          for (const ir of setup.programs) {
            const posted = postZ1(ir, ctx, Z1);
            expect(posted.ok, `${kind} seed ${seed}: postZ1 refused — ${posted.ok ? '' : posted.errors.join('; ')}`).toBe(true);
            if (!posted.ok) continue;
            // The machine's own verifier reads the posted text: a rapid at cut depth is the
            // defect the figures' acceptance caught, and the synthetic kinds must catch it too.
            const parsed = parseGcode(posted.text);
            const stockPart = setupFromHeader(parsed.header).patch.part;
            if (stockPart === undefined || stockPart.kind !== 'prism' || stockPart.outline.kind !== 'p-rect') {
              throw new Error(`#964 curved property: a posted program carries no rectangular stock header`);
            }
            const setup = stubSetup(stockPart, { kind: 'tape-down', contact: stockPart.outline }, { startingTool: 1 }, Z1);
            const verify = verifyProgram(posted.text, {
              setup,
              machine: Z1,
              tool: ir.tool,
              depthLimit: stockDepthLimit(part.stock, 0),
              minRapidZ: HOP_Z,
            });
            expect(
              verify.findings.filter((f) => f.severity === 'error'),
              `${kind} seed ${seed}: verifier errors:\n${verify.findings.map((f) => `${f.code}: ${f.message} (line ${f.line ?? '?'})`).join('\n')}`,
            ).toEqual([]);
            programs.push({ ir, text: posted.text });
          }
        }
        expect(programs.length, `${kind} seed ${seed}: the plan posted no program`).toBeGreaterThan(0);

        const field = sampleGoalHeightfield(part.target, { pitchMm: 0.1, stockTopZ: 0 });
        const top = wholeSurfaceTop(programs, field);
        const report = checkGoalCutInto(field, top, { passCoverage: 0.95, wallShadowRadiusMm: 3 });
        const coverage = 1 - (report.leftoverFractions[0] ?? 0);
        expect(
          coverage,
          `${kind} seed ${seed}: coverage ${(coverage * 100).toFixed(2)} % — the line is 95 %`,
        ).toBeGreaterThanOrEqual(0.95);
        expect(
          report.adjudicatedFraction,
          `${kind} seed ${seed}: ${(report.adjudicatedFraction * 100).toFixed(2)} % of cells cut below the adjudicated goal (raw ${(report.cutIntoFraction * 100).toFixed(2)} % at the 0.01 floor, adjudicated max ${report.adjudicatedMaxMm.toFixed(3)} mm at ${JSON.stringify(report.adjudicatedMaxAt)}; wall ${(report.wallNotScoredFraction * 100).toFixed(2)} %, shadow ${(report.shadowNotScoredFraction * 100).toFixed(2)} % excluded)`,
        ).toBe(0);
      }, 600_000);
    }
  }
});
