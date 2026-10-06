/**
 * Issue #157 — interface fit coupons.
 *
 * Every printed mating interface in this repo converges on one idea (ToolStack
 * ships standard + loose connectors; Multiboard ships four clearance grades and
 * a `MultiboardTestPrint.stl`; the HIVE drawers ship `drawer_fit_test.stl`):
 * **let the user print the interface alone before printing the 77 mm part.**
 * This repo learned it the hard way — the M5 pilot coupon (#140) settled 4.8 mm
 * after arithmetic sent it to 4.0, and every magnet row in `fasteners.ts` is
 * still `derived`. A coupon costs ~10 g and ~20 min instead of a full reprint.
 *
 * This module builds those coupons. It is deliberately DATA + GEOMETRY only:
 *
 *   • the ladder (which fit values go on the coupon) is exported so the specs
 *     and the scripts agree on it,
 *   • the printable slice is built from the SAME primitives the compiler uses
 *     (`magnetPocket`, `buildBoardSnapOps`, `roundPocketCutter`), so a coupon
 *     cannot drift from the feature it certifies — it is the feature, clipped
 *     and laid out flat,
 *   • the seven-segment labels are INJECTED (`Labeler`), because the engraver
 *     lives in `scripts/coupon-glyphs.ts` and `src/` must not reach into
 *     `scripts/`.
 *
 * Each coupon carries the SAME provenance discipline as `fasteners.ts`: a
 * number that has not been printed is PROVISIONAL. Printing the coupon does not
 * change `fasteners.ts` — the operator drives/measures, reports the winner, and
 * a follow-up flips the row to `coupon` with the printed value behind it.
 *
 * `scripts/magnet-coupon.ts` (issue #152) and `scripts/fit-coupon.ts` (#157)
 * both render through here.
 */

import type { BoardProfile, CaseParameters, MagnetSize, RackParams, SnapCatch, Vec3 } from '@/types';
import { MAGNETS, MAGNET_GLUE_GAP, magnetPocket } from './fasteners';
import { CLIP_FIT, buildBoardSnapOps } from './boardSnap';
import { cavityOriginXY } from '@/engine/coords';
import { defaultInsert, roundPocketCutter } from './insert';
import {
  FOOT_H,
  SIDE_T,
  TAB_REACH,
  TAB_T,
  buildRackNodes,
  computeRackDims,
  plateTabYs,
} from './rack';
import { FIT_VARIANTS, SNAP_DEFAULTS, fitRelief } from '@/types/snap';
import { buildSnapCatch, defaultSnapCatchesForCase } from './snapCatches';
import { computeShellDims } from './caseShell';
import { lidIsRecessed } from './lidMode';
import {
  aabbOfOp,
  cube,
  difference,
  intersection,
  rotate,
  translate,
  union,
  type BuildOp,
} from './buildPlan';

/**
 * Engrave `text` into the face at z = `faceZ`, `depth` deep, centred on x = `cx`
 * with its baseline at y = `y0`. Injected so `src/` stays free of `scripts/`.
 */
export type Labeler = (
  text: string,
  cx: number,
  y0: number,
  faceZ: number,
  depth: number,
) => BuildOp[];

/** One column of a coupon — one fit value under test. */
export interface CouponColumn {
  /** World X of the column's centre. */
  x: number;
  /** The fit value under test, in mm (meaning is per-coupon). */
  value: number;
  /** Engraved label (digits only — the coupon glyphs have no sign or dot). */
  label: string;
  /** True for the value the compiler currently ships; the one to beat. */
  shipped: boolean;
}

export interface FitCouponBuild {
  /** The printable solid(s), already in print orientation. May be >1 body when
   *  the fit needs TWO printed halves (the coupon tests the interface, so the
   *  halves must come off the bed separate). */
  op: BuildOp;
  dims: { x: number; y: number; z: number };
  columns: CouponColumn[];
  /** How many separate bodies the coupon is expected to mesh into. */
  bodies: number;
  /** The compiler number this coupon exists to settle (one sentence). */
  settles: string;
  /** What has and has not been measured — the PROVISIONAL note. */
  provenance: string;
}

