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
 *     (`magnetPocket`, `buildBoardSnapOps`), so a coupon cannot drift from the
 *     feature it certifies — it is the feature, clipped and laid out flat,
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

import type { BoardProfile, CaseParameters, MagnetSize } from '@/types';
import { MAGNETS, MAGNET_GLUE_GAP, magnetPocket } from './fasteners';
import { buildBoardSnapOps } from './boardSnap';
import {
  aabbOfOp,
  cube,
  difference,
  intersection,
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

/**
 * The board-snap clip coupon: ONE two-jaw clip, lifted off the compiler's own
 * `buildBoardSnapOps` output (not re-drawn here), plus a printed PCB-edge gauge
 * the clip grips. Two printed bodies on purpose — a fit coupon tests the
 * interface, so the mating half has to come off the bed as its own piece.
 *
 * The clip is the -y wall's: the coupon clips the compiler's four clips down to
 * a slab around the low-Y wall and keeps whatever the compiler emitted. If the
 * compiler's clip geometry changes, this coupon changes with it.
 */
export function buildBoardSnapClipCoupon(
  label?: Labeler,
  board: BoardProfile = COUPON_BOARD,
  params: CaseParameters = COUPON_PARAMS,
): FitCouponBuild {
  const ops = buildBoardSnapOps(board, params).caseAdditive;
  if (ops.length === 0) {
    throw new Error(
      'buildBoardSnapClipCoupon: the board/params produced no snap clips — ' +
        'boardRetention must be "snap" and the footprint must be big enough',
    );
  }
  const all = union(ops);
  const bb = aabbOfOp(all);
  if (!bb) throw new Error('buildBoardSnapClipCoupon: clip ops have no bounds');
  const xMid = (bb.min[0] + bb.max[0]) / 2;
  const clipHalfW = 7; // a finger is FINGER_W = 10 wide; 14 covers it with margin
  const SLAB_DEPTH = 12; // a thin band at the LOW-Y wall — the +Y clip is 40 mm away
  // -y wall: low Y, centred on X. Slab a little past the wall for a clean cut.
  const SLAB = cube([2 * clipHalfW, SLAB_DEPTH, bb.max[2] - bb.min[2] + 2]);
  const clip = intersection([
    all,
    translate([xMid - clipHalfW, bb.min[1] - 1, bb.min[2] - 1], SLAB),
  ]);
  // A base plinth grounds the clip (its spine already reaches the floor) to a
  // printable slab, and gives the label somewhere to sit.
  const PLINTH_T = 2;
  const plinth = cube([2 * clipHalfW, 16, PLINTH_T]);
  const base = translate([xMid - clipHalfW, bb.min[1], 0], plinth);
  // Label the PCB thickness the jaw is cut for: 1.6 mm -> "16". The glyphs are
  // digits only, so this is the one number on a single-fit coupon that reads.
  const labelOps = label
    ? label(board.pcb.size.z.toFixed(1).replace('.', ''), xMid, 4.5, PLINTH_T + 0.01, 0.6)
    : [];

  // The gauge: a board-thickness bar the user slides into the jaw. Printed
  // beside the clip (separate body) so the fit is a fit, not a fusion.
  const GAUGE_X = 16;
  const gauge = translate(
    [xMid + clipHalfW + 6, bb.min[1] + 2, 0],
    cube([GAUGE_X, board.pcb.size.y > 30 ? 24 : board.pcb.size.y - 4, board.pcb.size.z]),
  );

  const bodyA = difference([union([clip, base]), ...labelOps]);
  const op = union([bodyA, gauge]);
  // Explicit extents, not aabbOfOp: the clip is an INTERSECTION, whose
  // conservative AABB is the FULL four-clip bound and would over-report the bar.
  const gaugeY = board.pcb.size.y > 30 ? 24 : board.pcb.size.y - 4;
  const dims = {
    x: 2 * clipHalfW + 6 + GAUGE_X,
    y: Math.max(16, 2 + gaugeY),
    z: bb.max[2],
  };
  return {
    op,
    dims,
    columns: [],
    bodies: 2,
    settles:
      'the two-jaw board clip (boardSnap.ts FINGER_OVERHANG / CLIP_FIT): ' +
      'does a 1.6 mm board edge snap in and hold?',
    provenance:
      'PROVISIONAL — the clip is built from the compiler, but the fit is a fixed ' +
      'constant (no ladder yet; that needs #153 fit variants). A printed gauge that ' +
      'clicks and holds is the pass; report which way it fails if it does not.',
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
