import type { Mm, Vec2 } from '@/types';
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
 * exported as `HOLE_GRID_PITCH` / `HOLE_GRID_SOCKET`, and still defaults rather
 * than laws: every caller passes its own.
 *
 * HOST: the stacking toolbox's bin floor (#155) — `toolbox.ts` cuts this pocket
 * BLIND into its 4 mm floor and hangs `dividerPegs.ts` off the same constants.
 * The toolbox is also why `anchor` exists: a module family needs a centred
 * lattice where a one-off cavity wants a bbox-anchored one.
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
 * Cut it BLIND (leave a floor under it) — a tenon has nothing to seat on in a
 * through-hole and drops into whatever is below.
 */

/** The reviewed system's measured socket pitch, mm — 5.0 × 5.0 sockets on 12.0 mm centres. */
export const HOLE_GRID_PITCH: Mm = 12.0;
/** The reviewed system's measured socket side, mm — square, not round. */
export const HOLE_GRID_SOCKET: Mm = 5.0;

/**
 * Which edge the lattice hangs off.
 *
 *  - `'bbox'` — anchored at the outline's bounding box. The same cavity always
 *    yields the same sockets, so a divider printed for it keeps fitting after an
 *    unrelated parameter changes. The right choice for a ONE-OFF cavity, whose
 *    size the user is still moving around.
 *  - `'centre'` — symmetric about the outline's centre, with the count forced
 *    ODD so a socket always sits on the centre line. The right choice for a
 *    FAMILY of sizes: a centred lattice puts sockets at whole multiples of the
 *    pitch from the middle, so two modules of different sizes still share hole
 *    lines and one partition spans both. A corner-anchored lattice cannot do
 *    that — its lines move with the size.
 *
 * The two are mutually exclusive: an odd centred count has no socket at a
 * half-pitch offset, so a centred lattice is on-pitch about the middle and
 * nowhere anchored to an edge.
 */
export type HoleGridAnchor = 'bbox' | 'centre';

export interface HoleGridOptions {
  /** Centre-to-centre socket spacing, mm, in both axes. `HOLE_GRID_PITCH`. */
  pitch: number;
  /** Side length of one square socket, mm. `HOLE_GRID_SOCKET`. */
  socket: number;
  /** Solid margin left inside the outline edge, mm — measured to the socket EDGE. */
  margin: number;
  /**
   * Regions no socket may overlap — screw bosses, standoffs, an imported
   * asset's footprint. `LightenOptions.keepOut` is the same field for the
   * lightening lattice; feed `circleProfile`-per-boss the same way.
   */
  keepOut?: readonly Profile[];
  /** Where the lattice hangs off the outline. Defaults to `'bbox'`. */
  anchor?: HoleGridAnchor;
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

/** Nudge, so a lattice that fits exactly (`hi - lo` an exact multiple of `pitch`)
 *  gets its last row rather than losing it to a floating-point 11.999…. */
function spanCount(lo: number, hi: number, pitch: number): number {
  if (hi < lo) return 0;
  return Math.floor((hi - lo) / pitch + 1e-9) + 1;
}

/** The number of sockets a centred lattice fits across a half-span. Odd, so the
 *  centre line carries one; see `HoleGridAnchor`. */
function centredCount(halfSpan: number, pitch: number): number {
  if (halfSpan < 0) return 0;
  return 2 * Math.floor(halfSpan / pitch + 1e-9) + 1;
}

/**
 * Socket centres, in the outline's own XY frame.
 *
 * `'bbox'` is ANCHORED at the outline's bounding box, not centred on it;
 * `'centre'` is symmetric about the middle with an odd count. Which is right
 * depends on whether the outline is a one-off cavity or one member of a family
 * of sizes — the reasoning is on `HoleGridAnchor`.
 */
export function holeGridCentres(outline: Profile, opts: HoleGridOptions): Vec2[] {
  const { pitch, socket, margin, anchor = 'bbox' } = opts;
  const b = aabbOfProfile(outline);
  if (!b) return [];
  const inset = margin + socket / 2;
  const out: Vec2[] = [];

  if (anchor === 'centre') {
    const midX = (b.min[0] + b.max[0]) / 2;
    const midY = (b.min[1] + b.max[1]) / 2;
    const cols = centredCount((b.max[0] - b.min[0]) / 2 - inset, pitch);
    const rows = centredCount((b.max[1] - b.min[1]) / 2 - inset, pitch);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out.push([midX + (c - (cols - 1) / 2) * pitch, midY + (r - (rows - 1) / 2) * pitch]);
    return out;
  }

  const loX = b.min[0] + inset;
  const loY = b.min[1] + inset;
  const cols = spanCount(loX, b.max[0] - inset, pitch);
  const rows = spanCount(loY, b.max[1] - inset, pitch);
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
