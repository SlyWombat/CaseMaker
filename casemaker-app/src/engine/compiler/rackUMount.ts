/**
 * #261 — THE 10″ U-MOUNT RACK MODE: THE STANDARD'S RAILS AND ITS FIRST PIECE OF GEAR.
 *
 * The rack archetype generates a PRINTED-SHELF rack (16.5 mm side-column clamp pitch, Meuon,
 * Printables 1307276). The wider 10″ mini-rack ecosystem has consolidated on a different,
 * DOCUMENTED standard — Project Mini Rack (mini-rack.jeffgeerling.com), DeskPi RackMate and the
 * accessory market — and gear built to it cannot bolt into a printed-shelf frame. The maintainer
 * decided on 2026-10-07 (#261) to add a second rack mode that takes the ecosystem's gear.
 *
 * THIS MODULE IS THE STANDARD'S NUMBERS AND NOTHING OF OURS. The pitch and the hole pair are the
 * standard's own figures, quoted from its page (read 2026-11-01) so a later reader cannot mistake
 * 44.45 for a number this app chose:
 *
 *   "most of the industry has settled on the same '1U' height standard as typical 19″ racks
 *    (44.45mm, or 1.75″), but with the width being 236.525mm (9.312″) between screw holes. This
 *    equates to an absolute maximum of around 220mm (8.75″) of horizontal clearance … mini rack
 *    gear should fit within around 210mm (8.45″).
 *    … Screw or square holes must follow the same vertical spacing as the 19″ rack specification."
 *
 * WHAT WE CHOOSE, AND SAY SO: the rails' own thickness and depth, where along the depth the holes
 * sit, the deck under them, and the hole SHAPE. The standard leaves the hole shape to the maker
 * ("some manufacturers … use square holes for cage nuts, while others use standard 10/32 or 12/24
 * screws"); slice 1 prints round ⌀6.2 through-holes, which take an M6 bolt (or a 10/32 screw) with
 * a nut behind the rail. The POSITIONS are the standard's; the hardware is ours to state.
 *
 * The vertical pattern is EIA-310's, which the standard defers to: within each 44.45 mm unit the
 * holes sit 6.35 / 22.225 / 38.1 mm above the unit's base (three per unit per rail; gear commonly
 * bolts to the outer two). Each U's offsets are pinned here, not read from a per-rack table.
 *
 * Assembly coordinates follow the rack engine's: x across the width, y front→back, z up, z = 0 at
 * the deck's underside.
 */

