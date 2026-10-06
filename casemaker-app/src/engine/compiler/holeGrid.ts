import type { Vec2 } from '@/types';
import {
  aabbOfProfile,
  pDifference,
  pIntersection,
  pOffset,
  pTranslate,
  pUnion,
  rectProfile,
  type Profile,
} from './profile';

/**
 * Issue #150 — the interior hole grid: the floor of a cavity carries a lattice
 * of square sockets, and drop-in dividers and accessories mount on it.
 *
 * This is construct 3 of `/Toolbox.md` ("Interface 3 of 3 — the drawer peg
 * grid"). The numbers below are the reviewed system's own, MEASURED on a
 * physical unit — 5.0 × 5.0 mm square holes on a 12.0 mm pitch in both axes —
 * and they are defaults, not laws: every caller passes its own.
 *
 * They have not been printed HERE. A fit number read off someone else's part is
 * a hypothesis about your printer, which is the whole lesson of #140 (a 0.8 ×
 * major rule predicted a 4.0 mm M5 pilot and the coupon came back at 4.8). The
 * grid PITCH and SOCKET are dimensions of the vendor's part, so copying them is
 * fair; the tenon fit is a fit, and it lives in `dividerPegs.ts` marked
 * PROVISIONAL for exactly that reason.
 *
 * Pure profile math — no Manifold, no CrossSection, no worker. The result is
 * one `Profile`, so it drops into a cut (`difference([slab, extrude(pocket,
 * depth)])`), into a keep-out list, or into a test that never touches wasm.
 */

export interface HoleGridOptions {
  /** Centre-to-centre socket spacing, mm, in both axes. ToolStack: 12.0. */
  pitch: number;
  /** Side length of one square socket, mm. ToolStack: 5.0. */
  socket: number;
  /** Solid margin left inside the outline edge, mm. */
  margin: number;
  /**
   * Regions no socket may overlap — screw bosses, standoffs, an imported
   * asset's footprint. `LightenOptions.keepOut` is the same field for the
   * lightening lattice; feed `circleProfile`-per-boss the same way.
   */
  keepOut?: readonly Profile[];
}

/** Why these numbers cannot form a grid, or null when they can. */
export function holeGridProblem(opts: HoleGridOptions): string | null {
  const { pitch, socket, margin } = opts;
  if (!(pitch > 0)) return 'Pitch must be greater than zero';
  if (!(socket > 0)) return 'Socket size must be greater than zero';
  if (margin < 0) return 'Margin cannot be negative';
  if (pitch < socket) {
    return `Pitch ${pitch} mm is smaller than the ${socket} mm socket — the holes would merge into slots`;
  }
  return null;
}

function spanCount(lo: number, hi: number, pitch: number): number {
  if (hi < lo) return 0;
  // Nudge, so a lattice that fits exactly (hi - lo an exact multiple of pitch)
  // gets its last row rather than losing it to a floating-point 11.999….
  return Math.floor((hi - lo) / pitch + 1e-9) + 1;
}

/**
 * Socket centres, in the outline's own XY frame.
 *
 * The lattice is ANCHORED at the outline's bounding box, not centred on it.
 * Bbox-anchoring is the deterministic choice: the same cavity always yields the
 * same sockets, so a divider printed for it keeps fitting after an unrelated
 * parameter changes. A centred lattice shifts by half a pitch whenever the
 * cavity grows an odd number of millimetres.
 */
export function holeGridCentres(outline: Profile, opts: HoleGridOptions): Vec2[] {
  const { pitch, socket, margin } = opts;
  const b = aabbOfProfile(outline);
  if (!b) return [];
  const loX = b.min[0] + margin + socket / 2;
  const loY = b.min[1] + margin + socket / 2;
  const hiX = b.max[0] - margin - socket / 2;
  const hiY = b.max[1] - margin - socket / 2;
  const cols = spanCount(loX, hiX, pitch);
  const rows = spanCount(loY, hiY, pitch);
  const out: Vec2[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) out.push([loX + c * pitch, loY + r * pitch]);
  return out;
}

/**
 * The POCKET that makes the grid: every socket as one profile, clipped to
 * `pOffset(outline, -margin)` and minus the keep-outs.
 *
 * Cut it with `difference([slab, extrude(pocket, depth)])` for a blind grid, or
 * omit the slab's floor for a through grid. The clip is a no-op for a
 * rectangular outline and trims the outer sockets on a rounded one, so a
 * rounded-corner cavity gets sockets whose corners follow the wall instead of
 * four sockets hanging over a radius.
 *
 * Returns an empty region (an empty union) when the outline is too small for
 * even one socket, or when a keep-out swallows the field.
 */
export function holeGridPocket(outline: Profile, opts: HoleGridOptions): Profile {
  const { margin, socket, keepOut = [] } = opts;
  const centres = holeGridCentres(outline, opts);
  if (centres.length === 0) return pUnion([]);
  const sockets = pUnion(
    centres.map((c) => pTranslate(c, rectProfile(socket, socket, true))),
  );
  const field = pOffset(outline, -margin, 'miter');
  return pDifference([pIntersection([sockets, field]), ...keepOut]);
}
