// #1239 stage 2 (the analyst's amended ruling) — every finish/ball-rest ROW point is laid on the
// posted grid before its height is taken: the nearest grid position when its own height is within
// the finish tolerance of the planned one; otherwise the one of the four grid positions around the
// planned point whose height is nearest the planned height. The posted z is always the drop-cutter
// height at the posted position, rounded UP; nothing is ever posted below it.
import { describe, expect, it } from 'vitest';

import { layRowOnPostedGrid } from '@/engine/cnc/cam/model/ops/finish';
import { footprintIndex } from '@/engine/cnc/cam/model/footprintIndex';
import type { ClSurface } from '@/engine/cnc/cam/model/clsurface';
import type { DroppedPoint } from '@/engine/cnc/cam/model/rowDropper';

const STEP = 0.001;
const onGrid = (v: number): boolean => Math.abs(v / STEP - Math.round(v / STEP)) <= 1e-9;
const surface = (dropCutter: (x: number, y: number) => number | null): ClSurface =>
  ({ dropCutter, toleranceMm: 0.005 } as unknown as ClSurface);
/** A footprint wide enough that no test point sits on its edge. */
const BOUNDARY = footprintIndex([[[0, 0], [100, 0], [100, 100], [0, 100]]]);

const lay = (points: DroppedPoint[], cl: ClSurface, stats?: { step3: number; largestMoveMm: number }): DroppedPoint[] =>
  layRowOnPostedGrid(points, { clSurface: cl, axisPrecision: 3 }, BOUNDARY, stats);

describe('#1239 every row point lies on the posted grid', () => {
  it('a flat floor: the height at the rounded position is the same height', () => {
    const laid = lay([{ x: 2.0004, y: 3.0006, z: -2.5 }], surface(() => -2.5));
    expect(laid).toEqual([{ x: 2, y: 3.001, z: -2.5 }]);
  });

  it('an ordinary slope: the nearest grid position when its height is within the tolerance', () => {
    // CL = −2x: the planned (2.0004, −4.0008) and the nearest grid (2.000, −4.000) differ by
    // 0.0008, inside the 0.005 finish tolerance.
    const laid = lay([{ x: 2.0004, y: 3.0006, z: -4.0008 }], surface((x) => -2 * x));
    expect(laid).toHaveLength(1);
    expect(onGrid(laid[0]!.x)).toBe(true);
    expect(onGrid(laid[0]!.y)).toBe(true);
    expect(laid[0]!.x).toBeCloseTo(2, 12);
    expect(laid[0]!.y).toBeCloseTo(3.001, 12);
    expect(laid[0]!.z).toBeCloseTo(-4, 12); // ceil of the CL at the posted position
  });

  it('a vertical wall: the four grid positions settle on the planned height, one step away', () => {
    // The accuracy sample's edge, as the exact query measured it: the top side reads −0.75, the
    // pocket side −3.596, and the wall's edge lies between x = 41.250 and 41.251. The row was
    // planned a hair on the wrong side (41.2504) with the pocket-side height.
    const cl = surface((x) => (x <= 41.2505 ? -0.75 : -3.596));
    const planned: DroppedPoint = { x: 41.2504, y: 11.743, z: -3.596 };
    const stats = { step3: 0, largestMoveMm: 0 };
    const laid = lay([planned], cl, stats);
    expect(laid).toHaveLength(1);
    expect(stats.step3).toBe(1);
    expect(stats.largestMoveMm).toBeCloseTo(41.251 - 41.2504, 9);
    const p = laid[0]!;
    expect(onGrid(p.x)).toBe(true);
    expect(onGrid(p.y)).toBe(true);
    expect(p.x).toBeCloseTo(41.251, 9); // one posted step, the nearest height to the planned one
    expect(Math.abs(p.x - planned.x)).toBeLessThanOrEqual(STEP + 1e-9);
    const own = cl.dropCutter(p.x, p.y)!;
    expect(p.z).toBeGreaterThanOrEqual(own - 1e-6); // never below its own CL
    expect(p.z).toBeLessThan(own + STEP + 1e-6); // never more than one step above it
    expect(p.z).toBeLessThanOrEqual(planned.z + 0.005 + 1e-9); // the row is not lifted over the wall
  });

  it('the rounding up: every posted z is at or above its own CL by less than one step', () => {
    const cl = surface((x) => -1.234567 - 0.0004 * x);
    const laid = lay([{ x: 5.0004, y: 4, z: -1.236567 }], cl);
    const p = laid[0]!;
    const own = cl.dropCutter(p.x, p.y)!;
    expect(p.z).toBeGreaterThanOrEqual(own - 1e-6);
    expect(p.z).toBeLessThan(own + STEP + 1e-6);
  });

  it('a point the CL has no answer at is dropped, not posted', () => {
    const laid = lay([{ x: 2.0004, y: 3.0006, z: -1 }], surface(() => null));
    expect(laid).toEqual([]);
  });
});
