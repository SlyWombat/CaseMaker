/**
 * #872 slice 3 — THE ONE PRESS, as data: the flipped setup cuts the SAME part from the other
 * side, the hold's holes are named with a drill the shop OWNS, and the second setup records them
 * as pins in its own mounted frame. The corpus sphere is the shape (a goal that fits its blank).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { goalForSetup, planFlipSetups, turnsOfMatrix } from '@/engine/cnc/engrave/goalFlipSetups';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { length: 40, width: 40, thickness: 30 };
/** The setups engine's box name for the same stock. */
const BOX = { x: STOCK.length, y: STOCK.width, z: STOCK.thickness };

async function sphereJob(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here('near-sphere.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'near-sphere.stl'), 'g-sphere');
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    // Slightly right of centre, so a flip is distinguishable from the identity.
    position: { x: 22, y: 18, z: 0 },
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

/** The goal's placed bbox in its work frame. */
function placedBox(target: EngraveTargetObject): { min: number[]; max: number[] } {
  const mesh = targetObjectMesh(target);
  const { place } = placeTarget(target, mesh);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const bx of [mesh.bbox.min[0], mesh.bbox.max[0]]) {
    for (const by of [mesh.bbox.min[1], mesh.bbox.max[1]]) {
      for (const bz of [mesh.bbox.min[2], mesh.bbox.max[2]]) {
        const p = place(bx, by, bz);
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i]!, p[i]!);
          max[i] = Math.max(max[i]!, p[i]!);
        }
      }
    }
  }
  return { min, max };
}

const DRILL: { key: string; tool: Tool } = {
  key: 'user:drill-2.5',
  tool: flatEndMill(2.5, { name: '2.5 mm drill', shape: 'drill', typeText: 'Drill', tipDiameter: 2.5, diameter: 2.5 }),
};

describe('#872 the flip setup conversion', () => {
  it('reads a rotation back as the turns it was built from', () => {
    const t = turnsOfMatrix([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    // ±180 is the same turn (the atan2 branch); `goalForSetup` normalises it into 0…360.
    expect(Math.abs(t.x)).toBeCloseTo(180, 6);
    expect(t.y).toBeCloseTo(0, 6);
    expect(t.z).toBeCloseTo(0, 6);
  });

  it('a flip about X maps the goal to the other side: same size, mirrored Y, top at the old bottom', () => {
    return sphereJob().then(({ goal }) => {
      const before = placedBox(goal);
      const flipped = goalForSetup(goal, BOX, [1, 0, 0, 0, -1, 0, 0, 0, -1]);
      const after = placedBox(flipped);
      // Same extents (an isometry): 30 mm in every direction for this sphere.
      expect(after.max[0]! - after.min[0]!).toBeCloseTo(before.max[0]! - before.min[0]!, 6);
      expect(after.max[2]! - after.min[2]!).toBeCloseTo(before.max[2]! - before.min[2]!, 6);
      // Y mirrored about the stock: the centre at 18 goes to 22.
      expect((after.min[1]! + after.max[1]!) / 2).toBeCloseTo(40 - 18, 6);
      // The placement contract holds: its top is `position.z`.
      expect(flipped.position.z).toBeCloseTo(after.max[2]!, 6);
      // A 180° X turn, and Y unchanged.
      expect(flipped.rotationX).toBeCloseTo(180, 6);
      expect(flipped.rotationY).toBeCloseTo(0, 6);
    });
  });

  it('the plan becomes two setups with two goals, and the second names the hold’s pins', async () => {
    const { job, goal } = await sphereJob();
    const result = planFlipSetups(job, goal, ['top', 'bottom'], [DRILL]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setups).toHaveLength(2);
    expect(result.goals).toHaveLength(2);
    expect(result.setups[0]!.orientation.top).toBe('top');
    expect(result.setups[1]!.orientation.top).toBe('bottom');
    // The goal each setup cuts is its own, and the ids line up.
    expect(result.setups[0]!.itemIds).toEqual([result.goals[0]!.id]);
    expect(result.setups[1]!.itemIds).toEqual([result.goals[1]!.id]);

    // The hold: the shop's own 2.5 mm drill, through the stock into the board, in the margin.
    expect(result.hold).not.toBeNull();
    expect(result.hold!.diameterMm).toBeCloseTo(2.5, 6);
    expect(result.hold!.depthMm).toBeCloseTo(STOCK.thickness + 2, 6);
    expect(result.hold!.cutter).toBe('user:drill-2.5');
    // Off the centre line (30 / 70 %), so the pin question can tell a 180° spin apart.
    expect(result.hold!.at[0].x).not.toBe(STOCK.length / 2);
    // Behind the part: the goal's footprint ends at y 33 (18 ± 15), so the line sits clear.
    expect(result.hold!.at[0].y).toBeGreaterThan(33);

    // Setup 2's pins are the SAME holes in its mounted frame: across a flip about X, y → W − y.
    const pins = result.setups[1]!.pins;
    expect(pins).toBeDefined();
    expect(pins!.at[0].x).toBeCloseTo(result.hold!.at[0].x, 2);
    expect(pins!.at[0].y).toBeCloseTo(40 - result.hold!.at[0].y, 2);
  });

  it('with no drill owned, the plan still converts, and says the hold is not stated', async () => {
    const { job, goal } = await sphereJob();
    const result = planFlipSetups(job, goal, ['top', 'bottom'], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hold).toBeNull();
    expect(result.setups[1]!.pins).toBeUndefined();
  });

  it('a job that already states its setups is left alone', async () => {
    const { job, goal } = await sphereJob();
    const result = planFlipSetups({ ...job, setups: [] }, goal, ['top', 'bottom'], [DRILL]);
    expect(result.ok).toBe(false);
  });
});
