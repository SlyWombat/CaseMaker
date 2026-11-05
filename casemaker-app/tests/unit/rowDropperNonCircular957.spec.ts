/**
 * #957 — THE NON-CIRCULAR SPEC (the manager's ruling of 2026-11-05, comment 6654312290): the CL
 * comes from `dropCutterHeight` on REAL MESH FEATURES — a sharp vertex spike, a thin rib, a knife
 * edge and E's stepped ramp (#948) — and every chord `dropRow` emits is checked on a dense,
 * INDEPENDENT t-grid of 64 interior samples, never the planner's own 0.25 / 0.5 / 0.75.
 *
 * The claim under test is the rower's: a chord between two accepted drops departs from the TRUE
 * CL by no more than `surface.toleranceMm` (0.005 mm — ARC_CHORD_TOLERANCE_MM), and for a BALL
 * the sag is bounded by the ruling's own s²/(8R) — the CL's every upward feature is a contact
 * locus offset by R, so a local bump has curvature radius ≥ R and a chord of span s can dip at
 * most s²/(8R) below it. The rower's own max spacing IS that condition's ceiling:
 * √(8·R·tol) = 0.346 mm for the ⌀6 ball.
 *
 * If a case fails here it is a finding against the rower's bound, not a test to loosen (the
 * manager's words on this item).
 */
import { describe, expect, it } from 'vitest';

import { dropRow, type DroppedPoint } from '../../src/engine/cnc/cam/model/rowDropper';
import { clSurface, type ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const DENSE_SAMPLES = 64; // interior samples per chord; the planner's own fractions are 0.25/0.5/0.75
const BALL_RADIUS_MM = 3;

type Tri = [number, number, number][];

/** A triangle-soup FeatureSource straight from a list of triangles (real mesh geometry, nothing analytic). */
function meshOf(triangles: Tri[]): FeatureSource {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const tri of triangles) {
    const base = positions.length / 3;
    for (const [x, y, z] of tri) positions.push(x, y, z);
    indices.push(base, base + 1, base + 2);
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return {
    triangles: {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      triangleCount: triangles.length,
      bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    },
  };
}

function quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): Tri[] {
  return [[a, b, c], [a, c, d]];
}

/** A 12 × 12 plate at z = 0 — the ground every feature stands on. */
function plate(): Tri[] {
  return quad([-6, -6, 0], [6, -6, 0], [6, 6, 0], [-6, 6, 0]);
}

/** A sharp VERTEX spike: a square-based pyramid, base 3 × 3 centred at the origin, apex 2.5 mm up. */
function spikeMesh(): FeatureSource {
  const apex: [number, number, number] = [0, 0, 2.5];
  const corners: [number, number, number][] = [[-1.5, -1.5, 0], [1.5, -1.5, 0], [1.5, 1.5, 0], [-1.5, 1.5, 0]];
  const faces: Tri[] = [];
  for (let i = 0; i < 4; i++) faces.push([corners[i]!, corners[(i + 1) % 4]!, apex]);
  return meshOf([...plate(), ...faces]);
}

/** A thin RIB: a box 0.4 mm wide (x), 6 mm long (y), 2 mm tall — its top is the feature under test. */
function ribMesh(): FeatureSource {
  const x0 = -0.2, x1 = 0.2, y0 = -3, y1 = 3, h = 2;
  return meshOf([
    ...plate(),
    ...quad([x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]), // top
    ...quad([x0, y0, 0], [x0, y1, 0], [x0, y1, h], [x0, y0, h]), // -x side
    ...quad([x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h]), // +x side
    ...quad([x0, y0, 0], [x1, y0, 0], [x1, y0, h], [x0, y0, h]), // -y end
    ...quad([x0, y1, 0], [x1, y1, 0], [x1, y1, h], [x0, y1, h]), // +y end
  ]);
}

/** A KNIFE EDGE: a triangular wall 0.8 mm wide at its base, tapering to a zero-width line 2 mm up. */
function knifeMesh(): FeatureSource {
  const y0 = -3, y1 = 3, h = 2, base = 0.4;
  return meshOf([
    ...plate(),
    ...quad([-base, y0, 0], [0, y0, h], [0, y1, h], [-base, y1, 0]),
    ...quad([0, y0, h], [base, y0, 0], [base, y1, 0], [0, y1, h]),
    [[-base, y0, 0], [base, y0, 0], [0, y0, h]],
    [[-base, y1, 0], [base, y1, 0], [0, y1, h]],
  ]);
}

/** E's stepped ramp (#948): four risers of 1.5 mm at 3 mm runs, rising to the right from the plate. */
function steppedRampMesh(): FeatureSource {
  const tris: Tri[] = [...plate()];
  const rise = 1.5, run = 3;
  for (let i = 0; i < 4; i++) {
    const x0 = -6 + i * run;
    const x1 = x0 + run;
    const z0 = i * rise;
    const z1 = (i + 1) * rise;
    tris.push(...quad([x0, -3, z1], [x1, -3, z1], [x1, 3, z1], [x0, 3, z1])); // tread
    tris.push(...quad([x0, -3, z0], [x0, 3, z0], [x0, 3, z1], [x0, -3, z1])); // riser
  }
  return meshOf(tris);
}

function footprintRegion(x0: number, x1: number, y0: number, y1: number): RemainderRegion {
  return {
    id: 'feature',
    footprint: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]],
    area: (x1 - x0) * (y1 - y0),
    zTop: 0,
    zBottom: -100,
    triangles: new Uint32Array(),
    slopeDeg: [0, 90],
    slopeMedianDeg: 45,
    in: 'top',
  };
}

