import type { Vec3 } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import type { Aabb, BuildNode, BuildOp } from './buildPlan';
import { cube, difference, translate, union } from './buildPlan';
import { minEngagement, type FastenerSize } from './fasteners';
import { lidCavityHeight } from './lidMode';
import {
  jointClearanceHole,
  jointStarterHole,
  planSeams,
  seamAxisFacing,
  splitBySeams,
  type SplitPiece,
  type SplitSeam,
} from './splitPart';
import {
  DEFAULT_SPLIT_SCREW,
  LUG_DROP,
  LUG_EMBED,
  LUG_LAP,
  lugSitesFor,
  type LugSite,
} from './shellSplit';
import type { CaseParameters } from '@/types';

/**
 * #265 — THE LID'S HALF OF THE SPLIT: where a split lid's joint material goes.
 *
 * `splitPart.ts` cuts the lid and drills the shared fastener holes; this module
 * supplies the laps, because only the lid archetype knows which side of its own
 * body is free. It is the sibling of `shellSplit.ts`, and it uses the SAME lug
 * arithmetic (`lugSitesFor`) — a lap's band across the seam, its width along
 * it, and the screw sites are joint facts, not shell facts.
 *
 * WHERE THE LID'S LAPS GO — the decision #265 asks for, taken from the lid's
 * own mode (`lidMode.ts`, never from `lidRecess` alone):
 *
 *  • A lid WITH an internal cavity at least {@link LUG_DROP} deep — the
 *    clamshell family, or any lid given a `lidCavityHeight`. Its cavity is the
 *    lid's own free side: the walls and the ceiling enclose it, and nothing the
 *    board, a HAT or a port does can reach inside it. So the lugs hang DOWN
 *    from the ceiling, exactly as the shell's hang under its floor, and the
 *    joint is invisible from the outside.
 *
 *  • A PLATE lid — no cavity (flat-lid, screw-down, a thin snap lid) or one
 *    too shallow to bury the screw. Its underside faces the board and, when it
 *    is recessed, its four sides sit inside the shell's pocket, so neither can
 *    carry material. Its TOP face is the one side that is open air along the
 *    whole seam: the laps are pads standing proud of it, at the lid's rim.
 *    They are visible; they are never inside anything.
 *
 * A SEALED lid is refused, as a sealed shell is: the seam cuts the gasket
 * tongue and channel and gives away the seal the lid was built for.
 *
 * WHAT IT COSTS (v1 — PROVISIONAL, like the shell's numbers, pending a print):
 *  • Cavity lids: the joint is hidden, but the cavity must be at least
 *    {@link LUG_DROP} deep, and the lugs take room inside it near the seam.
 *  • Plate lids: the pads are proud of the top face by {@link LUG_DROP}, and
 *    because the lid prints ceiling-down the pads become the feet it stands on
 *    — the slicer supports the lid's face around them.
 *  • Both: a seam still cuts through whatever crosses it (vents, labels, the
 *    perimeter flange); the keep-outs only protect the LOCALISED features —
 *    hinges, latches, snap arms, lid bosses — for the same reason `#148`'s
 *    keep-outs do not include the brim or the ribs.
 */

/** Which free side a lid's split laps take (#265's decision). */
export type LidJointSide = 'cavity' | 'top';

/**
 * The side the lid's laps take, from the lid's own mode. A cavity deep enough
 * to bury the screw is the lid's free interior; anything else is a plate, and
 * a plate's top face is the only side open air can reach along the seam.
 */
export function lidJointSide(params: CaseParameters): LidJointSide {
  return lidCavityHeight(params) >= LUG_DROP ? 'cavity' : 'top';
}

export interface LidSplitRequest {
  /** The finished lid, in LID-LOCAL coordinates (its open underside at z = 0). */
  lidOp: BuildOp;
  /** `aabbOfOp(lidOp)` — passed in rather than re-measured here. */
  bounds: Aabb;
  printer: PrinterVolume;
  /** The side the laps take ({@link lidJointSide}). */
  side: LidJointSide;
  /**
   * The lid's internal cavity height, mm (`lidCavityHeight`). The laps' Z band
   * is measured from it, NOT from the op's bounding box: a bezel or a knuckle
   * can stand above the lid's own ceiling, and a lug placed from the bbox
   * would then hang from the wrong plane.
   */
  cavityHeightMm: number;
  /** Regions a seam must not cross: hinge knuckles, latches, snap arms, bosses. */
  keepOut?: Aabb[];
  size?: FastenerSize;
}

export interface LidJointPlan {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  lugs: LugSite[];
  /** Screws the joint takes, counted once per site (both halves share it). */
  screwCount: number;
  side: LidJointSide;
}

export interface LidSplit {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  nodes: BuildNode[];
  screwCount: number;
  screwLabel: string;
  label: string;
}

/** Whether a lid should even be offered a split (the sealed rule, as the shell's). */
export function canSplitLid(sealed: boolean): boolean {
  return !sealed;
}

/**
 * Decide the lid's joint — seams, pieces, lap sites — or null when there is
 * nothing honest to offer: the lid fits, is taller than the bed, no legal seam
 * clears its features, or the chosen side cannot fit the screw.
 */
