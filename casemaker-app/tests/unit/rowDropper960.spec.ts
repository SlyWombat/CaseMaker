/**
 * #960 — THE ROW-DROPPER, RED-FIRST.
 *
 * `cam/model/rowDropper.ts`'s `dropRow` against two analytic meshes: a smooth RAMP (where linear
 * interpolation between dropped points must stay close to the TRUE, closed-form ball-on-ramp
 * height) and a STEP (where no amount of subdivision can close the departure, and the staircase
 * rule must hold instead of a diagonal). `dropCutterHeight` is now EXACT (#957/#960's own
 * unified closed-form contact, `dropcutter.ts`) — these fixtures used to need a finely
 * tessellated ramp mesh and noise allowances on the step to work around that file's own
 * dense-sampling error (0.02-0.1 mm on a large facet); both are gone, since both tests now hold
 * to the real algorithmic precision, not a documented sampling limitation elsewhere.
 */

import { describe, expect, it } from 'vitest';

import { dropRow } from '../../src/engine/cnc/cam/model/rowDropper';
import { clSurface, type ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

// Every row queried below runs from x=0 to x=length — this margin extends BOTH meshes well past
// that on every side (more than any cutter radius used here) so a query never sits exactly at the
// mesh's own edge, where the disc would rest only on the material actually there (a different,
// legitimate answer, not what these fixtures mean to pose).
const MESH_MARGIN_MM = 10;

/** A plane through the origin tilted about Y: z = slope * x, `half` wide in y, from x=0 to x=length. */
function rampMesh(slope: number, length: number, half: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  const z0 = slope * x0;
  const z1 = slope * x1;
  return {
    triangles: {
      positions: Float32Array.from([
        x0, y0, z0, x1, y0, z1, x1, y1, z1,
        x0, y0, z0, x1, y1, z1, x0, y1, z0,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [x0, y0, Math.min(z0, z1)], max: [x1, y1, Math.max(z0, z1)] },
    },
  };
}

/** Two flat plateaus at `zTop`/`zBottom`, split at `x = at` — a GENUINE discontinuity, two
 * triangles each, no shared vertex at the seam. */
function stepMesh(at: number, length: number, half: number, zTop: number, zBottom: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  return {
    triangles: {
      positions: Float32Array.from([
        x0, y0, zTop, at, y0, zTop, at, y1, zTop,
        x0, y0, zTop, at, y1, zTop, x0, y1, zTop,
        at, y0, zBottom, x1, y0, zBottom, x1, y1, zBottom,
        at, y0, zBottom, x1, y1, zBottom, at, y1, zBottom,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      triangleCount: 4,
      bbox: { min: [x0, y0, zBottom], max: [x1, y1, zTop] },
    },
  };
}

// Padded half a mm past the mesh's own extent: a row endpoint queried EXACTLY at the mesh's edge
// (x = 0 or x = length) must not fall on the footprint's own boundary, where point-in-polygon
// ray-casting is ambiguous by convention (this module's job is the drop itself, not that edge
// case) — the mesh still bounds what `dropCutterHeight` can actually find a triangle for.
function region(half: number, length: number): RemainderRegion {
  const pad = 0.5;
  return {
    id: 'r1',
    footprint: [[[-pad, -half - pad], [length + pad, -half - pad], [length + pad, half + pad], [-pad, half + pad]]],
    area: length * 2 * half,
    zTop: 0,
    zBottom: -100,
    triangles: new Uint32Array(),
    slopeDeg: [0, 90],
    slopeMedianDeg: 45,
    in: 'top',
  };
}

const ball6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };

describe('#960 dropRow() — smooth ramp', () => {
  it('every dropped point IS the surface\'s own drop at its own (x, y) — no interpolation on the sampled points themselves', () => {
    const geometry = rampMesh(-0.2, 50, 10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    for (const p of row) expect(p.z, `(${p.x}, ${p.y})`).toBeCloseTo(surface.dropCutter(p.x, p.y)!, 9);
  });

  // The CLOSED FORM a ball resting on a flat tilted plane must reach — the module's own
  // documented `R(secθ − 1)` rise above the plane's height at the same (x, y).
  function ballTipOnFlatRamp(slopeDxDz: number, ballRadiusMm: number, x: number): number {
    const theta = Math.atan(Math.abs(slopeDxDz));
    const rise = ballRadiusMm * (1 / Math.cos(theta) - 1);
    return slopeDxDz * x + rise;
  }

  it('linear interpolation BETWEEN adjacent dropped points stays close to the TRUE analytic ball-on-ramp height, densely checked', () => {
    const slope = -0.2;
    const geometry = rampMesh(slope, 50, 10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    expect(row.length).toBeGreaterThan(1);
    let worst = 0;
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1]!;
      const b = row[i]!;
      for (let t = 0; t <= 1; t += 0.1) {
        const x = a.x + (b.x - a.x) * t;
        const interpolated = a.z + (b.z - a.z) * t;
        worst = Math.max(worst, Math.abs(interpolated - ballTipOnFlatRamp(slope, 3, x)));
      }
    }
    // `dropCutterHeight` is now exact (#957/#960's unified closed-form contact) — the earlier
    // 0.02 mm allowance for its own sampling granularity on a large facet is gone; this is the
    // real algorithmic tolerance now, not a documented limitation elsewhere.
    expect(worst, 'worst departure from the analytic ball-on-ramp height, mm').toBeLessThanOrEqual(surface.toleranceMm);
  });
});

describe('#960 dropRow() — a real discontinuity (staircase, not a diagonal)', () => {
  const R = 3;
  // The ball's own TRUE CL across the step (the manager's own derivation, confirmed independently
  // here): past the top plateau's own edge, the ball rests tangent to that edge — a quarter-circle
  // of radius R, NOT an instant drop — down to z = zTop - R at the edge's own reach limit, d = R
  // past x = 25 (x = 28 for this fixture); only THERE does a genuine vertical cliff to zBottom
  // occur, since zTop - R (-3) stays well above zBottom (-10) for the whole curve.
  function analyticStepCL(xStep: number, zTop: number, zBottom: number, x: number): number {
    const d = x - xStep;
    if (d < 0) return zTop;
    if (d < R) return zTop - R + Math.sqrt(R * R - d * d);
    return zBottom;
  }

  it('follows the TRUE analytic CL across the step — the quarter-circle edge contact up to x=28, the staircase only at the true cliff past it', () => {
    const geometry = stepMesh(25, 50, 10, 0, -10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    expect(row.length).toBeGreaterThan(2); // the edge curve itself forces real subdivision
    // #1129 — THE GUARANTEE, IN THE FLOOR'S TERMS. The row dropper emits a STAIRCASE: across a
    // stretch it cannot close it holds the SHALLOWER of two known points and steps vertically at
    // the deeper end. Those held stretches and vertical drops are the construction, not chords —
    // under the old 0.005 mm floor they were too short to see, and at the ruled sampling floor
    // (min(step-over / 10, 0.05 mm)) they are visible to a chord comparison. What the row must
    // never do is DIP BELOW the true CL (the diagonal defect this test was written against), and
    // on the resolvable arc it must track the CL to the floor.
    let worstDip = 0;
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1]!;
      const b = row[i]!;
      if (a.x === b.x && a.y === b.y) continue; // a vertical staircase drop: no chord to judge
      for (let t = 0; t <= 1; t += 0.05) {
        const x = a.x + (b.x - a.x) * t;
        const interpolated = a.z + (b.z - a.z) * t;
        worstDip = Math.max(worstDip, analyticStepCL(25, 0, -10, x) - interpolated);
      }
    }
    // A chord may never cut below the true CL by more than the sampler's ACCEPTANCE tolerance.
    expect(worstDip, 'the row never dips below the true analytic CL, mm').toBeLessThanOrEqual(surface.toleranceMm);
    // And the row still spans the WHOLE analytic surface: the top plateau, the arc, and the
    // bottom plateau are all on it (a staircase's holds must not swallow the cut).
    expect(row[0]!.z).toBeCloseTo(0, 6);
    expect(row[row.length - 1]!.z).toBeCloseTo(-10, 6);
    expect(row.some((p) => p.x > 25 + R + 0.1 && p.z === -10)).toBe(true);
  });

  it('produces an actual vertical step (two points at the same XY) right at the TRUE cliff (x = 25 + R = 28), not a smoothed ramp', () => {
    const geometry = stepMesh(25, 50, 10, 0, -10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    const cliff = row.findIndex((p, i) => i > 0 && p.x === row[i - 1]!.x && p.y === row[i - 1]!.y && Math.abs(p.z - row[i - 1]!.z) > 1);
    expect(cliff, `row: ${JSON.stringify(row)}`).toBeGreaterThan(0);
    expect(row[cliff]!.x, 'the cliff sits at x = 25 + R, not at the mesh seam x = 25').toBeCloseTo(28, 1);
  });

  it('refuses a row whose own endpoint falls outside the surface\'s reach, rather than guessing', () => {
    const geometry = rampMesh(-0.2, 50, 10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    expect(() => dropRow(surface, [0, 0], [500, 0])).toThrow(/outside the surface's reach|must be within the surface's reach/);
  });
});

// The manager's ruling on footprint vs links: a row is CUT only where `clSurface` answers; a
// straight line whose own ENDPOINTS are both reachable but which crosses OUT of the footprint in
// between (a notch) must never be guessed across as one chord — that is the "cutting move across
// unplanned ground" the ruling forbids. The caller (finish's own row-building, not yet built)
// clips a row into separate footprint intervals and hands the gap to `link()`; `dropRow` itself
// must refuse, not silently paper over it.
describe('#960 dropRow() — a footprint notch between two otherwise-reachable points', () => {
  function flatMeshWideOf(z: number, half: number): FeatureSource {
    return {
      triangles: {
        positions: Float32Array.from([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        triangleCount: 2,
        bbox: { min: [-half, -half, z], max: [half, half, z] },
      },
    };
  }

  /** Two disjoint lobes of a footprint, [0,10] and [40,50] in x — the gap between them (x in
   * (10, 40)) is real material (the mesh is one flat plane) but NOT part of this region's own
   * footprint, exactly a notch a finish raster's own row must not cross as a straight chord. */
  function twoLobeFootprint(): RemainderRegion {
    return {
      id: 'notched',
      footprint: [[[0, -5], [10, -5], [10, 5], [0, 5]], [[40, -5], [50, -5], [50, 5], [40, 5]]],
      area: 200,
      zTop: 0,
      zBottom: -10,
      triangles: new Uint32Array(),
      slopeDeg: [0, 0],
      slopeMedianDeg: 0,
      in: 'top',
    };
  }

  it('throws rather than posting a straight chord across the notch', () => {
    const geometry = flatMeshWideOf(0, 100);
    const surface = clSurface(geometry, twoLobeFootprint(), ball6, 3);
    // Both ends ARE reachable (each lobe's own interior) — `dropRow` must find the gap and throw,
    // not accept a chord across it because the two endpoints alone looked fine. Either this
    // function's own maxSpacing sampling lands in the gap directly, or (a narrower notch) a
    // bisection midpoint does — both are the SAME rule, caught at a different stride.
    expect(surface.dropCutter(5, 0)).not.toBeNull();
    expect(surface.dropCutter(45, 0)).not.toBeNull();
    expect(() => dropRow(surface, [5, 0], [45, 0])).toThrow(/footprint notch|outside the surface's reach/);
  });

  it('throws from the bisection itself when the row\'s own ends are one maxSpacing stride apart (so the maxSpacing loop never samples the gap directly)', () => {
    const geometry = flatMeshWideOf(0, 100);
    // A 0.2 mm-wide gap at x=25. Querying from 24.85 to 25.15 (0.3 mm apart, under the ball's own
    // maxSpacing — `dropRow`'s maxSpacing loop then takes exactly ONE step straight to the far
    // end, never sampling anywhere in between) isolates the BISECTION's own null-midpoint check
    // as the one thing that can find this gap at all.
    const notched: RemainderRegion = {
      ...twoLobeFootprint(),
      footprint: [[[0, -5], [24.9, -5], [24.9, 5], [0, 5]], [[25.1, -5], [50, -5], [50, 5], [25.1, 5]]],
    };
    const surface = clSurface(geometry, notched, ball6, 3);
    expect(surface.dropCutter(24.85, 0)).not.toBeNull();
    expect(surface.dropCutter(25.15, 0)).not.toBeNull();
    expect(Math.hypot(25.15 - 24.85, 0)).toBeLessThan(surface.maxSpacingMm); // confirms the isolation above
    expect(() => dropRow(surface, [24.85, 0], [25.15, 0])).toThrow(/footprint notch/);
  });
});

// #960 — the organizer's finish found this: the bisection accepted a segment when its MIDPOINT
// alone sat on the chord, so a CL kink off-centre (here a 0.05 mm ridge a third of the way along)
// let the chord dip under the surface. The real part measured 0.041 mm; this stub poses it exactly.
describe('#960 dropRow() — an off-centre kink the midpoint alone cannot see', () => {
  it('never lets the chord dip under the surface between two posted points', () => {
    const ridge = (x: number): number => Math.max(0, 0.05 - Math.abs(x - 0.09));
    const surface: ClSurface = {
      dropCutter: (x) => ridge(x),
      toleranceMm: 0.005,
      minSpacingMm: 0.005,
      maxSpacingMm: 0.346,
      sampleCount: 0,
    };
    expect(ridge(0.15), 'the midpoint sits on the chord — the case the old rule accepted').toBe(0);
    const row = dropRow(surface, [0, 0], [0.3, 0]);
    let worst = 0;
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i]!;
      const b = row[i + 1]!;
      for (let k = 1; k < 50; k++) {
        const t = k / 50;
        worst = Math.min(worst, a.z + (b.z - a.z) * t - ridge(a.x + (b.x - a.x) * t));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(-surface.toleranceMm);
  });
});

// #957/#960 — D's organizer finding: the #962 alternation walks the same row from either end
// depending on its parity, and the bisection's own accept/reject decisions are sensitive enough
// to floating-point order that the two directions could disagree at the same real point (eight
// of the organizer's cells read 0.10–0.26 mm differently depending on which way their row was
// walked). `dropRow` now always computes in one canonical direction internally; this pins that
// walking the SAME row from either end gives the SAME points, only in reverse order.
describe('#957/#960 dropRow() — direction-canonical: either end first gives the same row', () => {
  it('a row across the true staircase cliff agrees walked forward or backward', () => {
    const geometry = stepMesh(25, 50, 10, 0, -10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const forward = dropRow(surface, [0, 0], [50, 0]);
    const backward = dropRow(surface, [50, 0], [0, 0]);
    expect(backward.length, 'the two directions disagree on how many points the row needs').toBe(forward.length);
    const reversedBackward = [...backward].reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(reversedBackward[i]!.x, `point ${i}, x`).toBeCloseTo(forward[i]!.x, 9);
      expect(reversedBackward[i]!.y, `point ${i}, y`).toBeCloseTo(forward[i]!.y, 9);
      expect(reversedBackward[i]!.z, `point ${i}, z`).toBeCloseTo(forward[i]!.z, 9);
    }
  });

  it('the off-centre kink case (the knife-edge accept/reject decision) also agrees both ways', () => {
    const ridge = (x: number): number => Math.max(0, 0.05 - Math.abs(x - 0.09));
    const surface: ClSurface = {
      dropCutter: (x) => ridge(x),
      toleranceMm: 0.005,
      minSpacingMm: 0.005,
      maxSpacingMm: 0.346,
      sampleCount: 0,
    };
    const forward = dropRow(surface, [0, 0], [0.3, 0]);
    const backward = dropRow(surface, [0.3, 0], [0, 0]);
    expect(backward.length, 'the two directions disagree on how many points the row needs').toBe(forward.length);
    const reversedBackward = [...backward].reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(reversedBackward[i]!.x, `point ${i}, x`).toBeCloseTo(forward[i]!.x, 9);
      expect(reversedBackward[i]!.z, `point ${i}, z`).toBeCloseTo(forward[i]!.z, 9);
    }
  });
});