function tool(shape: 'flat' | 'ball' | 'v90'): Tool {
  if (shape === 'v90') {
    return {
      number: 3, id: 'v90-6', name: 'v90-6', typeText: 'v90', shape: 'chamfer',
      handleDiameter: null, tipDiameter: 0, diameter: 6, cornerRadius: null, angle: 90,
      halfAngle: null, fluteLength: null, shoulderLength: null, stickout: null, centreCutting: null,
    };
  }
  const base = flatEndMill(6, { number: shape === 'ball' ? 2 : 1, id: `${shape}-6`, name: `${shape}-6` });
  return shape === 'ball' ? { ...base, shape: 'ball' } : base;
}

interface ChordResult {
  chord: [DroppedPoint, DroppedPoint];
  spanMm: number;
  worstDipMm: number;
  atT: number;
}

/**
 * The manager's own check: every chord sampled on a t-grid INDEPENDENT of the planner's
 * 0.25 / 0.5 / 0.75 — `DENSE_SAMPLES` interior points plus both ends. `dip` is max(0, CL −
 * chord): the chord lying BELOW the true CL is a gouge; the chord lying above it is air.
 */
function denseCheck(surface: ClSurface, row: readonly DroppedPoint[]): ChordResult[] {
  const out: ChordResult[] = [];
  for (let i = 1; i < row.length; i++) {
    const a = row[i - 1]!;
    const b = row[i]!;
    const spanMm = Math.hypot(b.x - a.x, b.y - a.y);
    if (spanMm <= 1e-9) continue; // the staircase's own vertical step: no span to sample
    let worstDipMm = 0;
    let atT = 0;
    for (let s = 0; s <= DENSE_SAMPLES; s++) {
      const t = s / DENSE_SAMPLES;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const zTrue = surface.dropCutter(x, y);
      if (zTrue === null) throw new Error(`the dense sample at (${x}, ${y}) fell outside the surface`);
      const chordZ = a.z + (b.z - a.z) * t;
      const dip = zTrue - chordZ;
      if (dip > worstDipMm) { worstDipMm = dip; atT = t; }
    }
    out.push({ chord: [a, b], spanMm, worstDipMm, atT });
  }
  return out;
}

interface Feature {
  id: string;
  mesh: () => FeatureSource;
  /** The row's own ends (y fixed): it must cross the feature and stay inside the plate. */
  row: { from: [number, number]; to: [number, number] };
}

const FEATURES: Feature[] = [
  { id: 'sharp vertex spike', mesh: spikeMesh, row: { from: [-5.3, 0.37], to: [5.11, 0.37] } },
  { id: 'thin rib (0.4 mm)', mesh: ribMesh, row: { from: [-5.3, 0.41], to: [5.11, 0.41] } },
  { id: 'knife edge (0.8 mm base)', mesh: knifeMesh, row: { from: [-5.3, 0.43], to: [5.11, 0.43] } },
  { id: 'E’s stepped ramp', mesh: steppedRampMesh, row: { from: [-5.3, 0.47], to: [5.11, 0.47] } },
];

describe('#957 the non-circular spec — real mesh features, dense independent chords', () => {
  for (const feature of FEATURES) {
    for (const shape of ['ball', 'flat', 'v90'] as const) {
      it(`${feature.id}, ${shape}: every chord stays within tolerance on ${DENSE_SAMPLES + 1} dense samples`, () => {
        const geometry = feature.mesh();
        const surface = clSurface(geometry, footprintRegion(-5.5, 5.5, -1.5, 1.5), tool(shape), 0.1);
        const row = dropRow(surface, feature.row.from, feature.row.to);
        expect(row.length).toBeGreaterThan(1);
        const chords = denseCheck(surface, row);
        expect(chords.length).toBeGreaterThan(0);
        const worst = chords.reduce((m, c) => (c.worstDipMm > m.worstDipMm ? c : m), chords[0]!);
        expect(
          worst.worstDipMm,
          `${feature.id} ${shape}: worst chord dip ${worst.worstDipMm.toFixed(6)} mm over ${worst.spanMm.toFixed(4)} mm ` +
            `at (${worst.chord[0].x.toFixed(3)}, ${worst.chord[0].y.toFixed(3)})→(${worst.chord[1].x.toFixed(3)}, ${worst.chord[1].y.toFixed(3)}), t=${worst.atT.toFixed(3)}`,
        ).toBeLessThanOrEqual(surface.toleranceMm + 1e-9);

        if (shape === 'ball') {
          // THE RULING'S OWN BOUND: s²/(8R) for every chord (the CL's bumps have curvature radius ≥ R).
          for (const c of chords) {
            const bound = (c.spanMm * c.spanMm) / (8 * BALL_RADIUS_MM);
            expect(
              c.worstDipMm,
              `${feature.id} ball: chord ${c.spanMm.toFixed(4)} mm dips ${c.worstDipMm.toFixed(6)} mm, bound ${bound.toFixed(6)} mm ` +
                `at (${c.chord[0].x.toFixed(3)}, ${c.chord[0].y.toFixed(3)})→(${c.chord[1].x.toFixed(3)}, ${c.chord[1].y.toFixed(3)}), t=${c.atT.toFixed(3)}`,
            ).toBeLessThanOrEqual(bound + 1e-9);
          }
          // And the rower's max spacing never exceeds the condition's own ceiling.
          expect(surface.maxSpacingMm).toBeLessThanOrEqual(Math.sqrt(8 * BALL_RADIUS_MM * surface.toleranceMm) + 1e-9);
        }
      });
    }
  }
});
