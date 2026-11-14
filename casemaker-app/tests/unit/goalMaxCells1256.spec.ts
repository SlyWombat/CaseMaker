/**
 * #1256 — `goal.maxCells` REACHES THE SAMPLER at the edge that reads it. The top-face measure
 * samples the goal's heightfield; with no location it passes the recommendation, with a shop value
 * it passes that value (the sampler coarsens its pitch to stay under it).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTopFace } from '@/engine/cnc/engrave/goalTopFace';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { GOAL_MAX_CELLS } from '@/engine/cnc/goalLimits';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';

const sampled: Array<number | null | undefined> = [];
vi.mock('@/engine/cnc/engrave/goalHeightfield', async (original) => {
  const real = await original<typeof import('@/engine/cnc/engrave/goalHeightfield')>();
  return {
    ...real,
    sampleGoalHeightfield: (...args: Parameters<typeof real.sampleGoalHeightfield>) => {
      sampled.push(args[1]?.maxCells);
      return real.sampleGoalHeightfield(...args);
    },
  };
});

afterEach(() => {
  clearTargetObjectMeshCache();
  sampled.length = 0;
});

async function job(): Promise<EngraveJob> {
  const bytes = readFileSync(fileURLToPath(new URL('../fixtures/goals/relief-plate.stl', import.meta.url)));
  const r = await readTargetObjectFile(new File([bytes], 'relief-plate.stl'), 'goal-relief');
  if (!r.ok) throw new Error(r.error);
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    drills: [],
    stock: { length: 38, width: 28, thickness: 10, material: 'softwood' },
    targetObject: {
      id: r.id, name: r.name, format: r.format, sha256: r.sha256, data: r.data, size: r.size,
      position: { x: 20, y: 15, z: -2 }, rotation: 0, enabled: true, role: 'goal',
    },
  };
}

describe('#1256 goal.maxCells — the top-face edge', () => {
  it('no location: the recommendation (the sampler constant); a shop value: that value', async () => {
    const j = await job();
    jobTopFace(j, null);
    expect(sampled).toEqual([GOAL_MAX_CELLS]);
    sampled.length = 0;
    const shop = { 'goal.maxCells': { value: 50_000, source: 'chosen', setAt: null, unit: null, note: null } } as ShopDefaults;
    jobTopFace(j, shop);
    expect(sampled).toEqual([50_000]);
  });
});
