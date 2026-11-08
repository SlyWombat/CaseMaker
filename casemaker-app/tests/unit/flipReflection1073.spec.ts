/**
 * #1073 — THE FLIP'S REFLECTION: left↔right (x → L − x) or front↔back (y → W − y), z → −z below the
 * new top, composed with the setup affine that already places a later side's goal (#872).
 *
 * Everything that follows the part turns over by the SAME isometry: the side-2 goal, the locating
 * holes (pins), the tab band (carried on the goal), and the setup's own orientation record. One
 * matrix — the machine's own half turn, a proper rotation, never a mirror — decides all of them.
 *
 * RED at m1-land8: `flipMatrix`, `flipOrientation` and `goalForFlip` do not exist, `planFlipSetups`
 * takes no flip choice, and the re-hold reads the mount's default turn (the bracket's RY180) rather
 * than the setup's stated axis — so a front↔back choice is silently turned left↔right.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import {
  goalForFlip,
  goalForSetup,
  planFlipSetups,
  reholdSetupGoals,
  setupAffine,
} from '@/engine/cnc/engrave/goalFlipSetups';
import type { Mat3 } from '@/engine/cnc/engrave/targetScale';
import { flipMatrix, flipOrientation } from '@/engine/cnc/engrave/flipChoice';
import { det, orient, orientationOf } from '@/engine/cnc/setups/orient';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { length: 44, width: 36, thickness: 20 };
const BOX = { x: STOCK.length, y: STOCK.width, z: STOCK.thickness };

async function sphereJob(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here('near-sphere.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'near-sphere.stl'), 'g-sphere-1073');
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    // Right of centre in X and back of centre in Y, so either reflection is distinguishable.
    position: { x: 26, y: 19, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base,
    labels: [],
    shapes: [],
    drills: [],
    stock: { ...STOCK, material: 'pla' },
    targetObject: goal,
  };
  return { job, goal };
}

const DRILL: { key: string; tool: Tool } = {
  key: 'user:drill-2.5',
  tool: flatEndMill(2.5, { name: '2.5 mm drill', shape: 'drill', typeText: 'Drill', tipDiameter: 2.5, diameter: 2.5 }),
};

const M3 = (axis: 'left-right' | 'front-back'): Mat3 => flipMatrix(axis).flat() as unknown as Mat3;

describe('#1073 the flip’s matrix is the machine’s own half turn', () => {
  it('left↔right is the bracket’s RY180; front↔back is the vise’s RX180', () => {
    const bracket = orient('bottom', { kind: 'bracket' }, BOX);
    const vise = orient('bottom', { kind: 'vise' }, BOX);
    if (!bracket.ok || !vise.ok) throw new Error('the stock must be orientable both ways');
    expect(flipMatrix('left-right')).toEqual(bracket.matrix);
    expect(flipMatrix('front-back')).toEqual(vise.matrix);
  });

  it('every flip is a proper rotation — a turn a hand can make, never a mirror', () => {
    expect(det(flipMatrix('left-right'))).toBeCloseTo(1, 12);
    expect(det(flipMatrix('front-back'))).toBeCloseTo(1, 12);
  });

  it('the orientation record swaps exactly one edge pair and turns the stock over', () => {
    expect(flipOrientation('left-right')).toEqual({
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
      front: 'front',
      back: 'back',
    });
    expect(flipOrientation('front-back')).toEqual({
      top: 'bottom',
      bottom: 'top',
      left: 'left',
      right: 'right',
      front: 'back',
      back: 'front',
    });
    expect(flipOrientation('front-back')).toEqual(orientationOf(flipMatrix('front-back')));
  });

  it('the work frame mirrors as A’s note states: (x,y,z) → (L−x, y, −z−T) or (x, W−y, −z−T)', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 26, y: 19, z: -4 },
      { x: STOCK.length, y: STOCK.width, z: -STOCK.thickness },
      { x: 13.5, y: 2.25, z: -7.125 },
    ];
    const leftRight = setupAffine(M3('left-right'), BOX);
    const frontBack = setupAffine(M3('front-back'), BOX);
    for (const p of points) {
      const lr = leftRight.toSetup(p);
      expect(lr.x).toBeCloseTo(STOCK.length - p.x, 9);
      expect(lr.y).toBeCloseTo(p.y, 9);
      expect(lr.z).toBeCloseTo(-p.z - STOCK.thickness, 9);
      const fb = frontBack.toSetup(p);
      expect(fb.x).toBeCloseTo(p.x, 9);
      expect(fb.y).toBeCloseTo(STOCK.width - p.y, 9);
      expect(fb.z).toBeCloseTo(-p.z - STOCK.thickness, 9);
    }
  });

  it('it agrees with the same goal placed through goalForSetup, so the two paths cannot drift', async () => {
    const { goal } = await sphereJob();
    const lr = goalForFlip(goal, BOX, 'left-right');
    const viaSetup = goalForSetup(goal, BOX, M3('left-right'));
    expect(lr).toEqual(viaSetup);
  });
});

describe('#1073 the goal and its hold turn over by the same reflection', () => {
  it('left↔right mirrors the goal in X; front↔back mirrors it in Y', async () => {
    const { goal } = await sphereJob();
    const lr = goalForFlip(goal, BOX, 'left-right');
    const fb = goalForFlip(goal, BOX, 'front-back');
    // The sphere is 30 mm across; its centre was at (26, 19).
    expect(lr.position.x).toBeCloseTo(44 - 26, 6);
    expect(lr.position.y).toBeCloseTo(19, 6);
    expect(fb.position.x).toBeCloseTo(26, 6);
    expect(fb.position.y).toBeCloseTo(36 - 19, 6);
    // Both are 180° turns of the same object: about X either way, and about Z for left↔right only.
    expect(Math.abs(lr.rotationX ?? 0)).toBeCloseTo(180, 6);
    expect(Math.abs(lr.rotation)).toBeCloseTo(180, 6);
    expect(Math.abs(fb.rotationX ?? 0)).toBeCloseTo(180, 6);
    expect(Math.abs(fb.rotation)).toBeCloseTo(0, 6);
  });

  it('the plan stores the choice on the later setup and turns everything by it', async () => {
    const { job, goal } = await sphereJob();
    const flip = { method: 'tabs-in-blank', axis: 'front-back' } as const;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [DRILL], flip);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The record is exactly the operator's choice, on the later setup only.
    expect(plan.setups[1]!.flip).toEqual(flip);
    expect(plan.setups[0]!.flip).toBeUndefined();
    // The orientation follows the axis, not the mount's default turn.
    expect(plan.setups[1]!.orientation).toEqual(flipOrientation('front-back'));
    // The hole line runs along X (front↔back): both holes share a y, and the pins mirror in Y.
    expect(plan.hold!.at[0].y).toBeCloseTo(plan.hold!.at[1].y, 9);
    const pins = plan.setups[1]!.pins!;
    expect(pins.at[0].y).toBeCloseTo(36 - plan.hold!.at[0].y, 2);
    expect(pins.at[1].y).toBeCloseTo(36 - plan.hold!.at[1].y, 2);
    expect(pins.at[0].x).toBeCloseTo(plan.hold!.at[0].x, 2);
  });

  it('the method never moves geometry: both methods place the same goal and pins', async () => {
    const { job, goal } = await sphereJob();
    const planFor = (method: 'tabs-in-blank' | 'free-then-flip') => {
      const p = planFlipSetups(job, goal, ['top', 'bottom'], [DRILL], { method, axis: 'left-right' });
      if (!p.ok) throw new Error(p.reason);
      return p;
    };
    const a = planFor('tabs-in-blank');
    const b = planFor('free-then-flip');
    const placement = (g: EngraveTargetObject) => {
      const { id: _id, setupId: _setupId, ...rest } = g;
      return rest;
    };
    expect(placement(b.goals[1]!)).toEqual(placement(a.goals[1]!));
    expect(b.setups[1]!.pins).toEqual(a.setups[1]!.pins);
    expect(b.setups[1]!.orientation).toEqual(a.setups[1]!.orientation);
    expect(b.setups[1]!.flip!.method).toBe('free-then-flip');
  });

  it('a flip choice is one turn over: it needs exactly two sides, the second the bottom', async () => {
    const { job, goal } = await sphereJob();
    const flip = { method: 'tabs-in-blank', axis: 'left-right' } as const;
    const three = planFlipSetups(job, goal, ['top', 'bottom', 'back'], [DRILL], flip);
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.reason).toContain('two');
    const side = planFlipSetups(job, goal, ['top', 'left'], [DRILL], flip);
    expect(side.ok).toBe(false);
    if (!side.ok) expect(side.reason).toContain('bottom');
  });

  it('a stored front↔back choice survives a thickness change: the re-hold turns by the axis', async () => {
    const { job, goal } = await sphereJob();
    const flip = { method: 'tabs-in-blank', axis: 'front-back' } as const;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [DRILL], flip);
    if (!plan.ok) throw new Error(plan.reason);
    const twoSided: EngraveJob = { ...job, targetObject: undefined, targetObjects: plan.goals, setups: plan.setups };
    const before = twoSided.targetObjects!;
    const thinner = reholdSetupGoals(twoSided, { x: STOCK.length, y: STOCK.width, z: STOCK.thickness - 5 });
    expect(thinner).not.toBeNull();
    // A front↔back side mirrors in Y — the mount's bracket default would have mirrored in X.
    expect(thinner![1]!.position.x).toBeCloseTo(26, 6);
    expect(thinner![1]!.position.y).toBeCloseTo(36 - 19, 6);
    // The goal sits on the flipped top, which the thinner stock moves down 5 mm in that frame.
    expect(thinner![1]!.position.z).toBeCloseTo(before[1]!.position.z + 5, 6);
  });
});
