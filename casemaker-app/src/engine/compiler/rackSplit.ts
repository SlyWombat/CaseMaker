import type { Vec3 } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import type { Aabb, BuildNode, BuildOp } from './buildPlan';
import { cube, difference, translate, union } from './buildPlan';
import { minEngagement, type FastenerSize } from './fasteners';
import {
  jointClearanceHole,
  jointStarterHole,
  planSeams,
  seamAxisFacing,
  splitBySeams,
  type SplitPiece,
  type SplitSeam,
} from './splitPart';
import { DEFAULT_SPLIT_SCREW, LUG_DROP, LUG_EMBED, LUG_LAP, lugSitesFor, type LugSite } from './shellSplit';

/**
 * #266 — THE RACK'S OWN PARTS and their split joint.
 *
 * #148's joint hangs laps under a case floor because a floor has one side that
 * is always free air. A rack part has no such luxury: a plate has two faces and
 * one of them is visible in the finished rack; a 5 mm plate cannot take a screw
 * across its own thickness at all. So the archetype's half of the joint is a
 * BUTT STRAP on the part's free face:
 *
 *   • the strap is a plate on the outside of the part, spanning the seam —
 *     band {@link LUG_LAP} to each side, {@link LUG_WIDTH} across, and
 *     {@link STRAP_DEPTH} proud of the face so the screw head has material in
 *     the plane across the seam;
 *   • the screws run ALONG the seam, through the strap's band, exactly as the
 *     shell's laps carry theirs, and they are shared `fasteners.ts` parts;
 *   • the strap does not thin the part: the plate keeps its 5 mm and the joint
 *     adds material instead of relieving it. That is the issue's own reading —
 *     "The plate is thin, so the screws want the strap, not the plate."
 *
 * WHICH FACE. The caller names the free face per part (`face`), because only
 * the rack knows what is mounted where: the top plate's TOP, the bottom
 * plate's underside (the rack's outside face), a side panel's OUTER side, an
 * accessory's underside. The strap's face normal must not be the seam axis
 * (a strap protruding along the cut is not a butt joint), so a seam on the
 * face axis is refused — for a side panel (thin in X) that means cuts run up
 * its depth, which is the only axis `planSeams` can choose there anyway.
 *
 * SCREW COUNT. The shared `seamScrewCount` — the same seam-length rule the
 * body's laps use, floored at two — not a fixed pair: a 250 mm side panel is
 * as long a seam as any case and would be under-screwed by two. The sites are
 * spread along the strap's WIDTH axis, which for a side panel is its height.
 *
 * SEAM KEEP-OUTS are the caller's, in the part's own assembly frame. The rack's
 * wiring derives the SIDE PANELS' from the same facts `validateRackFit`
 * reports on — the accessory screw columns and the fan openings — so a panel
 * seam can never slice a column or a fan hole. Plate and accessory seams carry
 * none yet: their seams run mid-part and every piece keeps its own end rib
 * (where the mounting screws are), and a face plate's slot pitch is a
 * follow-up rather than a number this module can derive.
 *
 * WHAT IT COSTS (v1 — PROVISIONAL, pending a print, like every other joint
 * number here): the strap stands proud of the rack's face by {@link STRAP_DEPTH}
 * along the seam, on the outside of the finished rack. It is visible; it is
 * never inside anything.
 */


/**
 * How far the strap stands off the part's face, mm. The head seat needs ~6.1
 * of material in the plane across the seam, so 8 — the same room the shell's
 * laps are given (LUG_DROP), reused rather than re-chosen.
 */
export const STRAP_DEPTH = LUG_DROP;

/** The free face a part's strap stands on: an axis and its outward sign. */
export interface StrapFace {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}

export interface RackPartSplitRequest {
  /** The part, in its assembly orientation (the scene's coordinates). */
  partOp: BuildOp;
  /** `aabbOfOp(partOp)` — passed in rather than re-measured here. */
  bounds: Aabb;
  printer: PrinterVolume;
  /** The face the strap stands on (outward). */
  face: StrapFace;
  /** Regions a seam must not cross, in the part's assembly frame. */
  keepOut?: Aabb[];
  size?: FastenerSize;
}

export interface RackPartJointPlan {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  straps: LugSite[];
  screwCount: number;
  /** The axis the straps' widths (and screw sites) run along, per seam. */
  widthAxis: 0 | 1 | 2;
}

export interface RackPartSplit {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  nodes: BuildNode[];
  screwCount: number;
  screwLabel: string;
  label: string;
}

/**
 * The width axis for a seam given the strap's face: the axis that is neither
 * the seam nor the face (the three are always distinct; a seam on the face
 * axis is refused).
 */
function widthAxisFor(seam: SplitSeam, face: StrapFace): 0 | 1 | 2 | null {
  const used = new Set([seam.axis, face.axis]);
  if (used.size < 2) return null;
  for (const a of [0, 1, 2] as const) if (!used.has(a)) return a;
  return null;
}

