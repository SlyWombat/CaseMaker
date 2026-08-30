import type { Mm, RackParams, RackAccessory } from '@/types';
import {
  cube,
  cylinder,
  axisCylinder,
  circleProfile,
  difference,
  extrude,
  extrudeX,
  lightenBars,
  lightenPocket,
  pOffset,
  mesh,
  pDifference,
  pIntersection,
  pTranslate,
  pUnion,
  rectProfile,
  roundedRectPrism,
  rotate,
  translate,
  union,
  type BuildNode,
  type BuildOp,
  type Profile,
  aabbOfOp,
} from './buildPlan';
import { headHeight, screwHole, screwStarter } from './fasteners';

/**
 * Parametric mini-rack assembly (emulates "Mini Rack" by Meuon, Printables
 * 1307276, CC-BY 4.0 — measurements in /Mini-Rack.md). Every part is its own
 * BuildNode so manifoldIntegrity's one-component-per-node contract holds and
 * the export modal can save each STL separately.
 *
 * Assembly coords: x across the width (0..W), y front→back (0..D),
 * z up (0 = underside of the stacking feet).
 *
 * THE INVARIANT: the 16.5 mm slot pitch and every fastener-facing dimension
 * below are FIXED. Resizing changes width / depth / slot count only — a
 * faceplate printed for a 252 mm rack never fits a 200 mm one, but both take
 * the same screws, keystone jacks, and 3-slot shelves scaled to their width.
 */

// ---- Fixed functional dimensions (mm) --------------------------------------
export const SLOT_PITCH = 16.5;
/** Side panel plate thickness (the lateral M5 screws pass through this). */
export const SIDE_T = 15;
/** Height margin below the first / above the last slot. */
const END_MARGIN = 5.5;
/** Stacking feet under the side panels. */
const FOOT_H = 5;
const FOOT_LEN = 30;
const FOOT_INSET = 4;
/**
 * The MID bearing pad is longer than an end foot, and deliberately so: the end
 * tabs are each pulled down onto their foot by an M5, but the mid tab has no
 * screw at all. Bearing is the only thing holding it, so the pad is sized to
 * put a wide margin of material around the tab's footprint rather than the
 * 4 mm of overhang a plain FOOT_LEN block left at each end.
 */
const MID_PAD_LEN = 46;
/**
 * The rack's fastener is an M5 throughout, and no dimension of it is written
 * out in this file any more — `screwHole({ size: 'M5' })` and
 * `screwStarter({ size: 'M5' })` read the shared table in fasteners.ts
 * (issue #140).
 *
 * What that gets us, concretely: clearance through the sides at the house
 * 'located' fit of 5.2, deliberately tighter than ISO close because these holes
 * hold the accessories square and slack in them is crookedness; receiving holes
 * at the coupon-tested 4.8, the one number in that table that came from a
 * printed part rather than a standard.
 */
/** Tie-wrap holes down the front band. */
const TIE_D = 4.5;
/** Accessory faceplate thickness (blank/keystone front plate). */
const FACE_T = 4;
/** Accessory end-rib: width across x, depth along y, front screw center. */
const RIB_W = 12;
const RIB_D = 12;
/** Accessories mount RECESSED behind the sides' front faces so the front
 *  columns stand proud and protect cables/switches — the original's
 *  signature "extra column over the front". */
export const FRONT_RECESS = 12;
/** Screw-column y centers. Accessory-local: FRONT_HOLE_Y / ACC_REAR_HOLE_Y
 *  (from the accessory's front). Side-panel: add FRONT_RECESS. The rear
 *  column adds support for long shelves (>= LONG_SHELF). */
const FRONT_HOLE_Y = 10;
export const SIDE_FRONT_HOLE_Y = FRONT_RECESS + FRONT_HOLE_Y;
export const REAR_HOLE_Y = 100;
const ACC_REAR_HOLE_Y = REAR_HOLE_Y - FRONT_RECESS;
export const LONG_SHELF = 112;
/** Deck thickness — a shelf's is thinner than a cable tray's. */
export const SHELF_DECK_T = 3;
/**
 * Upstand stiffening ribs across the shelf deck.
 *
 * A flat 3 mm deck over a ~197 mm span is a trampoline: measured I = 106 mm4,
 * which is 23 mm of sag under 5 kg in PETG. PETG matters — it is about HALF the
 * stiffness of PLA (E ~2.0 GPa against ~3.5), and every earlier figure in this
 * file assumed PLA. Section depth is the only lever that works; closing the
 * lattice back up only reached 14.5 mm.
 *
 * UPSTAND, not downstand, for two reasons: the shelf prints deck-down, so
 * downstand ribs would print first and leave the deck bridging between them;
 * and downstand ribs would steal headroom from the accessory below. Raised ribs
 * also give a device airflow underneath, which is how most rack shelves work.
 * They run ACROSS the span, tying the two end ribs together.
 */
export const SHELF_RIB_H = 4;
const SHELF_RIB_W = 3;
const SHELF_RIB_PITCH = 30;
/**
 * The stiffening ribs run ACROSS the direction a device slides in and out, so
 * on their own they are a row of steps to catch on. Half the deck's cross-hatch
 * — one of the two diagonal families — is raised to the same height between
 * them, so a device rides on a near-continuous plane instead of dropping into
 * the gaps and snagging on the next rib. Diagonals rather than more straight
 * ribs on purpose: they engage progressively as something slides over them.
 *
 * Left clear at the very FRONT so there is a flat lead-in to start a device on,
 * and around any rear cable cutout, where nothing needs supporting.
 */
const SHELF_LEAD_CLEAR = 12;
export const TRAY_DECK_T = 4;
/**
 * Rear anchor for a full-depth shelf, measured in from the rack's back face.
 *
 * 25, not 12. At 12 it sat 3 mm from the REAR TAB SCREW (which is at
 * depth - 15) — radii summing 5.0 against a 3 mm separation, so the two holes
 * ran into each other at slot 0 and slot 15. The tab screws cannot move: the
 * front one is already as close to the foot's front edge as the tab allows, and
 * the plate is symmetric, so the rear one is pinned opposite it. Moving the
 * anchor is the only free variable, and 25 buys 10 mm of separation.
 *
 * A full shelf spans ~238 mm at sample size; the existing rear column sits
 * only 88 mm back from its front edge, which would leave most of the shelf
 * cantilevered. This gives it a screw at the actual back. The column is cut
 * into the sides ONLY when a full-depth shelf is present, so an ordinary rack
 * is not peppered with holes it will never use.
 */
export const REAR_ANCHOR_INSET = 25;

/** Resolve a shelf's depth, expanding 'full' against the rack's own depth. */
export function resolveShelfDepth(shelfDepth: Mm | 'full' | undefined, rackDepth: Mm): number {
  if (shelfDepth === 'full') return rackDepth - FRONT_RECESS;
  return shelfDepth ?? 123;
}

/** A shelf's ACTUAL deck depth after clamping — what buildShelf really cuts. */
export function shelfDeckDepth(shelfDepth: Mm | 'full' | undefined, rackDepth: Mm): number {
  return Math.min(Math.max(60, resolveShelfDepth(shelfDepth, rackDepth)), rackDepth - FRONT_RECESS);
}

/** Does this rack carry a shelf that runs its whole depth? */
export function hasFullDepthShelf(rack: RackParams): boolean {
  return (rack.accessories ?? []).some((a) => a.type === 'shelf' && a.shelfDepth === 'full');
}
/** Rack depth below which the sides have no mid rib (and thus no rear
 *  screw column) — long/extra-deep shelves lose their middle-bar anchor. */
export const MID_BAR_MIN_DEPTH = 132;
/** Side panel structure: solid front band (the cable-protecting column),
 *  rear band, top/bottom rails, rib carrying the rear screw column. */
const FRONT_BAND = 34;
const REAR_BAND = 15;
const REAR_BAND_WALL = 25; // widened when wall-mounted (strength)
const RAIL = 14;
const REAR_RIB = [92, 108] as const;
/** Lateral fit clearances. */
const SIDE_CLEAR = 0.3;
/** Weight relief: blind pockets cut into the solid bands from the OUTER
 *  face (so they open UPWARD in the inner-face-down print orientation — no
 *  bridging), leaving this much inner skin, with solid bosses kept around
 *  every screw / tie hole. */
const POCKET_SKIN = 3;
/** Boss kept full-thickness around each lateral screw hole. This is bearing
 *  area for the M5 cap head (8.5 mm across), NOT thread — the screw threads
 *  into the accessory's rib, so 10 mm leaves 2.4 mm of wall around the 5.2 mm
 *  clearance hole and still supports the whole head. At 13 mm the bosses were
 *  3.5 mm apart on the 16.5 pitch, which made each screw column a solid bar:
 *  the two columns alone were 107 cm3 of a 330 cm3 panel. */
export const SCREW_BOSS_D = 10;
/** Weight relief: solid margin kept around the panel edge and each keep-out,
 *  and the collar left around a tie-wrap hole. */
const RELIEF_RIM = 3;
const TIE_BOSS_MARGIN = 2;
/** Accessory rib hollowing: C-channel wall thickness and the boss kept
 *  around each thread hole so screw engagement stays full-width. */
const RIB_WALL = 5;
const RIB_BOSS_D = 12;
/** Side-panel fan mounts: strip margin beyond the fan frame, screw hole
 *  (fan self-tappers bite plastic), and the standard bolt spacing /
 *  opening per frame size. */
const FAN_BAND_MARGIN = 7;
/** Material outside the bolt circle on the fan pad. */
const FAN_BOLT_EDGE = 6;
/** Width of the rails that hang the pad off the frame. Deliberately
 *  SCREW_BOSS_D: a rail crossing a screw column then leaves that hole exactly
 *  the boss the panel's own lightening would have. */
const FAN_RAIL_W = 10;
export const FAN_SCREW_D = 3.6;
/**
 * Where a fan actually lands. Its configured position is clamped so the whole
 * mounting band stays on the panel and the opening keeps clear of the rails —
 * the validator has to warn about the clamped position, not the typed one.
 */
export function fanCenter(
  fan: { size: number; y: Mm; z: Mm },
  dims: { depth: Mm; bodyH: Mm },
): { y: Mm; z: Mm } {
  const spec = FAN_SPECS[fan.size] ?? FAN_SPECS[80]!;
  const half = fan.size / 2 + FAN_BAND_MARGIN;
  return {
    y: Math.min(Math.max(fan.y, half), dims.depth - half),
    z:
      FOOT_H +
      Math.min(Math.max(fan.z, spec.opening / 2 + 3), dims.bodyH - spec.opening / 2 - 3),
  };
}
export const FAN_SPECS: Record<number, { bolt: number; opening: number }> = {
  40: { bolt: 32, opening: 36 },
  60: { bolt: 50, opening: 55 },
  80: { bolt: 71.5, opening: 73 },
  92: { bolt: 82.5, opening: 84 },
  120: { bolt: 105, opening: 112 },
};
/**
 * Top/bottom plates. Each plate lands in a blind rebate cut into the side
 * panels' top and bottom rails.
 *
 * The seat occupies only the plate's INNER 3 mm, never its full thickness, so
 * the rebate keeps solid material on its outboard z face. The full-thickness
 * tab this replaces cut clean through the side body's bottom and top faces: it
 * located the plates fore/aft and left them free in z, so on the first printed
 * set the top plate lifted straight off and the bottom plate dropped out.
 * Seats sit over the stacking feet, which puts the whole foot depth beneath
 * the bottom rebate's floor.
 */
