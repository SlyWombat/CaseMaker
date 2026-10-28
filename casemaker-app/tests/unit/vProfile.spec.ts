/**
 * The V-bit's cone, as arithmetic (#405).
 *
 * The bench check this file exists to hold: `docs/bench/185-v-groove.nc` was cut on 2026-10-15 with
 * the 30° engraving bit the text job defaults to (0.3 mm tip), and the groove's top opening at
 * d = 1.0 mm is 0.836 mm — `0.3 + 2·1.0·tan(15°)`. The column engine's grid can only confirm that
 * to a cell; this is where the number itself is stated.
 */
import { describe, expect, it } from 'vitest';
import { coneHeight, depthForWidth, flankHeightAboveTip, grooveRadiusAt, grooveWidthAt, grooveWidthForTool, isVShape, vCone, type VCone } from '@/engine/cnc/vProfile';
import { flatEndMill, toolFromMkrRecord, type Tool } from '@/engine/cnc/tool';

/** The 30° engraving bit: 30° INCLUDED, so 15° from the axis, 0.3 mm tip, 3.175 mm shank. */
const bit30 = (): Tool =>
  flatEndMill(0.3, {
    name: '30° engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    handleDiameter: 3.175,
    diameter: 3.175,
    tipDiameter: 0.3,
    halfAngle: 15,
    angle: 30,
  });

describe('vCone', () => {
  it('reads the bench bit: 0.15 mm tip radius, 15° from the axis', () => {
    const cone = vCone(bit30());
    expect(cone).not.toBeNull();
    if (!cone) return;
    expect(cone.tipRadius).toBeCloseTo(0.15, 6);
    expect(cone.halfAngleDeg).toBe(15);
    expect(cone.tanHalf).toBeCloseTo(Math.tan(Math.PI / 12), 9);
  });

  it('takes half the INCLUDED angle when the file states only `angle`', () => {
    const only = flatEndMill(0.3, { shape: 'engraving', tipDiameter: 0.3, halfAngle: null, angle: 60 });
    const cone = vCone(only);
    expect(cone?.halfAngleDeg).toBe(30); // the 60° bit
    // …including the shape our OWN post writes for it: `halfAngle=0` is UNSET, not a 0°-from-axis
    // tool. Reading it as stated would refuse every engraver file this app produces.
    const roundTripped = flatEndMill(0.3, { shape: 'engraving', tipDiameter: 0.3, halfAngle: 0, angle: 60 });
    expect(vCone(roundTripped)?.halfAngleDeg).toBe(30);
  });

  it('refuses a tool with no tip diameter — the `diameter` field is the SHANK here', () => {
    // Makera writes 3.175 into `diameter` for an engraver. Falling back to it would simulate a
    // 3.175 mm-wide V and cut a groove six times too wide.
    const noTip = flatEndMill(3.175, { shape: 'engraving', tipDiameter: null, diameter: 3.175, halfAngle: 15 });
    expect(vCone(noTip)).toBeNull();
  });

  it('refuses an angle that is not a cone: 0, missing, or at/past 90° from the axis', () => {
    const at = (angle: number | null, half: number | null): VCone | null =>
      vCone(flatEndMill(0.3, { shape: 'engraving', tipDiameter: 0.3, angle, halfAngle: half }));
    expect(at(null, null)).toBeNull();
    expect(at(0, 0)).toBeNull();
    expect(at(null, 90)).toBeNull();
    expect(at(null, 120)).toBeNull();
    expect(at(2, null)).not.toBeNull(); // a 2° included angle is a needle, but a real one
  });

  it('is only for an engraver or a chamfer', () => {
    expect(isVShape(bit30())).toBe(true);
    expect(isVShape(flatEndMill(0.3, { shape: 'chamfer', tipDiameter: 0.3, halfAngle: 45 }))).toBe(true);
    expect(isVShape(flatEndMill(3.175))).toBe(false);
    expect(isVShape(flatEndMill(3.175, { shape: 'ball' }))).toBe(false);
    expect(vCone(flatEndMill(3.175))).toBeNull();
  });

  it('reads the geometry off a `.nc` header record, not just a hand-built tool', () => {
    // What `docs/bench/185-v-groove.nc`'s `;@MKR|TOOL|` line parses to, as far as the cone cares.
    const tool = toolFromMkrRecord({
      name: 'TOOL',
      fields: { type: 'Engraving', name: '30° engraving', tipdiameter: '0.3', diameter: '3.175', halfAngle: '15' },
      raw: '',
    } as unknown as Parameters<typeof toolFromMkrRecord>[0]);
    expect(vCone(tool)?.halfAngleDeg).toBe(15);
    expect(vCone(tool)?.tipRadius).toBeCloseTo(0.15, 6);
  });
});

