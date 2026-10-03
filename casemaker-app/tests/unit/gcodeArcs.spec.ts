// Arc tessellation (#174), against CLOSED FORMS, independent of any G-code text.
//
// The geometry follows the firmware's append_arc. The cases below are the ones where a
// sign or a branch is easy to get wrong: the G18 sense flip, the full circle (where the
// atan2 form cancels and the firmware takes ±2π), a helix, and a radius so small or large
// that the chord-error segment count could misbehave.

import { describe, it, expect } from 'vitest';
import { tessellateArc, type ArcRequest } from '@/engine/cnc/gcode/arcs';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';

type V3 = [number, number, number];
const AX: Record<string, [number, number, number]> = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] };

function run(req: ArcRequest) {
  const res = tessellateArc(req);
  if ('error' in res) throw new Error(res.error);
  const [a0, a1, lin] = AX[req.plane]!;
  const c0 = req.start[a0]! + req.offsets[a0]!;
  const c1 = req.start[a1]! + req.offsets[a1]!;
  let prev: V3 = req.start;
  let maxSagitta = 0;
  let maxRadiusError = 0;
  for (const p of res.points) {
    maxRadiusError = Math.max(maxRadiusError, Math.abs(Math.hypot(p[a0]! - c0, p[a1]! - c1) - res.radiusStart));
    const mid = Math.hypot((prev[a0]! + p[a0]!) / 2 - c0, (prev[a1]! + p[a1]!) / 2 - c1);
    maxSagitta = Math.max(maxSagitta, Math.abs(res.radiusStart - mid));
    prev = p;
  }
  return { res, maxSagitta, maxRadiusError, last: res.points.at(-1)!, lin };
}

const deg = (d: number) => (d * Math.PI) / 180;

describe('angular travel', () => {
  // Centre (10, 0) in every XY case. (0,0) is at 180°; (10,10) is at 90°.
  it.each([
    ['XY CCW (G3) 180° → 90°, the long way: +270°', { start: [0, 0, 0], end: [10, 10, 0], offsets: [10, 0, 0], plane: 'XY', clockwise: false }, 270],
    ['XY CW (G2) 180° → 90°, the short way: −90°', { start: [0, 0, 0], end: [10, 10, 0], offsets: [10, 0, 0], plane: 'XY', clockwise: true }, -90],
    ['XY CCW quarter with a helix', { start: [10, 0, 0], end: [0, 10, 5], offsets: [-10, 0, 0], plane: 'XY', clockwise: false }, 90],
    ['YZ (G19) CCW quarter', { start: [0, 10, 0], end: [0, 0, 10], offsets: [0, -10, 0], plane: 'YZ', clockwise: false }, 90],
  ] as [string, ArcRequest, number][])('%s', (_n, req, expectDeg) => {
    expect(run(req).res.angular).toBeCloseTo(deg(expectDeg), 12);
  });

  it('a full circle is ±2π, because start and end coincide and atan2 cancels', () => {
    for (const clockwise of [true, false]) {
      const { res } = run({ start: [0, 0, 0], end: [0, 0, 0], offsets: [5, 0, 0], plane: 'XY', clockwise });
      expect(res.angular).toBeCloseTo(clockwise ? -2 * Math.PI : 2 * Math.PI, 12);
    }
  });

  it('G18 (XZ) FLIPS the sense, because that plane\'s handedness is reversed', () => {
    // Same geometry as the first XY case, in XZ. Flagged CW, it travels the way XY CCW did.
    expect(run({ start: [0, 0, 0], end: [10, 0, 10], offsets: [10, 0, 0], plane: 'XZ', clockwise: true }).res.angular).toBeCloseTo(deg(270), 12);
    expect(run({ start: [0, 0, 0], end: [10, 0, 10], offsets: [10, 0, 0], plane: 'XZ', clockwise: false }).res.angular).toBeCloseTo(deg(-90), 12);
  });

  it('the G18 flip is NOT applied to a full circle (the firmware branches before it)', () => {
    const { res } = run({ start: [0, 0, 0], end: [0, 0, 0], offsets: [5, 0, 0], plane: 'XZ', clockwise: true });
    expect(res.angular).toBeCloseTo(-2 * Math.PI, 12);
  });
});

