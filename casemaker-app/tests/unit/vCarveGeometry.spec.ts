/**
 * The V-carve offset-ladder arithmetic (#221).
 *
 * The bench bit is the 30° × 0.3 mm engraver the text job uses: 15° from the axis, so
 * `tanHalf = tan(15°) = 0.267949…`. The caps are the two fixtures' stated depths
 * (0.394 thin, 0.985 thick), which is what the approved plan says the cap is.
 */
import { describe, expect, it } from 'vitest';
import {
  capWallRadius,
  coreOffsetRadius,
  cutDepthAtDistance,
  DEFAULT_V_CARVE_STEPOVER_RATIO,
  vCarveCap,
  vCarveGrooveRefusal,
  vCarveLevels,
  vCarvePlane,
  vCarvePlaneStepover,
  vCarveRadialStep,
} from '@/engine/cnc/vCarveGeometry';
import { vCone, type VCone } from '@/engine/cnc/vProfile';
import { flatEndMill } from '@/engine/cnc/tool';

/** 30° INCLUDED, 15° from the axis, 0.3 mm tip, 3.175 mm shank. */
function bit30(): VCone {
  const cone = vCone(
    flatEndMill(0.3, {
      shape: 'engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      halfAngle: 15,
      angle: 30,
    }),
  );
  if (cone === null) throw new Error('the 30° bit must have a cone');
  return cone;
}

const TAN15 = Math.tan(Math.PI / 12);

describe('vCarveLevels', () => {
  const cone = bit30();

  it('walks the thin fixture’s cap in 0.1 mm rungs and ends exactly on the cap', () => {
    const levels = vCarveLevels(cone, 0.394, 0.1);
    const depths = [0.1, 0.2, 0.3, 0.394];
    expect(levels).toHaveLength(depths.length);
    levels.forEach((level, i) => expect(level.depth).toBeCloseTo(depths[i]!, 12));
    expect(levels[0]!.radius).toBeCloseTo(0.15 + 0.1 * TAN15, 12);
    expect(levels[levels.length - 1]!.radius).toBeCloseTo(0.15 + 0.394 * TAN15, 12);
  });

  it('walks the thick fixture’s cap in 0.2 mm rungs', () => {
    const levels = vCarveLevels(cone, 0.985, 0.2);
    const depths = [0.2, 0.4, 0.6, 0.8, 0.985];
    expect(levels).toHaveLength(depths.length);
    levels.forEach((level, i) => expect(level.depth).toBeCloseTo(depths[i]!, 12));
  });

  it('does not trace the cap twice when the cap is one pitch or an exact multiple', () => {
    for (const [cap, depths] of [
      [0.3, [0.1, 0.2, 0.3]],
      [0.4, [0.1, 0.2, 0.3, 0.4]],
      [0.1, [0.1]],
    ] as const) {
      const levels = vCarveLevels(cone, cap, 0.1);
      expect(levels).toHaveLength(depths.length);
      levels.forEach((level, i) => expect(level.depth).toBeCloseTo(depths[i]!, 12));
    }
  });

  it('is one rung at the cap when the cap is below one pitch', () => {
    expect(vCarveLevels(cone, 0.05, 0.1).map((l) => l.depth)).toEqual([0.05]);
  });

  it('refuses a non-positive cap or pitch rather than inventing a ladder', () => {
    expect(() => vCarveLevels(cone, 0, 0.1)).toThrow(/cap/);
    expect(() => vCarveLevels(cone, 0.394, 0)).toThrow(/pitch/);
    expect(() => vCarveLevels(cone, Number.NaN, 0.1)).toThrow(/cap/);
  });

  it('the radial step is the depth pitch times tanHalf', () => {
    const levels = vCarveLevels(cone, 0.4, 0.1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.radius - levels[i - 1]!.radius).toBeCloseTo(vCarveRadialStep(cone, 0.1), 12);
    }
    expect(vCarveRadialStep(cone, 0.1)).toBeCloseTo(0.1 * TAN15, 12);
  });
});

describe('vCarveCap', () => {
  it('uses the item’s stated depth on both fixtures', () => {
    expect(vCarveCap(0.394, 1.5, 1.0)).toBeCloseTo(0.394, 12);
    expect(vCarveCap(0.985, 3.81, 1.0)).toBeCloseTo(0.985, 12);
  });

  it('lowers the cap to the blank’s own floor, never past it', () => {
    // The thin blank's 1.5 − 1.0 = 0.5 mm ceiling; a 1.3 mm item is capped at 0.5, not 1.3.
    expect(vCarveCap(1.3, 1.5, 1.0)).toBe(0.5);
    expect(vCarveCap(0.394, 1.5, 0.2)).toBeCloseTo(0.394, 12);
  });

  it('answers null when there is no depth or no floor left', () => {
    expect(vCarveCap(0, 1.5, 1.0)).toBeNull();
    expect(vCarveCap(0.394, 1.5, 1.5)).toBeNull();
    expect(vCarveCap(0.394, 1.5, 2.0)).toBeNull();
    expect(vCarveCap(Number.NaN, 1.5, 1.0)).toBeNull();
  });
});