export interface FitCouponSpec {
  /** File slug, e.g. `magnet-6x2`. */
  id: string;
  title: string;
  /** Build the coupon. `label` is optional — single-fit coupons carry no ladder. */
  build(label?: Labeler): FitCouponBuild;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Magnets (issue #152)
// ---------------------------------------------------------------------------

/**
 * Rungs on the magnet ladder — ODD, so the shipped glue fit sits in the MIDDLE
 * and the coupon brackets it on both sides. That is the opposite of the pilot
 * coupon's ladder (which puts the shipped value LAST, to answer "is the optimum
 * above us?"); a magnet can be too tight as easily as too loose, so we need to
 * see both directions. Raise this and the ladder grows symmetrically.
 */
export const MAGNET_FIT_STEPS = 7;

/**
 * The diametral clearance ladder for a magnet pocket, in mm:
 *   clearance = pocket Ø − disc Ø.
 *
 * Centred on the table's GLUE fit (`2 × MAGNET_GLUE_GAP` = 0.5), stepping
 * 0.25 mm down into INTERFERENCE (a press fit — pocket smaller than the disc)
 * and up into LOOSE. The shipped value is `shippedMagnetClearance()`.
 */
export function magnetFitLadder(_size: MagnetSize): number[] {
  const shipped = shippedMagnetClearance();
  const half = (MAGNET_FIT_STEPS - 1) / 2;
  const step = 0.25;
  return Array.from({ length: MAGNET_FIT_STEPS }, (_, i) => r2(shipped + (i - half) * step));
}

/** The table's glue clearance, diametral: `2 × MAGNET_GLUE_GAP`. */
export function shippedMagnetClearance(): number {
  return r2(2 * MAGNET_GLUE_GAP);
}

/** Pocket diameter for a ladder value. `clearance` is diametral (pocket − disc). */
export function magnetPocketDiameterFor(size: MagnetSize, clearance: number): number {
  return r2(MAGNETS[size].d + clearance);
}

/** Digits for an engraved label: the pocket Ø to 0.1 mm, e.g. 6.5 -> "65". */
function diameterLabel(d: number): string {
  return d.toFixed(1).replace('.', '');
}

/**
 * Column layout for a magnet coupon — one source the builder, the script's
 * probes and the spec all read, so a layout tweak cannot desync them. Sized to
 * keep the bar near the pilot coupon's ~60 cm³: a coupon that costs a spool is
 * not the cheap confidence it is meant to be.
 */
export function magnetCouponLayout(size: MagnetSize): {
  barX: number;
  barY: number;
  barZ: number;
  col: number;
  x0: number;
  vertY: number;
  horizZ: number;
  labelY: number;
  engrave: number;
  columns: number;
} {
  const spec = MAGNETS[size];
  const columns = MAGNET_FIT_STEPS;
  const col = Math.max(18, spec.d * 2.2);
  const x0 = Math.max(13, spec.d * 2.5);
  return {
    barX: x0 * 2 + col * (columns - 1),
    barY: 28,
    barZ: 13,
    col,
    x0,
    vertY: 22, // top-face row centre-Y (clear of the label band below it)
    horizZ: 6.5, // front-face row centre-Z
    labelY: 6,
    engrave: 0.8,
    columns,
  };
}

/**
 * A magnet coupon for one disc size: a bar with one blind pocket per rung, in
 * two print orientations (pockets DOWN through the top face, and INTO the front
 * face), because a press fit in PLA depends on how the layers stack — the same
 * lesson the pilot and thread coupons repeat.
 *
 * A real magnet is the OTHER half of this fit; it is a bought part, so only the
 * pocket prints (like the thread coupon — the screw is bought too). Press a
 * real magnet into every hole in both rows, then report the smallest pocket that
 * holds without splitting and the largest that still seats.
 *
 * The pocket DEPTH is held at the table value (only the diameter is laddered);
 * the +0.4 depth gap stays `derived` after this coupon and needs a second one.
 */
export function buildMagnetCoupon(size: MagnetSize, label?: Labeler): FitCouponBuild {
  const spec = MAGNETS[size];
  const gaps = magnetFitLadder(size);
  const pocketDepth = spec.pocket.h;
  const L = magnetCouponLayout(size);

  const cuts: BuildOp[] = [];
  const columns: CouponColumn[] = [];
  gaps.forEach((clearance, i) => {
    const pd = magnetPocketDiameterFor(size, clearance);
    const cx = L.x0 + i * L.col;
    const shipped = Math.abs(clearance - shippedMagnetClearance()) < 1e-9;
    // Row 1 — blind pocket DOWN through the top face.
    cuts.push(
      magnetPocket({
        size,
        at: [cx, L.vertY, L.barZ],
        axis: '-z',
        diameter: pd,
        depth: pocketDepth,
      }),
    );
    // Row 2 — blind pocket INTO the front face, axis along the layers.
    cuts.push(
      magnetPocket({
        size,
        at: [cx, 0, L.horizZ],
        axis: '+y',
        diameter: pd,
        depth: pocketDepth,
      }),
    );
    const text = diameterLabel(pd);
    if (label) cuts.push(...label(text, cx, L.labelY, L.barZ, L.engrave));
    columns.push({ x: cx, value: clearance, label: text, shipped });
  });

  const op = difference([cube([L.barX, L.barY, L.barZ]), ...cuts]);
  return {
    op,
    dims: { x: L.barX, y: L.barY, z: L.barZ },
    columns,
    bodies: 1,
    settles:
      `MAGNETS['${size}'].pocket.d (currently ${spec.pocket.d} = disc + ` +
      `${shippedMagnetClearance()} glue clearance)`,
    provenance:
      'PROVISIONAL — every magnet pocket in fasteners.ts is derived. This coupon ' +
      'settles the diameter; the +0.4 depth gap stays derived until its own coupon.',
  };
}

// ---------------------------------------------------------------------------
// Board-snap two-jaw clip (issue #157)
// ---------------------------------------------------------------------------

/** A board the clips are built around for the coupon — small, default layout. */
export const COUPON_BOARD: BoardProfile = {
  id: 'fit-coupon-board',
  name: 'Fit-coupon board',
  manufacturer: 'CaseMaker',
  pcb: { size: { x: 60, y: 40, z: 1.6 } },
  mountingHoles: [],
  components: [],
  defaultStandoffHeight: 5,
  recommendedZClearance: 10,
  builtin: false,
};

/** Planner case parameters for the coupon — a bare snap-retention shell. */
export const COUPON_PARAMS: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 2,
  internalClearance: 1,
  zClearance: 10,
  joint: 'flat-lid',
  boardRetention: 'snap',
  ventilation: { enabled: false, pattern: 'none', coverage: 0 },
  bosses: { enabled: false, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
} as CaseParameters;

/** Half the band each clip is slabbed to, mm — a finger is FINGER_W = 10 wide,
 *  so 14 covers it with margin. */
const CLIP_HALF_W = 7;
/** Slab depth, mm — a thin band at the LOW-Y wall; the +Y clip is 40 mm away. */
const SLAB_DEPTH = 12;
/** Slab overshoot past the clip's own faces, mm (also the plinth's inset). */
const SLAB_MARGIN = 1;
const PLINTH_T = 2;
const PLINTH_D = 16;
/** Centre-to-centre column spacing, and the clear gap to the gauge, mm. */
const COL_PITCH = 18;
const GAUGE_X = 16;
const GAUGE_GAP = 6;
/** Label baseline above the slab's front edge, and the engraving depth, mm. */
const LABEL_Y = 4.5;
const LABEL_DEPTH = 0.6;

/**
 * Where every column of the board-snap coupon lands: the slab each clip is cut
 * from, the stride between columns, and the world→coupon offset that moves a
 * slabbed clip (and its plinth and label) into place.
 *
 * Exported because a ladder is only proven by MEASURING it: the specs walk each
 * rung's jaw with the same offsets the builder used, so what they measure is the
 * printed part, not the intent. Positions come from the compiler's own clip
 * bounds and `cavityOriginXY` — never hand-copied numbers.
 */
export interface BoardSnapCouponPlan {
  board: BoardProfile;
  params: CaseParameters;
  /** World min corner and size of the slab every column's clip is cut from. */
  slabMin: Vec3;
  slabSize: Vec3;
  /** Centre-to-centre column spacing, mm. */
  stride: number;
  /** PRINTED coupon x of each column's clip centre — also its label's centre. */
  columnX: number[];
  /** World → coupon for a rung: coupon = world − slabMin + (rung · stride, 0, 0). */
  shift: (rung: number) => Vec3;
  /** World point inside the −y jaw opening: the PCB's low-Y edge at
   *  mid-thickness. The spine's inner face stands CLIP_FIT + relief outboard of
   *  it, so the jaw gap is measurable by walking −y from here. */
  jawProbe: Vec3;
  /** Coupon z of the plinth top face the rung labels are engraved into, and the
   *  y of their baseline (text runs along +x from x = the column centre). */
  labelFaceZ: number;
  labelY0: number;
  /** The PCB-edge gauge's coupon-space origin and size. */
  gaugeOrigin: Vec3;
  gaugeSize: Vec3;
  dims: { x: number; y: number; z: number };
}

export function boardSnapCouponPlan(
  board: BoardProfile = COUPON_BOARD,
  params: CaseParameters = COUPON_PARAMS,
): BoardSnapCouponPlan {
  const ops = buildBoardSnapOps(board, params).caseAdditive;
  if (ops.length === 0) {
    throw new Error(
      'boardSnapCouponPlan: the board/params produced no snap clips — ' +
        'boardRetention must be "snap" and the footprint must be big enough',
    );
  }
  const bb = aabbOfOp(union(ops));
  if (!bb) throw new Error('boardSnapCouponPlan: clip ops have no bounds');
  const xMid = (bb.min[0] + bb.max[0]) / 2;
  // -y wall: low Y, centred on X. Slab a little past the wall for a clean cut.
  // The SLAB's min corner is the coupon origin for every clip column, so the
  // plinth and the labels move with it rather than with the clip's own bounds.
  const slabMin: Vec3 = [xMid - CLIP_HALF_W, bb.min[1] - SLAB_MARGIN, bb.min[2] - SLAB_MARGIN];
  const slabSize: Vec3 = [
    2 * CLIP_HALF_W,
    SLAB_DEPTH,
    bb.max[2] - bb.min[2] + 2 * SLAB_MARGIN,
  ];
  const lastX = (FIT_VARIANTS.length - 1) * COL_PITCH;
  const gaugeY = board.pcb.size.y > 30 ? 24 : board.pcb.size.y - 4;
  // The jaw opening sits between the shelf's top face (the board's underside)
  // and the finger, so mid-thickness is inside it whatever the rung.
  const origin = cavityOriginXY(params);
  return {
    board,
    params,
    slabMin,
    slabSize,
    stride: COL_PITCH,
    columnX: FIT_VARIANTS.map((_, i) => i * COL_PITCH + CLIP_HALF_W),
    shift: (rung) => [rung * COL_PITCH - slabMin[0], -slabMin[1], -slabMin[2]],
    jawProbe: [
      xMid,
      origin.y + (board.retentionFootprint?.y ?? 0),
      params.floorThickness + board.defaultStandoffHeight + board.pcb.size.z / 2,
    ],
    labelFaceZ: SLAB_MARGIN + PLINTH_T + 0.01,
    labelY0: SLAB_MARGIN + LABEL_Y,
    gaugeOrigin: [lastX + 2 * CLIP_HALF_W + GAUGE_GAP, SLAB_MARGIN + 2, 0],
    gaugeSize: [GAUGE_X, gaugeY, board.pcb.size.z],
    // Explicit extents, not aabbOfOp: each clip is an INTERSECTION, whose
    // conservative AABB is the FULL four-clip bound and would over-report the bar.
    dims: {
      x: lastX + 2 * CLIP_HALF_W + GAUGE_GAP + GAUGE_X,
      y: Math.max(SLAB_DEPTH, SLAB_MARGIN + PLINTH_D, SLAB_MARGIN + 2 + gaugeY),
      z: Math.max(
        bb.max[2] - bb.min[2] + SLAB_MARGIN,
        SLAB_MARGIN + PLINTH_T,
        board.pcb.size.z,
      ),
    },
  };
}

/**
 * The board-snap clip coupon: ONE two-jaw clip per #153 fit rung, lifted off
 * the compiler's own `buildBoardSnapOps` output (not re-drawn here), plus ONE
 * printed PCB-edge gauge the clips grip.
 *
 * The clip is the -y wall's: the coupon slabs the compiler's four clips down to
 * a band around the low-Y wall and keeps whatever the compiler emitted. If the
 * compiler's clip geometry changes, this coupon changes with it.
 *
 * The relief is one-sided here — a case clip mates a PURCHASED PCB, so there is
 * no second printed half for it to cancel against — and it widens only the
 * lateral gap (`CLIP_FIT + relief`); the Z jaw opening stays cut for the board.
 * So one gauge tests all three clips, the same way one lid tab tests three
 * snap-catch sockets.
 */
export function buildBoardSnapClipCoupon(
  label?: Labeler,
  board: BoardProfile = COUPON_BOARD,
  params: CaseParameters = COUPON_PARAMS,
): FitCouponBuild {
  const plan = boardSnapCouponPlan(board, params);
  const slab = cube(plan.slabSize);

  const bodies: BuildOp[] = [];
  const cuts: BuildOp[] = [];
  const columns: CouponColumn[] = [];
  FIT_VARIANTS.forEach((fit, i) => {
    const opsFor = buildBoardSnapOps(board, { ...params, fit }).caseAdditive;
    const clip = translate(
      plan.shift(i),
      intersection([union(opsFor), translate(plan.slabMin, slab)]),
    );
    // A base plinth grounds the clip (its spine already reaches the floor) to a
    // printable slab, and gives the label somewhere to sit.
    const base = translate(
      [i * plan.stride, SLAB_MARGIN, SLAB_MARGIN],
      cube([2 * CLIP_HALF_W, PLINTH_D, PLINTH_T]),
    );
    bodies.push(union([clip, base]));

    const relief = fitRelief(fit);
    const text = hundredthsLabel(relief);
    if (label) {
      // The rung is the RELIEF (#153's ladder), not the absolute jaw gap: every
      // rung is a named variant the project can be set to, and the same 0 / 10 /
      // 25 reads on the snap-catch and rack coupons too.
      cuts.push(
        ...label(
          text,
          i * plan.stride + CLIP_HALF_W,
          plan.labelY0,
          plan.labelFaceZ,
          LABEL_DEPTH,
        ),
      );
    }
    columns.push({
      x: i * plan.stride + CLIP_HALF_W,
      value: relief,
      label: text,
      shipped: relief === 0,
    });
  });

  // The gauge: a board-thickness bar the user slides into each jaw in turn.
  // Printed beside the last column (separate body) so the fit is a fit, not a
  // fusion, and shared, because the jaw's Z opening does not move with the rung.
  const gauge = translate(plan.gaugeOrigin, cube(plan.gaugeSize));

  return {
    op: difference([union([...bodies, gauge]), ...cuts]),
    dims: plan.dims,
    columns,
    bodies: FIT_VARIANTS.length + 1,
    settles:
      `the two-jaw board clip (boardSnap.ts CLIP_FIT = ${CLIP_FIT} mm between ` +
      'spine face and PCB edge) + fitRelief(#153): which grade — a 0.15 / 0.25 / ' +
      '0.40 mm gap — lets a 1.6 mm board edge cam the jaw aside, snap in and ' +
      'still be held?',
    provenance:
      'PROVISIONAL — the ladder is #153’s and no board has been clipped into a ' +
      'loosened jaw to prove it. The clips are the compiler’s own geometry, slabbed ' +
      'down to the -y wall; the plinths and the gauge are coupon scaffolding. The ' +
      'gauge is cut to the board’s stated thickness, so a pass is also a check that ' +
      'the Z jaw opening (pcb.z + FINGER_CLEARANCE_Z) accepts THIS board — if the ' +
      'gauge will not enter, the rung is not the problem.',
  };
}

// ---------------------------------------------------------------------------
// Snap-catch hook: socket + tab (issue #157; the ladder is #153's)
// ---------------------------------------------------------------------------

/**
 * Solid wall printed BEHIND the real wall band, mm (#157).
 *
 * Two jobs. It carries the engraved rung labels, which need a 7 mm glyph box
 * clear of the socket; and it turns a 2 mm wall into something you can hold
 * while pressing a tab into it. 11 mm is the width a two-digit label needs
 * (2 · 4.2 + 1.4 = 9.8) with a millimetre of face either side.
 */
export const SNAP_COUPON_BACKING = 11;

/** Solid wall printed BELOW the socket, mm — the sill the tab's tip lands on. */
export const SNAP_COUPON_SILL = 4;

/** Solid wall printed past the outermost column, mm. */
export const SNAP_COUPON_END = 6;

/** Centre-to-centre column spacing, mm — wide enough for the labels to miss. */
export const SNAP_COUPON_PITCH = 18;

/** Engraving depth for the rung labels, mm. */
const SNAP_COUPON_ENGRAVE = 0.8;

/**
 * Glyph box height, mm — `GLYPH_H` in `scripts/coupon-glyphs.ts`, which owns
 * the seven-segment digits and cannot be imported from `src/` (see the module
 * note). The labels are CENTRED on a face of known size, so a drift here moves
 * the digits rather than dropping them off the coupon.
 */
const COUPON_GLYPH_H = 7;

/** Clear space between the socket bar and the tab that presses into it, mm. */
const SNAP_COUPON_TAB_GAP = 8;

/** The tab's plate stub: overhang past the arm, and thickness, mm (#157). */
const SNAP_COUPON_STUB_OVERHANG = 3;
const SNAP_COUPON_STUB_T = 3;

/** Where a catch's wall material sits. Read off the shell dims the compiler
 *  computed — this never re-derives the envelope it is cutting into. */
interface CouponWallBand {
  /** World axis (0 = x, 1 = y) the wall's normal runs along; the other is tangent. */
  nIdx: 0 | 1;
  tIdx: 0 | 1;
  /** +1 when the wall's outward normal points along +axis (the +x / +y walls). */
  outSign: 1 | -1;
  /** Coordinates of the wall's outer and inner faces on the normal axis. */
  wallOuter: number;
  wallInner: number;
}

function couponWallBand(c: SnapCatch, outerX: number, outerY: number, wall: number): CouponWallBand {
  switch (c.wall) {
    case '-x':
      return { nIdx: 0, tIdx: 1, outSign: -1, wallOuter: 0, wallInner: wall };
    case '+x':
      return { nIdx: 0, tIdx: 1, outSign: 1, wallOuter: outerX, wallInner: outerX - wall };
    case '-y':
      return { nIdx: 1, tIdx: 0, outSign: -1, wallOuter: 0, wallInner: wall };
    case '+y':
      return { nIdx: 1, tIdx: 0, outSign: 1, wallOuter: outerY, wallInner: outerY - wall };
  }
}

/** The coupon's frame, in the catch's own world coordinates: everything the
 *  builder and the specs need to agree on, computed once. */
export interface SnapCatchCouponPlan {
  nIdx: 0 | 1;
  tIdx: 0 | 1;
  outSign: 1 | -1;
  wallOuter: number;
  wallInner: number;
  /** The catch's own position along the wall — the middle column. */
  uPosition: number;
  /** Column centres along the tangent axis, one per #153 fit rung. */
  columnU: number[];
  /** The bar's top face: the real wall's top, where the lid plate seats. */
  barTopZ: number;
  barBottomZ: number;
  /** Normal-axis coordinate the rung labels are centred on (the backing). */
  labelN: number;
  /** Z band the hook's cut spans — the socket plus the arm's reach below it. */
  cutZ: [number, number];
  /** Tangent extent of the bar. */
  barU: [number, number];
  /** Normal extent of the bar: real wall plus the backing behind it. */
  barN: [number, number];
  /** World min/max corners of the bar block. The bar is printed at the coupon's
   *  own origin, so a world point `p` prints at `p − barMin` — the one mapping a
   *  spec needs to walk the socket ladder on the meshed part. */
  barMin: Vec3;
  barMax: Vec3;
}

/** An axis-aligned box from two opposite world corners. */
function boxBetween(min: Vec3, max: Vec3): BuildOp {
  return translate(min, cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]], false));
}