import type { Mm } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import {
  axisCylinder,
  cube,
  difference,
  roundedRectPrism,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';

// ---- The standard's numbers (mm) — quoted, not chosen ----------------------
/** One rack unit: 44.45 mm (1.75″) — the 19″ racks' own height standard. */
export const U_PITCH = 44.45;
/** The distance between the two rails' mounting-hole centres: 236.525 mm (9.312″). */
export const HOLE_PAIR = 236.525;
/** The gear width the standard asks makers to keep within: around 210 mm (8.45″). */
export const GEAR_WIDTH = 210;
/**
 * EIA-310's hole pattern within one U, measured from the unit's base: 6.35 / 22.225 / 38.1 mm.
 * The standard above says vertical spacing "must follow the same … 19″ rack specification".
 */
export const HOLE_OFFSETS_IN_U = [6.35, 22.225, 38.1] as const;

// ---- Ours, stated ---------------------------------------------------------
/** The hole the rails print: ⌀6.2 takes an M6 bolt or a 10/32 screw; the standard leaves the shape to the maker. */
export const RAIL_HOLE_D = 6.2;
/** Rail plate thickness across x. */
export const RAIL_T = 12;
/** How far behind the front face the mounting holes sit along the depth. */
export const RAIL_HOLE_Y = 15;
/** The deck under the rails: its thickness, and how far past the rails it runs at each side. */
export const DECK_T = 6;
export const DECK_LIP = 6;
/** The 1U blank coupon: the ear beyond its hole, and the plate's thickness. */
export const BLANK_EAR = 10;
export const BLANK_T = 2.5;

/** The default unit count a new u-mount rack starts at; the standard fixes the pitch, not sizes. */
export const UMOUNT_DEFAULT_U = 6;

/** The params the U-mount mode reads: the unit count and the depth. The pitch is not a parameter. */
export interface UMountParams {
  /** Rack units, 1–12. The standard fixes the pitch, not the sizes. */
  u: number;
  /** Front-to-back depth of the rails and deck, mm. */
  depth: Mm;
}

/** The derived numbers every builder and test reads; nothing here is re-derived downstream. */
export interface UMountDims {
  u: number;
  depth: Mm;
  /** Rail height: exactly `u × U_PITCH` — the standard's, with no house margin. */
  railH: number;
  /** The two rails' hole-centre planes, across x. */
  holeX: readonly [number, number];
  /** Overall width of the deck (rail outer faces plus the lip). */
  deckW: number;
}

export function uMountDims(params: UMountParams): UMountDims {
  const u = Math.min(12, Math.max(1, Math.trunc(params.u)));
  const depth = params.depth;
  const railH = u * U_PITCH;
  // The left hole plane is the left rail's mid-plane; the right one is the pair away, exactly.
  const left = RAIL_T / 2;
  const right = left + HOLE_PAIR;
  const deckW = right + RAIL_T / 2 + 2 * DECK_LIP;
  return { u, depth, railH, holeX: [left, right], deckW };
}

/** The hole Z positions for `u` units, from the deck's top face: every unit's three offsets. */
export function uMountHoleZs(u: number): number[] {
  const zs: number[] = [];
  for (let unit = 0; unit < u; unit += 1) {
    for (const offset of HOLE_OFFSETS_IN_U) zs.push(unit * U_PITCH + offset);
  }
  return zs;
}

function rail(dims: UMountDims): BuildOp {
  const plate = roundedRectPrism(RAIL_T, dims.depth, dims.railH, 2, 12);
  const cuts: BuildOp[] = [];
  for (const z of uMountHoleZs(dims.u)) {
    cuts.push(
      translate(
        [-1, RAIL_HOLE_Y, z],
        // Through the plate along x: one unit longer than the rail, so both faces are opened.
        axisCylinder('+x', RAIL_T + 2, RAIL_HOLE_D / 2, 32),
      ),
    );
  }
  return cuts.length === 0 ? plate : difference([plate, ...cuts]);
}

function deck(dims: UMountDims): BuildOp {
  const plate = roundedRectPrism(dims.deckW, dims.depth, DECK_T, 3, 12);
  return plate;
}

/**
 * The 1U blank: a plate one U tall whose BODY is the standard's 210 mm, with an ear each side
 * reaching its rail's holes. The pair of holes on each side sits at the outer two EIA offsets, so
 * the coupon proves the standard's positions and the gear width in one part.
 */
function blank1U(): BuildOp {
  const earRun = BLANK_EAR;
  const totalW = HOLE_PAIR + 2 * earRun;
  const bodyW = GEAR_WIDTH;
  const earW = (totalW - bodyW) / 2;
  // Body plus two ears, one solid 1U plate.
  const plate = union([
    translate([earW, 0, 0], cube([bodyW, BLANK_T, U_PITCH])),
    cube([earW, BLANK_T, U_PITCH]),
    translate([earW + bodyW, 0, 0], cube([earW, BLANK_T, U_PITCH])),
  ]);
  const cuts: BuildOp[] = [];
  const leftX = earRun;
  const rightX = earRun + HOLE_PAIR;
  for (const x of [leftX, rightX]) {
    for (const z of [HOLE_OFFSETS_IN_U[0], HOLE_OFFSETS_IN_U[2]]) {
      cuts.push(translate([x, -1, z], axisCylinder('+y', BLANK_T + 2, RAIL_HOLE_D / 2, 32)));
    }
  }
  return difference([plate, ...cuts]);
}

/**
 * The U-mount parts, as nodes: the two rails, the deck, and the 1U blank coupon. Ids carry the
 * unit count (`-6u`) so the export list reads them as the standard's ("10″ rail — LEFT, 6U").
 */
export function buildUMountNodes(params: UMountParams, _printer?: PrinterVolume): BuildNode[] {
  const dims = uMountDims(params);
  const nodes: BuildNode[] = [
    { id: `umount-rail-left-${dims.u}u`, op: translate([0, 0, DECK_T], rail(dims)) },
    {
      id: `umount-rail-right-${dims.u}u`,
      // The right rail's hole plane is HOLE_PAIR from the left one's, so its plate starts there.
      op: translate([dims.holeX[1] - RAIL_T / 2, 0, DECK_T], rail(dims)),
    },
    { id: `umount-deck-${dims.u}u`, op: deck(dims) },
    { id: 'umount-blank-1u', op: blank1U() },
  ];
  return nodes;
}
