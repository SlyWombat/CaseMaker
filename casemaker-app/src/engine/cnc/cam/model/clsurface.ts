/**
 * cam/model/clsurface.ts — the cutter-location surface by drop-cutter (#957, B), §2 of
 * `docs/design/cam-model-engine.md`.
 *
 * Re-implemented from OpenCamLib's published description (`BatchDropCutter`/`PathDropCutter`,
 * LGPL-2.1, algorithm reference only — no OCL source read or copied) and PyCAM's
 * (`PathGenerators/DropCutter.py`, GPL-3.0, reference only) for flat/ball/bull; the V cutter is
 * OpenCamLib's description alone. Adaptive sampling per §2: subdivide on departure from the
 * straight-line interpolation past `ARC_CHORD_TOLERANCE_MM`, down to `minSpacingMm`; a stated
 * `maxSpacingMm` per cutter from its own sagitta (ball/bull/flat) or flank sensitivity (V); a
 * staircase, not a diagonal, when a true discontinuity is found at `minSpacingMm` (the lesson from
 * Session C's #945 finding and Review B's F1 — the old engine's defect was always a straight-line
 * approximation graded against a rule that didn't agree with how it was built).
 *
 * The real drop-cutter geometry is `dropcutter.ts`'s `dropCutterHeight`/`profileOf` — built, and
 * checked red-first against F's parity fixtures (`tests/unit/clSurface957.spec.ts`, 33 passing
 * cases, both OpenCamLib and PyCAM columns). `clSurface()` below stays a throwing stub: it needs a
 * `DropCutterMesh` view of `RemainderRegion.triangles`' backing mesh, which `RemainderRegion` does
 * not itself carry (it only has `Uint32Array` triangle indices, not the vertex positions they index
 * into) — that wiring is #959's integration (the caller holds `ModelPlanInput.geometry`, the mesh
 * these indices resolve against). `reach()` needs no mesh and is implemented now.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import type { Tool } from '@/engine/cnc/tool';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import type { FeatureSource, RemainderRegion } from './features';
import { dropCutterHeight, profileOf, type DropCutterMesh } from './dropcutter';

export interface ClSurface {
  /** The CL height at (x, y), or `null` where the cutter cannot reach (outside the region, or past `reach`'s limit). */
  dropCutter(x: number, y: number): number | null;
  /**
   * #1033 (lever b) — THE SAME CL, IGNORING THE FOOTPRINT CLIP. Outside the region's footprint the
   * physical surface still exists: the ball riding an island's top or a pocket mouth sits at its
   * own CL there, and a join may ride across it ONLY when its chord stays at or above that height.
   * The rows keep the clipped query; this one is the join's proof against the neighbouring surface.
   * `null` where no triangle lies within the cutter's reach (off the part entirely). Optional so a
   * caller's own `ClSurface` literal (the op specs' fakes) keeps compiling; absent reads as "no
   * unclipped proof", which is exactly the pre-#1033 refusal.
   */
  dropCutterUnclipped?(x: number, y: number): number | null;
  toleranceMm: number;
  minSpacingMm: number;
  maxSpacingMm: number;
  /** How many drop-cutter evaluations this surface took to build — a report number, not a budget (§6: no caps on geometry, a stall guard only). */
  sampleCount: number;
}

export interface ReachResult {
  reachable: boolean;
  /** Stated when `reachable` is false — e.g. a V cutter's flank angle is shallower than the region's own slope. */
  note?: string;
}

/**
 * The manager's ruling on B's question (6621141190): `geometry` is `ModelPlanInput.geometry` (the
 * FeatureSource #958's `FeatureTree` is built from) — the ONE mesh `RemainderRegion.triangles`
 * indexes into, which `RemainderRegion` never carried on its own. `clSurface()` is a LAZY point
 * query, not a pre-built adaptive grid: §2's own adaptive sampling (subdivide on departure from a
 * straight-line interpolation, down to `minSpacingMm`, a staircase not a diagonal past a true
 * discontinuity) is a PATH concern — the `finish()`/`rough()` row-dropper's job, walking along a
 * raster row — not this interface's; `dropCutter` answers one (x, y) at a time, against every
 * triangle of the WHOLE mesh (never just `region.triangles`) so a cutter overhanging the region's
 * own edge still sees the wall/land beside it, not air past the region's own footprint boundary.
 */
/**
 * Exactly on the footprint's own boundary. `pointInPolygons` answers "outside" for a point lying
 * ON a vertical edge (ray casting's own convention, `pocket.ts`), while the raster's interval
 * tracer counts that same column as inside — the disagreement surfaced as `dropRow`'s "footprint
 * notch" on the organizer's grown finish region, whose offset lands vertical edges on exactly the
 * raster's round x values. A point on the boundary is the region's own edge, so it is reachable.
 * Guarded by the footprint's bbox, so a genuinely outside point costs one rectangle test.
 */
function onBoundary(footprint: readonly (readonly [number, number][])[], x: number, y: number, eps = 1e-9): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of footprint) {
    for (const [px, py] of ring) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (x < minX - eps || x > maxX + eps || y < minY - eps || y > maxY + eps) return false;
  for (const ring of footprint) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j]!;
      const [x2, y2] = ring[i]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
      if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= eps) return true;
    }
  }
  return false;
}