/**
 * The hook catch's wall subtract, in world coordinates, with its bounds (#157).
 *
 * This is the compiler's own cut — `buildSnapCatch`'s `wallPocket` — never a
 * re-drawn socket, so the coupon cannot certify a fit the case does not have.
 * The bounds are the CUT's, not the wall's share of it: an intersection is
 * bounded by its first child (`aabbOfOp`), so the arm's 1 mm of reach below the
 * barb is inside them. That is a millimetre of sill, not a fit dimension — the
 * socket itself is measured off the meshed coupon in `fitCoupons.spec.ts`.
 */
function hookCutBounds(
  c: SnapCatch,
  board: BoardProfile,
  params: CaseParameters,
): { cut: BuildOp; z: [number, number] } {
  const cut = buildSnapCatch(c, board, params)?.wallPocket;
  if (!cut) {
    throw new Error(
      'snapCatchCouponPlan: this catch has no wall socket to ladder — only the ' +
        "default 'hook' design is relieved by #153 (see the coupon's provenance)",
    );
  }
  const bb = aabbOfOp(cut);
  if (!bb) throw new Error('snapCatchCouponPlan: the socket cut has no bounds');
  return { cut, z: [bb.min[2], bb.max[2]] };
}

export function snapCatchCouponPlan(
  board: BoardProfile = COUPON_BOARD,
  params: CaseParameters = COUPON_PARAMS,
): SnapCatchCouponPlan {
  const dims = computeShellDims(board, params, [], () => undefined);
  const catches = defaultSnapCatchesForCase(board, params, [], () => undefined);
  const c = catches.find((k) => k.wall === '-y') ?? catches[0];
  if (!c) throw new Error('snapCatchCouponPlan: this board/parameters produce no snap catches');
  const band = couponWallBand(c, dims.outerX, dims.outerY, params.wallThickness);
  const { z: cutZ } = hookCutBounds(c, board, params);

  const mid = (FIT_VARIANTS.length - 1) / 2;
  const columnU = FIT_VARIANTS.map((_, i) => c.uPosition + (i - mid) * SNAP_COUPON_PITCH);
  const halfU = SNAP_DEFAULTS.armWidth / 2 + SNAP_COUPON_END;
  const backingFace = band.wallOuter + band.outSign * SNAP_COUPON_BACKING;
  // The wall's top is where the lid plate seats: `computeHookTabFrame` in
  // snapCatches.ts decides the same plane with the same predicate, and the
  // tab's plate stub lands on it.
  const barTopZ = lidIsRecessed(params) ? dims.outerZ - params.lidThickness : dims.outerZ;
  const barU: [number, number] = [columnU[0]! - halfU, columnU[columnU.length - 1]! + halfU];
  const barN: [number, number] = [
    Math.min(backingFace, band.wallInner),
    Math.max(backingFace, band.wallInner),
  ];
  // The sockets are cut strictly inside this block (the deepest reach is the
  // arm's, and the sill below it is part of the block), so its corners are also
  // the difference's. Cutting the bar and walking the ladder both start here.
  const barMin: Vec3 = [0, 0, 0];
  const barMax: Vec3 = [0, 0, 0];
  barMin[band.nIdx] = barN[0];
  barMax[band.nIdx] = barN[1];
  barMin[band.tIdx] = barU[0];
  barMax[band.tIdx] = barU[1];
  barMin[2] = cutZ[0] - SNAP_COUPON_SILL;
  barMax[2] = barTopZ;
  return {
    nIdx: band.nIdx,
    tIdx: band.tIdx,
    outSign: band.outSign,
    wallOuter: band.wallOuter,
    wallInner: band.wallInner,
    uPosition: c.uPosition,
    columnU,
    barTopZ,
    barBottomZ: cutZ[0] - SNAP_COUPON_SILL,
    labelN: band.wallOuter + band.outSign * (SNAP_COUPON_BACKING / 2),
    cutZ,
    barU,
    barN,
    barMin,
    barMax,
  };
}