describe('geometry', () => {
  it.each([
    ['r = 0.1', { start: [0, 0, 0], end: [0.1, 0.1, 0], offsets: [0.1, 0, 0], plane: 'XY', clockwise: false }],
    ['r = 10', { start: [0, 0, 0], end: [10, 10, 0], offsets: [10, 0, 0], plane: 'XY', clockwise: false }],
    ['r = 500', { start: [0, 0, 0], end: [500 - 500 * Math.cos(Math.PI / 18), 500 * Math.sin(Math.PI / 18), 0], offsets: [500, 0, 0], plane: 'XY', clockwise: true }],
    ['full circle', { start: [0, 0, 0], end: [0, 0, 0], offsets: [5, 0, 0], plane: 'XY', clockwise: true }],
  ] as [string, ArcRequest][])('%s: every chord stays within the shared tolerance and the end is exact', (_n, req) => {
    const { maxSagitta, maxRadiusError, last } = run(req);
    expect(maxSagitta).toBeLessThanOrEqual(ARC_CHORD_TOLERANCE_MM + 1e-9);
    expect(maxRadiusError).toBeLessThan(1e-9);
    expect(last).toEqual(req.end);
  });

  it('a helix is linear in the linear axis and lands on the target', () => {
    const { res, last } = run({ start: [10, 0, 0], end: [0, 10, 5], offsets: [-10, 0, 0], plane: 'XY', clockwise: false });
    expect(last[2]).toBe(5);
    const dz = res.points.map((p, i) => p[2] - (i === 0 ? 0 : res.points[i - 1]![2]));
    for (const d of dz) expect(d).toBeCloseTo(dz[0]!, 9);
  });

  it('the segment count is bounded: a 1 m radius cannot ask for millions of points', () => {
    const { res } = run({ start: [0, 0, 0], end: [0, 0, 0], offsets: [1000, 0, 0], plane: 'XY', clockwise: false });
    expect(res.points.length).toBeLessThan(100_001);
    expect(res.points.length).toBeGreaterThan(100);
  });

  it('a zero radius is an error, not a NaN', () => {
    const r = tessellateArc({ start: [0, 0, 0], end: [1, 1, 0], offsets: [0, 0, 0], plane: 'XY', clockwise: false });
    expect('error' in r).toBe(true);
  });
});

describe('REGRESSION (review #174): a mismatched radius is a circle then ONE JUMP, not a spiral', () => {
  // Start radius 10, end radius 12. The firmware rotates the START radius vector through the
  // angular travel and only lands the last segment on the target. The first port
  // interpolated the radius and spiralled (2.0 mm of radial error) while its own comment
  // claimed to reproduce the firmware.
  const req: ArcRequest = { start: [0, 0, 0], end: [10, 12, 0], offsets: [10, 0, 0], plane: 'XY', clockwise: false };

  it('every intermediate point lies on the START circle', () => {
    const { res } = run(req);
    const c0 = 10;
    for (const p of res.points.slice(0, -1)) {
      expect(Math.abs(Math.hypot(p[0] - c0, p[1]) - res.radiusStart)).toBeLessThan(1e-9);
    }
  });

  it('only the last point is off the circle, and it is exactly the target', () => {
    const { res, last } = run(req);
    expect(last).toEqual([10, 12, 0]);
    expect(res.radiusEnd).toBeCloseTo(12, 12);
    expect(Math.abs(Math.hypot(last[0] - 10, last[1]) - res.radiusStart)).toBeGreaterThan(1.9);
  });
});
