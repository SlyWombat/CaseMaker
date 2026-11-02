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
import { flatEndMill } from '@/engine/cnc/tool';
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
    // The percentage is the GEOMETRY the sides expose; the cutter's own reproduction is the run's
    // simulation verdict (#869 lifts it). The sentence says so rather than promising a finish.
    expect(finding!.message).toMatch(/how much of it the CHOSEN CUTTER reproduces is the run's own simulation verdict/);
    // The hold the flip needs is stated: the default registry owns no drill, and the sentence
    // says which one to record rather than planning a registration with nothing to sit on.
    expect(finding!.message).toMatch(/locating holes/);
  });

  it('a reference object is not a goal and gets no finding', async () => {
    const { job, goal } = await goalOf('relief-plate.stl');
    expect(goalFlipFindings(job, { ...goal, role: 'reference' })).toEqual([]);
  });
});

describe('#914 the chosen cutter’s reach', () => {
  /** The corpus sphere in a blank that just holds it — the plan's own tight-stock case. */
  async function tight(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
    const { job, goal } = await goalOf('near-sphere.stl');
    const placed = { ...goal, position: { x: 30, y: 25, z: 0 } };
    return { job: { ...job, stock: { ...job.stock, length: 60, width: 50, thickness: 32 }, targetObject: placed }, goal: placed };
  }

  it('a short cutter states each side’s band and its remainder, and carries the bands', async () => {
    const { job, goal } = await tight();
    const short = flatEndMill(3.175, { name: 'short ball', fluteLength: 10 });
    const offer = goalSurfaceOffer(job, goal, short, []);
    expect(offer).not.toBeNull();
    expect(offer!.reach?.mm).toBe(10);
    expect(offer!.plan.sides[0]!.remainderMm).toBeGreaterThan(0);
    expect(offer!.plan.stopped).toBe('reach-limit');

    const [finding] = goalFlipFindings(job, goal, [], short);
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('The cutter reaches 10 mm below each setup’s top face');
    expect(finding!.message).toContain('kept clear for the holder');
    // Each limited side names the band it cuts in the sides list.
    expect(finding!.message).toContain('9 mm band');
    // The press needs the band per side, aligned with the faces it adds.
    expect(finding!.goalFlipBands).toBeDefined();
    expect(finding!.goalFlipBands).toHaveLength(finding!.goalFlipSides!.length);
    for (const band of finding!.goalFlipBands!) {
      expect(band).not.toBeNull();
      expect(band!).toBeCloseTo(9, 6);
    }
  });

  it('a cutter that reaches the whole part says nothing about a band', async () => {
    const { job, goal } = await tight();
    const long = flatEndMill(3.175, { name: 'long ball', fluteLength: 60 });
    const [finding] = goalFlipFindings(job, goal, [], long);
    expect(finding).toBeDefined();
    expect(finding!.message).not.toContain('kept clear for the holder');
    expect(finding!.message).not.toContain('mm band');
    expect(finding!.goalFlipBands?.every((b) => b === null) ?? true).toBe(true);
  });

  it('with no cutter chosen the plan stays geometric, and no band is carried', async () => {
    const { job, goal } = await tight();
    const [finding] = goalFlipFindings(job, goal);
    expect(finding).toBeDefined();
    expect(finding!.message).not.toContain('kept clear for the holder');
  });
});
