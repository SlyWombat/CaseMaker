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
  seamScrewCount,
  seamScrewSites,
  splitBySeams,
  type SplitPiece,
  type SplitSeam,
} from './splitPart';

/**
 * Issue #148 — the case shell's half of the split: WHERE the joint's material
 * goes. `splitPart.ts` decides where to cut and drills the holes; this module
 * supplies the laps that the holes go through, because only the case archetype
 * knows which side of its own floor is free air.
 *
 * WHY THE LUGS HANG BELOW THE FLOOR. A case shell is a box; a seam through it
 * is a vertical plane, so the screws cross that plane horizontally and each
 * head needs ~6 mm of material around it in the vertical plane. Inside the
 * cavity that space is the board's — the PCB sits on its standoffs a few mm
 * above the floor, and the walls hold the board to within a hair. Under the
 * floor is the only side of a shell that is always empty, whatever the board,
 * the hats or the ports turn out to be. So the laps are a row of lugs on the
 * underside, each a small block straddling the seam: the low piece carries a
 * clearance hole with a head seat, the high piece a starter hole, and one
 * M3×16 socket cap pulls them together.
 *
 * WHAT THAT COSTS, SAID PLAINLY (v1 — PROVISIONAL, pending a print):
 *  • The printed piece sits 8 mm off the bed on its lugs, so the slicer builds
 *    support in that gap and the floor's underside is a supported face. That is
 *    the price of the joint; `printMetaForId` says so on the part's own row
 *    rather than letting it be discovered on the plate.
 *  • An assembled split shell stands on its lugs as well as its feet, 6 mm
 *    prouder than the feet alone. Cosmetic and reversible (the split is an
 *    OFFER, not a replacement), but it is real.
 *  • It does not lock the pieces in shear: the laps are separate bodies joined
 *    by screws through clearance holes, so there is the clearance's worth of
 *    play along the seam until the screws are tight. That is why `planSeams`
 *    keeps seams out of ports and other functional regions.
 *  • A SEALED shell is refused outright (see `canSplitShell`) — cutting it
 *    opens the gasket channel and gives away the drop resistance #107/#108
 *    were for.
 *
 * The lid is not offered a split yet: its underside faces the board, so the
 * same "which side is free" question has a different answer that depends on
 * the board's height, and guessing it is how a lid gets a lug through a USB
 * port. Tracked separately.
 */

/** How far the lug hangs below the floor's underside, mm.
 *
 * Set by the head it has to bury: an M3 socket cap is 5.5 across and 3.0 tall,
 * so the seat needs ~6.1 of material around the screw axis, and a lug centred
 * on that axis needs a shade over 6.1 of its own thickness. 8 leaves ~1 mm
 * above and below the seat. CHOSEN — a first print settles it. */
export const LUG_DROP = 8;

/** Width of one lug along the seam, mm. The head seat is 6.1 across; 12 leaves
 *  ~3 mm of wall on each side of it. CHOSEN. */
export const LUG_WIDTH = 12;

/** How far each lug laps its own side of the seam, mm — and therefore the
 *  screw's engagement, since the screw threads the high piece's whole lap.
 *  This is the number that makes an M3×16 the right screw (16 under the head =
 *  8 through + 8 engaged), which is the length the source systems used on their
 *  own 250 mm seams. */
export const LUG_LAP = 8;

/** Solid left behind the end of the starter hole, mm, so the pilot is blind and
 *  its end face is never coplanar with the lug's (coincident faces are what a
 *  slicer reports as a repair). */
export const LUG_BACKING = 3;

/** How far the lug reaches up into the floor, mm, so the union has real volume
 *  to fuse rather than a coplanar face (the #119 lesson, same as the feet). */
export const LUG_EMBED = 0.8;

/** Smallest lug worth keeping, mm — below this a clipped lug is a nub. */
export const MIN_LUG_SPAN = 5;

/** The screw the joint is designed around. #140's table supplies every number
 *  that follows from it; nothing here is hand-rolled. */
export const DEFAULT_SPLIT_SCREW: FastenerSize = 'M3';

export interface ShellSplitRequest {
  /** The finished shell, in assembly orientation (XY is the bed plane). */
  shellOp: BuildOp;
  /** `aabbOfOp(shellOp)` — passed in rather than re-measured here. */
  bounds: Aabb;
  printer: PrinterVolume;
  /** Regions a seam must not cross: ports, vents, latches, hinges. */
  keepOut?: Aabb[];
  size?: FastenerSize;
}

