/**
 * #985 — THE SCALLOP SEAT HOLDS A CUSP, THE FINISH PITCH HAS ITS OWN SEAT.
 *
 * `buildModelPlanInputForGoal` used to fill `tolerances.finishMm` from the goal's
 * `finishStepOverMm` (a finishing raster PITCH, a width) or the shop's `stockToLeaveMm` (an
 * allowance) — a unit conflation: a job stating 0.3 mm of row spacing commanded a 0.3 mm cusp,
 * which on a ⌀2 ball is a 1.43 mm row (4.8× the pitch it asked for). The issue's three cases:
 *
 *   (a) no pitch, shop allowance 0.2  → `finishMm` undefined (the engine's 0.027 default);
 *   (b) `finishStepOverMm: 0.3`       → carried as `finishStepOverMm`, and the plan reads the
 *                                       cusp it implies on the finishing ball, "0.011 mm";
 *   (c) a stated cusp                 → passes through unchanged, and wins over a pitch.
 *
 * Red at 50c6c5036: (a) comes out 0.2 (the allowance) and (b) comes out 0.300 (the pitch read as
 * a cusp).
 */
import { describe, expect, it } from 'vitest';

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

function goalJob(finishStepOverMm: number | undefined): EngraveJob {
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
  };
}

const shop = {
  tools: [
    { key: 'inv:ball-2', tool: { ...BALL, number: null }, provenance: 'test fixture' },
    { key: 'inv:flat-3', tool: { ...FLAT, number: null }, provenance: 'test fixture' },
  ],
  // The shop's finish allowance is the OTHER half of the old conflation: it must not reach the
  // scallop seat either (it is deliberately different from both numbers under test).
  finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' as const } },
};

describe('#985 the scallop seat holds a cusp; the finish pitch has its own seat', () => {
  /** The plan's scallop sentence, or null when the plan states none. */
  const scallopLineOf = async (job: EngraveJob): Promise<string | null> => {
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, shop);
    const output = await planModelCam(input);
    return output.perSetup.flatMap((setup) => setup.notes).find((n) => n.includes('mm scallop')) ?? null;
  };

  it('(a) no stated pitch, a shop allowance of 0.2: the allowance never reaches the seat — the default applies', async () => {
    const job = goalJob(undefined);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, shop);
    expect('finishMm' in input.tolerances ? input.tolerances.finishMm : undefined, 'the shop allowance reached the scallop seat').toBeUndefined();
    expect('finishStepOverMm' in input.tolerances ? input.tolerances.finishStepOverMm : undefined).toBeUndefined();
    const line = await scallopLineOf(job);
    expect(line, 'no scallop note in the plan').not.toBeNull();
    expect(line!, 'the 0.2 allowance became a cusp').toContain('0.027 mm scallop');
    expect(line!).not.toContain('0.200');
  }, 120_000);

  it('(b) a stated finishStepOverMm 0.3 is carried as a PITCH and read as the cusp it makes on the ⌀2 ball', async () => {
    const job = goalJob(0.3);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, shop);
    expect(input.tolerances.finishStepOverMm, 'the pitch was not carried').toBe(0.3);
    expect('finishMm' in input.tolerances ? input.tolerances.finishMm : undefined, 'the pitch leaked into the cusp seat').toBeUndefined();
    // R − √(R² − (s/2)²) on the ⌀2: 1 − √(1 − 0.15²) = 0.01131 mm.
    const line = await scallopLineOf(job);
    expect(line, 'no scallop note in the plan').not.toBeNull();
    expect(line!, 'the 0.3 pitch was read as a 0.3 cusp').toContain('0.011 mm scallop');
    expect(line!).not.toContain('0.300');
  }, 120_000);

  it('(c) a stated cusp passes through unchanged and wins over a pitch', async () => {
    // A cusp is stated on the plan input directly (the job model carries no cusp field).
    const job = goalJob(0.3);
    const direct = async (tolerances: { finishMm?: number; finishStepOverMm?: number }): Promise<string | null> => {
      const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, shop);
      const output = await planModelCam({ ...input, tolerances });
      return output.perSetup.flatMap((setup) => setup.notes).find((n) => n.includes('mm scallop')) ?? null;
    };
    expect(await direct({ finishMm: 0.01 }), 'a stated cusp was not honoured').toContain('0.010 mm scallop');
    // Both stated: the cusp wins, the pitch does not override it.
    expect(await direct({ finishMm: 0.01, finishStepOverMm: 0.3 }), 'the pitch overrode the stated cusp').toContain('0.010 mm scallop');
  }, 240_000);
});
