/**
 * #846 follow-up — THE GOAL PATH TAKES THE ROUGHING CHOICE.
 *
 * #966 — the three raster-vs-adaptive comparison cases this file used to pin (a shallow goal
 * kept the raster by the rough3d.compareCellBudget rule, a deep one past
 * rough3d.planBudgetCellLevels did too, and the choice note itself) are deleted: that premise —
 * comparing a raster rough against rough3d.ts's own adaptive pool — has no meaning with one
 * engine, and the keys it read are gone with rough3d.ts. The one case left is D's own red-first
 * pin for cand/966-cutter-fallbacks (the ball-nose gap, #982's own class of issue): a deep PLA
 * goal on a flat-only house used to raster through the OLD engine's own (non-pool) 2D-sweep
 * rule; it is untouched here, fixture and all, for that branch to turn green.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject, StockMaterial } from '@/types/engraveJob';
import { planCutInto } from '../tools/planCutInto';
import { binaryStl } from './helpers/meshes';

afterEach(() => clearTargetObjectMeshCache());

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

/** A 10 × 10 mm ramp whose top face falls from z = 0 at y = 0 to -depth at y = 10. */
function rampTris(depth: number): Tri[] {
  return [
    [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, -depth],
    ],
    [
      [0, 0, 0],
      [10, 10, -depth],
      [0, 10, -depth],
    ],
  ];
}

let shaCounter = 0;
function rampGoal(depth: number): EngraveTargetObject {
  return {
    id: 'ramp-goal',
    name: 'ramp.stl',
    format: 'stl',
    sha256: `ramp-${shaCounter++}`,
    data: Buffer.from(new Uint8Array(binaryStl(rampTris(depth)))).toString('base64'),
    size: { x: 10, y: 10, z: depth },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
  };
}

const FLAT: Tool = flatEndMill(3.175);
const BALL: Tool = flatEndMill(3.175, { shape: 'ball', name: '3.175 mm ball nose' });

function jobFor(depth: number, material: StockMaterial): EngraveJob {
  const job = defaultEngraveJob();
  return {
    ...job,
    labels: [],
    shapes: [],
    stock: { ...job.stock, material },
    targetObject: rampGoal(depth),
  };
}

describe('#846 — the goal path chooses its rough, and says so', () => {
  // #966 triage — #1010 (after #999): the engine-chosen rough changes this job's measured plan;
  // rewritten against the model engine there.
  it.fails('a deep PLA goal on a flat cutter posts the adaptive rough, with both roughs measured', async () => {
    const job = jobFor(5, 'pla');
    const out = await generateGoalProgram(job, job.targetObject!, FLAT, null, { shop: {} });
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.nc).not.toBeNull();
    // The operation the post names, and the one line the run carries.
    expect(out.nc!).toContain('3D rough (adaptive)');
    const note = (out.surface3d?.notes ?? []).find((n) => n.includes('roughing chosen'));
    expect(note, 'the chooser must state its choice').toBeDefined();
    expect(note!).toContain('Adaptive roughing chosen');
    expect(note!).toContain('both were measured');
    expect(note!).toMatch(/max engagement .* mm under the .* mm cap/);
  });

  // #982 pins — the fixture's OWN single-cutter sets through the ONE model entry: the fallback
  // is planned, never a refusal.
  it('#982 pin — a flat-only set plans the curved ramp through planModelCam (no ball: flat raster)', async () => {
    const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
    const job = jobFor(5, 'pla');
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT, {});
    const out = await planModelCam(input);
    expect(out.perSetup[0]!.programs.length, 'no program was planned').toBeGreaterThan(0);
    expect(out.perSetup.flatMap((s) => s.notes).join('\n')).toContain('no ball nose');
    // #982 follow-up (A's review) — the no-ball plan swept against the goal cuts into it NOWHERE
    // (the flat-raster fallback's own outcome check; a cusp/step regression shows up here).
    const report = planCutInto(job, job.targetObject!, out.perSetup.flatMap((s) => s.programs));
    expect(report.adjudicated, `cut-into must be 0 — ${JSON.stringify(report)}`).toBe(0);
  }, 120_000);

  it('#982 pin — a ball-only set plans the same ramp (no flat: the ball floor pass)', async () => {
    const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
    const job = jobFor(5, 'pla');
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, BALL, {});
    const out = await planModelCam(input);
    expect(out.perSetup[0]!.programs.length, 'no program was planned').toBeGreaterThan(0);
    expect(out.perSetup.flatMap((s) => s.notes).join('\n')).toContain('no flat end mill');
  }, 120_000);
});