export interface ShellSplit {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  /** One node per piece, each an alternative to the whole `shell` node. */
  nodes: BuildNode[];
  /** Screws the joint takes, counted once per seam site (both halves share it). */
  screwCount: number;
  /** e.g. `M3×16 socket cap`. */
  screwLabel: string;
  /** One line for the export list. */
  label: string;
}

/**
 * One lug the joint stands on, as arithmetic: which piece it belongs to, what
 * it spans, and what the screw does there. Geometry comes later — this is the
 * part of the joint that can be decided without touching Manifold.
 */
export interface LugSite {
  /** Index into `ShellJointPlan.pieces`. */
  piece: number;
  axis: 0 | 1;
  /** The lug's extent along the seam — it straddles the cut. */
  band: [number, number];
  /** The lug's extent across the seam — the screw's neighbourhood. */
  width: [number, number];
  /** The screw's coordinate across the seam (the un-clamped site). */
  at: number;
  /** Where the screw enters THIS piece: the seam face, or the lug's far end. */
  mouth: number;
  /** True for the piece carrying the head, false for the one it threads. */
  low: boolean;
  /** How far the screw reaches inside this piece. */
  reach: number;
  /** Identical on both halves of one screw, so a screw is counted once. */
  screwKey: string;
}

/**
 * What the joint WOULD be: the seams, the pieces they make, and one lug per
 * screw per piece. No geometry — that is `buildShellSplit`'s half.
 *
 * This exists so the offer can be the ENGINE's answer. Bounds (`aabbOfOp`) and
 * everything here are metadata arithmetic, so the compiler can afford to ask
 * "would a split work?" on every compile; building the pieces costs Manifold
 * work and stays behind the `splitForPrint` gate. An offer derived from "the
 * shell is bigger than the bed" instead would promise a split whenever the box
 * overruns, including when every seam is blocked by the case's own board
 * bosses — and the user would tick a box that builds nothing.
 */
export interface ShellJointPlan {
  seams: SplitSeam[];
  pieces: SplitPiece[];
  lugs: LugSite[];
  /** Screws the joint takes, counted once per site (both halves share it). */
  screwCount: number;
}

/**
 * Decide the joint — seams, pieces, lug sites — or null if this shell cannot be
 * split at all.
 *
 * Null is the answer for: a shell that already fits the bed, a shell taller
 * than the bed (Z is not ours to cut), no legal seam placement, or a joint the
 * chosen screw cannot make. Callers offer the split on a non-null result and
 * say why on null.
 */
export function planShellJoint(req: ShellSplitRequest): ShellJointPlan | null {
  const seams = planSeams(req.bounds, req.printer, { keepOut: req.keepOut });
  if (!seams) return null;
  const pieces = splitBySeams(req.shellOp, req.bounds, seams);

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
  return { seams, pieces, lugs, screwCount: screws.size };
}

/**
 * Every lug one piece needs on one seam, or none if this piece has no room for
 * a lap there.
 *
 * Shared by the planner and the builder so the offer and the geometry can never
 * disagree about where a screw goes.
 */
function lugSitesFor(
  piece: number,
  piece_: SplitPiece,
  seam: SplitSeam,
  bounds: Aabb,
): LugSite[] {
  const axis = seam.axis;
  const otherAxis: 0 | 1 = axis === 0 ? 1 : 0;
  const along = trueRange(
    axis === 0 ? piece_.ranges.x : piece_.ranges.y,
    bounds.min[axis],
    bounds.max[axis],
  );
  const other = trueRange(
    axis === 0 ? piece_.ranges.y : piece_.ranges.x,
    bounds.min[otherAxis],
    bounds.max[otherAxis],
  );
  const low = piece_.cell[axis] === 0;

  // This piece's lap of the seam: the low piece laps back to the head's end
  // face, the high piece laps forward and keeps LUG_BACKING of solid past the
  // starter hole's end.
  const bandLo = Math.max(low ? seam.at - LUG_LAP : seam.at, along[0]);
  const bandHi = Math.min(low ? seam.at : seam.at + LUG_LAP + LUG_BACKING, along[1]);
  if (bandHi - bandLo < MIN_LUG_SPAN) return [];

  // What the screw does in THIS piece: it passes through the low one and
  // threads the high one. Both are capped by the material actually there.
  const reach = low ? seam.at - bandLo : Math.min(LUG_LAP, bandHi - seam.at - 1);
  if (reach < MIN_LUG_SPAN) return [];

  const sites = seamScrewSites(other[0], other[1], seamScrewCount(other[1] - other[0]));
  const out: LugSite[] = [];
  for (const site of sites) {
    const wLo = Math.max(site - LUG_WIDTH / 2, other[0]);
    const wHi = Math.min(site + LUG_WIDTH / 2, other[1]);
    if (wHi - wLo < MIN_LUG_SPAN) continue;
    out.push({
      piece,
      axis,
      band: [bandLo, bandHi],
      width: [wLo, wHi],
      at: site,
      mouth: low ? bandLo : seam.at,
      low,
      reach,
      screwKey: `${axis}:${seam.at}:${site.toFixed(3)}`,
    });
  }
  return out;
}

