/**
 * #960 — THE ROW-DROPPER, RED-FIRST.
 *
 * `cam/model/rowDropper.ts`'s `dropRow` against two analytic meshes: a smooth RAMP (where linear
 * interpolation between dropped points must stay close to the TRUE, closed-form ball-on-ramp
 * height — not a re-query of `dropCutterHeight`, whose own dense-but-discrete per-triangle
 * sampling, already parity-tested in `clSurface957.spec.ts`, is not exact enough at this
 * precision to serve as a second ground truth here) and a STEP (where no amount of subdivision
 * can close the departure, and the staircase rule must hold instead of a diagonal).
 */

import { describe, expect, it } from 'vitest';

import { dropRow } from '../../src/engine/cnc/cam/model/rowDropper';
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

// Every row queried below runs from x=0 to x=length — this margin extends BOTH meshes well past
// that on every side (more than any cutter radius used here) so `dropCutterHeight` always has a
// full neighbourhood of real triangles at the row's own endpoints: querying right at a mesh's own
// edge changes the answer (the disc only rests on the material that is actually there), which is
// an edge effect of this FIXTURE, not of `dropRow`'s own algorithm.
const MESH_MARGIN_MM = 10;

// `dropCutterHeight`'s own per-triangle sampling is a DENSE but FINITE grid (48 divisions,
// `dropcutter.ts`'s own header) — on one giant triangle spanning this whole fixture, that grid's
// own spacing (tens of mm apart) is coarser than the 3 mm ball this file drops, so most queries
// have NO sampled point within the cutter's own reach at all and the true max is missed by a wide
// margin (checked directly: a single 70x40 mm triangle read ~0.02-0.1 mm off the analytic answer,
// advisor's own prediction). A pre-existing, documented limitation of that file, not this one's —
// sidestepped here with a FINELY tessellated mesh (1 mm cells, well under the ball's own radius),
// the same density a real STEP/mesh import already has.
function tessellatedPlane(zAt: (x: number, y: number) => number, x0: number, x1: number, y0: number, y1: number, cellMm: number): FeatureSource {
  const cols = Math.max(1, Math.round((x1 - x0) / cellMm));
  const rows = Math.max(1, Math.round((y1 - y0) / cellMm));
  const positions: number[] = [];
  const indices: number[] = [];
  const indexAt = new Map<string, number>();
  const vertex = (i: number, j: number): number => {
    const key = `${i},${j}`;
    const existing = indexAt.get(key);
    if (existing !== undefined) return existing;
    const x = x0 + (i / cols) * (x1 - x0);
    const y = y0 + (j / rows) * (y1 - y0);
    const idx = positions.length / 3;
    positions.push(x, y, zAt(x, y));
    indexAt.set(key, idx);
    return idx;
  };
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const a = vertex(i, j);
      const b = vertex(i + 1, j);
      const c = vertex(i + 1, j + 1);
      const d = vertex(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  const flat = Float32Array.from(positions);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 2; k < positions.length; k += 3) {
    minZ = Math.min(minZ, positions[k]!);
    maxZ = Math.max(maxZ, positions[k]!);
  }
  return {
    triangles: {
      positions: flat,
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
      bbox: { min: [x0, y0, minZ], max: [x1, y1, maxZ] },
    },
  };
}

/** A plane through the origin tilted about Y: z = slope * x, `half` wide in y, from x=0 to x=length. */
function rampMesh(slope: number, length: number, half: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  return tessellatedPlane((x) => slope * x, x0, x1, y0, y1, 1);
}

/**
 * Two flat plateaus at `zTop`/`zBottom`, split at `x = at` — a GENUINE discontinuity, two
 * triangles each. Fine tessellation (`tessellatedPlane`, above) is the ramp's own fix for a
 * SLOPED triangle's sampling density; a FLAT triangle has no such problem (every point on it is
 * the same height, so `dropCutterHeight`'s own sampling is exact regardless of spacing) — and
 * tessellating the step itself would turn the true vertical wall this test needs into a finite,
 * if steep, SLOPE the ball could roll down smoothly, never exercising the staircase at all.
 */
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

  // `dropCutterHeight`'s own dense-but-discrete per-triangle sampling (a 48-point barycentric
  // grid, `dropcutter.ts`'s own header) is not exact — re-querying it at arbitrary new (x, y)
  // mixes its own sampling noise into what would otherwise be a bisection-convergence check. The
  // CLOSED FORM a ball resting on a flat tilted plane must reach (the module's own documented
  // `R(secθ − 1)` rise above the plane's height at the same (x, y)) is the real ground truth here.
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
    // `dropCutterHeight`'s own sampling granularity on these (wide, margin-extended) triangles is
    // a documented, separate limitation (advisor's review) — allowed for explicitly here, not
    // folded silently into a looser claim about this function's own convergence.
    expect(worst, 'worst departure from the analytic ball-on-ramp height, mm').toBeLessThanOrEqual(surface.toleranceMm + 0.02);
  });
});

describe('#960 dropRow() — a real discontinuity (staircase, not a diagonal)', () => {
  it('holds near the shallow plateau\'s own true height until the step — never a diagonal guess toward the deep side early', () => {
    const geometry = stepMesh(25, 50, 10, 0, -10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    // `dropCutterHeight`'s own sampling granularity (see the ramp test above), not this
    // function's claim — a diagonal across the step would fall well past this well before x=25.
    const NOISE_ALLOWANCE_MM = 0.05;
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1]!;
      const b = row[i]!;
      for (let t = 0; t <= 1; t += 0.1) {
        const x = a.x + (b.x - a.x) * t;
        if (x >= 25 - NOISE_ALLOWANCE_MM) continue; // at or past the step: the deep side is correct here
        const interpolated = a.z + (b.z - a.z) * t;
        expect(interpolated, `x=${x.toFixed(2)}`).toBeGreaterThanOrEqual(0 - NOISE_ALLOWANCE_MM);
      }
    }
  });

  it('produces an actual vertical step (two points at the same XY) right at the discontinuity, not a smoothed ramp between the two levels', () => {
    const geometry = stepMesh(25, 50, 10, 0, -10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    const row = dropRow(surface, [0, 0], [50, 0]);
    const vertical = row.some((p, i) => i > 0 && p.x === row[i - 1]!.x && p.y === row[i - 1]!.y && Math.abs(p.z - row[i - 1]!.z) > 1);
    expect(vertical, `row: ${JSON.stringify(row)}`).toBe(true);
  });

  it('refuses a row whose own endpoint falls outside the surface\'s reach, rather than guessing', () => {
    const geometry = rampMesh(-0.2, 50, 10);
    const surface = clSurface(geometry, region(10, 50), ball6, 3);
    expect(() => dropRow(surface, [0, 0], [500, 0])).toThrow(/outside the surface's reach|must be within the surface's reach/);
  });
});