/**
 * The snap-catch coupon (#157): ONE wall bar carrying a socket per #153 fit
 * rung, plus ONE tab.
 *
 * Both halves come from `buildSnapCatch`, the compiler's own function, at the
 * rung under test — the socket is the real subtract, the tab is the real lid
 * tab. #153's relief widens and deepens the CUT only, and the tab is built from
 * the un-relieved frame, so a single printed tab is the honest test of all
 * three sockets: whatever clicks in and holds is the fit that ships.
 *
 * The tab is printed with a stub of the lid plate it hangs from, flipped stub-
 * down so it stands on the bed — which is also how the real lid prints (the
 * export layout flips it). Press each socket in turn: the rung that clicks and
 * does not rattle is the answer.
 */
export function buildSnapCatchCoupon(
  label?: Labeler,
  board: BoardProfile = COUPON_BOARD,
  params: CaseParameters = COUPON_PARAMS,
): FitCouponBuild {
  const plan = snapCatchCouponPlan(board, params);
  const catches = defaultSnapCatchesForCase(board, params, [], () => undefined);
  const c = catches.find((k) => k.wall === '-y') ?? catches[0]!;
  const tight = buildSnapCatch(c, board, params);
  if (!tight) throw new Error('buildSnapCatchCoupon: the sample catch did not build');

  const barBlock = boxBetween(plan.barMin, plan.barMax);

  const cuts: BuildOp[] = [];
  const columns: CouponColumn[] = [];
  FIT_VARIANTS.forEach((fit, i) => {
    const u = plan.columnU[i]!;
    const g = buildSnapCatch({ ...c, fit }, board, params);
    const socket = g?.wallPocket;
    if (!socket) throw new Error(`buildSnapCatchCoupon: no socket for fit "${fit}"`);
    const delta: Vec3 = [0, 0, 0];
    delta[plan.tIdx] = u - plan.uPosition;
    cuts.push(translate(delta, socket));

    const relief = fitRelief(fit);
    const text = hundredthsLabel(relief);
    if (label) {
      // The glyph box is centred on the backing (never over the socket) and on
      // the column's own position along the wall.
      const cx = plan.nIdx === 1 ? u : plan.labelN;
      const y0 = (plan.nIdx === 1 ? plan.labelN : u) - COUPON_GLYPH_H / 2;
      cuts.push(...label(text, cx, y0, plan.barTopZ, SNAP_COUPON_ENGRAVE));
    }
    columns.push({ x: 0, value: relief, label: text, shipped: relief === 0 });
  });
  const barOp = difference([barBlock, ...cuts]);

  // The lid half: the compiler's tab plus a stub of the plate it hangs from,
  // flipped stub-down. `rotate` is a proper rotation, so nothing is mirrored.
  const tabBB = aabbOfOp(tight.armBarb);
  if (!tabBB) throw new Error('buildSnapCatchCoupon: the tab has no bounds');
  const stub = translate(
    [tabBB.min[0] - SNAP_COUPON_STUB_OVERHANG, tabBB.min[1] - SNAP_COUPON_STUB_OVERHANG, 0],
    cube(
      [
        tabBB.max[0] - tabBB.min[0] + 2 * SNAP_COUPON_STUB_OVERHANG,
        tabBB.max[1] - tabBB.min[1] + 2 * SNAP_COUPON_STUB_OVERHANG,
        SNAP_COUPON_STUB_T,
      ],
      false,
    ),
  );
  const tabInWorld = translate([0, 0, plan.barTopZ], rotate([180, 0, 0], union([tight.armBarb, stub])));
  const tabBB2 = aabbOfOp(tabInWorld);
  if (!tabBB2) throw new Error('buildSnapCatchCoupon: the placed tab has no bounds');

  const barBB = aabbOfOp(barOp);
  if (!barBB) throw new Error('buildSnapCatchCoupon: the bar has no bounds');
  const bar = translate([-barBB.min[0], -barBB.min[1], -barBB.min[2]], barOp);
  const barW = barBB.max[0] - barBB.min[0];
  const barD = barBB.max[1] - barBB.min[1];
  const tabW = tabBB2.max[0] - tabBB2.min[0];
  const tabD = tabBB2.max[1] - tabBB2.min[1];
  const tab = translate(
    [barW + SNAP_COUPON_TAB_GAP - tabBB2.min[0], -tabBB2.min[1], -tabBB2.min[2]],
    tabInWorld,
  );

  // `columns[].x` is the PRINTED x of each rung's label, which for the ±y walls
  // is the socket's own column: the catch-world coordinates the plan works in
  // are shifted onto the bed above, and a spec probing the meshed op needs the
  // printed one. The bar's normal axis is x for the ±x walls, and there the
  // columns run along y instead — the plan carries those coordinates.
  columns.forEach((col, i) => {
    const worldX = plan.nIdx === 1 ? plan.columnU[i]! : plan.labelN;
    col.x = worldX - barBB.min[0];
  });

  const barH = barBB.max[2] - barBB.min[2];
  return {
    op: union([bar, tab]),
    dims: {
      x: barW + SNAP_COUPON_TAB_GAP + tabW,
      y: Math.max(barD, tabD),
      z: Math.max(barH, tabBB2.max[2] - tabBB2.min[2]),
    },
    columns,
    bodies: 2,
    settles:
      'snapCatches.ts buildHookTabWallSubtract relief (#153): which grade — ' +
      '0 / 0.10 / 0.25 mm — lets the hook tab click into its socket and still ' +
      'hold the lid down',
    provenance:
      'PROVISIONAL — the ladder is #153’s, and NO fit grade has been printed ' +
      'against a real catch. The socket and the tab are both the compiler’s own ' +
      'geometry; the plate stub on the tab and the backing behind the wall are ' +
      'coupon scaffolding, not mating surfaces. Only the default hook design is ' +
      'relieved, so this coupon certifies the hook and nothing else: the lip ' +
      'barb types (asymmetric-ramp, symmetric-ramp, half-round, ball-socket) ' +
      'still carry a fixed fit and would need their own relief to be laddered.',
  };
}