/**
 * Cut the shell and bolt it back together, or null if it should not be offered.
 *
 * The geometry half of `planShellJoint`. A caller that has already planned the
 * joint (the compiler does, to decide what to offer) passes the plan in rather
 * than paying for it twice.
 */
export function buildShellSplit(
  req: ShellSplitRequest,
  plan?: ShellJointPlan,
): ShellSplit | null {
  const size = req.size ?? DEFAULT_SPLIT_SCREW;
  if (LUG_LAP < minEngagement(size)) {
    throw new Error(
      `shell split: a ${size} screw wants ${minEngagement(size)} mm of engagement, ` +
        `and a ${LUG_LAP} mm lap gives it ${LUG_LAP}`,
    );
  }

  const joint = plan ?? planShellJoint(req);
  if (!joint) return null;
  const { seams, pieces } = joint;

  // The lug hangs off the part's own underside. `bounds.min[2]` is the lowest
  // material there is (rugged feet sit below the floor), so anchoring to the
  // floor plane means never asking a lug to float — and never burying one
  // inside a foot.
  const zTop = Math.max(LUG_EMBED, req.bounds.min[2] + LUG_EMBED);
  const zAxis = zTop - LUG_DROP / 2;
  const zLo = zTop - LUG_DROP;

  const lugsByPiece = new Map<number, LugSite[]>();
  for (const lug of joint.lugs) {
    const list = lugsByPiece.get(lug.piece);
    if (list) list.push(lug);
    else lugsByPiece.set(lug.piece, [lug]);
  }

  const nodes: BuildNode[] = pieces.map((piece, index) => {
    let op = piece.op;
    const holes: BuildOp[] = [];
    for (const lug of lugsByPiece.get(index) ?? []) {
      op = union([
        op,
        lugBox(lug.axis, lug.band[0], lug.band[1], lug.width[0], lug.width[1], zLo, zTop),
      ]);
      const facing = seamAxisFacing(lug.axis, true); // the screw always drives +axis
      const at: Vec3 =
        lug.axis === 0 ? [lug.mouth, lug.at, zAxis] : [lug.at, lug.mouth, zAxis];
      holes.push(
        lug.low
          ? jointClearanceHole(at, facing, lug.reach, size)
          : jointStarterHole(at, facing, lug.reach, size),
      );
    }
    if (holes.length > 0) op = difference([op, ...holes]);
    return { id: pieceId(piece.cell), op };
  });

  const screwLabel = `${size}×${LUG_LAP * 2} socket cap`;
  const label =
    `Shell split for a ${req.printer.x}×${req.printer.y} mm bed — ` +
    `${nodes.length} pieces, ${joint.screwCount}× ${screwLabel}`;
  // One shared label object: nothing mutates a variant after it is built.
  const variant = { replaces: ['shell'], label };
  for (const n of nodes) n.variant = variant;

  return { seams, pieces, nodes, screwCount: joint.screwCount, screwLabel, label };
}

/**
 * Whether a shell should even be offered a split.
 *
 * A sealed shell is refused, not warned about: the seam cuts straight through
 * the gasket channel and the rim that carries it (#107/#108), and a case that
 * has given up its seal to fit on the bed has traded away the thing it was
 * built for. Better to say no.
 */
export function canSplitShell(sealed: boolean): boolean {
  return !sealed;
}

/** Stable, legible node id for a grid cell: the X index as a letter, the Y
 *  index 1-based — `shell-split-a1`, `shell-split-b2`. */
export function pieceId(cell: [number, number]): string {
  return `shell-split-${String.fromCharCode(97 + cell[0])}${cell[1] + 1}`;
}

/**
 * A piece's cell, shrunk to the material that is really there.
 *
 * `splitBySeams` grows the outer edges 1 mm outward so the boundary pieces cut
 * cleanly; a seam edge, by contrast, IS the face. Anything placed at the cell's
 * edge has to know which of the two it is looking at, or a lug overlaps the
 * neighbour across a seam.
 */
function trueRange(range: [number, number], min: number, max: number): [number, number] {
  return [range[0] < min ? min : range[0], range[1] > max ? max : range[1]];
}

/** One lug, as a box: `[aLo, aHi]` along the seam axis, `[oLo, oHi]` across it. */
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
