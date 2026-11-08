/**
 * #1073 follow-up (b) — THE VENDOR METHOD'S AVAILABILITY, MEASURED FROM THE PART'S OUTLINE.
 *
 * The vendor method poses the FREED part against the bracket's two arms, so it needs a straight
 * front edge long enough to read the turn on (6b's answer 2). A disc — or any organic outline —
 * has none, and the method must be shown UNAVAILABLE with the reason, the frame method staying
 * pre-selected. Nothing today measures a goal's outline for this, so the choice would be a guess.
 *
 * The measure: the goal's mesh in work coordinates (the same mesh the flip plan samples), its
 * footprint on the coverage field's grid, the front profile (the lowest covered row per column),
 * and the longest run of columns whose front stays within `FRONT_STRAIGHT_TOLERANCE_MM` of the
 * run's first value. A straight wall reads as its full length; a disc's tangent reads as a few
 * millimetres. Availability is then the REGISTRATION PLANNER's own verdict on that run — one
 * rule, so the row and the plan cannot disagree — never a second threshold in the UI.
 *
 * RED at m1-land9: no such measure exists, and the row offers the vendor method to every outline.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { partSilhouetteOf, vendorMethodOffer } from '@/engine/cnc/engrave/flipSilhouette';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));
const S = registrationSettings(null).settings;

async function goalOf(name: string): Promise<EngraveTargetObject> {
  const bytes = readFileSync(here(name));
  const read = await readTargetObjectFile(new File([bytes], name), `g-${name}`);
  if (!read.ok) throw new Error(read.error);
  return {
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
}

describe('#1073(b) the freed part’s front edge, measured', () => {
  it('a box-shaped part reads its front wall as a long straight run', async () => {
    const box = await goalOf('thin-wall-box.stl');
    const sil = partSilhouetteOf(box);
    expect(sil).not.toBeNull();
    expect(sil!.frontStraight).not.toBeNull();
    // The wall is the part's own width; a grid cell is half a millimetre.
    expect(sil!.frontStraightMm).toBeGreaterThan(15);
    expect(sil!.frontStraight!.maxX - sil!.frontStraight!.minX).toBeCloseTo(sil!.frontStraightMm, 6);
    // The footprint box is the part's own extents in work coordinates.
    expect(sil!.box.maxX - sil!.box.minX).toBeGreaterThan(15);
    expect(sil!.box.maxY - sil!.box.minY).toBeGreaterThan(5);
  });

  it('a disc reads only its tangent: no run long enough to pose against two arms', async () => {
    const disc = await goalOf('near-sphere.stl');
    const sil = partSilhouetteOf(disc);
    expect(sil).not.toBeNull();
    expect(sil!.frontStraightMm).toBeLessThan(10);
  });

  it('availability is the registration planner’s own verdict on that run', async () => {
    const box = partSilhouetteOf(await goalOf('thin-wall-box.stl'));
    const disc = partSilhouetteOf(await goalOf('near-sphere.stl'));
    expect(vendorMethodOffer(box, S)).toEqual({ available: true, reason: null });
    const no = vendorMethodOffer(disc, S);
    expect(no.available).toBe(false);
    expect(no.reason).toContain('straight');
    // No measurement at all is not a refusal: the option stays, and the planner refuses later.
    expect(vendorMethodOffer(null, S)).toEqual({ available: true, reason: null });
  });
});
