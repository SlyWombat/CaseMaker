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
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
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
    // The staircase's own transition zone right at the true cliff (x = 28) is a HELD point
    // (travel laterally at the shallow height) followed by a zero-length-in-XY drop — by design
    // NOT a smooth approximation of the analytic curve in that razor-thin sliver (the "produces
    // an actual vertical step" test below is what validates THAT shape is right). A tolerance
    // band around x = 28 excludes only that known, deliberate construction, not the real
    // curvature either side of it.
    const CLIFF_ZONE_MM = 0.01;
    let worst = 0;
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1]!;
      const b = row[i]!;
      for (let t = 0; t <= 1; t += 0.05) {
        const x = a.x + (b.x - a.x) * t;
        if (Math.abs(x - (25 + R)) <= CLIFF_ZONE_MM) continue;
        const interpolated = a.z + (b.z - a.z) * t;
        worst = Math.max(worst, Math.abs(interpolated - analyticStepCL(25, 0, -10, x)));
      }
    }
    expect(worst, 'worst departure from the true analytic step CL, mm').toBeLessThanOrEqual(surface.toleranceMm);
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