const PLATE_T = 5;
/**
 * Corner tabs. Each tab is flush with the plate's OUTER face and reaches out
 * over a side panel, dropping into a ledge cut in that panel's rail. An M5 is
 * driven straight DOWN through the tab into the side.
 *
 * Flush with the OUTER face on purpose. That face points out of the rack in
 * BOTH installs — the top plate is this same part turned over — so the tab
 * fills its ledge at whichever end it lands, leaving the top stackable and the
 * underside flat. It also means one counterbore serves the top plate's head;
 * the bottom plate's head sits proud on the inner face, which is harmless
 * because the tabs sit outboard of every accessory.
 *
 * This replaces a blind rebate + snap darts. Those held z perfectly well but
 * could only be assembled plate-then-sides and could never come back out of a
 * standing rack; the screws buy serviceability the snap could not.
 */
export const TAB_REACH = 12;
const TAB_LEN = 22;
/**
 * Tab thickness EQUALS the deck, so the plate is a flat slab with ears rather
 * than a slab with lumps: both faces are dead flat, which is what lets it be
 * printed counterbore-UP. Printed the other way the counterbore opens onto the
 * bed and its floor becomes an unsupported ceiling — a bridge — which is no
 * seat for a screw head to bear on.
 */
export const TAB_T = PLATE_T;
const TAB_SLACK = 0.3;
/** How far a tab overlaps the deck it grows out of, to avoid a coplanar seam. */
const TAB_MERGE = 0.5;
/**
 * The tab screw is the SAME M5 as everything else in the rack, so it takes the
 * same numbers. It used to carry its own: TAB_SCREW_CLEAR_D was a byte-identical
 * duplicate of SCREW_CLEAR_D, and the head recess was a pair of magic numbers
 * with a "provisional pending #140" comment on them. #140 has landed, and the
 * recess is the MEASURED button head (9.2 across, 3.0 tall) plus the table's
 * head fit, giving the same Ø9.8 x 3.0 as before.
 *
 * Only the HEIGHT survives as a named constant, because the tab's thickness is
 * built from it (head height + a bearing floor) and the tests pin that.
 */
export const TAB_SCREW_HEAD_H = headHeight('M5', 'button');
/**
 * Screw axis, measured INBOARD from the plate edge — not the centre of the
 * tab. Centred, a Ø9.8 counterbore leaves 0.6 mm of wall each side, which is
 * not a wall.
 *
 * The offset trades two walls directly against each other and both matter:
 * moving the axis inboard fattens the tab's outboard wall but thins the side
 * panel's inner wall, where the same screw threads a few millimetres from the
 * open ledge. At an inset of 3.5 in an 11 mm tab that inner wall was 0.8 mm —
 * a thread that would split straight out into the rack. 12 mm of reach at
 * 4.3 balances them: 2.8 mm of tab outboard, 1.6 mm of panel inboard, and
 * still 3 mm of rail left outboard of the ledge.
 */
export const TAB_SCREW_INSET = 4.3;
/** Pilot depth below the TOP ledge, sized for the 24 mm-thread M5s in hand:
 *  a screw longer than its hole bottoms out and jacks the plate back up. The
 *  bottom tab lands on a stacking foot instead and takes what the foot gives. */
export const TAB_SCREW_BITE = 21;
/** Solid column reserved around a tab screw in the side's lightening pocket. */
const TAB_COLUMN_D = 10;
/**
 * How far in from the outer face a tab screw column is pocketed back to. The
 * thread only needs material around itself, not a full-height lump: with the
 * axis 4.3 mm in from the plate edge the screw spans x 8.6..13.4, so keeping
 * material from x=8 inward covers it with room to spare.
 */
const COLUMN_FLOOR = 7;
/** Driver access up through a stacking foot to the bottom tab screw's head. */
const TAB_ACCESS_D = 10.8;
/** Keystone jack (industry standard, NEVER scaled): retention window in a
 *  2 mm web the jack's latch clicks over (insert from the back), body
 *  clearance behind, 30 mm jack pitch. */
const KS_WIN_W = 15.0;
const KS_WIN_H = 16.7;
const KS_WEB_T = 2;
const KS_BODY_W = 17.4;
const KS_BODY_H = 20.5;
const KS_DEPTH = 10;
const KS_PITCH = 30;
/** Wall mount — ears. */
const EAR_REACH = 28;
const EAR_T = 4;
const WALL_SCREW_D = 4.5;
const WALL_HEAD_D = 9.6;
const WALL_HEAD_RECESS = 2;
const GUSSET_T = 4;
/** Wall mount — french cleat. Chunky on purpose: the 15×40 profile keeps
 *  the hook step and bevel legible at rack scale and adds bearing area. */
const CLEAT_D = 15;
const CLEAT_H = 40;
const CLEAT_FIT = 0.4;
/** Seat height below the panel top (hook block height + a little). */
const CLEAT_SEAT_DROP = 58;
/** Wall mount — keyhole hangers (flush): sized for #8 / 4 mm pan heads. */
const KEY_HEAD_D = 9.6;
const KEY_SLOT_W = 4.8;
const KEY_DEPTH = 9;
const KEY_FACE_T = 4;
const KEY_TRAVEL = 14;
/** Cutter overshoot so booleans punch cleanly through faces. */
const OVER = 1;

export interface RackDims {
  width: number;
  depth: number;
  slots: number;
  /** Side panel body height (feet excluded). */
  bodyH: number;
  /** Overall height including feet. */
  totalH: number;
  /** Top/bottom plate width (nests between the sides). */
  plateW: number;
  rearBand: number;
  /** z of a slot's bottom edge, k = 0..slots-1. */
  slotZ: (k: number) => number;
  /** z of slot k's screw-hole center. */
  holeZ: (k: number) => number;
}

export function computeRackDims(rack: RackParams): RackDims {
  const width = Math.max(120, rack.width);
  const depth = Math.max(80, rack.depth);
  const slots = Math.max(2, Math.round(rack.slots));
  const bodyH = slots * SLOT_PITCH + 2 * END_MARGIN;
  const wallMounted = (rack.wallMount ?? 'none') !== 'none';
  return {
    width,
    depth,
    slots,
    bodyH,
    totalH: FOOT_H + bodyH,
    plateW: width - 2 * SIDE_T - 2 * SIDE_CLEAR,
    rearBand: wallMounted ? REAR_BAND_WALL : REAR_BAND,
    slotZ: (k) => FOOT_H + END_MARGIN + k * SLOT_PITCH,
    holeZ: (k) => FOOT_H + END_MARGIN + (k + 0.5) * SLOT_PITCH,
  };
}

/** Accessory slot height with defaults applied. */
export function accessorySlots(acc: RackAccessory): number {
  if (acc.type === 'cable-tray') return 2;
  return Math.max(1, Math.round(acc.slots ?? (acc.type === 'keystone' ? 2 : 3)));
}

/** Triangular prism extruded along Z — ear gussets. Vertices are (x, y)
 *  pairs; winding is normalized so the solid always faces outward. */
function triPrismZ(
  tri: readonly [[number, number], [number, number], [number, number]],
  zMin: number,
  zMax: number,
): BuildOp {
  const a = tri[0];
  let b = tri[1];
  let c = tri[2];
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross < 0) {
    const swap = b;
    b = c;
    c = swap;
  }
  const positions: number[] = [];
  for (const [x, y] of [a, b, c]) positions.push(x, y, zMin);
  for (const [x, y] of [a, b, c]) positions.push(x, y, zMax);
  const tris = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    2, 0, 3, 2, 3, 5,
  ];
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

/** Rounded-corner window piercing the full side-panel thickness along X. */
function xWindow(x0: number, y0: number, z0: number, yLen: number, zLen: number, r: number): BuildOp {
  return translate(
    [x0 - OVER, y0, z0 + zLen],
    rotate([0, 90, 0], roundedRectPrism(zLen, yLen, SIDE_T + 2 * OVER, r)),
  );
}

/**
 * One side panel. `mirror=false` builds the LEFT panel occupying x 0..SIDE_T;
 * `mirror=true` maps every x range through (width - x) for the RIGHT panel.
 * The two are true chiral parts (tab pockets open inward, ears point outward).
 */