/**
 * Decide the part's joint — seams and strap sites — or null when the part
 * fits, is taller than the bed, has no legal seam, or the strap has no face to
 * stand on. The plan is metadata arithmetic only; `buildRackPartSplit` is the
 * geometry.
 */
export function planRackPartSplit(req: RackPartSplitRequest): RackPartJointPlan | null {
  const seams = planSeams(req.bounds, req.printer, { keepOut: req.keepOut });
  if (!seams) return null;
  const axes = seams.map((s) => widthAxisFor(s, req.face));
  if (axes.some((a) => a === null)) return null;
  const pieces = splitBySeams(req.partOp, req.bounds, seams);

  const straps: LugSite[] = [];
  const screws = new Set<string>();
  pieces.forEach((piece, index) => {
    seams.forEach((seam, i) => {
      for (const lug of lugSitesFor(index, piece, seam, req.bounds, axes[i]!)) {
        straps.push(lug);
        screws.add(lug.screwKey);
      }
    });
  });
  if (screws.size === 0) return null;
  return {
    seams,
    pieces,
    straps,
    screwCount: screws.size,
    // A part is cut on one axis at a time in practice; the first seam's width
    // axis names the strap's direction for labels and callers.
    widthAxis: axes[0]!,
  };
}

/** The strap's extents along the face axis: embedded into the part, proud of it. */
function strapDepthRange(req: RackPartSplitRequest): [number, number] {
  const { axis, sign } = req.face;
  const faceAt = sign > 0 ? req.bounds.max[axis]! : req.bounds.min[axis]!;
  return sign > 0
    ? [faceAt - LUG_EMBED, faceAt - LUG_EMBED + STRAP_DEPTH]
    : [faceAt + LUG_EMBED - STRAP_DEPTH, faceAt + LUG_EMBED];
}

/** One strap, as a box in the part's frame, from three per-axis extents. */
function strapBox(ext: [ [number, number], [number, number], [number, number] ]): BuildOp {
  const size: Vec3 = [ext[0][1] - ext[0][0], ext[1][1] - ext[1][0], ext[2][1] - ext[2][0]];
  return translate([ext[0][0], ext[1][0], ext[2][0]], cube(size));
}

/**
 * Cut the part, add one strap per screw per piece, and drill the joint. The
 * nodes are in the part's own frame; the caller positions them as it does the
 * whole part.
 */
export function buildRackPartSplit(
  req: RackPartSplitRequest,
  plan?: RackPartJointPlan,
  idPrefix = 'rack-part',
): RackPartSplit | null {
  const size = req.size ?? DEFAULT_SPLIT_SCREW;
  if (LUG_LAP < minEngagement(size)) {
    throw new Error(
      `rack split: a ${size} screw wants ${minEngagement(size)} mm of engagement, ` +
        `and a ${LUG_LAP} mm lap gives it ${LUG_LAP}`,
    );
  }
  const joint = plan ?? planRackPartSplit(req);
  if (!joint) return null;
  const depth = strapDepthRange(req);
  const depthMid = (depth[0] + depth[1]) / 2;

  const strapsByPiece = new Map<number, LugSite[]>();
  for (const lug of joint.straps) {
    const list = strapsByPiece.get(lug.piece);
    if (list) list.push(lug);
    else strapsByPiece.set(lug.piece, [lug]);
  }

  const nodes: BuildNode[] = joint.pieces.map((piece, index) => {
    let op = piece.op;
    const holes: BuildOp[] = [];
    for (const lug of strapsByPiece.get(index) ?? []) {
      const ext: [[number, number], [number, number], [number, number]] = [
        [0, 0],
        [0, 0],
        [0, 0],
      ];
      ext[lug.axis] = lug.band;
      ext[lug.widthAxis] = lug.width;
      ext[req.face.axis] = depth;
      op = union([op, strapBox(ext)]);
      const facing = seamAxisFacing(lug.axis, true);
      const at: Vec3 = [0, 0, 0];
      at[lug.axis] = lug.mouth;
      at[lug.widthAxis] = lug.at;
      at[req.face.axis] = depthMid;
      holes.push(
        lug.low
          ? jointClearanceHole(at, facing, lug.reach, size)
          : jointStarterHole(at, facing, lug.reach, size),
      );
    }
    if (holes.length > 0) op = difference([op, ...holes]);
    return { id: rackPieceId(idPrefix, piece.cell), op };
  });

  const screwLabel = `${size}×${LUG_LAP * 2} socket cap`;
  const label =
    `${idPrefix} split for a ${req.printer.x}×${req.printer.y} mm bed — ` +
    `${nodes.length} pieces, ${joint.screwCount}× ${screwLabel} through an outside butt strap`;
  const variant = { replaces: [idPrefix], label };
  for (const n of nodes) n.variant = variant;

  return { seams: joint.seams, pieces: joint.pieces, nodes, screwCount: joint.screwCount, screwLabel, label };
}

/** Stable, legible node id for a rack piece: `rack-top-split-a1`. */
export function rackPieceId(partId: string, cell: [number, number]): string {
  return `${partId}-split-${String.fromCharCode(97 + cell[0])}${cell[1] + 1}`;
}
