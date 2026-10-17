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
  DEFAULT_CORE_STEPOVER_RATIO,
  tipClearStepover,
  vCarveCap,
  vCarveLevels,
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

describe('tipClearStepover', () => {
  it('is 0.6 of the 0.3 mm tip flat by default — 0.18 mm', () => {
    expect(DEFAULT_CORE_STEPOVER_RATIO).toBe(0.6);
    expect(tipClearStepover(bit30())).toBeCloseTo(0.18, 12);
    expect(tipClearStepover(bit30(), 0.5)).toBeCloseTo(0.15, 12);
    expect(tipClearStepover(bit30(), 1)).toBeCloseTo(0.3, 12);
  });

  it('answers null for a sharp point: there is no flat to clear with', () => {
    const sharp = vCone(
      flatEndMill(0, { shape: 'engraving', tipDiameter: 0, diameter: 3.175, halfAngle: 15 }),
    );
    if (sharp === null) throw new Error('a zero-tip bit is still a cone');
    expect(sharp.tipRadius).toBe(0);
    expect(tipClearStepover(sharp)).toBeNull();
  });

  it('refuses a ratio outside (0, 1]', () => {
    expect(() => tipClearStepover(bit30(), 0)).toThrow(/ratio/);
    expect(() => tipClearStepover(bit30(), 1.01)).toThrow(/ratio/);
    expect(() => tipClearStepover(bit30(), Number.NaN)).toThrow(/ratio/);
  });
});