function buildSide(rack: RackParams, dims: RackDims, mirror: boolean): BuildOp {
  const { width, depth, bodyH, rearBand } = dims;
  const H_TOP = FOOT_H + bodyH;
  // Map an [a, b] x-interval into this panel's frame.
  const xr = (a: number, b: number): [number, number] =>
    mirror ? [width - b, width - a] : [a, b];
  const box = (xa: number, xb: number, y: number, z: number, dy: number, dz: number): BuildOp => {
    const [a, b] = xr(xa, xb);
    return translate([a, y, z], cube([b - a, dy, dz]));
  };

  const solid: BuildOp[] = [
    // Panel body spans z FOOT_H..H_TOP; stacking feet hang below at both ends.
    box(0, SIDE_T, 0, FOOT_H, depth, bodyH),
    // Run to the front and rear FACES, not inset from them. The plate tab
    // ledge is cut from z FOOT_H upward and reaches within ~4 mm of each face,
    // so an inset foot left that end wall of the ledge standing on nothing —
    // a thin cantilevered lip exactly where the tab loads it.
    box(0, SIDE_T, 0, 0, FOOT_INSET + FOOT_LEN, FOOT_H + OVER),
    box(0, SIDE_T, depth - FOOT_INSET - FOOT_LEN, 0, FOOT_INSET + FOOT_LEN, FOOT_H + OVER),
  ];
  // Bearing pad under the MID tab, on a rack deep enough to have one.
  //
  // Only the end tabs carry downward load: they land on a stacking foot, while
  // the mid tab has nothing beneath it and merely resists uplift — so anything
  // heavy on the floor plate is held on four corners. This pad gives the mid
  // tab something to bear on, taking it to six. It works in COMPRESSION into
  // the side panel, so it carries whether the rack stands on the floor or hangs
  // off its ears; a screw there would do the same job in tension but needs a
  // reserved column at mid-depth, which splits the vent window and measured
  // ~100 cm3 per panel against this pad's ~2.
  if (depth >= MID_BAR_MIN_DEPTH) {
    // MID_PAD_LEN, not FOOT_LEN: no screw pins this tab down, so all it has is
    // the material it bears on — see MID_PAD_LEN.
    solid.push(box(0, SIDE_T, depth / 2 - MID_PAD_LEN / 2, 0, MID_PAD_LEN, FOOT_H + OVER));
  }

  const cuts: BuildOp[] = [];

  // Vent/tie windows between the structural bands, split by the rear-column
  // rib. Sample racks use a truss aesthetic; big rounded windows carry the
  // same airflow + tie-wrap intent with primitive-friendly geometry.
  const spans: Array<[number, number]> = [];
  const rearEdge = depth - rearBand;
  // A window reaching the full rear band would carve away the rear tab screw's
  // column — it left that thread only 67% of its annulus. Stop the windows
  // short of it; the front tab sits inside the solid front band already.
  const windowRear = Math.min(
    rearEdge,
    depth - (FOOT_INSET + TAB_LEN / 2) - TAB_COLUMN_D / 2 - 3,
    // ...and clear of the rear anchor's head boss when one is present.
    ...(hasFullDepthShelf(rack) ? [depth - REAR_ANCHOR_INSET - SCREW_BOSS_D / 2 - 3] : []),
  );
  if (depth >= MID_BAR_MIN_DEPTH) {
    spans.push([FRONT_BAND, REAR_RIB[0]]);
    spans.push([REAR_RIB[1], windowRear]);
  } else {
    spans.push([FRONT_BAND, windowRear]);
  }
  const windows: Array<[number, number, number, number]> = []; // y0, yLen, z0, zLen
  for (const [a, b] of spans) {
    let segs: Array<[number, number]> = [[a, b]];
    if (b - a > 130) {
      const mid = (a + b) / 2;
      segs = [
        [a, mid - 5],
        [mid + 5, b],
      ];
    }
    for (const [sa, sb] of segs) {
      if (sb - sa < 24) continue;
      windows.push([sa + 4, sb - sa - 8, FOOT_H + RAIL, bodyH - 2 * RAIL]);
    }
  }
  for (const [wy, wdy, wz, wdz] of windows) {
    cuts.push(xWindow(xr(0, SIDE_T)[0], wy, wz, wdy, wdz, 6));
  }

  // Screw columns: front (every accessory) + rear (long shelves), one hole
  // per slot, pierced laterally through the panel. Tie-wrap holes run along
  // the top/bottom rails instead of the front band — the recessed screw
  // column leaves no band room for a second column.
  const [holeX] = xr(-OVER, SIDE_T + OVER);
  const holeLen = SIDE_T + 2 * OVER;
  const rearAnchorY = depth - REAR_ANCHOR_INSET;
  const wantsRearAnchor = hasFullDepthShelf(rack);
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    const column = (y: number): BuildOp =>
      screwHole({ size: 'M5', at: [holeX, y, z], axis: '+x', through: holeLen, segments: 24 });
    cuts.push(column(SIDE_FRONT_HOLE_Y));
    if (depth >= MID_BAR_MIN_DEPTH) cuts.push(column(REAR_HOLE_Y));
    if (wantsRearAnchor) cuts.push(column(rearAnchorY));
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    cuts.push(translate([holeX, ty, FOOT_H + RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
    cuts.push(translate([holeX, ty, FOOT_H + bodyH - RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
  }

  // Ledges for the plate corner tabs, plus the starter hole each tab screw
  // threads into. Every ledge is open UPWARD so the plate drops straight down
  // into an assembled frame; the tab then fills the ledge flush.
  //
  // The two ends are not alike and cannot be. At the top the ledge is only as
  // deep as the tab, so the rail keeps material beneath it for the screw. At
  // the bottom there is nothing below plate level at all — the plate's
  // underside IS the rack's underside — so the ledge is cut clear through the
  // rail and the tab lands on a stacking foot, which is the only material
  // down there to thread into.
  const tabEdge = SIDE_T + SIDE_CLEAR;
  const xAt = (v: number): number => xr(v, v)[0];
  const tabAxis = xAt(tabEdge - TAB_SCREW_INSET);
  const screwYs = new Set(plateScrewYs(depth));
  for (const ty of plateTabYs(depth)) {
    const y0 = ty - TAB_LEN / 2 - TAB_SLACK;
    const dy = TAB_LEN + 2 * TAB_SLACK;
    // Bottom: the ledge is only as deep as the tab, so the rail ABOVE it stays
    // solid — that is what the bottom screw threads into, driven UP from
    // underneath. Downward is not an option here: there are only 19 mm of rack
    // below plate level (5 mm foot + 14 mm rail) and a 24 mm screw would come
    // straight out through the foot. Going up instead reaches the rail and the
    // web above it, and lands the head in the same outer-face counterbore the
    // top plate uses.
    cuts.push(box(tabEdge - TAB_REACH - TAB_SLACK, SIDE_T + OVER, y0, FOOT_H, dy, TAB_T));
    // Top: only as deep as the tab, so the rail below stays solid to bite.
    cuts.push(
      box(tabEdge - TAB_REACH - TAB_SLACK, SIDE_T + OVER, y0, H_TOP - TAB_T, dy, TAB_T + OVER),
    );
    if (!screwYs.has(ty)) continue; // mid tab bears the deck, takes no screw
    // A millimetre deeper than the screw reaches: a screw that bottoms out
    // jacks the plate back up off its seat.
    cuts.push(
      screwStarter({
        size: 'M5',
        at: [tabAxis, ty, FOOT_H + TAB_T],
        axis: '+z',
        depth: TAB_SCREW_BITE + OVER,
        segments: 24,
      }),
    );
    // Driver access to that screw's head. The head lands in the tab's
    // outer-face counterbore, which on the bottom plate faces the underside of
    // the rack — and these tabs sit over a stacking foot. Without this the
    // head pocket is a sealed void: the screw threads upward, so it can only
    // be entered from below, and below is solid foot. (Measured: a Ø9.8
    // insertion path was 375 mm3 blocked — an unfittable screw.)
    cuts.push(
      translate([tabAxis, ty, -OVER], cylinder(FOOT_H + 2 * OVER, TAB_ACCESS_D / 2, 32)),
    );
    // Driven DOWN from the top ledge, so the hole runs -z from its mouth. The
    // bottom one is the mirror case and goes UP, which is the whole reason the
    // two ends of this joint are not the same part of the rail.
    cuts.push(
      screwStarter({
        size: 'M5',
        at: [tabAxis, ty, H_TOP - TAB_T],
        axis: '-z',
        depth: TAB_SCREW_BITE,
        segments: 24,
      }),
    );
  }

  // Weight relief, cut from the OUTER face — which faces UP in the
  // inner-face-down print orientation, so every pocket opens upward and
  // nothing bridges. Relieving only the front and rear bands (what this
  // replaces) left the rails and the rear rib essentially solid, and the
  // panel came out 46% heavier than the original despite being 5 mm THINNER.
  // Every structural region gets pocketed now; the profile is drawn once in
  // the panel's own y-z plane and extruded through the thickness.
  //
  // What stays full thickness, and why:
  //   - a rim around the panel edge and each region
  //   - a boss at every screw and tie-wrap hole (head bearing area)
  //   - the plate tab ledges, and a column under each tab screw so it has
  //     something solid to thread into
  //   - the whole rear band whenever the rack wall-mounts (strength package,
  //     and where the cleat hook and keyhole hangers land)
  const [pa, pb] = xr(-OVER, SIDE_T - POCKET_SKIN);
  const pocketDepthX = pb - pa;
  const yzRect = (y0: number, y1: number, z0: number, z1: number): Profile =>
    pTranslate([y0, z0], rectProfile(y1 - y0, z1 - z0));
  const webZ0 = FOOT_H + RELIEF_RIM;
  const webZ1 = H_TOP - RELIEF_RIM;
  const wallMounted = (rack.wallMount ?? 'none') !== 'none';
  const regions: Profile[] = [
    yzRect(RELIEF_RIM, FRONT_BAND - RELIEF_RIM, webZ0, webZ1),
    // The rails run the full depth and sit below / above every window.
    yzRect(RELIEF_RIM, depth - RELIEF_RIM, webZ0, FOOT_H + RAIL - 2),
    yzRect(RELIEF_RIM, depth - RELIEF_RIM, H_TOP - RAIL + 2, webZ1),
  ];
  if (depth >= MID_BAR_MIN_DEPTH) {
    regions.push(yzRect(REAR_RIB[0] + 2, REAR_RIB[1] - 2, webZ0, webZ1));
  }
  if (!wallMounted) {
    // When the rear anchor column is present, its bosses have to sit WHOLLY
    // inside this pocket. Left at the band edge each boss straddles the pocket
    // boundary and prints as a half-buried crescent rather than the clean ring
    // the front column gives — measured, the rear bosses were 31-50% fused
    // into the surrounding rim where the front ones are 0-4%. Pull the pocket
    // forward far enough to clear a whole boss with margin.
    const bandStart = depth - rearBand + RELIEF_RIM;
    regions.push(
      yzRect(
        wantsRearAnchor
          ? Math.min(bandStart, rearAnchorY - SCREW_BOSS_D / 2 - 4)
          : bandStart,
        depth - RELIEF_RIM,
        webZ0,
        webZ1,
      ),
    );
  }
  const keepOut: Profile[] = [];
  const screwColumns: Profile[] = [];
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    keepOut.push(pTranslate([SIDE_FRONT_HOLE_Y, z], circleProfile(SCREW_BOSS_D / 2, 20)));
    if (wantsRearAnchor) {
      keepOut.push(pTranslate([rearAnchorY, z], circleProfile(SCREW_BOSS_D / 2, 20)));
    }
    if (depth >= MID_BAR_MIN_DEPTH) {
      keepOut.push(pTranslate([REAR_HOLE_Y, z], circleProfile(SCREW_BOSS_D / 2, 20)));
    }
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    for (const z of [FOOT_H + RAIL / 2, FOOT_H + bodyH - RAIL / 2]) {
      keepOut.push(pTranslate([ty, z], circleProfile(TIE_D / 2 + TIE_BOSS_MARGIN, 16)));
    }
  }
  // The tab ledges, and the solid column each tab screw threads into.
  // Measured: directly under the rack's top face there is only ~1.5 mm of
  // solid before this pocket opens up, so without the column the top screws
  // would be threading into a void.
  for (const yC of plateTabYs(depth)) {
    // The ledges themselves...
    keepOut.push(yzRect(yC - TAB_LEN / 2 - 4, yC + TAB_LEN / 2 + 4, FOOT_H - 2, FOOT_H + TAB_T + 2));
    keepOut.push(yzRect(yC - TAB_LEN / 2 - 4, yC + TAB_LEN / 2 + 4, H_TOP - TAB_T - 2, H_TOP));
    // ...and the column each tab screw threads into, running up from the
    // bottom ledge and down from the top one. These are collected separately
    // from the true keep-outs: they need material for the thread, but NOT all
    // the way out to the face — see the shallow pocket below.
    if (!screwYs.has(yC)) continue;
    for (const [za, zb] of [
      [FOOT_H + TAB_T, FOOT_H + TAB_T + TAB_SCREW_BITE + 2],
      [H_TOP - TAB_T - TAB_SCREW_BITE - 2, H_TOP - TAB_T],
    ] as [number, number][]) {
      screwColumns.push(yzRect(yC - TAB_COLUMN_D / 2, yC + TAB_COLUMN_D / 2, za, zb));
    }
  }
  cuts.push(
    translate(
      [pa, 0, 0],
      extrudeX(pDifference([pUnion(regions), ...keepOut, ...screwColumns]), pocketDepthX),
    ),
  );
  // The tab screw columns get a SHALLOWER pocket rather than none at all.
  // The thread needs material from COLUMN_FLOOR inward — it does not need the
  // column standing out flush with the face. Left full height each one was a
  // 12 mm lump at the corner that read as lightening having missed a patch,
  // and it swallowed the neighbouring accessory screw boss into the same mass.
  // Cut back to COLUMN_FLOOR it is a shallow pad, the bosses stay their own
  // distinct cylinders, and the thread still has 7 mm of material around it.
  if (screwColumns.length > 0) {
    const [ca, cb] = xr(-OVER, COLUMN_FLOOR);
    cuts.push(
      translate([ca, 0, 0], extrudeX(pDifference([pUnion(screwColumns), ...keepOut]), cb - ca)),
    );
  }

  // ---- Wall mount ----------------------------------------------------------
  const wallMount = rack.wallMount ?? 'none';
  if (wallMount === 'ears') {
    // Rear flange blade pointing outward, gusseted at each screw. Prints
    // with the panel lying inner-face-down; the blade rises as a wall.
    const [ba, bb] = mirror ? [width - OVER, width + EAR_REACH] : [-EAR_REACH, OVER];
    solid.push(translate([ba, depth - EAR_T, FOOT_H], cube([bb - ba, EAR_T, bodyH])));
    const screws = earScrewsPerSide(bodyH);
    const xC = mirror ? width + EAR_REACH / 2 : -EAR_REACH / 2;
    const tipX = mirror ? width + EAR_REACH - 4 : -(EAR_REACH - 4);
    const rootX = mirror ? width - OVER : OVER;
    /** Horizontal triangular gusset bracing the blade back to the panel. */
    const gusset = (zTop: number): void => {
      solid.push(
        triPrismZ(
          [
            [tipX, depth - EAR_T + 0.5],
            [rootX, depth - EAR_T + 0.5],
            [rootX, depth - EAR_T - 24],
          ],
          zTop - GUSSET_T,
          zTop,
        ),
      );
    };
    for (let i = 0; i < screws; i++) {
      const z = FOOT_H + (bodyH * (i + 1)) / (screws + 1);
      // The user's own wall fixings, not ours: the diameters stay explicit
      // overrides rather than a table lookup, because whatever goes into the
      // wall is whatever they have.
      cuts.push(
        screwHole({
          size: 'M4',
          at: [xC, depth - EAR_T, z],
          axis: '+y',
          through: EAR_T,
          clearanceD: WALL_SCREW_D,
          head: 'socket-cap',
          headD: WALL_HEAD_D,
          recess: WALL_HEAD_RECESS,
          segments: 24,
          recessSegments: 32,
        }),
      );
      gusset(z - 8);
    }
    // ...and brace the ENDS of the blade, not just under the screws. The screws
    // are spread through the middle of the height by construction, which left
    // the top and bottom of the blade as unbraced cantilever — the corners that
    // peel first when a heavy rack tries to rotate off the wall.
    gusset(FOOT_H + GUSSET_T + 2);
    gusset(FOOT_H + bodyH - 2);
  } else if (wallMount === 'cleat') {
    // French-cleat hook: the panel keeps full depth only ABOVE a 45° seat
    // plane near the top rear (that full-depth region IS the catch — it
    // rests on the wall cleat's beveled top); everything in the rear band
    // below it is relieved by the cleat's thickness so the rack slides down
    // the wall onto the cleat. A wall strip that protrudes from the wall
    // makes a truly flush back geometrically impossible — the cleat +
    // bottom spacer strips ARE the 15 mm standoff plane. For a dead-flush
    // wall mount use 'keyhole' instead.
    const notchD = CLEAT_D + CLEAT_FIT;
    const seatZ = FOOT_H + bodyH - CLEAT_SEAT_DROP; // seat height at its front (low) edge
    const [na, nb] = xr(-OVER, SIDE_T + OVER);
    const diag = (notchD + OVER) * Math.SQRT2;
    cuts.push(
      translate(
        [na, depth - notchD, seatZ],
        rotate([45, 0, 0], translate([0, 0, -diag], cube([nb - na, diag, diag]))),
      ),
    );
    cuts.push(translate([na, depth - notchD, -OVER], cube([nb - na, notchD + OVER, seatZ + 2 + OVER])));
  } else if (wallMount === 'keyhole') {
    // Keyhole hangers: the FLUSH wall option. The rear face stays a flat
    // plane; two keyholes per side accept pan-head screws driven into the
    // wall — drop the rack over the heads and slide down to lock. The entry
    // circle passes the screw head; the narrow slot traps its shank behind
    // a KEY_FACE_T face wall while a widened internal cavity gives the head
    // room to travel. Cut into the solid rear band (wall mounts keep it
    // unpocketed), centered in the panel thickness.
    const cx = mirror ? width - SIDE_T / 2 : SIDE_T / 2;
    for (const zEntry of [FOOT_H + bodyH - 30, FOOT_H + bodyH * 0.45]) {
      // Entry circle, cut from the rear face inward (cylinder re-aimed -y).
      cuts.push(
        translate([cx, depth + OVER, zEntry], rotate([90, 0, 0], cylinder(KEY_DEPTH + OVER, KEY_HEAD_D / 2, 32))),
      );
      // Shank slot through the face wall, running DOWN from the entry.
      cuts.push(
        translate(
          [cx - KEY_SLOT_W / 2, depth - KEY_DEPTH, zEntry - KEY_TRAVEL],
          cube([KEY_SLOT_W, KEY_DEPTH + OVER, KEY_TRAVEL]),
        ),
      );
      // Head cavity behind the face wall (blind — no overshoot, or it
      // would breach the wall that does the trapping).
      cuts.push(
        translate(
          [cx - KEY_HEAD_D / 2 - 0.5, depth - KEY_DEPTH, zEntry - KEY_TRAVEL],
          cube([KEY_HEAD_D + 1, KEY_DEPTH - KEY_FACE_T, KEY_TRAVEL]),
        ),
      );
    }
  }

  const base = difference([union(solid), ...cuts]);

  // ---- Fan mounts ----------------------------------------------------------
  // A fan gets a PAD carrying its bolt circle, hung off the surrounding frame
  // by two rails — not a strip. A strip, whichever way it ran, slabbed over
  // the vent windows it crossed: even lightened it left POCKET_SKIN there, so
  // the panel came out closed exactly where the air was meant to move. With a
  // fan on each side (one pushing, one pulling) the windows are the intake and
  // exhaust path, so nothing may close them.
  //
  // The pad is full thickness — it is the fan's flange seat and the four bolts
  // thread into it — and it is added AFTER the window/pocket cuts so nothing
  // carves it. Rails run to the nearest structural members on whichever axis
  // has the shorter worst-case gap, and overrun 3 mm into them so they fuse
  // rather than butt. Opening + standard 4-bolt pattern cut through.
  const fans = (rack.fans ?? []).filter((f) => (f.side === 'left') === !mirror);
  if (fans.length === 0) return base;
  const strips: BuildOp[] = [];
  const fanCuts: BuildOp[] = [];
  // The strips fuse AFTER the base cuts, so they would bury any screw/tie
  // column they overlap — re-drill every column through the final solid.
  // Every column: a horizontal strip runs the full depth, so it crosses the
  // rear anchor too, not just the front and mid ones.
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    const column = (y: number): BuildOp =>
      screwHole({ size: 'M5', at: [holeX, y, z], axis: '+x', through: holeLen, segments: 24 });
    fanCuts.push(column(SIDE_FRONT_HOLE_Y));
    if (depth >= MID_BAR_MIN_DEPTH) fanCuts.push(column(REAR_HOLE_Y));
    if (hasFullDepthShelf(rack)) fanCuts.push(column(depth - REAR_ANCHOR_INSET));
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    fanCuts.push(translate([holeX, ty, FOOT_H + RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
    fanCuts.push(translate([holeX, ty, FOOT_H + bodyH - RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
  }
  // ...and the tab ledges: a vertical fan strip spans rail-to-rail, so one landing on a
  // ledge would fill it right back in.
  for (const ty of plateTabYs(depth)) {
    const y0 = ty - TAB_LEN / 2 - TAB_SLACK;
    const dy = TAB_LEN + 2 * TAB_SLACK;
    fanCuts.push(box(tabEdge - TAB_REACH - TAB_SLACK, SIDE_T + OVER, y0, FOOT_H, dy, TAB_T));
    fanCuts.push(
      box(tabEdge - TAB_REACH - TAB_SLACK, SIDE_T + OVER, y0, H_TOP - TAB_T, dy, TAB_T + OVER),
    );
  }
  const [sx0, sx1] = xr(0, SIDE_T);
  // Fan cuts reuse holeX/holeLen — the SAME lateral start the screw columns
  // use — rather than their own interval.
  //
  // They had `xr(-OVER, 0)`, whose mirrored form is [width, width + OVER]. On
  // the right-hand panel that put the cutting cylinder's start ON the outer
  // face, extending +x AWAY from the part, so every fan cut landed in thin air
  // and the panel came out a solid wall. Only the left panel was ever right,
  // which is why it looked like "the second fan doesn't work".
  for (const fan of fans) {
    const spec = FAN_SPECS[fan.size] ?? FAN_SPECS[80]!;
    const { y: yC, z: zC } = fanCenter(fan, dims);
    // Pad: big enough for the bolt circle with an edge, and for the opening
    // rim. Everything outside it stays window.
    const padHalf = Math.max(spec.bolt / 2 + FAN_BOLT_EDGE, spec.opening / 2 + 3);
    const [padY0, padY1] = [yC - padHalf, yC + padHalf];
    const [padZ0, padZ1] = [zC - padHalf, zC + padHalf];
    strips.push(translate([sx0, padY0, padZ0], cube([sx1 - sx0, 2 * padHalf, 2 * padHalf])));

    // What the rails can hang from. Along y that is the structural span the
    // fan sits between (front band / rear rib / rear band) — the `windows`
    // rects are already inset 4 mm from those, so a rail ending on one would
    // stop in mid-air. Along z it is the top and bottom rails.
    const span = spans.find(([a, b]) => yC > a && yC < b);
    const gapY: [number, number] = span
      ? [Math.max(0, padY0 - span[0]), Math.max(0, span[1] - padY1)]
      : [0, 0];
    const gapZ: [number, number] = [
      Math.max(0, padZ0 - (FOOT_H + RAIL)),
      Math.max(0, FOOT_H + bodyH - RAIL - padZ1),
    ];
    // Worst gap, not total: a pad already touching on one side and reaching
    // 30 mm on the other is a cantilever, however small the sum looks.
    const runY = !span || Math.max(...gapY) <= Math.max(...gapZ);
    // A rail is SCREW_BOSS_D wide, so where one crosses a screw column it
    // gives that hole exactly the boss the panel's own lightening leaves.
    const railOff = padHalf - FAN_RAIL_W / 2;
    if (runY && span) {
      for (const zr of [zC - railOff, zC + railOff]) {
        for (const [a, b] of [
          [span[0] - 3, padY0],
          [padY1, span[1] + 3],
        ] as Array<[number, number]>) {
          if (b - a <= 0) continue;
          strips.push(translate([sx0, a, zr - FAN_RAIL_W / 2], cube([sx1 - sx0, b - a, FAN_RAIL_W])));
        }
      }
    } else if (!runY) {
      for (const yr of [yC - railOff, yC + railOff]) {
        for (const [a, b] of [
          [FOOT_H + RAIL - 3, padZ0],
          [padZ1, FOOT_H + bodyH - RAIL + 3],
        ] as Array<[number, number]>) {
          if (b - a <= 0) continue;
          strips.push(translate([sx0, yr - FAN_RAIL_W / 2, a], cube([sx1 - sx0, FAN_RAIL_W, b - a])));
        }
      }
    }
    fanCuts.push(translate([holeX, yC, zC], axisCylinder('+x', holeLen, spec.opening / 2, 64)));
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        fanCuts.push(
          // The screws that ship with the fan: a self-tapper with no metric
          // size, so the hole is named outright rather than looked up.
          screwStarter({
            size: 'M4',
            at: [holeX, yC + (sy * spec.bolt) / 2, zC + (sz * spec.bolt) / 2],
            axis: '+x',
            depth: holeLen,
            pilotD: FAN_SCREW_D,
            segments: 20,
          }),
        );
      }
    }
  }
  return difference([union([base, ...strips]), ...fanCuts]);
}

/**
 * Seat centres along y. They sit over the stacking feet so the bottom rebate's
 * floor is backed by the full foot depth, plus a mid seat on deep racks so the
 * plate is not carried by its two ends alone. Symmetric about depth/2, which is
 * what lets the top plate be the same printed part, flipped.
 */
/**
 * Tab centres. Three constraints pin these, and they nearly conflict:
 *  - symmetric about depth/2, so the flipped install lands on the same ledges;
 *  - wholly over a stacking foot, which is what the bottom tab lands on;
 *  - clear of the front accessory screw column at SIDE_FRONT_HOLE_Y. Centring
 *    on the foot (y = 19) puts the tab screw 3 mm from that column, and with
 *    radii summing to 4.7 the two holes break into each other — the tab screw
 *    would run out into slot 0's clearance hole. Sitting the tab at the FRONT
 *    of the foot instead opens that to 7 mm.
 */
export function plateTabYs(depth: number): number[] {
  const ys = [...plateScrewYs(depth)];
  // A deep rack carried only at its four corners sags across the middle of a
  // 5 mm latticed deck; the old rebate joint had a mid seat for this. The mid
  // tab is SUPPORT ONLY — it takes no screw. Giving it one means reserving a
  // solid column at depth/2, and the only way to do that is to split the vent
  // window there, which measured ~100 cm3 per panel. A tab that just carries
  // the deck costs nothing and is what the sag actually needs.
  if (depth >= MID_BAR_MIN_DEPTH) ys.push(depth / 2);
  return ys;
}

/** Tab centres that additionally take a screw: the two ends, where the panel
 *  can give the thread a solid column without eating a vent window. */
export function plateScrewYs(depth: number): number[] {
  const yc = FOOT_INSET + TAB_LEN / 2;
  return [yc, depth - yc];
}

/**
 * Top/bottom plate: a vented deck spanning between the sides, carried by four
 * corner tabs that drop into ledges in the side rails and are screwed down
 * from outside. One printed part serves both ends — the top is this same plate
 * turned over (see buildRackNodes), which is why every y feature is symmetric
 * about depth/2 and the tabs sit on the face that points OUT of the rack.
 *
 * Print it OUTER FACE DOWN: the tabs are flush with that face, so the whole
 * underside is one flat plane on the bed and nothing needs support. The head
 * counterbores open downward and their floors bridge — a short annular bridge
 * slicers handle cleanly.
 */
function buildPlate(dims: RackDims, notchSolid: Profile[] = [], floorRibs = false): BuildOp {
  const { plateW, depth } = dims;
  const x0 = SIDE_T + SIDE_CLEAR;
  const plateOutline = pTranslate([x0, 0], rectProfile(plateW, depth));

  // Keep the deck solid where each tab roots into it, so the lattice never
  // undercuts a tab it has to carry.
  const tabKeepOut: Profile[] = [];
  for (const yC of plateTabYs(depth)) {
    for (const nearLeft of [true, false]) {
      const a = nearLeft ? x0 : x0 + plateW - TAB_REACH - 8;
      tabKeepOut.push(
        pTranslate([a, yC - TAB_LEN / 2 - 4], rectProfile(TAB_REACH + 8, TAB_LEN + 8)),
      );
    }
  }
  // Downstand stiffening ribs, and the deck kept SOLID where they attach: a rib
  // rising off an open lattice cell is neither a T-section nor printable
  // without bridging.
  const ribProfiles: Profile[] = [];
  if (floorRibs) {
    ribProfiles.push(pDifference([plateOutline, pOffset(plateOutline, -FLOOR_RIB_W, 'miter')]));
    for (let y = FLOOR_RIB_PITCH; y < depth - FLOOR_RIB_W; y += FLOOR_RIB_PITCH) {
      ribProfiles.push(pTranslate([x0, y], rectProfile(plateW, FLOOR_RIB_W)));
    }
  }
  // ...and the ribs notched clear of the tab screws' driver paths.
  //
  // The bottom plate's tab screws are driven UP from the rack's underside, so a
  // driver has to reach each head counterbore through the very face the ribs
  // hang off. Measured on a 350x300 rack, the perimeter rib left 18.5 mm3
  // standing in every one of those four Ø10.8 access circles. Same failure as a
  // rib bridging a cable notch: the rib is right, the thing it crosses is right,
  // and nobody subtracted one from the other.
  if (ribProfiles.length > 0) {
    const access: Profile[] = [];
    for (const yC of plateScrewYs(depth)) {
      for (const dir of [-1, 1] as const) {
        const edge = dir < 0 ? x0 : x0 + plateW;
        access.push(
          pTranslate(
            [dir < 0 ? edge - TAB_SCREW_INSET : edge + TAB_SCREW_INSET, yC],
            circleProfile(TAB_ACCESS_D / 2, 32),
          ),
        );
      }
    }
    for (let i = 0; i < ribProfiles.length; i++) {
      ribProfiles[i] = pDifference([ribProfiles[i]!, ...access]);
    }
  }

  const deck = pDifference([
    plateOutline,
    lightenPocket(plateOutline, {
      rim: 15,
      rib: 3.5,
      pitch: 14,
      keepOut: [...tabKeepOut, ...notchSolid, ...ribProfiles],
    }),
  ]);

  const solid: BuildOp[] = [extrude(deck, PLATE_T)];
  if (ribProfiles.length > 0) {
    // Below the OUTER face, into the 5 mm of air under the floor. 1 mm of
    // ground clearance is left on purpose — see FLOOR_RIB_D.
    solid.push(translate([0, 0, -FLOOR_RIB_D], extrude(pUnion(ribProfiles), FLOOR_RIB_D)));
  }
  const cuts: BuildOp[] = [];
  const screwYs = new Set(plateScrewYs(depth));
  for (const yC of plateTabYs(depth)) {
    for (const dir of [-1, 1] as const) {
      const edge = dir < 0 ? x0 : x0 + plateW;
      // Overlap the deck by TAB_MERGE rather than butting exactly against it.
      // The solid is identical either way — the deck is solid here, well inside
      // the lattice's rim — but an exact face-to-face union leaves coincident
      // vertices along the seam, and a slicer reading the de-indexed STL sees
      // those as a mesh needing repair. Overlapping removes the seam.
      const xa = dir < 0 ? edge - TAB_REACH : edge - TAB_MERGE;
      solid.push(
        translate([xa, yC - TAB_LEN / 2, 0], cube([TAB_REACH + TAB_MERGE, TAB_LEN, TAB_T])),
      );
      if (!screwYs.has(yC)) continue; // mid tab is a rest, not a fixing
      const axis = dir < 0 ? edge - TAB_SCREW_INSET : edge + TAB_SCREW_INSET;
      // Thread-width clearance the whole way through, and a counterbore in the
      // OUTER face so the head finishes flush — one call, because they are one
      // hole. The recess carries more facets than the shank: it is a seating
      // face the head bears on, and it shows on the finished part.
      cuts.push(
        screwHole({
          size: 'M5',
          at: [axis, yC, 0],
          axis: '+z',
          through: TAB_T,
          head: 'button',
          recess: 'flush',
          segments: 24,
          recessSegments: 32,
        }),
      );
    }
  }
  return difference([union(solid), ...cuts]);
}

/**
 * Receiving hole in an accessory end rib — one per slot per side. This is the
 * joint that holds the whole rack together: the M5 goes in from OUTSIDE the
 * side panel, through its clearance column, and taps into this.
 *
 * Shared by the faceplate, the shelf and the cable tray, which had three
 * copies of the same cylinder between them.
 */
function ribStarter(rx: number, y: number, z: number): BuildOp {
  return screwStarter({
    size: 'M5',
    at: [rx - OVER, y, z],
    axis: '+x',
    depth: RIB_W + 2 * OVER,
    segments: 24,
  });
}

/** Faceplate spanning BETWEEN the side panels (recessed behind their
 *  protective front columns) + threaded end ribs — blank & keystone. */
function faceplateBase(dims: RackDims, nSlots: number, plateDepth: number): { solid: BuildOp[]; cuts: BuildOp[]; h: number } {
  const { width, plateW } = dims;
  const h = nSlots * SLOT_PITCH - 0.5;
  const solid: BuildOp[] = [translate([SIDE_T + SIDE_CLEAR, 0, 0], cube([plateW, plateDepth, h]))];
  const ribX: number[] = [SIDE_T + SIDE_CLEAR, width - SIDE_T - SIDE_CLEAR - RIB_W];
  const cuts: BuildOp[] = [];
  for (const rx of ribX) {
    solid.push(translate([rx, plateDepth - OVER, 0], cube([RIB_W, FACE_T + RIB_D - plateDepth + OVER, h])));
  }
  // One thread hole per slot per side, matching the sides' front column
  // (part-local z: the part gets translated to its slot's global z later).
  for (let k = 0; k < nSlots; k++) {
    const z = (k + 0.5) * SLOT_PITCH - 0.25;
    for (const rx of ribX) {
      cuts.push(ribStarter(rx, FRONT_HOLE_Y, z));
    }
  }
  return { solid, cuts, h };
}

/** N-slot blank faceplate (drill-it-yourself), 4 mm plate. */
function buildBlank(dims: RackDims, nSlots: number): BuildOp {
  const { solid, cuts } = faceplateBase(dims, nSlots, FACE_T);
  return difference([union(solid), ...cuts]);
}

/** Keystone patch plate: as many standard jacks as the width allows, plus a
 *  cable pass-through when there's room. Jacks insert from the BACK; their
 *  latch clicks over the 2 mm front web. */
function buildKeystone(dims: RackDims, nSlots: number): { op: BuildOp; jacks: number } {
  const { width } = dims;
  const base = faceplateBase(dims, nSlots, FACE_T);
  const h = base.h;
  const usable0 = SIDE_T + SIDE_CLEAR + RIB_W + 6;
  const usable1 = width - SIDE_T - SIDE_CLEAR - RIB_W - 6;
  const jacks = Math.max(1, Math.floor((usable1 - usable0) / KS_PITCH));
  const rowW = jacks * KS_PITCH;
  const rowX0 = usable0 + (usable1 - usable0 - rowW) / 2;
  const zC = h / 2;
  const solid = [...base.solid];
  const cuts = [...base.cuts];
  // Boss band behind the plate spanning the jack row, giving the jacks a
  // full-depth socket to seat in.
  solid.push(
    translate(
      [rowX0 - 4, FACE_T - OVER, zC - KS_BODY_H / 2 - 4],
      cube([rowW + 8, KS_DEPTH - FACE_T + OVER, KS_BODY_H + 8]),
    ),
  );
  for (let j = 0; j < jacks; j++) {
    const cx = rowX0 + KS_PITCH / 2 + j * KS_PITCH;
    // Front retention window through the 2 mm web…
    cuts.push(
      translate([cx - KS_WIN_W / 2, -OVER, zC - KS_WIN_H / 2], cube([KS_WIN_W, KS_WEB_T + OVER, KS_WIN_H])),
    );
    // …and body clearance behind it, out the back of the boss.
    cuts.push(
      translate(
        [cx - KS_BODY_W / 2, KS_WEB_T, zC - KS_BODY_H / 2],
        cube([KS_BODY_W, KS_DEPTH - KS_WEB_T + OVER, KS_BODY_H]),
      ),
    );
  }
  // Cable pass-through in the leftover width (right of the jack row).
  // roundedRectPrism extrudes along z; rotate X by -90° re-aims it along +y
  // so the slot pierces the plate + boss band front-to-back.
  const spare = usable1 - (rowX0 + rowW);
  if (spare >= 55) {
    const sx = rowX0 + rowW + 6;
    cuts.push(
      translate([sx, -OVER, zC + 9], rotate([-90, 0, 0], roundedRectPrism(spare - 12, 18, KS_DEPTH + 2 * OVER, 6))),
    );
  }
  return { op: difference([union(solid), ...cuts]), jacks };
}

/** Open-front vented shelf: end ribs the screws bite into + a low deck. */
function buildShelf(
  dims: RackDims,
  nSlots: number,
  shelfDepth: number,
  opts: {
    frontPlate?: boolean;
    vented?: boolean;
    /**
     * Cable pass-throughs in the shelf's REAR edge, matching the plates'.
     *
     * Only a FULL-DEPTH shelf needs them: it runs right to the rack's back
     * face, so its deck blocks the vertical cable run the plate notches exist
     * to open. A shorter shelf leaves that run clear behind it already. The
     * geometry is shared with the plates so a cable dropping through a shelf
     * lands on the opening below rather than beside it.
     */
    rearNotches?: { cx: number[]; w: number; d: number };
  } = {},
): BuildOp {
  const { width, depth, plateW } = dims;
  const vented = opts.vented !== false;
  const h = nSlots * SLOT_PITCH - 0.5;
  const d = Math.min(Math.max(60, shelfDepth), depth - FRONT_RECESS);
  const ribX: number[] = [SIDE_T + SIDE_CLEAR, width - SIDE_T - SIDE_CLEAR - RIB_W];
  const solid: BuildOp[] = [];
  const cuts: BuildOp[] = [];
  for (const rx of ribX) solid.push(translate([rx, 0, 0], cube([RIB_W, d, h])));
  // Optional faceplate closing the shelf's front opening.
  if (opts.frontPlate) {
    solid.push(translate([SIDE_T + SIDE_CLEAR, 0, 0], cube([plateW, FACE_T, h])));
  }
  // Deck at the bottom so the device opening is maximal.
  const deckX0 = SIDE_T + SIDE_CLEAR + 1;
  const deckW = width - 2 * deckX0;
  solid.push(translate([deckX0, 0, 0], cube([deckW, d, SHELF_DECK_T])));
  // Vent the deck with a triangulated rib lattice rather than parallel slots:
  // ~60% open against the slots' ~35% for a stiffer deck, and a side fan can
  // blow diagonally across it instead of only along the slot direction. The
  // end ribs are kept out — the deck overlaps them, and they carry the M5
  // threads.
  // Upstand ribs across the deck, tying the two end ribs together. The deck is
  // kept SOLID under each one: a rib rising off an open lattice cell is neither
  // a T-section nor printable without bridging.
  const shelfRibs: Profile[] = [];
  for (let y = SHELF_RIB_PITCH / 2; y < d - SHELF_RIB_W; y += SHELF_RIB_PITCH) {
    shelfRibs.push(pTranslate([deckX0, y], rectProfile(deckW, SHELF_RIB_W)));
  }
  const notch = opts.rearNotches;
  const notchKeep: Profile[] = notch
    ? notch.cx.map((cx) =>
        pTranslate([cx - notch.w / 2 - 5, d - notch.d - 5], rectProfile(notch.w + 10, notch.d + 10)),
      )
    : [];
  // One outline and one set of lattice options, shared by the pocket that cuts
  // the cross-hatch and the bars raised to slide over. Reconstructing the bars
  // separately would land them fractionally off the lattice they must sit on.
  const deckOutline = pTranslate([deckX0, 0], rectProfile(deckW, d));
  const latticeOpts = {
    // Back to 3/14 (~43% solid). Opening this to 2.6/19 saved 7.5 cm3 and cost
    // a third of the deck's material on the one accessory that carries
    // equipment — a bad trade, and the printed shelf showed it.
    rim: 10,
    rib: 3,
    pitch: 14,
  };
  if (vented) {
    const ribKeepOut = ribX
      .map((rx) => pTranslate([rx - 1, -OVER], rectProfile(RIB_W + 2, d + 2 * OVER)))
      .concat(notchKeep, shelfRibs);
    cuts.push(
      translate(
        [0, 0, -OVER],
        extrude(lightenPocket(deckOutline, { ...latticeOpts, keepOut: ribKeepOut }), 3 + 2 * OVER),
      ),
    );
  }
  // Screw holes: front column always; rear column when the shelf is long
  // enough to reach it (matches the sides' rear rib); plus a rear anchor once
  // the shelf actually reaches the back. Resolved ONCE so the hole and the
  // boss that gives it something to bite cannot disagree.
  const backCandidate = depth - REAR_ANCHOR_INSET - FRONT_RECESS;
  const backAnchorY = d >= backCandidate + 4 ? backCandidate : undefined;
  for (let k = 0; k < nSlots; k++) {
    const z = (k + 0.5) * SLOT_PITCH - 0.25;
    for (const rx of ribX) {
      cuts.push(ribStarter(rx, FRONT_HOLE_Y, z));
      if (d >= LONG_SHELF) {
        cuts.push(ribStarter(rx, ACC_REAR_HOLE_Y, z));
      }
      // ...and a third at the very back once the shelf actually reaches it.
      if (backAnchorY !== undefined) {
        cuts.push(ribStarter(rx, backAnchorY, z));
      }
    }
  }
  if (shelfRibs.length > 0) {
    solid.push(translate([0, 0, SHELF_DECK_T], extrude(pUnion(shelfRibs), SHELF_RIB_H)));
    // ...and raise ONE of the two diagonal families to the same height, so the
    // ribs are not a row of steps across the sliding direction. Clear of the
    // front lead-in and of any rear cutout.
    const family = lightenBars(deckOutline, latticeOpts)[0];
    if (family) {
      const clear: Profile[] = [
        pTranslate([deckX0 - OVER, -OVER], rectProfile(deckW + 2 * OVER, SHELF_LEAD_CLEAR + OVER)),
        ...notchKeep,
      ];
      solid.push(
        translate(
          [0, 0, SHELF_DECK_T],
          extrude(pDifference([pIntersection([family, deckOutline]), ...clear]), SHELF_RIB_H),
        ),
      );
    }
  }
  if (notch) {
    // Through the deck at the rear edge, rounded at the inner end like the
    // plates'. The deck is what blocks the cable run; the space above it is
    // open already.
    for (const cx of notch.cx) {
      const yInner = d - notch.d + notch.w / 2;
      // Full rib height, not just the deck: cutting only the deck left the
      // stiffening rib bridging straight over the cable opening.
      const thru = SHELF_DECK_T + SHELF_RIB_H + 2 * OVER;
      cuts.push(
        translate([cx - notch.w / 2, yInner, -OVER], cube([notch.w, d - yInner + OVER, thru])),
      );
      cuts.push(translate([cx, yInner, -OVER], cylinder(thru, notch.w / 2, 32)));
    }
  }
  cuts.push(...ribChannelCuts(width, ribX, d, h, nSlots, d >= LONG_SHELF, backAnchorY));
  // Side vents: perforate the rib walls laterally so a side fan blows
  // straight through the shelf (cross-flow), skipping the screw bosses.
  if (vented) {
    // Every screw column, the rear anchor included. Miss one and the vents
    // perforate the very boss its thread was supposed to bite — which is how
    // the rear anchor ended up at 83% after it moved.
    const bossYs = [
      FRONT_HOLE_Y,
      ...(d >= LONG_SHELF ? [ACC_REAR_HOLE_Y] : []),
      ...(backAnchorY !== undefined ? [backAnchorY] : []),
    ];
    const bossZs = Array.from({ length: nSlots }, (_, k) => (k + 0.5) * SLOT_PITCH - 0.25);
    for (const rx of ribX) {
      for (let vy = 22; vy <= d - 10; vy += 14) {
        for (let vz = 12; vz <= h - 8; vz += 14) {
          const nearBoss = bossYs.some((by) => Math.abs(vy - by) < 11) && bossZs.some((bz) => Math.abs(vz - bz) < 11);
          if (nearBoss) continue;
          cuts.push(translate([rx - OVER, vy, vz], axisCylinder('+x', RIB_W + 2 * OVER, 4, 20)));
        }
      }
    }
  }
  return difference([union(solid), ...cuts]);
}

/** Hollow accessory end ribs into C-channels: keep the outer wall (the
 *  screw-bearing face against the side panel), front/rear posts, and a
 *  bottom band tying into the deck; open the pocket to the TOP and the
 *  inner face so nothing bridges when printed deck-down. Solid bosses stay
 *  around every thread hole for full-width screw engagement. */
function ribChannelCuts(
  width: number,
  ribX: number[],
  d: number,
  h: number,
  nSlots: number,
  rearHoles: boolean,
  /**
   * Extra screw column for a full-depth shelf's rear anchor, in shelf-local y.
   *
   * Every screw needs a boss left standing in the hollowed rib — that solid
   * plug is what the thread bites. Adding the rear anchor hole without adding
   * its boss meant the channel hollowed straight through behind it and the
   * screw caught nothing, which is exactly how it printed.
   */
  backAnchorY?: number,
): BuildOp[] {
  const out: BuildOp[] = [];
  for (const rx of ribX) {
    const isLeft = rx < width / 2;
    const px0 = isLeft ? rx + RIB_WALL : rx - OVER;
    const px1 = isLeft ? rx + RIB_W + OVER : rx + RIB_W - RIB_WALL;
    const bosses: BuildOp[] = [];
    for (let k = 0; k < nSlots; k++) {
      const z = (k + 0.5) * SLOT_PITCH - 0.25;
      bosses.push(translate([px0, FRONT_HOLE_Y, z], axisCylinder('+x', px1 - px0, RIB_BOSS_D / 2, 24)));
      if (rearHoles) {
        bosses.push(translate([px0, ACC_REAR_HOLE_Y, z], axisCylinder('+x', px1 - px0, RIB_BOSS_D / 2, 24)));
      }
      if (backAnchorY !== undefined) {
        bosses.push(translate([px0, backAnchorY, z], axisCylinder('+x', px1 - px0, RIB_BOSS_D / 2, 24)));
      }
    }
    out.push(
      difference([
        translate([px0, 8, 8], cube([px1 - px0, d - 16, h - 8 + OVER])),
        ...bosses,
      ]),
    );
  }
  return out;
}

/** Cable tray: shelf-like ribs + a deck with tie-wrap comb fingers along the
 *  front and rear edges. Occupies 2 slots. */
function buildCableTray(dims: RackDims): BuildOp {
  const { width, depth } = dims;
  const nSlots = 2;
  const h = nSlots * SLOT_PITCH - 0.5;
  const d = Math.min(104, depth - FRONT_BAND / 2);
  const ribX: number[] = [SIDE_T + SIDE_CLEAR, width - SIDE_T - SIDE_CLEAR - RIB_W];
  const solid: BuildOp[] = [];
  const cuts: BuildOp[] = [];
  for (const rx of ribX) solid.push(translate([rx, 0, 0], cube([RIB_W, d, h])));
  const deckX0 = SIDE_T + SIDE_CLEAR + 1;
  const deckW = width - 2 * deckX0;
  solid.push(translate([deckX0, 0, 0], cube([deckW, d, TRAY_DECK_T])));
  // Comb fingers rising from both long edges: cables drop between them and
  // tie-wraps loop through the gaps.
  const fingerW = 5;
  const fingerH = 21;
  const fingerGap = 12;
  const nf = Math.floor((deckW - 10) / (fingerW + fingerGap));
  for (let i = 0; i < nf; i++) {
    const fx = deckX0 + 5 + (deckW - 10 - nf * (fingerW + fingerGap) + fingerGap) / 2 + i * (fingerW + fingerGap);
    solid.push(translate([fx, 0, 0], cube([fingerW, EAR_T, 4 + fingerH])));
    solid.push(translate([fx, d - EAR_T, 0], cube([fingerW, EAR_T, 4 + fingerH])));
  }
  for (let k = 0; k < nSlots; k++) {
    const z = (k + 0.5) * SLOT_PITCH - 0.25;
    for (const rx of ribX) {
      cuts.push(ribStarter(rx, FRONT_HOLE_Y, z));
    }
  }
  cuts.push(...ribChannelCuts(width, ribX, d, h, nSlots, false));
  // Drain the deck with the same triangulated lattice as the shelf. The 10 mm
  // rim clears both comb-finger rows, which are rooted on the deck.
  cuts.push(
    translate(
      [0, 0, -OVER],
      extrude(
        lightenPocket(pTranslate([deckX0, 0], rectProfile(deckW, d)), {
          rim: 10,
          rib: 3,
          pitch: 14,
        }),
        4 + 2 * OVER,
      ),
    ),
  );
  return difference([union(solid), ...cuts]);
}

/** The separate french-cleat strip that screws to the wall (cleat mode). */
function buildWallCleat(dims: RackDims): BuildOp {
  const { width } = dims;
  const len = width - 2 * CLEAT_FIT;
  const diag = (CLEAT_D + OVER) * Math.SQRT2;
  const body = cube([len, CLEAT_D, CLEAT_H]);
  // Slice the top at 45° so it slopes from full height at the wall face
  // (y = CLEAT_D) down toward the front: remove everything above the plane
  // z = (CLEAT_H - CLEAT_D) + y. A cube rotated +45° about x has its former
  // bottom face lying exactly on the plane z' = y', so translating that
  // rotated cube up by (CLEAT_H - CLEAT_D) leaves its interior covering the
  // exact half-space to remove across the whole cross-section.
  const wedge = translate(
    [-OVER, 0, CLEAT_H - CLEAT_D],
    rotate([45, 0, 0], cube([len + 2 * OVER, diag, diag])),
  );
  const cuts: BuildOp[] = [wedge];
  const screws = Math.max(3, Math.floor(width / 80));
  for (let i = 0; i < screws; i++) {
    const x = (len * (i + 1)) / (screws + 1);
    cuts.push(translate([x, -OVER, 9], axisCylinder('+y', CLEAT_D + 2 * OVER, WALL_SCREW_D / 2, 24)));
    cuts.push(translate([x, -OVER, 9], axisCylinder('+y', WALL_HEAD_RECESS + OVER, WALL_HEAD_D / 2, 32)));
  }
  return difference([body, ...cuts]);
}

/** Flat spacer strip for cleat mode — same depth as the cleat, mounted low
 *  on the wall so the rack hangs plumb. */
function buildWallSpacer(dims: RackDims): BuildOp {
  const len = dims.width - 2 * CLEAT_FIT;
  const cuts: BuildOp[] = [];
  const screws = Math.max(3, Math.floor(dims.width / 80));
  for (let i = 0; i < screws; i++) {
    const x = (len * (i + 1)) / (screws + 1);
    cuts.push(translate([x, -OVER, 10], axisCylinder('+y', CLEAT_D + 2 * OVER, WALL_SCREW_D / 2, 24)));
    cuts.push(translate([x, -OVER, 10], axisCylinder('+y', WALL_HEAD_RECESS + OVER, WALL_HEAD_D / 2, 32)));
  }
  return difference([cube([len, CLEAT_D, 20]), ...cuts]);
}

/**
 * Wall-mount ear screws per side.
 *
 * A loaded rack hangs off these, and the load grows with the box: a 250 mm
 * deep rack cantilevers hard off the wall, and the ear is the only thing
 * carrying it. Two screws at a third and two thirds of the height — the old
 * rule — is thin for anything of size.
 *
 * So: one screw per ~60 mm of blade and never fewer than four. Erring high is
 * deliberate — extra holes cost almost nothing to print, and more of them up
 * the blade gives more chances to land on a stud or on solid backing rather
 * than bare plasterboard. At the sample height that is five a side.
 */
export function earScrewsPerSide(bodyH: number): number {
  return Math.max(4, Math.round(bodyH / 60));
}

/**
 * Can the whole rack be printed in one piece on the selected printer?
 *
 * It is a box: it prints in its assembly orientation, so this is straight or
 * turned 90 degrees on the bed, nothing diagonal, and the full height has to
 * clear. Shared by the compiler and the panel so the offer and the checkbox
 * can never disagree.
 */
export function rackFitsWhole(rack: RackParams): boolean {
  const printer = rack.printer;
  if (!printer) return false;
  const { width, depth, totalH } = computeRackDims(rack);
  const onBed =
    (width <= printer.x && depth <= printer.y) || (depth <= printer.x && width <= printer.y);
  return onBed && totalH <= printer.z;
}

/**
 * Downstand stiffening ribs under the floor plate.
 *
 * There is 5 mm of clear air beneath the plate doing nothing — the feet are
 * under the SIDES, not under the deck — so ribs cost no space. 4 mm deep takes
 * the section from 5 mm to 9 mm where it counts, and stiffness goes as depth
 * cubed. 1 mm of ground clearance is left deliberately: ribs reaching the floor
 * would help a freestanding rack and do nothing for a wall-mounted one, which
 * is the case that needs them.
 *
 * The perimeter rib matters as much as the cross ribs. Only the END tabs bear
 * downward — the mid tab has nothing under it and merely resists uplift — so
 * the load runs to four corners, and the edge rib is the beam that gets it
 * there.
 */
const FLOOR_RIB_D = 4;
const FLOOR_RIB_W = 3;
const FLOOR_RIB_PITCH = 45;
/** Plate span past which ribs default ON. */
const FLOOR_RIB_AUTO_SPAN = 260;

/** Ribs on? Explicit setting wins; otherwise on once the span gets wide. */
export function floorRibsEnabled(rack: RackParams): boolean {
  if (rack.floorRibs !== undefined) return rack.floorRibs;
  return computeRackDims(rack).plateW >= FLOOR_RIB_AUTO_SPAN;
}

/** Keep notches clear of the plate's lattice rim and its tab roots. */
const NOTCH_EDGE_MARGIN = 18;
/** Minimum wall left between two adjacent notches. */
const NOTCH_GAP = 6;

/**
 * Cable / power pass-throughs in a plate's REAR edge, cut in ASSEMBLY space.
 *
 * Assembly space matters: the top plate is the bottom one turned over, and
 * that flip maps the authored rear edge to the front. Cutting here — after the
 * flip — puts the notch at the back of whichever plate carries it, at the cost
 * of the two plates no longer being one printed part. That trade is the user's
 * to make, so notches are opt-in and the panel says so.
 *
 * Slots open at the rear edge and are rounded at their inner end: a square
 * inside corner is where a loaded plate starts a crack, and a cable dragged
 * over a sharp edge is a cable that eventually shorts.
 */
/**
 * Where the cable notches sit, sized and clamped — resolved ONCE so the plates
 * and any full-depth shelf cut the same slots at the same x. A cable dropping
 * through a shelf has to line up with the plate opening below it, so these
 * cannot be computed twice.
 */
export function cableNotchGeometry(
  rack: RackParams,
  dims: RackDims,
): { cx: number[]; w: number; d: number } | null {
  const cfg = rack.cableNotches;
  if (!cfg || cfg.count < 1) return null;
  const x0 = SIDE_T + SIDE_CLEAR;
  const span = dims.plateW - 2 * NOTCH_EDGE_MARGIN;
  if (span <= 0) return null;
  // Clamp so N notches plus the walls between them actually fit.
  const w = Math.max(4, Math.min(cfg.width, span / cfg.count - NOTCH_GAP));
  if (w < 4) return null;
  const d = Math.max(4, Math.min(cfg.depth, dims.depth * 0.4));
  const cx: number[] = [];
  for (let i = 0; i < cfg.count; i++) {
    cx.push(x0 + NOTCH_EDGE_MARGIN + (span * (i + 0.5)) / cfg.count);
  }
  return { cx, w, d };
}

function plateNotchCuts(rack: RackParams, dims: RackDims, zBase: number, ribD = 0): BuildOp[] {
  const g = cableNotchGeometry(rack, dims);
  if (!g) return [];
  const { w, d } = g;
  const cuts: BuildOp[] = [];
  // The FULL section, not just the deck: the floor ribs hang below the plate's
  // outer face, and the perimeter rib runs along the very edge the notches open
  // through. Cutting only PLATE_T left that rib bridging straight across the
  // mouth of every notch — the same trap the shelf ribs hit.
  const z0 = zBase - ribD - OVER;
  const thru = PLATE_T + ribD + 2 * OVER;
  for (const cx of g.cx) {
    const yInner = dims.depth - d + w / 2;
    cuts.push(translate([cx - w / 2, yInner, z0], cube([w, dims.depth - yInner + OVER, thru])));
    cuts.push(translate([cx, yInner, z0], cylinder(thru, w / 2, 32)));
  }
  return cuts;
}

/**
 * The same notches as flat footprints in the plate's OWN coordinates, so the
 * deck's lattice can keep solid material around them.
 *
 * Without this the walls between notches land wherever the lattice happens to
 * be open and come away as detached fingers — eight notches at the minimum
 * spacing split the plate into NINE separate bodies. The flip is why this
 * needs the plate argument: a rear notch is at authored y≈depth on the bottom
 * plate and authored y≈0 on the top one.
 */
function notchKeepOut(rack: RackParams, dims: RackDims, which: 'top' | 'bottom'): Profile[] {
  const cfg = rack.cableNotches;
  if (!cfg || (cfg.plate !== 'both' && cfg.plate !== which)) return [];
  const g = cableNotchGeometry(rack, dims);
  if (!g) return [];
  const pad = 5;
  return g.cx.map((cx) =>
    pTranslate(
      [cx - g.w / 2 - pad, which === 'bottom' ? dims.depth - g.d - pad : -pad],
      rectProfile(g.w + 2 * pad, g.d + 2 * pad),
    ),
  );
}

/** Apply the rear cable notches to a plate, if this one carries them. */
function withNotches(
  op: BuildOp,
  rack: RackParams,
  dims: RackDims,
  which: 'top' | 'bottom',
  zBase: number,
  ribD = 0,
): BuildOp {
  const cfg = rack.cableNotches;
  if (!cfg || (cfg.plate !== 'both' && cfg.plate !== which)) return op;
  const cuts = plateNotchCuts(rack, dims, zBase, ribD);
  return cuts.length > 0 ? difference([op, ...cuts]) : op;
}

/**
 * Optional one-piece exports./**
 * Optional one-piece exports. Printing the rack fused is far stronger than
 * bolting it together, at the cost of a very long print and heavy internal
 * support — so these are OFFERED, never substituted for the separate parts,
 * and only when the whole thing fits the selected printer.
 *
 * Two variants, because they are not the same gamble:
 *  - FRAME: sides + plates. They already touch — the plate tabs seat in their
 *    ledges with no z clearance — so this is a plain union of existing
 *    geometry, and support stays in the open interior where a hand can reach.
 *  - ALL: accessories too. Those sit on SIDE_CLEAR and do NOT touch, so they
 *    are welded to the sides deliberately. Shelf positions become permanent
 *    and the support under each deck is sealed in, reachable only through the
 *    side vent windows.
 */
function assembledNodes(
  rack: RackParams,
  dims: RackDims,
  built: BuildNode[],
  accessoryOps: BuildOp[],
): BuildNode[] {
  const { width, depth } = dims;
  if (!rack.assembledExport || !rackFitsWhole(rack)) return [];

  const FRAME_IDS = ['rack-side-left', 'rack-side-right', 'rack-bottom', 'rack-top'];
  const frameOps = built.filter((n) => FRAME_IDS.includes(n.id)).map((n) => n.op);
  if (frameOps.length === 0) return [];

  // Weld the plates to the sides along their FULL length.
  //
  // Unioning the frame as it stands yields a single Manifold component, which
  // is a much weaker statement than it sounds: the plate tabs only TOUCH their
  // ledges on coincident faces, and everywhere else a SIDE_CLEAR slot runs the
  // whole depth. Measured, just 26% of each plate edge was bridged — the three
  // tabs, 66 mm of 250 — leaving a 1.1 kg frame hanging off six small tabs and
  // a 0.3 mm crack down both sides. Fit clearance is for parts that come apart;
  // this one is printed as a unit, so the clearance is filled.
  const plateWelds: BuildOp[] = [];
  const wt = SIDE_CLEAR + 0.8; // bites 0.4 mm into the panel and 0.4 into the deck
  for (const zPlate of [FOOT_H, FOOT_H + dims.bodyH - PLATE_T]) {
    plateWelds.push(translate([SIDE_T - 0.4, 0, zPlate], cube([wt, depth, PLATE_T])));
    plateWelds.push(
      translate([width - SIDE_T - SIDE_CLEAR - 0.4, 0, zPlate], cube([wt, depth, PLATE_T])),
    );
  }

  const out: BuildNode[] = [
    { id: 'rack-assembled-frame', op: union([...frameOps, ...plateWelds]) },
  ];

  if (accessoryOps.length > 0) {
    // Weld each accessory to both sides across the fit clearance. The slab is
    // backed by the accessory's full-height end rib on one face and the panel
    // on the other, so it is a joint rather than a floating fin.
    const welds: BuildOp[] = [];
    for (const op of accessoryOps) {
      const bb = aabbOfOp(op);
      if (!bb) continue;
      const y0 = bb.min[1];
      const dy = bb.max[1] - y0;
      const z0 = bb.min[2];
      const dz = bb.max[2] - z0;
      const t = SIDE_CLEAR + 0.8; // bites 0.4 mm into the panel and 0.4 into the rib
      welds.push(translate([SIDE_T - 0.4, y0, z0], cube([t, dy, dz])));
      welds.push(translate([width - SIDE_T - SIDE_CLEAR - 0.4, y0, z0], cube([t, dy, dz])));
    }
    out.push({
      id: 'rack-assembled-all',
      op: union([...frameOps, ...plateWelds, ...accessoryOps, ...welds]),
    });
  }
  return out;
}

export interface AccessorySpace {
  /** Index into rack.accessories. */
  index: number;
  slots: number;
  /** First slot the accessory occupies, after the overflow clamp. */
  startSlot: number;
  /**
   * The clear box a device can occupy on this accessory, or null for things
   * with no deck (a blank or keystone faceplate holds nothing).
   */
  usable: { w: Mm; d: Mm; h: Mm } | null;
}

/**
 * What actually fits on each accessory (issue #141).
 *
 * Slots are a mounting pitch, not usable space: a 3-slot shelf is not 49.5 mm
 * of room, because the deck takes its thickness off the bottom and the next
 * accessory starts at its own slot boundary. Height is measured from the deck's
 * TOP face to the underside of whatever is above — the next accessory, or the
 * top plate when the shelf is the highest thing in the rack.
 *
 * The slot cursor here mirrors buildRackNodes exactly, overflow clamp included.
 * Computing it any other way would let the number drift away from the geometry
 * it claims to describe.
 */
export function accessorySpaces(rack: RackParams): AccessorySpace[] {
  const dims = computeRackDims(rack);
  const accs = rack.accessories ?? [];
  const starts: number[] = [];
  let cursor = 0;
  for (const acc of accs) {
    const n = accessorySlots(acc);
    starts.push(Math.min(cursor, Math.max(0, dims.slots - n)));
    cursor += n;
  }
  // Between the end ribs, not the rack's outside width — a device sits between
  // them, and the difference is ~55 mm at sample size.
  const usableW = dims.width - 2 * (SIDE_T + SIDE_CLEAR + RIB_W);
  return accs.map((acc, i) => {
    const n = accessorySlots(acc);
    const startSlot = starts[i]!;
    const base = { index: i, slots: n, startSlot };
    if (acc.type !== 'shelf' && acc.type !== 'cable-tray') return { ...base, usable: null };
    // A device rests on the shelf's stiffening ribs, not on the deck between
    // them, so the usable height starts at the RIB TOP.
    const deckT = acc.type === 'cable-tray' ? TRAY_DECK_T : SHELF_DECK_T + SHELF_RIB_H;
    const deckTop = dims.slotZ(startSlot) + 0.25 + deckT;
    // Only a DECKED accessory forms a ceiling. A blank or keystone faceplate
    // above is 4 mm of plate at the very front and blocks nothing behind it —
    // measured against the compiled geometry, a shelf under a blank has the
    // full run up to the next shelf, not one slot span. Counting faceplates
    // here under-reported a 3-slot shelf as 46.5 mm when it really had 79.5.
    let ceiling = FOOT_H + dims.bodyH - PLATE_T;
    for (let j = 0; j < accs.length; j++) {
      const above = accs[j]!;
      if (above.type !== 'shelf' && above.type !== 'cable-tray') continue;
      if (starts[j]! >= startSlot + n) ceiling = Math.min(ceiling, dims.slotZ(starts[j]!) + 0.25);
    }
    const d =
      acc.type === 'cable-tray'
        ? Math.min(104, dims.depth - FRONT_BAND / 2)
        : shelfDeckDepth(acc.shelfDepth, dims.depth);
    return {
      ...base,
      usable: {
        w: Math.max(0, usableW),
        d: Math.max(0, d),
        h: Math.max(0, ceiling - deckTop),
      },
    };
  });
}

/** Compile the whole rack to one BuildNode per printable part, positioned in
 *  assembly space so the viewport previews the assembled rack. */
export function buildRackNodes(rack: RackParams): BuildNode[] {
  const dims = computeRackDims(rack);
  // One local for both the build and the notch depth: the notches have to cut
  // as deep as the ribs actually reach, so these two must never drift apart.
  const floorRibs = floorRibsEnabled(rack);
  const nodes: BuildNode[] = [
    { id: 'rack-side-left', op: buildSide(rack, dims, false) },
    { id: 'rack-side-right', op: buildSide(rack, dims, true) },
    {
      id: 'rack-bottom',
      op: withNotches(
        translate([0, 0, FOOT_H], buildPlate(dims, notchKeepOut(rack, dims, 'bottom'), floorRibs)),
        rack,
        dims,
        'bottom',
        FOOT_H,
        floorRibs ? FLOOR_RIB_D : 0,
      ),
    },
    // Same printed part, turned over: the tabs sit on the face that points OUT
    // of the rack, and every y feature is symmetric about depth/2, so the flip
    // lands them back in the same ledges.
    {
      id: 'rack-top',
      op: withNotches(
        translate(
          [0, dims.depth, FOOT_H + dims.bodyH],
          rotate([180, 0, 0], buildPlate(dims, notchKeepOut(rack, dims, 'top'))),
        ),
        rack,
        dims,
        'top',
        FOOT_H + dims.bodyH - PLATE_T,
      ),
    },
  ];

  // Accessories stack bottom-up in their mounted positions for the preview.
  const accessoryOps: BuildOp[] = [];
  let cursor = 0;
  (rack.accessories ?? []).forEach((acc, i) => {
    const n = accessorySlots(acc);
    const z0 = dims.slotZ(Math.min(cursor, Math.max(0, dims.slots - n))) + 0.25;
    cursor += n;
    let op: BuildOp;
    if (acc.type === 'blank') op = buildBlank(dims, n);
    else if (acc.type === 'keystone') op = buildKeystone(dims, n).op;
    else if (acc.type === 'shelf')
      op = buildShelf(dims, n, resolveShelfDepth(acc.shelfDepth, dims.depth), {
        frontPlate: acc.frontPlate,
        vented: acc.vented,
        // Only a full-depth shelf reaches the back and blocks the cable run.
        rearNotches: acc.shelfDepth === 'full' ? (cableNotchGeometry(rack, dims) ?? undefined) : undefined,
      });
    else op = buildCableTray(dims);
    // Recessed behind the sides' protective front columns (FRONT_RECESS).
    const placed = translate([0, FRONT_RECESS, z0], op);
    accessoryOps.push(placed);
    nodes.push({ id: `rack-${acc.type}-${i}`, op: placed });
  });

  nodes.push(...assembledNodes(rack, dims, nodes, accessoryOps));

  if (rack.wallMount === 'cleat') {
    const seatZ = FOOT_H + dims.bodyH - CLEAT_SEAT_DROP;
    nodes.push({
      id: 'rack-wall-cleat',
      op: translate([CLEAT_FIT, dims.depth - CLEAT_D, seatZ - CLEAT_H + CLEAT_D], buildWallCleat(dims)),
    });
    // Bottom spacer: same footprint strip (no bevel) screwed to the wall so
    // the hanging rack sits plumb instead of leaning its feet on drywall.
    nodes.push({
      id: 'rack-wall-spacer',
      op: translate([CLEAT_FIT, dims.depth - CLEAT_D, FOOT_H], buildWallSpacer(dims)),
    });
  }
  return nodes;
}
