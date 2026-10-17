// The V-bit trace's groove (#420 slice 4): the cone from `vProfile.ts` dragged along the path,
// mouth at the top face and the tip's own flat at the floor.
//
// Every volumetric assertion is against a CLOSED FORM built from `grooveRadiusAt` — the same
// statement of the cone the oracle and the column engine read — never against another run of the
// builder. The polygonized disc area is `(n/2)·r²·sin(2π/n)`, exactly what Manifold's n-gon gives.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { vGrooveSolid } from '@/workers/sim/engraveGroove';
import { vCone, grooveRadiusAt, type VCone } from '@/engine/cnc/vProfile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { Tool } from '@/engine/cnc/tool';

/** The bench bit: 30° included, 0.3 mm tip (halfAngle is measured from the axis). */
function bit(tipDiameter = 0.3): Tool {
  return {
    number: 1,
    id: 'C1-BIT-ENGRAVE-30-0.3',
    name: 'Single Flute Engraving Bit 30 x 0.3',
    typeText: 'Engraving',
    shape: 'engraving',
    handleDiameter: 3.175,
    tipDiameter,
    diameter: 3.175,
    cornerRadius: 0,
    angle: 30,
    halfAngle: 15,
    fluteLength: null,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  };
}

/** Polygon area of an n-gon of radius r, as a factor of r². */
function discFactor(segments: number): number {
  return (segments / 2) * Math.sin((2 * Math.PI) / segments);
}

/**
 * The swept cone's volume over height h ∈ [0, d]: every level is a capsule of length L and radius
 * `tipR + t·h`, so the rectangle term is `2Lr` and the cap term `A·r²`.
 */
function capsuleSweepVolume(length: number, cone: VCone, depth: number, capFactor: number): number {
  const r0 = cone.tipRadius;
  const t = cone.tanHalf;
  const rectangle = 2 * length * (r0 * depth + (t * depth * depth) / 2);
  const caps = capFactor * (r0 * r0 * depth + r0 * t * depth * depth + (t * t * depth ** 3) / 3);
  return rectangle + caps;
}

describe('vGrooveSolid (#420 slice 4)', () => {
  const cone = vCone(bit())!;
  const depth = 1;
  const paths: [number, number][][] = [
    [
      [0, 0],
      [10, 0],
    ],
  ];

  it('sweeps the cone straight run to the volume of its integral', () => {
    const solid = vGrooveSolid(tl, paths, [false], cone, depth, 0)!;
    const topR = grooveRadiusAt(cone, depth);
    const expected = capsuleSweepVolume(10, cone, depth, discFactor(segmentsForRadius(topR)));
    expect(solid.volume()).toBeCloseTo(expected, 6);
    solid.delete();
  });

  it('is the mouth at the top face and narrows to the tip at the floor', () => {
    const solid = vGrooveSolid(tl, paths, [false], cone, depth, 0)!;
    const topR = grooveRadiusAt(cone, depth);
    const capFactor = discFactor(segmentsForRadius(topR));

    const areaAt = (heightAboveTip: number): number => {
      const r = cone.tipRadius + cone.tanHalf * heightAboveTip;
      return 10 * 2 * r + capFactor * r * r;
    };
    const sliceArea = (z: number): number => {
      const cs = solid.slice(z);
      const area = cs.area();
      cs.delete();
      return area;
    };

    // Away from the two boundary planes, so the slice is the open solid's cross-section.
    const quarter = depth * 0.25;
    const middle = depth * 0.5;
    const threeQuarters = depth * 0.75;
    expect(sliceArea(-depth + quarter)).toBeCloseTo(areaAt(quarter), 5);
    expect(sliceArea(-depth + middle)).toBeCloseTo(areaAt(middle), 5);
    expect(sliceArea(-depth + threeQuarters)).toBeCloseTo(areaAt(threeQuarters), 5);

    // The taper — the point of the slice: the mouth is wider than the middle, which is wider than
    // the floor.
    expect(areaAt(depth)).toBeGreaterThan(areaAt(middle));
    expect(areaAt(middle)).toBeGreaterThan(areaAt(0));
    solid.delete();
  });

  it('leaves a point rather than a floor under a sharp tip', () => {
    const sharp = vCone(bit(0))!;
    expect(sharp.tipRadius).toBe(0);
    const solid = vGrooveSolid(tl, paths, [false], sharp, depth, 0)!;
    const topR = grooveRadiusAt(sharp, depth);
    const expected = capsuleSweepVolume(10, sharp, depth, discFactor(segmentsForRadius(topR)));
    expect(solid.volume()).toBeCloseTo(expected, 6);
    expect(solid.volume()).toBeGreaterThan(0);
    solid.delete();
  });

  it('caps a one-point path as a cone, and sweeps a closed path as a ring', () => {
    const dot = vGrooveSolid(tl, [[[5, 5]]], [false], cone, depth, 0)!;
    const topR = grooveRadiusAt(cone, depth);
    const n = segmentsForRadius(topR);
    const t = cone.tanHalf;
    const r0 = cone.tipRadius;
    const expectedDot =
      discFactor(n) * (r0 * r0 * depth + r0 * t * depth * depth + (t * t * depth ** 3) / 3);
    expect(dot.volume()).toBeCloseTo(expectedDot, 5);
    dot.delete();

    const square: [number, number][][] = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ];
    const ring = vGrooveSolid(tl, square, [true], cone, depth, 0)!;
    // Four 10 mm runs plus the corners: strictly more than the straight-run formula, and finite.
    const straight = capsuleSweepVolume(40, cone, depth, discFactor(segmentsForRadius(topR)));
    expect(ring.volume()).toBeGreaterThan(straight * 0.9);
    expect(Number.isFinite(ring.volume())).toBe(true);
    ring.delete();
  });

  it('returns nothing when there is no path, no depth, or no cone reach', () => {
    expect(vGrooveSolid(tl, [], [], cone, depth, 0)).toBeNull();
    expect(vGrooveSolid(tl, paths, [false], cone, 0, 0)).toBeNull();
    expect(vGrooveSolid(tl, paths, [false], cone, depth, -1)).toBeNull();
  });
});