// ---------------------------------------------------------------------------
// Rack plate tab + ledge (issue #157; the ladder is #153's)
// ---------------------------------------------------------------------------

/**
 * The rack the coupon slices one corner from, mm. Any rack has the same corner
 * joint — `plateTabYs` is a function of depth alone and every tab dimension is
 * a fixed constant — so the coupon takes one small frame and says so.
 *
 * `depth` stays under `MID_BAR_MIN_DEPTH` so `plateTabYs` returns the two END
 * tabs only: the joint the load goes through, and the one whose ledge is cut
 * clean through the rail.
 */
export const RACK_COUPON_RACK: RackParams = { enabled: true, width: 200, depth: 130, slots: 3 };

/** Half the assembly-y window a slice keeps around the tab centre, mm. The tab
 *  and its ledge are 22 mm long and the ledge's lightening keep-out 4 mm wider
 *  than that, so 14 mm either side puts the slice's own walls in solid rail. */
const RACK_COUPON_HALF_WINDOW = 14;

/** Rail kept above the ledge slot, mm. The slice's top face ends here because
 *  `buildSide`'s ledge keep-out does: 2 mm higher and the outer-face lightening
 *  pocket has taken the outer half of the face, which is no place to engrave. */
const RACK_COUPON_PAD = 2;