describe('the cap wall and the core', () => {
  const cone = bit30();

  it('the wall is at tipRadius + cap·tanHalf; the core starts one more tip radius in', () => {
    const wall = capWallRadius(cone, 0.394);
    const core = coreOffsetRadius(cone, 0.394);
    expect(wall).toBeCloseTo(0.15 + 0.394 * TAN15, 12);
    expect(core - wall).toBeCloseTo(cone.tipRadius, 12);
    expect(core).toBeCloseTo(0.15 + 0.394 * TAN15 + 0.15, 12);
  });

  it('refuses a negative cap', () => {
    expect(() => capWallRadius(cone, -0.1)).toThrow(/cap/);
    expect(() => coreOffsetRadius(cone, -0.1)).toThrow(/cap/);
  });
});

describe('cutDepthAtDistance', () => {
  const cone = bit30();

  it('is zero inside the tip flat, one at the depth-one flank, and clamps at the cap', () => {
    expect(cutDepthAtDistance(cone, 0, 0.394)).toBe(0);
    expect(cutDepthAtDistance(cone, cone.tipRadius, 0.394)).toBe(0);
    expect(cutDepthAtDistance(cone, cone.tipRadius + TAN15, 2)).toBeCloseTo(1, 12);
    expect(cutDepthAtDistance(cone, cone.tipRadius + 2 * TAN15, 0.394)).toBeCloseTo(0.394, 12);
  });

  it('agrees with the ladder: the rung radius is the distance cut to that rung’s depth', () => {
    for (const level of vCarveLevels(cone, 0.394, 0.1)) {
      expect(cutDepthAtDistance(cone, level.radius, 0.394)).toBeCloseTo(level.depth, 12);
    }
  });

  it('refuses a negative cap', () => {
    expect(() => cutDepthAtDistance(cone, 0.2, -0.1)).toThrow(/cap/);
  });
});

describe('vCarvePlane', () => {
  const cone = bit30();

  it('places the thin blank’s plane: 0.194 mm below the film, 0.40396 mm of groove', () => {
    const plane = vCarvePlane(cone, 0.394, 0.2);
    expect(plane.film).toBe(0.2);
    expect(plane.belowPlane).toBeCloseTo(0.194, 12);
    expect(plane.planeRadius).toBeCloseTo(0.15 + 0.194 * TAN15, 12);
    expect(plane.grooveWidth).toBeCloseTo(2 * (0.15 + 0.194 * TAN15), 12);
    expect(plane.floorInset).toBeCloseTo(0.194 * TAN15, 12);
    expect(plane.surfaceOutset).toBeCloseTo(0.2 * TAN15, 12);
    expect(plane.wallOffset).toBeCloseTo(0.394 * TAN15, 12);
    // The floor-to-surface span is exactly wallOffset per side.
    expect(plane.surfaceOutset + plane.floorInset).toBeCloseTo(plane.wallOffset, 12);
  });

  it('places the badge’s plane: 0.175 mm below the film, 0.39378 mm of groove', () => {
    const plane = vCarvePlane(cone, 0.985, 0.81);
    expect(plane.belowPlane).toBeCloseTo(0.175, 12);
    expect(plane.grooveWidth).toBeCloseTo(2 * (0.15 + 0.175 * TAN15), 12);
    expect(plane.surfaceOutset).toBeCloseTo(0.81 * TAN15, 12);
  });

  it('no film puts the plane AT the floor: the tip radius is the offset and the design is the floor', () => {
    const plane = vCarvePlane(cone, 0.394, null);
    expect(plane.film).toBe(0);
    expect(plane.belowPlane).toBe(0);
    expect(plane.planeRadius).toBeCloseTo(0.15, 12);
    expect(plane.floorInset).toBe(0);
    expect(plane.surfaceOutset).toBeCloseTo(0.394 * TAN15, 12);
    expect(plane.surfaceOutset).toBeCloseTo(plane.wallOffset, 12);
  });

  it('a cut above the film has no plane below it, so the plane is the floor', () => {
    const plane = vCarvePlane(cone, 0.1, 0.2);
    expect(plane.belowPlane).toBe(0);
    expect(plane.planeRadius).toBeCloseTo(0.15, 12);
    expect(plane.surfaceOutset).toBeCloseTo(0.1 * TAN15, 12);
  });

  it('a true point tip works: the cone still widens the groove below the plane', () => {
    const sharp = vCone(
      flatEndMill(0, { shape: 'engraving', tipDiameter: 0, diameter: 3.175, halfAngle: 15 }),
    );
    if (sharp === null) throw new Error('a zero-tip bit is still a cone');
    const plane = vCarvePlane(sharp, 0.394, 0.2);
    expect(plane.planeRadius).toBeCloseTo(0.194 * TAN15, 12);
    expect(plane.floorInset).toBeCloseTo(0.194 * TAN15, 12);
    // With no film the plane is the floor and a true point has no width there at all — the run
    // sheet's "a point draws a line at the surface and nothing at the bottom".
    expect(vCarvePlane(sharp, 0.1, null).planeRadius).toBe(0);
  });
});

