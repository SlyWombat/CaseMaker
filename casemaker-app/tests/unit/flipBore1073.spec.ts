/**
 * #1073 — THE LOCATING BORE IS HALF A MILLIMETRE, BORED WITH AN OWNED FLAT.
 *
 * The maintainer asked on 11-07: "why 6 mm into the wasteboard?" (6b's amendment B). The holes
 * exist so the probe can ENTER them from side 2; they need only be THROUGH — the job's own
 * breakthrough rule plus a chip clearance — so the bore stops half a millimetre into the board,
 * and the sheet says so. The bore is ⌀5–6 (the wired V2's ⌀2 tip needs the room) and is made
 * with an owned FLAT: the owned drills have no hardwood rows.
 *
 * RED at m1-land8: the hold is `thickness + 2`, the cutter is whatever drill the shop owns, and
 * the offer's sentence says "drills two ⌀3 mm locating holes 14 mm deep".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { FLIP_BORE_CHIP_CLEARANCE_MM, ownedBoreCutter, planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { goalFlipFindings } from '@/engine/cnc/engrave/goalFlipFindings';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { length: 40, width: 40, thickness: 12 };

async function sphereJob(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here('near-sphere.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'near-sphere.stl'), 'g-sphere-bore');
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: 20, y: 18, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = { ...base, labels: [], shapes: [], drills: [], stock: { ...STOCK, material: 'pla' }, targetObject: goal };
  return { job, goal };
}

const FLAT3: { key: string; tool: Tool } = { key: 'user:flat-3', tool: flatEndMill(3) };
const FLAT6: { key: string; tool: Tool } = { key: 'user:flat-6', tool: flatEndMill(6) };
const DRILL25: { key: string; tool: Tool } = {
  key: 'user:drill-2.5',
  tool: flatEndMill(2.5, { shape: 'drill', typeText: 'Drill', tipDiameter: 2.5, diameter: 2.5 }),
};

describe('#1073 the bore’s cutter', () => {
  it('prefers the owned flat in the ⌀5–6 band — the bore the ⌀2 tip enters', () => {
    expect(ownedBoreCutter([FLAT3, DRILL25, FLAT6])).toEqual(FLAT6);
    // The largest in the band wins.
    const flat5: { key: string; tool: Tool } = { key: 'user:flat-5', tool: flatEndMill(5) };
    expect(ownedBoreCutter([flat5, FLAT6])).toEqual(FLAT6);
  });

  it('still finds a hold on a shop with no ⌀5–6 flat, and says which tool it used', () => {
    expect(ownedBoreCutter([FLAT3])).toEqual(FLAT3);
    // A 5–6 DRILL stands in when no flat is that size.
    const drill5: { key: string; tool: Tool } = {
      key: 'user:drill-5',
      tool: flatEndMill(5, { shape: 'drill', typeText: 'Drill', tipDiameter: 5, diameter: 5 }),
    };
    expect(ownedBoreCutter([FLAT3, drill5])).toEqual(drill5);
    expect(ownedBoreCutter([])).toBeNull();
  });
});

describe('#1073 the bore goes half a millimetre into the board', () => {
  it('the hold’s depth is the blank, the job’s breakthrough and the chip clearance', async () => {
    const { job, goal } = await sphereJob();
    expect(FLIP_BORE_CHIP_CLEARANCE_MM).toBe(0.2);
    expect(job.breakthrough).toBeCloseTo(0.3, 6);
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT6]);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold).not.toBeNull();
    // 12 mm blank + 0.3 breakthrough + 0.2 chip = 12.5 mm, not 14.
    expect(plan.hold!.depthMm).toBeCloseTo(12.5, 6);
    expect(plan.hold!.diameterMm).toBeCloseTo(6, 6);
    expect(plan.hold!.cutter).toBe('user:flat-6');
  });

  it('a job that states its own breakthrough moves the depth with it', async () => {
    const { job, goal } = await sphereJob();
    const shallow: EngraveJob = { ...job, breakthrough: 0.05 };
    const plan = planFlipSetups(shallow, goal, ['top', 'bottom'], [FLAT6]);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold!.depthMm).toBeCloseTo(12.25, 6);
  });

  it('the offer’s sentence states the bore, the half millimetre and the flat', async () => {
    const { job, goal } = await sphereJob();
    const withBoard: EngraveJob = {
      ...job,
      sacrificial: { ...job.sacrificial, under: { thickness: 6, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' } },
    };
    const [finding] = goalFlipFindings(withBoard, goal, [FLAT6]);
    expect(finding!.goalFlipAction).toBeDefined();
    expect(finding!.goalFlipDetail).toContain('bores two ⌀6 mm locating holes 12.5 mm deep');
    expect(finding!.goalFlipDetail).toContain('0.5 mm into the board');
  });

  it('a board thinner than the bore’s drop is the need; one that can take it is the action', async () => {
    const { job, goal } = await sphereJob();
    const withUnder = (thickness: number | null): EngraveJob => ({
      ...job,
      sacrificial: {
        ...job.sacrificial,
        under: thickness === null ? null : { thickness, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      },
    });
    const [thin] = goalFlipFindings(withUnder(0.4), goal, [FLAT6]);
    expect(thin!.goalFlipNeed).toBe('needs a sacrificial board under the blank');
    const [enough] = goalFlipFindings(withUnder(0.5), goal, [FLAT6]);
    expect(enough!.goalFlipAction).toBeDefined();
  });
});
