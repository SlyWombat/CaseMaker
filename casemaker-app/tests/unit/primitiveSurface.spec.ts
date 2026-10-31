/**
 * #786 slice 4a-2 — THE CONE AND SPHERE FIELDS, AND THE BALL THE SHOP COULD CUT THEM WITH.
 *
 * The 3D CAM takes a GoalHeightfield; this module states the analytic field for a cone and a
 * sphere in the goal sampler's work frame (stock top 0, top-Z per column, uncovered cells at the
 * sentinel). The numbers below are the closed forms at named radii, so a drift in either shape is
 * a failing test rather than a wrong surface.
 */
import { describe, expect, it } from 'vitest';

import {
  primitiveHeightfield,
  surfaceBallOffer,
  surfaceCurvatureRadius,
  surfacePrimitivesOf,
  type SurfacePrimitive,
} from '@/engine/cnc/engrave/primitiveSurface';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';

const base = {
  id: 'p1',
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  depth: 2,
};
const CONE: SurfacePrimitive = { ...base, kind: 'cone', name: 'funnel', diameter: 10, tipDiameter: 2 };
const SPHERE: SurfacePrimitive = { ...base, kind: 'sphere', name: 'dimple', diameter: 10 };

/** The field's own z at a work XY, by nearest cell. */
function zAt(field: NonNullable<ReturnType<typeof primitiveHeightfield>>, x: number, y: number): number | null {
  const i = Math.round((x - field.x0) / field.pitch);
  const j = Math.round((y - field.y0) / field.pitch);
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
  const k = j * field.nx + i;
  return field.covered[k] === 1 ? field.z[k]! : null;
}

describe('#786 4a-2 the cone field', () => {
  it('follows −d·(R−ρ)/(R−r) from its flat tip disc to the top-face rim', () => {
    const f = primitiveHeightfield(CONE)!;
    expect(f).not.toBeNull();
    expect(zAt(f, 50, 30)).toBeCloseTo(-2, 4); // the floor at the axis
    expect(zAt(f, 51, 30)).toBeCloseTo(-2, 4); // ρ = 1 = r: still the tip's floor
    expect(zAt(f, 53, 30)).toBeCloseTo(-2 * ((5 - 3) / (5 - 1)), 3); // ρ = 3
    expect(zAt(f, 55, 30)).toBeCloseTo(0, 3); // ρ = R: the rim meets the top face
    expect(zAt(f, 55.5, 30)).toBeNull(); // past the rim: uncut stock
    expect(f.minZ).toBeCloseTo(-2, 4);
    expect(f.topZ).toBe(0);
    expect(f.coveredCount).toBeGreaterThan(0);
    expect(f.resolutionNote).toContain('mm grid');
  });

  it('is symmetric about the axis in every direction', () => {
    const f = primitiveHeightfield(CONE)!;
    const north = zAt(f, 50, 32)!;
    const east = zAt(f, 52, 30)!;
    const south = zAt(f, 50, 28)!;
    expect(north).toBeCloseTo(east, 6);
    expect(south).toBeCloseTo(east, 6);
  });
});

describe('#786 4a-2 the sphere field', () => {
  it('follows the cap of the ball from −d at the axis to 0 at ρmax', () => {
    const f = primitiveHeightfield(SPHERE)!;
    expect(zAt(f, 50, 30)).toBeCloseTo(-2, 4);
    expect(zAt(f, 52, 30)).toBeCloseTo(-(Math.sqrt(21) - 3), 4); // ρ = 2: −(√(25−4) − 3) = −1.583
    expect(zAt(f, 54, 30)).toBeCloseTo(0, 3); // ρ = 4 = ρmax
    expect(zAt(f, 54.5, 30)).toBeNull();
    expect(f.minZ).toBeCloseTo(-2, 4);
  });
});

describe('#786 4a-2 which primitives are surfaces, and which ball to offer', () => {
  it('takes enabled, top-facing cones and spheres only', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      primitives: [
        { ...CONE, id: 'c' },
        { ...SPHERE, id: 's' },
        { ...SPHERE, id: 'side', axis: 'x' },
        { ...SPHERE, id: 'off', enabled: false },
        { id: 'b', kind: 'box', position: { x: 10, y: 10 }, rotation: 0, enabled: true, depth: 1, width: 5, height: 5 },
      ],
    };
    expect(surfacePrimitivesOf(job).map((p) => p.id)).toEqual(['c', 's']);
  });

  it('offers the largest OWNED ball that fits the surface curvature, and none that does not', () => {
    const ball = (key: string, r: number) => ({
      key,
      tool: { shape: 'ball', name: `${key} ball`, tipDiameter: r * 2, diameter: r * 2 },
    });
    // The cone's curvature limit is its tip radius: 1 mm. A 1 mm-radius ball fits; 2 mm does not.
    const offer = surfaceBallOffer(CONE, [ball('inv:small', 0.5), ball('inv:fit', 1), ball('inv:big', 2), ball('cat:x', 0.3)]);
    expect(surfaceCurvatureRadius(CONE)).toBeCloseTo(1, 9);
    expect(offer).toEqual({ key: 'inv:fit', name: 'inv:fit ball', radius: 1 });
    // The sphere's own ball is its curvature: a 4 mm-radius ball is the largest that fits.
    // The sphere's own ball fits exactly (a ball of the cavity's radius); the largest fitting wins.
    expect(surfaceBallOffer(SPHERE, [ball('inv:a', 3), ball('inv:b', 4), ball('inv:c', 5)])?.key).toBe('inv:c');
    expect(surfaceBallOffer(SPHERE, [ball('inv:too-big', 6)])).toBeNull();
  });
});
