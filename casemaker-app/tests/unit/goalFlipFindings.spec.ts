/**
 * #872 — THE SENTENCE AND THE OFFER, spoken on the corpus: a relief gets the split and NO
 * proposal (its remainder is one flat face); a sphere gets the plan with the sides named. The
 * finding is inform-only — it carries the share and the sides, and nothing about it refuses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { goalFlipFindings, goalSurfaceOffer } from '@/engine/cnc/engrave/goalFlipFindings';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

async function goalOf(name: string): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here(name));
  const read = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const job = { ...defaultEngraveJob(), labels: [], shapes: [], drills: [], targetObject: goal };
  return { job, goal };
}

describe('#872 the goal-unreached finding', () => {
  it('a relief: the split is stated, and no flip is proposed — its remainder is a flat face', async () => {
    const { job, goal } = await goalOf('relief-plate.stl');
    const offer = goalSurfaceOffer(job, goal);
    expect(offer).not.toBeNull();
    // The flat back is a large share of the plate; the plan refuses a setup for it.
    expect(offer!.first.facingAwayMm2).toBeGreaterThan(0);

    const [finding] = goalFlipFindings(job, goal);
    expect(finding).toBeDefined();
    expect(finding!.code).toBe('goal-unreached');
    expect(finding!.targetId).toBe(goal.id);
    expect(finding!.message).toMatch(/The top setup reproduces \d/);
    expect(finding!.message).toMatch(/faces away from the tool/);
    expect(finding!.message).toMatch(/flat face/);
    expect(finding!.goalFlipSides).toBeUndefined();
  });

  it('a sphere: the plan is offered, with the bottom named as the second side', async () => {
    const { job, goal } = await goalOf('near-sphere.stl');
    const [finding] = goalFlipFindings(job, goal);
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.goalFlipSides).toEqual(['top', 'bottom']);
    expect(finding!.goalReachedFraction).toBeGreaterThan(0.9);
    expect(finding!.message).toMatch(/A flip finishes it: top, then bottom — 2 setups reach/);
    // The hold the flip needs is stated: the default registry owns no drill, and the sentence
    // says which one to record rather than planning a registration with nothing to sit on.
    expect(finding!.message).toMatch(/locating holes/);
  });

  it('a reference object is not a goal and gets no finding', async () => {
    const { job, goal } = await goalOf('relief-plate.stl');
    expect(goalFlipFindings(job, { ...goal, role: 'reference' })).toEqual([]);
  });
});