describe('the groove width and its inverse', () => {
  const cone = vCone(bit30());
  if (!cone) throw new Error('the bench bit must have a cone');

  it('is 0.836 mm at d = 1.0 — the bench number (#185, 2026-10-15)', () => {
    expect(grooveWidthAt(cone, 1)).toBeCloseTo(0.8359, 4);
  });

  it('is the TIP at zero depth: the tool cannot cut narrower than its own flat', () => {
    expect(grooveWidthAt(cone, 0)).toBeCloseTo(0.3, 9);
    expect(depthForWidth(cone, 0.3)).toBe(0);
    expect(depthForWidth(cone, 0.2)).toBeNull(); // no depth reaches a width under the tip
  });

  it('inverts: the depth that opens the groove to a width', () => {
    expect(depthForWidth(cone, grooveWidthAt(cone, 1.37))).toBeCloseTo(1.37, 9);
    expect(depthForWidth(cone, 0.8359)).toBeCloseTo(1.0, 3);
  });

  it('grows with the bit’s angle: a 60° bit is wider than a 30° one at the same depth', () => {
    const cone60 = vCone(flatEndMill(0.3, { shape: 'engraving', tipDiameter: 0.3, angle: 60 }));
    if (!cone60) throw new Error('a 60° bit must have a cone');
    expect(grooveWidthAt(cone60, 1)).toBeCloseTo(0.3 + 2 * Math.tan(Math.PI / 6), 6);
    expect(grooveWidthAt(cone60, 1)).toBeGreaterThan(grooveWidthAt(cone, 1));
  });

  it('answers a flat end mill with null — a flat has no cone, only `cuttingDiameter`', () => {
    expect(grooveWidthForTool(flatEndMill(3.175), 1)).toBeNull();
    expect(grooveWidthForTool(bit30(), 1)).toBeCloseTo(0.8359, 4);
  });
});

describe('the flank profile the column engine writes', () => {
  const cone = vCone(bit30());
  if (!cone) throw new Error('the bench bit must have a cone');

  it('is 0 inside the tip’s flat and rises at 1/tan outside it', () => {
    expect(flankHeightAboveTip(cone, 0)).toBe(0);
    expect(flankHeightAboveTip(cone, 0.15)).toBe(0); // the tip's own edge
    expect(flankHeightAboveTip(cone, 0.15 + Math.tan(Math.PI / 12))).toBeCloseTo(1, 9);
    expect(flankHeightAboveTip(cone, 0.15 + 2 * Math.tan(Math.PI / 12))).toBeCloseTo(2, 9);
  });

  it('agrees with the width: the flank is at the top face exactly at the opening’s edge', () => {
    // At depth d the groove's edge is at ρ = w(d)/2, and there the flank stands exactly d above the
    // tip plane. Two statements of one geometry, so they must not drift apart.
    for (const d of [0.25, 1, 2.5]) {
      expect(flankHeightAboveTip(cone, grooveRadiusAt(cone, d))).toBeCloseTo(d, 9);
    }
  });
});

/**
 * #741 — THE FLANK ENDS AT THE BIT'S BODY. The bench bit's `diameter` is the 3.175 mm shank the
 * cone flares to, so its flank stops at 1.5875 mm radius — 5.3648 mm above the tip. Past that the
 * body cuts a vertical wall, so the model must not keep opening the V (which is how a 5.1 mm cut
 * was simulated 10.3 mm wide). All three readers — the width, its inverse, and the column
 * engine's flank profile — must stop at the SAME radius; this block pins the one owner.
 */
describe('the flank ends at the bit’s body (#741)', () => {
  const cone = vCone(bit30());
  if (!cone) throw new Error('the bench bit must have a cone');
  const bodyRadius = 3.175 / 2;
  const flank = (bodyRadius - 0.15) / Math.tan(Math.PI / 12);

  it('caps the groove’s width at the body diameter', () => {
    expect(cone.outerRadius).toBeCloseTo(bodyRadius, 9);
    expect(coneHeight(cone)).toBeCloseTo(flank, 9);
    expect(grooveWidthAt(cone, flank)).toBeCloseTo(3.175, 9);
    // Deeper than the cone, the opening is the body's own diameter — not 0.3 + 2·d·tan.
    expect(grooveWidthAt(cone, flank + 1)).toBeCloseTo(3.175, 9);
    expect(grooveWidthAt(cone, 50)).toBeCloseTo(3.175, 9);
    expect(0.3 + 2 * (flank + 1) * Math.tan(Math.PI / 12)).toBeGreaterThan(3.175);
  });

  it('answers “no depth reaches it” for a width wider than the body', () => {
    expect(depthForWidth(cone, 3.175)).toBeCloseTo(flank, 9);
    expect(depthForWidth(cone, 3.2)).toBeNull();
    expect(depthForWidth(cone, 10)).toBeNull();
    // Inside the cone the inverse is unchanged.
    expect(depthForWidth(cone, 0.8359)).toBeCloseTo(1.0, 3);
  });

  it('leaves no cutter past the body in the flank profile', () => {
    expect(flankHeightAboveTip(cone, bodyRadius)).toBeCloseTo(flank, 9);
    expect(flankHeightAboveTip(cone, bodyRadius + 1e-9)).toBe(Infinity);
    expect(flankHeightAboveTip(cone, 3)).toBe(Infinity);
  });

  it('leaves a record with no body stated open, as before #741', () => {
    // The degenerate-record rule: a diameter the width of the tip is not a body. The model keeps
    // reading an open flank rather than inventing a 0 mm cone (which would forbid every V-cut).
    const open = vCone({ ...bit30(), diameter: 0.3 })!;
    expect(open.outerRadius).toBeUndefined();
    expect(coneHeight(open)).toBeNull();
    expect(grooveWidthAt(open, 5.1)).toBeCloseTo(0.3 + 2 * 5.1 * Math.tan(Math.PI / 12), 9);
    expect(depthForWidth(open, 10)).toBeCloseTo((10 - 0.3) / (2 * Math.tan(Math.PI / 12)), 9);
    expect(flankHeightAboveTip(open, 3)).toBeCloseTo((3 - 0.15) / Math.tan(Math.PI / 12), 9);
  });
});
