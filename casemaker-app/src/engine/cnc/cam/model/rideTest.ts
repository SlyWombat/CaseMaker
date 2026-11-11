/**
 * rideTest.ts — THE RIDE TEST FOR A JOIN OVER A CUT SURFACE (#962; shared by the ops and, per the
 * manager's 2026-11-05 coordination, D's row-end leg-join for the flat ops, the rest, the skin and
 * the flat raster).
 *
 * A stay-down join may travel at the op's own cut z only where the surface the op is cutting says
 * it is clear along the path — not merely at the endpoints. The test samples the join's CENTRE
 * line against the surface's own top at each sample (the caller supplies `topAt`, which answers
 * null where the surface has no reach) and requires:
 *
 *  - KIRI:MOTO'S SHORT HOP: the join is no longer than the caller's cap (2 x the cutter's
 *    diameter for the ops' own joins). B's review of e3f25fc7 found a long ride approved purely
 *    on its centre samples; the cap lives HERE, inside the test, so every caller gets it.
 *  - the surface answers at every sample (a null is no proof; the join retracts), and
 *  - the join's interpolated z is at or above the surface's top at each sample (within the
 *    surface's own tolerance) — a path that dips below the surface would cut into the design.
 *
 * THE CALLER'S SURFACE IS THE DESIGN BOUND, NOT THE STOCK: for the finish the surface is the
 * cutter's own CL, for the skim it is the CL the skim cuts to. Material standing ABOVE the surface
 * (the band the op exists to remove) is what the join cuts at its cutting feed — the same cut the
 * passes either side of it make.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import { dropRow, type DroppedPoint } from './rowDropper';
import { isPlunge } from '../printedZ';

export interface RidePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * True when a join from `from` to `to` may stay down: within the short hop, over a surface that
 * answers all the way, never dipping below it.
 */
export function ridesCutSurface(
  from: RidePoint,
  to: RidePoint,
  topAt: (x: number, y: number) => number | null,
  toleranceMm: number,
  shortHopMm: number,
  pitchMm: number,
): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length > shortHopMm + 1e-9) return false;
  const steps = Math.max(1, Math.ceil(length / Math.max(pitchMm, 1e-9)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const top = topAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (top === null) return false;
    const z = from.z + (to.z - from.z) * t;
    if (z < top - toleranceMm) return false;
  }
  return true;
}

/**
 * #962 — THE FOLLOWING LINK: where a join's chord dips below the cut surface (concave ground),
 * sample the surface and FEED it — the cutter cuts the rise exactly as the passes either side do,
 * never below the surface. The TIME GUARD decides: the follow is taken only when its own feed
 * time (descending segments at the plunge rate) beats the retract it replaces — the retract's
 * legs priced at the caller's rapid rates (up to the clearance from both ends, across, and the
 * plunge). Returns the feed moves, or null when the path cannot be proved (a null top anywhere)
 * or the follow is not faster.
 */