/** Deck kept inboard of the tab, mm — enough to hold the gauge by. */
const RACK_COUPON_DECK = 12;

/** Clearance the tab slice leaves outboard of the tab, mm. */
const RACK_COUPON_CLEAR = 2;

/** Centre-to-centre spacing of the ledge slices, mm. */
const RACK_COUPON_PITCH = 22;

/** Clear space between the ledge row and the tab gauge, mm. */
const RACK_COUPON_GAP = 8;

/** Engraving depth for the rung labels, mm. */
const RACK_COUPON_ENGRAVE = 0.8;

/** Baseline of a rung label along the slice, mm. The tab screw's starter hole
 *  opens onto the same top face at the tab centre, so the digits stay clear of
 *  it (a 7 mm glyph box from here ends 4 mm short). */
const RACK_COUPON_LABEL_Y = 3;

/**
 * Everything the builder and the specs need to agree on for the rack coupon
 * (#157), computed once: the slabs each piece is cut from, and where the slab's
 * min corner lands on the bed.
 */
export interface RackTabCouponPlan {
  rack: RackParams;
  /** Assembly y of the corner tab the coupon slices (`plateTabYs[0]`). */
  tabY: number;
  /** Assembly z of the plate's underside — the tab's seating plane, and the
   *  bottom plate's own z datum. */
  plateZ: number;
  /** Assembly-space slabs, as `[min, max]`: the ledge slice, and the tab. */
  ledgeSlab: [Vec3, Vec3];
  tabSlab: [Vec3, Vec3];
  /** PRINTED x of each rung's ledge slice. */
  columnX: number[];
  /** Assembly → coupon offset for rung `rung`'s ledge slice. */
  ledgeShift: (rung: number) => Vec3;
  /** The tab gauge is FLIPPED about x first, as the real plate prints
   *  (counterbore up, never open onto the bed), so its coupon coordinates are
   *  `(x, -y, -z) + tabShift`. */
  tabShift: Vec3;
  /** The top face the rung labels are engraved into, coupon z. */
  labelZ: number;
  /** Slice extents, mm. */
  ledgeSize: Vec3;
  tabSize: Vec3;
  dims: { x: number; y: number; z: number };
}

/** The rack's own part, by the id `buildRackNodes` gives it — never re-drawn. */
function rackPart(rack: RackParams, id: string): BuildOp {
  const node = buildRackNodes(rack).find((n) => n.id === id);
  if (!node) throw new Error(`rackTabCoupon: the compiler emitted no "${id}" part`);
  return node.op;
}

/** Where a sliced piece's slab min corner lands for the origin `at`, with the
 *  slab's own bounds mirrored when the piece is flipped. */
function pieceShift(slab: [Vec3, Vec3], at: [number, number], turnOver: boolean): Vec3 {
  const m: Vec3 = turnOver ? [slab[0][0], -slab[1][1], -slab[1][2]] : slab[0];
  return [at[0] - m[0], at[1] - m[1], -m[2]];
}

/** Cut `part` with an axis-aligned slab and drop the piece on the bed so the
 *  slab's min corner sits at `at` (x, y) — flipped about x first when that is
 *  the way the real part reaches the bed. The slab is a query, not a drawing:
 *  everything the coupon prints is the compiler's own geometry, clipped. */
function slicePiece(
  part: BuildOp,
  slab: [Vec3, Vec3],
  at: [number, number],
  turnOver = false,
): BuildOp {
  const cut = intersection([part, boxBetween(slab[0], slab[1])]);
  return translate(pieceShift(slab, at, turnOver), turnOver ? rotate([180, 0, 0], cut) : cut);
}

export function rackTabCouponPlan(rack: RackParams = RACK_COUPON_RACK): RackTabCouponPlan {
  const dims = computeRackDims(rack);
  const tabY = plateTabYs(dims.depth)[0]!;
  const yMin = tabY - RACK_COUPON_HALF_WINDOW;
  const yMax = tabY + RACK_COUPON_HALF_WINDOW;
  // The tab's band is `FOOT_H .. FOOT_H + TAB_T`: `buildPlate` grows the tabs
  // from its own z = 0 and `buildRackNodes` seats that at FOOT_H.
  const ledgeSlab: [Vec3, Vec3] = [
    [0, yMin, 0],
    [SIDE_T, yMax, FOOT_H + TAB_T + RACK_COUPON_PAD],
  ];
  const tabSlab: [Vec3, Vec3] = [
    [SIDE_T - TAB_REACH - RACK_COUPON_CLEAR, yMin, FOOT_H],
    [SIDE_T + RACK_COUPON_DECK, yMax, FOOT_H + TAB_T],
  ];
  const ledgeSize: Vec3 = [SIDE_T, yMax - yMin, FOOT_H + TAB_T + RACK_COUPON_PAD];
  const tabSize: Vec3 = [
    tabSlab[1][0] - tabSlab[0][0],
    yMax - yMin,
    TAB_T,
  ];
  const rowW = (FIT_VARIANTS.length - 1) * RACK_COUPON_PITCH + SIDE_T;
  const tabAt: [number, number] = [rowW + RACK_COUPON_GAP, 0];
  return {
    rack,
    tabY,
    plateZ: FOOT_H,
    ledgeSlab,
    tabSlab,
    columnX: FIT_VARIANTS.map((_, i) => i * RACK_COUPON_PITCH),
    ledgeShift: (rung) => pieceShift(ledgeSlab, [rung * RACK_COUPON_PITCH, 0], false),
    tabShift: pieceShift(tabSlab, tabAt, true),
    labelZ: ledgeSlab[1][2],
    ledgeSize,
    tabSize,
    dims: {
      x: tabAt[0] + tabSize[0],
      y: yMax - yMin,
      z: Math.max(ledgeSize[2], tabSize[2]),
    },
  };
}

