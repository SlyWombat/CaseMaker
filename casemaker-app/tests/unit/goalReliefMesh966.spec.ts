/**
 * #966 blocker b — A PICTURE ENTERS THE ONE MODEL ENGINE AS A MESH.
 *
 * `buildModelPlanInputForGoal` (`workers/sim/engraveGenerate.ts`) used to reach
 * `targetObjectMesh`, which throws for a picture ("a picture relief has no mesh to draw — its
 * heights come from the pixels"), so a PNG relief could not be planned through `cam/model` at
 * all. Today the builder triangulates the heightfield its own GATE samples
 * (`sampleGoalHeightfield`, the same decoder and placement), which is the surface the check will
 * measure, and hands `planModelCam` an ordinary closed solid.
 *
 * RED-FIRST: on the seam commit this spec fails at the first call, with that throw; it is green
 * only when the builder returns a plan with programs. The plan itself is ~50 s on dave-1 (the
 * engine's drop-cutter, not this triangulation, which takes ~1 ms for ~4.6k triangles).
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBS = join(HERE, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

const job = JSON.parse(fs.readFileSync(join(JOBS, 'j07-photo-relief.json'), 'utf8')) as EngraveJob;
const goal = job.targetObject!;

const BALL: Tool = {
  ...flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2' }),
  typeText: 'Ball Nose',
  shape: 'ball',
};
const FLAT: Tool = flatEndMill(6, { number: 2, id: 'flat-6', name: 'flat-6' });
const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool, provenance: 'test fixture' });
const SHOP: EngraveShopOpts = { tools: [entry('inv:flat-6', FLAT)] };

describe('#966 blocker b — a picture relief is a mesh at the engine door', () => {
  it('plans the committed j07 picture job through buildModelPlanInputForGoal + planModelCam', async () => {
    expect(goal.format).toBe('png');

    const input = buildModelPlanInputForGoal(job, goal, BALL, SHOP);
    const mesh = input.geometry.triangles;
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);

    // THE SURFACE IS THE GATE'S: the builder's top vertices are the sampler's own cells, in the
    // sampler's own work frame (its image branch already applies `position`/`rotation`).
    const field = sampleGoalHeightfield(goal, { maxCells: 2_000 });
    expect(mesh.positions.length / 3).toBeGreaterThanOrEqual(field.nx * field.ny);
    for (let k = 0; k < field.nx * field.ny; k++) {
      // Positions are stored float32; the sampler's own float64 values are rounded to match.
      expect(mesh.positions[k * 3]).toBe(Math.fround(field.x0 + (k % field.nx) * field.pitch));
      expect(mesh.positions[k * 3 + 1]).toBe(Math.fround(field.y0 + Math.floor(k / field.nx) * field.pitch));
      expect(mesh.positions[k * 3 + 2]).toBe(Math.fround(field.z[k]!));
    }
    // The worked relief sits centred on the job's position, and its deepest cell is the bbox floor.
    const cx = (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2;
    const cy = (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2;
    expect(Math.abs(cx - goal.position.x)).toBeLessThanOrEqual(field.pitch);
    expect(Math.abs(cy - goal.position.y)).toBeLessThanOrEqual(field.pitch);
    expect(mesh.bbox.min[2]).toBeLessThan(field.minZ);

    const output = await planModelCam(input);
    const programs = output.perSetup.reduce((n, s) => n + s.programs.length, 0);
    console.log(`#966 blocker b: ${output.perSetup.length} setup(s), ${programs} program(s)`);
    expect(output.perSetup.length).toBeGreaterThan(0);
    expect(programs).toBeGreaterThan(0);
  }, 300_000);
});
