/**
 * #888 — DOES THE PLAN LEAVE ANY OF THE STOCK'S TOP? The measure facing's default reads before
 * it acts: a goal whose whole surface is below the blank's top (and whose footprint covers the
 * blank) leaves nothing to skim; a goal that keeps any of the top — a smaller footprint, or a
 * surface at the top height — keeps facing as it was. Measured on the plan's own cut surface (the
 * heightfield), never from the mesh's bounding box alone.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { goalTopFace, jobTopFace } from '@/engine/cnc/engrave/goalTopFace';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

async function read(name: string): Promise<Extract<Awaited<ReturnType<typeof readTargetObjectFile>>, { ok: true }>> {
  const bytes = readFileSync(here(name));
  const result = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result;
}

function targetOf(
  read: Extract<Awaited<ReturnType<typeof readTargetObjectFile>>, { ok: true }>,
  at: { x: number; y: number; z: number },
  over: Partial<EngraveTargetObject> = {},
): EngraveTargetObject {
  return {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: at,
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function jobWith(target: EngraveTargetObject | undefined, stock: { length: number; width: number; thickness: number }): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: target?.name ?? 'plain',
    labels: [],
    shapes: [],
    drills: [],
    stock: { ...stock, material: 'softwood' },
    ...(target === undefined ? {} : { targetObject: target }),
  };
}

describe('#888 — the top-face measure', () => {
  it('a goal sunk below the top that covers the blank leaves NO top to skim', async () => {
    const relief = await read('relief-plate.stl'); // 40 × 30 × 4 plate with a boss
    // The stock is a little smaller than the footprint, so every grid cell is covered; the goal
    // sits 2 mm below the blank's top, so every covered cell is cut lower than the top.
    const goal = targetOf(relief, { x: 20, y: 15, z: -2 });
    const job = jobWith(goal, { length: 38, width: 28, thickness: 10 });
    const facts = goalTopFace(job, goal);
    expect(facts).not.toBeNull();
    expect(facts!.keeps).toBe(false);
    expect(facts!.keptFraction).toBe(0);
  });

  it('a goal at the top height keeps the top (a relief is cut into it, not away)', async () => {
    const relief = await read('relief-plate.stl');
    const goal = targetOf(relief, { x: 20, y: 15, z: 0 });
    const job = jobWith(goal, { length: 38, width: 28, thickness: 10 });
    const facts = goalTopFace(job, goal);
    expect(facts!.keeps).toBe(true);
  });

  it('a goal smaller than the blank keeps the top around it', async () => {
    const relief = await read('relief-plate.stl');
    const goal = targetOf(relief, { x: 40, y: 25, z: -2 }, { surface: { clearAround: 'none' } });
    const job = jobWith(goal, { length: 80, width: 50, thickness: 10 });
    const facts = goalTopFace(job, goal);
    expect(facts!.keeps).toBe(true);
  });

  it('a reference, a picture or a disabled mesh is not judged', async () => {
    const figure = await read('figure.stl');
    const job = jobWith(undefined, { length: 80, width: 50, thickness: 40 });
    expect(goalTopFace(job, targetOf(figure, { x: 40, y: 25, z: 0 }, { role: 'reference' }))).toBeNull();
    expect(goalTopFace(job, targetOf(figure, { x: 40, y: 25, z: 0 }, { enabled: false }))).toBeNull();
    expect(goalTopFace(job, targetOf(figure, { x: 40, y: 25, z: 0 }, { format: 'png' }))).toBeNull();
  });

  it('the job reads its FIRST setup’s goals only: a flip side’s frame is not the top', async () => {
    const relief = await read('relief-plate.stl');
    const goal = targetOf(relief, { x: 40, y: 25, z: -2 }, { surface: { clearAround: 'none' } });
    const base = jobWith(goal, { length: 80, width: 50, thickness: 10 });
    // A later setup's goal (in its own work frame) is cut from the underside and is not asked.
    const later = targetOf(relief, { x: 40, y: 25, z: -20 }, { setupId: 'setup-2' });
    const orientation = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
    const job: EngraveJob = {
      ...base,
      targetObject: undefined,
      targetObjects: [goal, later],
      setups: [
        { id: 'setup-1', orientation: { ...orientation }, mount: { kind: 'vise' }, itemIds: [goal.id], tools: [base.toolKey] },
        { id: 'setup-2', orientation: { ...orientation }, mount: { kind: 'vise' }, itemIds: [later.id], tools: [base.toolKey] },
      ],
    };
    const facts = jobTopFace(job);
    expect(facts?.targetId).toBe(goal.id);
    expect(facts?.keeps).toBe(true);
  });

  it('a job with no goal has no opinion (facing keeps its finish default)', () => {
    expect(jobTopFace(jobWith(undefined, { length: 80, width: 50, thickness: 10 }))).toBeNull();
  });
});