/**
 * The rack plate-tab coupon (#157): THREE ledge slices, one per #153 fit rung,
 * plus ONE plate tab.
 *
 * Both halves are the compiler's own parts, cut with a slab: the ledges are
 * `rack-side-left` compiled at the rung under test, the tab is `rack-bottom` —
 * the same plate for every rung, because `buildSide` applies the relief to the
 * LEDGE only and the plate's tabs never move. One printed tab therefore tests
 * all three ledges honestly: whichever the tab slides into and still holds the
 * deck down is the grade that ships.
 *
 * The tab is printed with its deck stub down, counterbore UP — the orientation
 * the real plate prints in (`buildPlate`: printed the other way the tab's
 * counterbore opens onto the bed and its head seat becomes a bridge).
 */
export function buildRackTabCoupon(
  label?: Labeler,
  rack: RackParams = RACK_COUPON_RACK,
): FitCouponBuild {
  const plan = rackTabCouponPlan(rack);
  const bodies: BuildOp[] = [];
  const cuts: BuildOp[] = [];
  const columns: CouponColumn[] = [];

  FIT_VARIANTS.forEach((fit, i) => {
    const at: [number, number] = [plan.columnX[i]!, 0];
    bodies.push(slicePiece(rackPart({ ...rack, fit }, 'rack-side-left'), plan.ledgeSlab, at));
    const relief = fitRelief(fit);
    const text = hundredthsLabel(relief);
    if (label) {
      cuts.push(
        ...label(text, at[0] + SIDE_T / 2, RACK_COUPON_LABEL_Y, plan.labelZ, RACK_COUPON_ENGRAVE),
      );
    }
    columns.push({ x: at[0] + SIDE_T / 2, value: relief, label: text, shipped: relief === 0 });
  });

  const tabAt: [number, number] = [plan.dims.x - plan.tabSize[0], 0];
  bodies.push(slicePiece(rackPart(rack, 'rack-bottom'), plan.tabSlab, tabAt, true));

  return {
    op: difference([union(bodies), ...cuts]),
    dims: plan.dims,
    columns,
    bodies: FIT_VARIANTS.length + 1,
    settles:
      'rack.ts TAB_SLACK + fitRelief(rack.fit) (#153): which grade — 0 / 0.10 / ' +
      '0.25 mm — lets the plate tab slide into its bottom ledge and still stop ' +
      'the deck shifting',
    provenance:
      'PROVISIONAL — the ladder is #153’s, and no rack has been assembled with a ' +
      'loosened ledge to prove it. Both halves are the compiler’s own parts cut ' +
      'with a slab, so the coupon cannot certify a slot the panel does not have; ' +
      'the slice windows are coupon scaffolding, not mating surfaces. What it does ' +
      'NOT cover: the same ledge is cut at the rack TOP with `TAB_T + OVER` of ' +
      'depth (the coupon slices the bottom one), the plate is also carried by a ' +
      'mid tab on racks deeper than MID_BAR_MIN_DEPTH, and nothing here tests the ' +
      'M5 that pins the tab (its starter hole and head access are both in the ' +
      'slice, but a print is not a torque test).',
  };
}

// ---------------------------------------------------------------------------
// Tool-insert pocket (issue #158; #262 item 5)
// ---------------------------------------------------------------------------

/** The tool shank the coupon's pockets are cut for, mm.
 *
 *  `defaultInsert()`'s starter item is a Ø10 round pocket, so a Ø10 shank is
 *  the one tool the shipped defaults already claim to hold. Holding it FIXED is
 *  what makes every label mean one thing: each column's number is a fit value,
 *  never a tool size. */
export const INSERT_COUPON_TOOL_D = 10;

/** Rungs on each ladder. */
export const INSERT_FIT_STEPS = 7;
export const INSERT_CHAMFER_STEPS = 7;

/** Clearance ladder step, mm. */
export const INSERT_CLEARANCE_STEP = 0.1;

/** Chamfer ladder step, mm. */
export const INSERT_CHAMFER_STEP = 0.2;

/**
 * Pocket depth and plate thickness the coupon is cut at, mm.
 *
 *  Deliberately NOT the shipped defaults (6 / 4.5 / 1.5): the coupon holds the
 *  depth constant — as the magnet coupon does — so the only thing a fit result
 *  can be blamed on is the number on the ladder. 6 mm of bore is enough for a
 *  shank to be felt to wobble or not; 4 mm of floor is enough to be pressed on.
 */
const COUPON_POCKET_DEPTH = 6;
const COUPON_THICKNESS = 10;

/** The insert's shipped friction fit, diametral (pocket Ø − tool Ø), mm. */
export function shippedInsertClearance(): number {
  return defaultInsert().clearance;
}

/** The insert's shipped entry chamfer, mm. */
export function shippedInsertChamfer(): number {
  return defaultInsert().chamfer;
}

/**
 * The clearance ladder, mm — pocket Ø minus tool Ø.
 *
 * NOT centred on the shipped value the way the magnet ladder is. The shipped
 * 0.25 is a guess the insert file itself calls one, and the reviewed generators
 * fit socket-OD pockets at +0.6, so the answer is far more likely to be LOOSER
 * than what ships: the ladder spends four of its seven rungs above 0.25 and two
 * below. That is the pilot coupon's shape (#140) — "is the optimum above us?" —
 * rather than the magnet ladder's symmetric bracket, and the asymmetry is the
 * one honest thing to encode when the shipped number is unmeasured.
 *
 * It cannot go negative. A magnet can be pressed in and left there; a tool has
 * to come back OUT, and `insertProblem` rejects a negative clearance anyway.
 */
export function insertClearanceLadder(): number[] {
  const first = Math.max(0, shippedInsertClearance() - 2 * INSERT_CLEARANCE_STEP);
  return Array.from({ length: INSERT_FIT_STEPS }, (_, i) =>
    r2(first + i * INSERT_CLEARANCE_STEP),
  );
}

/**
 * The chamfer ladder, mm — 0 (a hard edge, the control) up in 0.2 steps.
 *
 * Anchored at ZERO rather than centred on the shipped 0.8, for the same reason
 * the clearance ladder stops at 0: `insertProblem` rejects a negative chamfer
 * and entry ease only ever rises with it, so three centred rungs would be
 * numbers the compiler refuses to build. The shipped 0.8 lands on rung 4 of 7.
 */
export function insertChamferLadder(): number[] {
  return Array.from({ length: INSERT_CHAMFER_STEPS }, (_, i) => r2(i * INSERT_CHAMFER_STEP));
}

/** Digits for a label: the value in hundredths, digits only, e.g. 0.25 -> "25". */
function hundredthsLabel(value: number): string {
  return (value * 100).toFixed(0);
}