describe('vCarvePlaneStepover', () => {
  const cone = bit30();

  it('is 0.6 of the groove width at the plane — not of the tip flat', () => {
    expect(DEFAULT_V_CARVE_STEPOVER_RATIO).toBe(0.6);
    const thin = vCarvePlane(cone, 0.394, 0.2);
    const badge = vCarvePlane(cone, 0.985, 0.81);
    expect(vCarvePlaneStepover(thin)).toBeCloseTo(0.6 * 2 * (0.15 + 0.194 * TAN15), 12);
    expect(vCarvePlaneStepover(thin)).toBeCloseTo(0.242, 3);
    expect(vCarvePlaneStepover(badge)).toBeCloseTo(0.236, 3);
    expect(vCarvePlaneStepover(thin, 0.5)).toBeCloseTo(thin.grooveWidth * 0.5, 12);
  });

  it('refuses a ratio outside (0, 1]', () => {
    const plane = vCarvePlane(cone, 0.394, 0.2);
    expect(() => vCarvePlaneStepover(plane, 0)).toThrow(/ratio/);
    expect(() => vCarvePlaneStepover(plane, 1.01)).toThrow(/ratio/);
    expect(() => vCarvePlaneStepover(plane, Number.NaN)).toThrow(/ratio/);
  });
});

describe('vCarveGrooveRefusal', () => {
  const cone = bit30();
  /** The Z1's 1600 steps/mm on X and Y, mm per step. */
  const STEP = 1 / 1600;

  it('passes a normal blank: the plane groove is far wider than two steps', () => {
    expect(vCarveGrooveRefusal(vCarvePlane(cone, 0.394, 0.2), STEP)).toBeNull();
    expect(vCarveGrooveRefusal(vCarvePlane(cone, 0.985, 0.81), STEP)).toBeNull();
  });

  it('refuses a groove under the margin by name, with both widths and the way out', () => {
    // A point tip on a 0.002 mm film, 0.003 mm deep: e = 0.001, so the groove is
    // 2·0.001·tan15 = 0.000536 mm (0.536 µm), under 2 × 0.625 µm. The refusal is the maintainer's:
    // go deeper or widen the stroke.
    const sharp = vCone(
      flatEndMill(0, { shape: 'engraving', tipDiameter: 0, diameter: 3.175, halfAngle: 15 }),
    );
    if (sharp === null) throw new Error('a zero-tip bit is still a cone');
    const refusal = vCarveGrooveRefusal(vCarvePlane(sharp, 0.003, 0.002), STEP);
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/0\.536 µm/);
    expect(refusal).toMatch(/1\.25 µm/);
    expect(refusal).toMatch(/go deeper or widen the stroke/);
  });

  it('uses the margin: a groove between one and two steps is still refused', () => {
    const sharp = vCone(
      flatEndMill(0, { shape: 'engraving', tipDiameter: 0, diameter: 3.175, halfAngle: 15 }),
    );
    if (sharp === null) throw new Error('a zero-tip bit is still a cone');
    // e = 0.0019 -> 2·0.0019·tan15 = 1.018 µm: over one 0.625 µm step, under the shipped 1.25 bar.
    const plane = vCarvePlane(sharp, 0.0039, 0.002);
    expect(vCarveGrooveRefusal(plane, STEP, 1)).toBeNull();
    expect(vCarveGrooveRefusal(plane, STEP)).not.toBeNull();
  });

  it('refuses a non-positive machine step rather than passing everything', () => {
    const plane = vCarvePlane(cone, 0.394, 0.2);
    expect(() => vCarveGrooveRefusal(plane, 0)).toThrow(/machineStepMm/);
    expect(() => vCarveGrooveRefusal(plane, Number.NaN)).toThrow(/machineStepMm/);
  });
});