export function clSurface(geometry: FeatureSource, region: RemainderRegion, cutter: Tool, _stepOverMm: number): ClSurface {
  const profile = profileOf(cutter);
  if (profile === null) {
    throw new Error(`cam/model/clsurface: ${cutter.name || cutter.shape} has no drop-cutter profile for a CL surface`);
  }
  const mesh: DropCutterMesh = geometry.triangles;
  const toleranceMm = ARC_CHORD_TOLERANCE_MM;
  // The sagitta bound (the same closed form `finishStepOverForCusp`, surface3d.ts, derives for the
  // scallop band — here for the GEOMETRIC sampling tolerance instead): the largest spacing that
  // keeps a straight-line interpolation within `toleranceMm` of the cutter's own curved profile. A
  // flat/cone has no such curvature within its own flat/tip radius, so its own radius is the
  // stated bound instead — this is the cutter's OWN worst case, not a claim that sampling this
  // coarsely always finds a real surface discontinuity (the row-dropper's own job).
  const maxSpacingMm =
    profile.kind === 'arc' && profile.curveRadiusMm !== undefined && profile.curveRadiusMm > toleranceMm
      ? 2 * Math.sqrt(2 * profile.curveRadiusMm * toleranceMm - toleranceMm * toleranceMm)
      : profile.radiusMm;
  let sampleCount = 0;
  return {
    dropCutter(x, y) {
      if (!pointInPolygons(region.footprint, x, y) && !onBoundary(region.footprint, x, y)) return null;
      sampleCount++;
      return dropCutterHeight(profile, mesh, x, y);
    },
    // #1033 — the footprint clip is the ROWS' own reach rule; the join's ride proof asks the same
    // mesh without it, so the neighbouring surface (an island's top, a pocket mouth) can prove a
    // chord at or above it. Same profile, same bins, same value inside the footprint.
    dropCutterUnclipped(x, y) {
      sampleCount++;
      return dropCutterHeight(profile, mesh, x, y);
    },
    toleranceMm,
    minSpacingMm: toleranceMm,
    maxSpacingMm,
    get sampleCount() {
      return sampleCount;
    },
  };
}

/**
 * #965 (the review session's step 2; the manager's 2026-11-05 ruling) — THE CREASE ADMISSION, the
 * groove's own rule, BESIDE `reach()` and never replacing it: `reach()` is the FACE rule (a V's
 * apex touches only a slope shallower than its flank — a V cutting a surface); a V riding a
 * CREASE is the opposite case, admitted where BOTH walls are steeper than 90° − the half-angle
 * (the flanks clear the walls) and the groove's width at the leftover depth — `d/tanθL + d/tanθR`
 * — is within the V's width there (`2·(tipRadius + d·tanθ)`), so the flanks stay out of the walls.
 */
export function creaseFits(
  cutter: Tool,
  crease: { leftSlopeDeg: number; rightSlopeDeg: number; depthMm: number },
): ReachResult {
  const profile = profileOf(cutter);
  if (profile === null || profile.kind !== 'cone' || profile.tanHalfAngle === undefined) {
    return { reachable: false, note: `${cutter.name || cutter.shape}: not a V — the crease rule is the V's own` };
  }
  const flankDeg = 90 - (Math.atan(profile.tanHalfAngle) * 180) / Math.PI;
  const shallower = Math.min(crease.leftSlopeDeg, crease.rightSlopeDeg);
  if (shallower < flankDeg) {
    return { reachable: false, note: `a wall (${shallower.toFixed(1)}° from horizontal) is shallower than the V's flank (${flankDeg.toFixed(1)}°)` };
  }
  const d = Math.max(0, crease.depthMm);
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const grooveWidth = d / Math.tan(rad(crease.leftSlopeDeg)) + d / Math.tan(rad(crease.rightSlopeDeg));
  const vWidth = 2 * (profile.flatRadiusMm + d * profile.tanHalfAngle);
  if (grooveWidth > vWidth + 1e-9) {
    return { reachable: false, note: `the groove is ${grooveWidth.toFixed(2)} mm wide at ${d.toFixed(2)} mm depth, wider than the V (${vWidth.toFixed(2)} mm) there` };
  }
  return { reachable: true };
}

/**
 * A V/chamfer cutter's apex can only touch a slope shallower than its own flank angle from
 * horizontal (`90° − half-angle`) without the flank interfering — §2's derivation, carried into the
 * `dropcutter.ts` profile as `flatRadiusMm`/`tanHalfAngle`. Flat/ball/bull have no such limit within
 * this engine's scope (a slope steep enough to be a real overhang is an undercut, A's #958
 * `unreachable` list, not a `RemainderRegion`'s own `slopeDeg`).
 */
export function reach(cutter: Tool, feature: RemainderRegion): ReachResult {
  const profile = profileOf(cutter);
  if (profile === null) return { reachable: false, note: `${cutter.shape} has no drop-cutter profile for a CL surface` };
  if (profile.kind !== 'cone') return { reachable: true };
  const halfAngleDeg = profile.tanHalfAngle === undefined ? 90 : Math.atan(profile.tanHalfAngle) * (180 / Math.PI);
  const flankFromHorizontalDeg = 90 - halfAngleDeg;
  const steepest = feature.slopeDeg[1];
  if (steepest > flankFromHorizontalDeg) {
    return {
      reachable: false,
      note: `${cutter.name || cutter.shape}'s flank (${flankFromHorizontalDeg.toFixed(1)}° from horizontal) is shallower than this region's steepest slope (${steepest.toFixed(1)}°)`,
    };
  }
  return { reachable: true };
}