/**
 * Column and row layout for the insert coupon — one source the builder, the
 * spec's probes and the printed part all read, so a layout tweak cannot desync
 * them. Two rows of `INSERT_FIT_STEPS` pockets: the upper row ladders the
 * clearance, the lower row the chamfer.
 */
export function insertCouponLayout(): {
  barX: number;
  barY: number;
  barZ: number;
  col: number;
  x0: number;
  clearanceY: number;
  chamferY: number;
  clearanceLabelY: number;
  chamferLabelY: number;
  pocketDepth: number;
  engrave: number;
  columns: number;
} {
  const maxR = (INSERT_COUPON_TOOL_D + Math.max(...insertClearanceLadder())) / 2;
  // The pitch clears the widest engraved LABEL, not just the widest pocket: a
  // three-digit string is 3·4.2 + 2·1.4 = 15.4 mm wide, so a pitch sized to the
  // pocket alone (2·maxR + 4) would run the neighbouring labels together.
  const col = Math.max(2 * maxR + 4, 18);
  const x0 = maxR + 6;
  const clearanceY = 38;
  const chamferY = 16;
  // Baseline offset below a row's pocket centres, so the 7 mm glyphs clear the
  // bore wall they sit under.
  const labelGap = 9;
  return {
    barX: 2 * x0 + col * (INSERT_FIT_STEPS - 1),
    barY: clearanceY + maxR + 6,
    barZ: COUPON_THICKNESS,
    col,
    x0,
    clearanceY,
    chamferY,
    clearanceLabelY: clearanceY - maxR - labelGap,
    chamferLabelY: 2,
    pocketDepth: COUPON_POCKET_DEPTH,
    engrave: 0.8,
    columns: INSERT_FIT_STEPS,
  };
}

/**
 * The tool-insert pocket coupon: a bar with two ladders of blind pockets in its
 * top face, cut with the compiler's own `roundPocketCutter`.
 *
 * The upper row ladders the diametral CLEARANCE with the entry chamfer held at
 * the shipped value; its labels are the clearance in hundredths ("25" = 0.25 mm
 * of clearance). The lower row ladders the CHAMFER with the clearance held at
 * the shipped value; its labels are the chamfer in hundredths ("80" = 0.8 mm).
 * The two rows do not share a number system on purpose — a diameter label would
 * be identical across the whole of the lower row — and only the upper row's
 * rungs reach `FitCouponBuild.columns`, because that is the ladder the `shipped`
 * flag means anything for.
 *
 * A printed pass is the operator sliding a real Ø10 shank (a drill bit, a hex
 * key, a 1/4" driver) into each hole and reporting the smallest one it enters
 * and the smallest one that still grips without rattle. Those are not the same
 * number, which is the whole point of a ladder.
 */
export function buildInsertPocketCoupon(label?: Labeler): FitCouponBuild {
  const L = insertCouponLayout();
  const shippedClearance = shippedInsertClearance();
  const shippedChamfer = shippedInsertChamfer();
  const floorZ = L.barZ - L.pocketDepth;

  const cuts: BuildOp[] = [];
  const columns: CouponColumn[] = [];

  // Upper row — the clearance ladder, chamfer held at the shipped value.
  insertClearanceLadder().forEach((clearance, i) => {
    const cx = L.x0 + i * L.col;
    cuts.push(
      translate(
        [cx, L.clearanceY, floorZ],
        roundPocketCutter(INSERT_COUPON_TOOL_D + clearance, L.pocketDepth, shippedChamfer),
      ),
    );
    const text = hundredthsLabel(clearance);
    if (label) cuts.push(...label(text, cx, L.clearanceLabelY, L.barZ, L.engrave));
    columns.push({
      x: cx,
      value: clearance,
      label: text,
      shipped: Math.abs(clearance - shippedClearance) < 1e-9,
    });
  });

  // Lower row — the chamfer ladder, clearance held at the shipped value.
  insertChamferLadder().forEach((chamfer, i) => {
    const cx = L.x0 + i * L.col;
    cuts.push(
      translate(
        [cx, L.chamferY, floorZ],
        roundPocketCutter(INSERT_COUPON_TOOL_D + shippedClearance, L.pocketDepth, chamfer),
      ),
    );
    if (label) {
      cuts.push(...label(hundredthsLabel(chamfer), cx, L.chamferLabelY, L.barZ, L.engrave));
    }
  });

  const op = difference([cube([L.barX, L.barY, L.barZ]), ...cuts]);
  return {
    op,
    dims: { x: L.barX, y: L.barY, z: L.barZ },
    columns,
    bodies: 1,
    settles:
      `insert.ts defaultInsert().clearance (currently ${shippedClearance}) — the ` +
      `diametral grip a round pocket holds a Ø${INSERT_COUPON_TOOL_D} tool shank with; ` +
      `the lower row ladders the entry chamfer (currently ${shippedChamfer})`,
    provenance:
      'PROVISIONAL — every insert fit number is a default, not a measurement ' +
      '(clearance 0.25, chamfer 0.8, floor 1.5, pitchGap 3) and no tool insert has been ' +
      'printed here. Upper-row labels are the clearance ×100; lower-row labels are the ' +
      'chamfer ×100. A printed pass reports the smallest hole a real shank enters and the ' +
      'smallest that still holds it without rattle; print a second coupon if the best rung ' +
      'is at either end of a ladder.',
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every fit coupon the generator can render. Add an interface here when its
 * mating geometry becomes buildable from the compiler (see the module note).
 */
export const FIT_COUPONS: readonly FitCouponSpec[] = [
  ...(['6x2', '8x3', '10x2'] as MagnetSize[]).map(
    (size): FitCouponSpec => ({
      id: `magnet-${size}`,
      title: `Magnet pocket ${size} — press/glue fit ladder`,
      build: (label) => buildMagnetCoupon(size, label),
    }),
  ),
  {
    id: 'board-snap',
    title: 'Board-snap two-jaw clip + PCB-edge gauge',
    build: (label) => buildBoardSnapClipCoupon(label),
  },
  {
    id: 'snap-catch',
    title: 'Snap-catch hook: socket ladder + tab',
    build: (label) => buildSnapCatchCoupon(label),
  },
  {
    id: 'rack-tab',
    title: 'Rack plate tab + ledge ladder, with the plate tab',
    build: (label) => buildRackTabCoupon(label),
  },
  {
    id: 'insert-pocket',
    title: `Tool-insert pocket Ø${INSERT_COUPON_TOOL_D} — clearance + chamfer ladder`,
    build: (label) => buildInsertPocketCoupon(label),
  },
];

export function fitCouponIds(): string[] {
  return FIT_COUPONS.map((c) => c.id);
}

export function buildFitCoupon(id: string, label?: Labeler): FitCouponBuild {
  const spec = FIT_COUPONS.find((c) => c.id === id);
  if (!spec) {
    throw new Error(`unknown fit coupon "${id}" — one of ${fitCouponIds().join(', ')}`);
  }
  return spec.build(label);
}