export function followCutSurface(
  from: RidePoint,
  to: RidePoint,
  topAt: (x: number, y: number) => number | null,
  stepMm: number,
  clampZMm: number,
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number },
  rapid: { xyMmPerMin: number; zMmPerMin: number },
  clearanceZMm: number,
): { kind: 'feed'; x: number; y: number; z: number; f: number }[] | null {
  // #970 — THE CHORD HOLDS THE ROW DROPPER'S GUARANTEE. The old point list sampled the surface
  // every `stepMm` and connected the samples with straight chords: on a convex CL corner (a ridge
  // whose peak sits between the samples) the chord cut the corner and the ball's flank followed it
  // under the design — measured 0.486 mm on the organizer's ridge, 0.177 mm of cut-into. The
  // points are now laid by `dropRow`, the same subdivision the rows already use (midpoint/quarter
  // departure within the surface's tolerance, the kink guard, and the min-spacing staircase, which
  // holds the HIGHER height across a true discontinuity), so every chord this link emits carries
  // the same stated guarantee the rows do (features at least span/4 wide; narrower ones stated).
  // A throw from `dropRow` is its footprint-notch case: a null on the span is no proof, so the
  // caller retracts — always safe.
  const stride = stepMm > 0 ? stepMm : 0.5;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  let row: DroppedPoint[];
  try {
    row = dropRow(
      {
        dropCutter: topAt,
        toleranceMm: ARC_CHORD_TOLERANCE_MM,
        minSpacingMm: ARC_CHORD_TOLERANCE_MM,
        minSpacingSource: 'derived',
        minSpacingFromStepOverMm: 0,
        maxSpacingMm: stride,
        sampleCount: 0,
      },
      [from.x, from.y],
      [to.x, to.y],
    );
  } catch {
    return null;
  }
  if (row.length < 2) return null;
  const points: RidePoint[] = row.map((p, i) => ({
    x: p.x,
    y: p.y,
    z: i === 0 ? from.z : i === row.length - 1 ? to.z : Math.max(p.z, clampZMm),
  }));
  let followSeconds = 0;
  const moves: { kind: 'feed'; x: number; y: number; z: number; f: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const f = isPlunge(a.z, b.z) ? feeds.plungeFeedMmPerMin : feeds.feedMmPerMin;
    followSeconds += (d / f) * 60;
    moves.push({ kind: 'feed', x: b.x, y: b.y, z: b.z, f });
  }
  const retractSeconds =
    ((Math.abs(clearanceZMm - from.z) + Math.abs(clearanceZMm - to.z)) / rapid.zMmPerMin) * 60 +
    (length / rapid.xyMmPerMin) * 60 +
    (1 / feeds.plungeFeedMmPerMin) * 60;
  return followSeconds < retractSeconds ? moves : null;
}

/**
 * #1030 (the manager's 2026-11-06 ruling) — A SHORT JOIN THE RIDE TEST REFUSES IS FED ALONG THE
 * CL, NOT RETRACTED. When `ridesTheCl` refuses a short join only because the chord crosses below
 * the CL — the surface is continuous along the path and only BULGES over the chord, a crease at a
 * concave corner (0.011–0.014 mm measured on the organizer) — the join is posted as the sampled CL
 * polyline at feed: a few points over the join's own length, about zero seconds, no rapid. A path
 * whose CL CLIMBS above the straight join by more than `climbBandMm` (a wall, not a crease) or is
 * interrupted (a null anywhere) is not provable this way; the caller keeps its retract/hop, as
 * before. No time guard: a short follow is a few feed steps, so the ruling makes it the default
 * rather than pricing it against the retract. The points are laid by `dropRow` — the rows' own
 * adaptive subdivision — so a crease the CL bends around between samples cannot be cut through.
 *
 * The interior points sit ON the CL (`max(top, clampZMm)` — never below the level being cut), and
 * the last point is the join's own end, so the polyline starts and ends where the row does.
 */
