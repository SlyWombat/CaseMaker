/**
 * #965 — THE SCALLOP SEAT HOLDS A SCALLOP, NEVER A STEP-OVER. `buildModelPlanInputForGoal` used to
 * fill `tolerances.finishMm` from the goal's `finishStepOverMm` (a row spacing for the heightfield
 * raster) or the shop's `stockToLeaveMm` (a roughing allowance). With the ruling that the job's
 * tolerance IS the ball's cusp height, a job stating "step-over 0.2" was commanding a 0.2 mm
 * scallop — ten times coarser than the engine's default. A goal job states no cusp (the surface
 * settings carry step-overs, an allowance and a scallop on/off), so the seat is now EMPTY and the
 * default applies; the step-over and the allowance have no seat in the model plan and are ignored
 * (stated in the builder).
 *
 * Red at 50c6c5036 (1db5eef1 + F's 209d2fa97): `finishMm` comes out 0.2 and the plan's note says
 * "0.200 mm scallop". Green: `finishMm` absent and the note says 0.027.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/** An open relief sheet (the everyday user goal): the goal path closes it before the plan. */
function sheetMesh(n: number, sizeMm: number): { positions: Float32Array; indices: Uint32Array } {
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = 3 * (j * n + i);
      positions[k] = (i / (n - 1)) * sizeMm;
      positions[k + 1] = (j / (n - 1)) * sizeMm;
      positions[k + 2] = rnd() * 0.8;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });

function goalJob(finishStepOverMm: number, stockToLeaveMm: number): EngraveJob {
  const sheet = sheetMesh(12, 20);
  const stl = buildBinaryStl([{ positions: sheet.positions, indices: sheet.indices }]);
  const goal: EngraveTargetObject = {
    id: 'goal-scallop-965',
    name: 'relief-sheet.stl',
    format: 'stl',
    sha256: 'c'.repeat(64),
    data: Buffer.from(stl).toString('base64'),
    size: { x: 20, y: 20, z: 0.8 },
    position: { x: 15, y: 10, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    surface: { finishStepOverMm },
  };
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 30, width: 20, thickness: 10 },
    targetObject: goal,
    // The shop's finish allowance is the OTHER half of the old conflation: it must not reach the
    // scallop seat either (here it is deliberately different from both numbers under test).
    finish: { stockToLeaveMm: { value: stockToLeaveMm, source: 'chosen' as const } },
  };
}

const shop = {
  tools: [
    { key: 'inv:ball-2', tool: { ...BALL, number: null }, provenance: 'test fixture' },
    { key: 'inv:flat-3', tool: { ...FLAT, number: null }, provenance: 'test fixture' },
  ],
};

describe('#965 the goal path does not read a step-over as a scallop', () => {
  it('RED-FIRST: a goal stating finishStepOverMm 0.2 gets no 0.2 mm scallop — the default applies', async () => {
    const job = goalJob(0.2, 0.3);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, shop);
    expect('finishMm' in input.tolerances ? input.tolerances.finishMm : undefined, 'the step-over reached the scallop seat').toBeUndefined();

    const output = await planModelCam(input);
    const notes = output.perSetup.flatMap((setup) => setup.notes);
    const scallopLine = notes.find((n) => n.includes('mm scallop'));
    expect(scallopLine, `no scallop note: ${notes.join(' | ')}`).toBeDefined();
    expect(scallopLine!).toContain('0.027 mm scallop');
    expect(scallopLine!, 'the job’s 0.2 step-over became a scallop').not.toContain('0.200');
  }, 120_000);
});