export function planLidJoint(req: LidSplitRequest): LidJointPlan | null {
  if (!sideCanCarryTheScrew(req)) return null;
  const seams = planSeams(req.bounds, req.printer, { keepOut: req.keepOut });
  if (!seams) return null;
  const pieces = splitBySeams(req.lidOp, req.bounds, seams);

  const lugs: LugSite[] = [];
  const screws = new Set<string>();
  pieces.forEach((piece, index) => {
    for (const seam of seams) {
      for (const lug of lugSitesFor(index, piece, seam, req.bounds)) {
        lugs.push(lug);
        screws.add(lug.screwKey);
      }
    }
  });
  if (screws.size === 0) return null;
  return { seams, pieces, lugs, screwCount: screws.size, side: req.side };
}

/** Where a lap's Z band sits: below the cavity's ceiling, or above the top face. */
function lugBandZ(req: LidSplitRequest): { zLo: number; zHi: number } | null {
  if (req.side === 'cavity') {
    // The lid is built LID-LOCAL with its open underside at z = 0, so the
    // cavity's ceiling underside IS `cavityHeightMm` — not a bbox reading,
    // which a bezel or knuckle could lift.
    const zHi = req.cavityHeightMm + LUG_EMBED;
    const zLo = zHi - LUG_DROP;
    // The lug must hang clear of the lid's open underside (its own floor line).
    if (zLo < 0.5) return null;
    return { zLo, zHi };
  }
  // A pad standing proud of the lid's top face, fused into it by the embed.
  const zLo = req.bounds.max[2] - LUG_EMBED;
  return { zLo, zHi: zLo + LUG_DROP };
}

/** Can the chosen side really bury the screw? The cavity must be deep enough. */
function sideCanCarryTheScrew(req: LidSplitRequest): boolean {
  return lugBandZ(req) !== null;
}

/**
 * The geometry half: cut the lid, add one lap per screw per piece, and drill
 * the joint. Nodes are in LID-LOCAL coordinates; the caller lifts them to the
 * lid's assembled Z exactly as it lifts the whole lid.
 */
export function buildLidSplit(req: LidSplitRequest, plan?: LidJointPlan): LidSplit | null {
  const size = req.size ?? DEFAULT_SPLIT_SCREW;
  if (LUG_LAP < minEngagement(size)) {
    throw new Error(
      `lid split: a ${size} screw wants ${minEngagement(size)} mm of engagement, ` +
        `and a ${LUG_LAP} mm lap gives it ${LUG_LAP}`,
    );
  }
  const joint = plan ?? planLidJoint(req);
  if (!joint) return null;
  const band = lugBandZ(req);
  if (band === null) return null;
  const { zLo, zHi } = band;
  const zAxis = (zLo + zHi) / 2;

  const lugsByPiece = new Map<number, LugSite[]>();
  for (const lug of joint.lugs) {
    const list = lugsByPiece.get(lug.piece);
    if (list) list.push(lug);
    else lugsByPiece.set(lug.piece, [lug]);
  }

  const nodes: BuildNode[] = joint.pieces.map((piece, index) => {
    let op = piece.op;
    const holes: BuildOp[] = [];
    for (const lug of lugsByPiece.get(index) ?? []) {
      op = union([
        op,
        lugBox(lug.axis, lug.band[0], lug.band[1], lug.width[0], lug.width[1], zLo, zHi),
      ]);
      const facing = seamAxisFacing(lug.axis, true);
      const at: Vec3 = lug.axis === 0 ? [lug.mouth, lug.at, zAxis] : [lug.at, lug.mouth, zAxis];
      holes.push(
        lug.low
          ? jointClearanceHole(at, facing, lug.reach, size)
          : jointStarterHole(at, facing, lug.reach, size),
      );
    }
    if (holes.length > 0) op = difference([op, ...holes]);
    return { id: lidPieceId(piece.cell), op };
  });

  const screwLabel = `${size}×${LUG_LAP * 2} socket cap`;
  const sideWords = joint.side === 'cavity' ? 'lugs inside the lid’s cavity' : 'pads proud of the lid’s top face';
  const label =
    `Lid split for a ${req.printer.x}×${req.printer.y} mm bed — ` +
    `${nodes.length} pieces, ${joint.screwCount}× ${screwLabel}, ${sideWords}`;
  const variant = { replaces: ['lid'], label };
  for (const n of nodes) n.variant = variant;

  return { seams: joint.seams, pieces: joint.pieces, nodes, screwCount: joint.screwCount, screwLabel, label };
}

/** Stable, legible node id for a lid piece: `lid-split-a1`, `lid-split-b2`. */
export function lidPieceId(cell: [number, number]): string {
  return `lid-split-${String.fromCharCode(97 + cell[0])}${cell[1] + 1}`;
}

/** One lap, as a box: `[aLo, aHi]` along the seam axis, `[oLo, oHi]` across it. */
function lugBox(
  axis: 0 | 1,
  aLo: number,
  aHi: number,
  oLo: number,
  oHi: number,
  zLo: number,
  zHi: number,
): BuildOp {
  return axis === 0
    ? translate([aLo, oLo, zLo], cube([aHi - aLo, oHi - oLo, zHi - zLo]))
    : translate([oLo, aLo, zLo], cube([oHi - oLo, aHi - aLo, zHi - zLo]));
}