export function followShortJoin(
  from: RidePoint,
  to: RidePoint,
  topAt: (x: number, y: number) => number | null,
  stepMm: number,
  clampZMm: number,
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number },
  climbBandMm: number,
): { kind: 'feed'; x: number; y: number; z: number; f: number }[] | null {
  const stride = stepMm > 0 ? stepMm : 0.05;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  // #1030 (the re-acceptance's finding) — THE CHORD HOLDS THE ROW DROPPER'S GUARANTEE, the same
  // rule #970 gave `followCutSurface`. The first form of this follow laid points every `stride`
  // along XY and joined them with straight chords; on the organizer's wall transition the CL rises
  // 0.303 mm over a 0.048 mm step, and the chord between two samples cut the corner by 0.055 mm —
  // five chords below CL − 0.005 in finishClOrganizer960. `dropRow` subdivides on the departure
  // from the straight-line interpolation (down to the surface's own min spacing, a staircase that
  // holds the HIGHER height across a true discontinuity), so every chord this join emits carries
  // the same stated guarantee the rows and the #970 follow already prove on this part.
  let row: DroppedPoint[];
  try {
    row = dropRow(
      {
        dropCutter: topAt,
        toleranceMm: ARC_CHORD_TOLERANCE_MM,
        minSpacingMm: ARC_CHORD_TOLERANCE_MM,
        minSpacingSource: 'derived',
        minSpacingFromStepOverMm: 0,
        maxSpacingMm: stride,
        sampleCount: 0,
      },
      [from.x, from.y],
      [to.x, to.y],
    );
  } catch {
    return null; // a null on the span is no proof — the caller retracts, as before
  }
  if (row.length < 2) return null;
  const points: RidePoint[] = row.map((p, i) => ({
    x: p.x,
    y: p.y,
    z: i === 0 ? from.z : i === row.length - 1 ? to.z : Math.max(p.z, clampZMm),
  }));
  // The climb band, unchanged: a CL that rises above the straight join by more than the band is a
  // WALL to retract over, not a crease to follow. Judged on the row's own sampled heights, before
  // the clamp lifts a point that sits below the level being cut.
  const inv = length > 0 ? 1 / length : 0;
  for (let i = 1; i < row.length - 1; i++) {
    const p = row[i]!;
    const t = Math.hypot(p.x - from.x, p.y - from.y) * inv;
    const chordZ = from.z + (to.z - from.z) * t;
    if (p.z > chordZ + climbBandMm) return null;
  }
  const moves: { kind: 'feed'; x: number; y: number; z: number; f: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    moves.push({ kind: 'feed', x: b.x, y: b.y, z: b.z, f: isPlunge(a.z, b.z) ? feeds.plungeFeedMmPerMin : feeds.feedMmPerMin });
  }
  return moves;
}

/**
 * #970 — THE LINEAR FOLLOW, kept for the GRID-TARGET joins (the rough's skim): the surface there
 * is a cell-quantised target (`skimTarget`'s grid lookup), not a continuous CL. Laying those
 * points with `dropRow` turned every cell edge into a min-spacing staircase — measured on the
 * organizer: +987 segments in program 1 and 12 flat-6 cells cut 0.13–0.23 mm below the goal at
 * y ≈ 99.1, because a staircase plunge at a grid point puts the flat's 3 mm disc over neighbouring
 * cells whose material stands above the target. The ball's own CL (the finish's join) is
 * continuous and carries `dropRow`'s guarantee; a grid target needs its own rule (a
 * disc-aware check at the join points), which is filed on #970 rather than guessed here.
 */
export function followLinearCutSurface(
  from: RidePoint,
  to: RidePoint,
  topAt: (x: number, y: number) => number | null,
  stepMm: number,
  clampZMm: number,
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number },
  rapid: { xyMmPerMin: number; zMmPerMin: number },
  clearanceZMm: number,
): { kind: 'feed'; x: number; y: number; z: number; f: number }[] | null {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(length / stepMm));
  const points: RidePoint[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const top = topAt(x, y);
    if (top === null) return null;
    points.push({ x, y, z: s === 0 ? from.z : s === steps ? to.z : Math.max(top, clampZMm) });
  }
  let followSeconds = 0;
  const moves: { kind: 'feed'; x: number; y: number; z: number; f: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const f = isPlunge(a.z, b.z) ? feeds.plungeFeedMmPerMin : feeds.feedMmPerMin;
    followSeconds += (d / f) * 60;
    moves.push({ kind: 'feed', x: b.x, y: b.y, z: b.z, f });
  }
  const retractSeconds =
    ((Math.abs(clearanceZMm - from.z) + Math.abs(clearanceZMm - to.z)) / rapid.zMmPerMin) * 60 +
    (length / rapid.xyMmPerMin) * 60 +
    (1 / feeds.plungeFeedMmPerMin) * 60;
  return followSeconds < retractSeconds ? moves : null;
}
