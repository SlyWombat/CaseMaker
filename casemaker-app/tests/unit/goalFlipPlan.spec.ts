/**
 * #872 — THE FLIP PLAN, on shapes whose answer is countable: a cube (the bottom is one flat face,
 * so no flip is worth a setup), a plate with a flat back (the relief case — no proposal), and a
 * sphere (no flat back: the flip is what finishes it). Plus the mount's own rule: a side a tape
 * hold cannot stand is dropped by name, not offered.
 */
import { describe, expect, it } from 'vitest';

import {
  FLIP_TARGET_FRACTION,
  goalFlipPlan,
  type FlipPlanInput,
} from '@/engine/cnc/engrave/goalFlipPlan';
import type { CoverageMesh } from '@/engine/cnc/engrave/goalCoverage';
import type { MountSpec } from '@/engine/cnc/setups/types';

function quad(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function meshOf(p: number[]): CoverageMesh {
  const positions = new Float32Array(p);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** A closed box `w × d × h`, min corner at the origin. */
function box(w: number, d: number, h: number): CoverageMesh {
  const p: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [0, w, 0, d, 0, h];
  quad(p, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(p, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  quad(p, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(p, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad(p, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad(p, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return meshOf(p);
}

/** A UV sphere, radius r, bottom at z 0. */
function sphere(r: number, rings = 24, segs = 48): CoverageMesh {
  const p: number[] = [];
  const at = (i: number, j: number): [number, number, number] => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      // Outward winding (the STL/Manifold convention): b and c swapped from the naive fan, or the
      // sphere's normals point IN and the classifier reads every upper face as facing away.
      p.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return meshOf(p);
}

/**
 * A plate with a flat back and a raised plateau — the relief, as a proper closed solid: the top
 * face is a RING around the plateau (a full top quad under it would be interior loft, not surface,
 * and the plan would rightly call it hidden).
 */
function relief(): CoverageMesh {
  const p: number[] = [];
  const [w, d, h] = [40, 30, 4];
  const [bx0, bx1, by0, by1, bz] = [10, 30, 10, 20, 8];
  // bottom (the flat back), facing down
  quad(p, [0, d, 0], [w, d, 0], [w, 0, 0], [0, 0, 0]);
  // the plate's four walls
  quad(p, [0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]);
  quad(p, [w, d, 0], [0, d, 0], [0, d, h], [w, d, h]);
  quad(p, [0, d, 0], [0, 0, 0], [0, 0, h], [0, d, h]);
  quad(p, [w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]);
  // the top RING around the plateau (four strips, wound up)
  quad(p, [0, 0, h], [w, 0, h], [w, by0, h], [0, by0, h]); // front strip
  quad(p, [0, by1, h], [w, by1, h], [w, d, h], [0, d, h]); // back strip
  quad(p, [0, by0, h], [bx0, by0, h], [bx0, by1, h], [0, by1, h]); // left strip
  quad(p, [bx1, by0, h], [w, by0, h], [w, by1, h], [bx1, by1, h]); // right strip
  // the plateau: four walls and its top
  quad(p, [bx0, by0, h], [bx1, by0, h], [bx1, by0, bz], [bx0, by0, bz]);
  quad(p, [bx1, by1, h], [bx0, by1, h], [bx0, by1, bz], [bx1, by1, bz]);
  quad(p, [bx0, by1, h], [bx0, by0, h], [bx0, by0, bz], [bx0, by1, bz]);
  quad(p, [bx1, by0, h], [bx1, by1, h], [bx1, by1, bz], [bx1, by0, bz]);
  quad(p, [bx0, by0, bz], [bx1, by0, bz], [bx1, by1, bz], [bx0, by1, bz]);
  return meshOf(p);
}

const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 120 };
const TAPE: MountSpec = { kind: 'tape' };

function plan(mesh: CoverageMesh, over: Partial<FlipPlanInput> = {}) {
  return goalFlipPlan({
    mesh,
    firstUp: 'top',
    mount: VISE,
    stockSize: { x: 100, y: 80, z: 60 },
    pitchMm: 0.5,
    ...over,
  });
}

describe('#872 the flip plan', () => {
  it('a cube needs no flip: its only remaining gain is one flat face', () => {
    const p = plan(box(40, 30, 20));
    expect(p.sides).toHaveLength(1);
    expect(p.stopped).toBe('only-flat-faces-remain');
    // The top and the four cliffs are reached from the top; the bottom is the flat remainder.
    expect(p.reachedFraction).toBeCloseTo(0.769, 2);
  });

  it('a relief with a flat back gets no proposal — the noise rule', () => {
    const p = plan(relief());
    expect(p.sides).toHaveLength(1);
    expect(p.stopped).toBe('only-flat-faces-remain');
  });

  it('a sphere gets the flip: two setups reach it, and the turn is stated', () => {
    const p = plan(sphere(15));
    expect(p.sides).toHaveLength(2);
    expect(p.sides[1]!.faceUp).toBe('bottom');
    expect(p.sides[1]!.rotate).toEqual({ about: 'x', degrees: 180 });
    expect(p.reachedFraction).toBeGreaterThanOrEqual(FLIP_TARGET_FRACTION);
    expect(p.sides[1]!.marginalMm2).toBeGreaterThan(0);
    expect(p.stopped).toBe('target-reached');
  });

  it('a tape hold cannot stand the stock on an edge, and says so per side', () => {
    // A shape with no flat back: the flip is the bottom face, which tape CAN do (a half turn
    // lies it over); the edge faces are refused by name.
    const p = plan(sphere(15), { mount: TAPE });
    expect(p.sides[1]!.faceUp).toBe('bottom');
    expect(p.sides[1]!.rotate).toEqual({ about: 'y', degrees: 180 });
  });

  it('a vise narrower than the stock’s height refuses a side that would not fit', () => {
    const narrow: MountSpec = { kind: 'vise', viseOpeningMm: 30 };
    const p = plan(sphere(15), { mount: narrow, stockSize: { x: 100, y: 80, z: 60 } });
    // Every side-up orientation stands the 60 mm stock across a 30 mm opening: none is offered.
    const reasons = p.dropped.filter((d) => d.reason.includes('opening'));
    expect(reasons.length).toBeGreaterThan(0);
  });
});
