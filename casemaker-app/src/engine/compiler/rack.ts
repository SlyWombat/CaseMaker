import type { RackParams, RackAccessory } from '@/types';
import {
  cube,
  cylinder,
  axisCylinder,
  circleProfile,
  difference,
  extrude,
  extrudeX,
  lightenPocket,
  mesh,
  pDifference,
  pOffset,
  poly,
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
} from './buildPlan';

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
/** M5 cap screws: clearance through the sides, thread into accessory ribs. */
const SCREW_CLEAR_D = 5.2;
const SCREW_THREAD_D = 4.7;
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
const SIDE_FRONT_HOLE_Y = FRONT_RECESS + FRONT_HOLE_Y;
const REAR_HOLE_Y = 100;
const ACC_REAR_HOLE_Y = REAR_HOLE_Y - FRONT_RECESS;
export const LONG_SHELF = 112;
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
const POCKET_SKIN = 5;
/** Boss kept full-thickness around each lateral screw hole. This is bearing
 *  area for the M5 cap head (8.5 mm across), NOT thread — the screw threads
 *  into the accessory's rib, so 10 mm leaves 2.4 mm of wall around the 5.2 mm
 *  clearance hole and still supports the whole head. At 13 mm the bosses were
 *  3.5 mm apart on the 16.5 pitch, which made each screw column a solid bar:
 *  the two columns alone were 107 cm3 of a 330 cm3 panel. */
const SCREW_BOSS_D = 10;
/** Weight relief: solid margin kept around the panel edge and each keep-out,
 *  and the collar left around a tie-wrap hole. */
const RELIEF_RIM = 4;
const TIE_BOSS_MARGIN = 2;
/** Accessory rib hollowing: C-channel wall thickness and the boss kept
 *  around each thread hole so screw engagement stays full-width. */
const RIB_WALL = 5;
const RIB_BOSS_D = 12;
/** Side-panel fan mounts: strip margin beyond the fan frame, screw hole
 *  (fan self-tappers bite plastic), and the standard bolt spacing /
 *  opening per frame size. */
const FAN_BAND_MARGIN = 7;
const FAN_SCREW_D = 3.6;
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
const SEAT_T = 3;
const SEAT_LEN = 20;
const SEAT_DEPTH = 10;
const SEAT_SLACK = 0.3;
/**
 * Snap darts hold the sides onto the plates before a single shelf is screwed
 * in — the assembly step the printed set had no answer for.
 *
 * Each dart is a two-jaw arrowhead lying IN the plate's print plane, so the
 * jaws flex along the layers rather than across them, and they squeeze toward
 * each other into the dart's own central slot — the side panel never has to
 * provide deflection clearance, which is what lets the rebate stay tight on
 * both faces. Symmetric about the seat centre on purpose: the top plate is
 * this same part turned over, so a barb on one side only would engage at the
 * bottom of the rack and do nothing at the top.
 *
 * A jaw clears `DART_BARB - SEAT_SLACK` over `DART_FREE` of free length, which
 * puts peak surface strain near 0.35% — well inside PLA, never mind PETG.
 */
const DART_W = 8;
const DART_SPLIT = 2;
const DART_BARB = 1.0;
const DART_LEAD = 2.5;
const DART_LAND = 4;
const DART_RELIEF = 2.5;
const DART_FREE = 30;
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
    box(0, SIDE_T, FOOT_INSET, 0, FOOT_LEN, FOOT_H + OVER),
    box(0, SIDE_T, depth - FOOT_INSET - FOOT_LEN, 0, FOOT_LEN, FOOT_H + OVER),
  ];

  const cuts: BuildOp[] = [];

  // Vent/tie windows between the structural bands, split by the rear-column
  // rib. Sample racks use a truss aesthetic; big rounded windows carry the
  // same airflow + tie-wrap intent with primitive-friendly geometry.
  const spans: Array<[number, number]> = [];
  const rearEdge = depth - rearBand;
  if (depth >= MID_BAR_MIN_DEPTH) {
    spans.push([FRONT_BAND, REAR_RIB[0]]);
    spans.push([REAR_RIB[1], rearEdge]);
  } else {
    spans.push([FRONT_BAND, rearEdge]);
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
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    cuts.push(translate([holeX, SIDE_FRONT_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    if (depth >= MID_BAR_MIN_DEPTH) {
      cuts.push(translate([holeX, REAR_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    }
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    cuts.push(translate([holeX, ty, FOOT_H + RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
    cuts.push(translate([holeX, ty, FOOT_H + bodyH - RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
  }

  // Blind rebates for the top/bottom plates, opening from the INNER face. Both
  // sit wholly inside the top/bottom rails, which are solid the full depth, so
  // each rebate keeps material above AND below it — the bottom one is backed
  // by the stacking foot as well.
  const seats = plateSeats(
    mirror ? width - SIDE_T - SIDE_CLEAR : SIDE_T + SIDE_CLEAR,
    mirror ? 1 : -1,
    depth,
  );
  for (const z0 of [FOOT_H + PLATE_T - SEAT_T, H_TOP - PLATE_T]) {
    cuts.push(
      translate([0, 0, z0 - SEAT_SLACK], extrude(seats.pocket, SEAT_T + 2 * SEAT_SLACK)),
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
  //   - the plate rebates: those are cut SEAT_DEPTH from the INNER face, and
  //     POCKET_SKIN + SEAT_DEPTH exceeds SIDE_T, so pocketing across one would
  //     punch straight through the seat
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
    regions.push(yzRect(depth - rearBand + RELIEF_RIM, depth - RELIEF_RIM, webZ0, webZ1));
  }
  const keepOut: Profile[] = [];
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    keepOut.push(pTranslate([SIDE_FRONT_HOLE_Y, z], circleProfile(SCREW_BOSS_D / 2, 20)));
    if (depth >= MID_BAR_MIN_DEPTH) {
      keepOut.push(pTranslate([REAR_HOLE_Y, z], circleProfile(SCREW_BOSS_D / 2, 20)));
    }
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    for (const z of [FOOT_H + RAIL / 2, FOOT_H + bodyH - RAIL / 2]) {
      keepOut.push(pTranslate([ty, z], circleProfile(TIE_D / 2 + TIE_BOSS_MARGIN, 16)));
    }
  }
  for (const yC of plateSeatYs(depth)) {
    for (const z0 of [FOOT_H + PLATE_T - SEAT_T, H_TOP - PLATE_T]) {
      keepOut.push(
        yzRect(yC - SEAT_LEN / 2 - 3, yC + SEAT_LEN / 2 + 3, z0 - 2, z0 + SEAT_T + 2),
      );
    }
  }
  cuts.push(
    translate(
      [pa, 0, 0],
      extrudeX(pDifference([pUnion(regions), ...keepOut]), pocketDepthX),
    ),
  );

  // ---- Wall mount ----------------------------------------------------------
  const wallMount = rack.wallMount ?? 'none';
  if (wallMount === 'ears') {
    // Rear flange blade pointing outward, gusseted at each screw. Prints
    // with the panel lying inner-face-down; the blade rises as a wall.
    const [ba, bb] = mirror ? [width - OVER, width + EAR_REACH] : [-EAR_REACH, OVER];
    solid.push(translate([ba, depth - EAR_T, FOOT_H], cube([bb - ba, EAR_T, bodyH])));
    const screws = Math.max(2, Math.floor(dims.slots / 6));
    const xC = mirror ? width + EAR_REACH / 2 : -EAR_REACH / 2;
    for (let i = 0; i < screws; i++) {
      const z = FOOT_H + (bodyH * (i + 1)) / (screws + 1);
      cuts.push(translate([xC, depth - EAR_T - OVER, z], axisCylinder('+y', EAR_T + 2 * OVER, WALL_SCREW_D / 2, 24)));
      cuts.push(
        translate([xC, depth - EAR_T - OVER, z], axisCylinder('+y', WALL_HEAD_RECESS + OVER, WALL_HEAD_D / 2, 32)),
      );
      // Horizontal triangular gusset bracing blade to panel, below the screw.
      const tipX = mirror ? width + EAR_REACH - 4 : -(EAR_REACH - 4);
      const rootX = mirror ? width - OVER : OVER;
      solid.push(
        triPrismZ(
          [
            [tipX, depth - EAR_T + 0.5],
            [rootX, depth - EAR_T + 0.5],
            [rootX, depth - EAR_T - 24],
          ],
          z - 8 - GUSSET_T,
          z - 8,
        ),
      );
    }
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
  // Each fan gets a FULL-THICKNESS, full-height strip fused into the panel
  // — added AFTER the window/pocket cuts so nothing carves it, spanning
  // rail-to-rail so the mount is always anchored to the frame, and solid
  // through the thickness so it never bridges over a vent window in the
  // inner-face-down print orientation. The strip is then lightened with
  // the same outer-face blind pockets as the structural bands, above and
  // below the fan zone. Opening + standard 4-bolt pattern cut through.
  const fans = (rack.fans ?? []).filter((f) => (f.side === 'left') === !mirror);
  if (fans.length === 0) return base;
  const strips: BuildOp[] = [];
  const fanCuts: BuildOp[] = [];
  // The strips fuse AFTER the base cuts, so they would bury any screw/tie
  // column they overlap — re-drill every column through the final solid.
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    fanCuts.push(translate([holeX, SIDE_FRONT_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    if (depth >= MID_BAR_MIN_DEPTH) {
      fanCuts.push(translate([holeX, REAR_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    }
  }
  for (let ty = FRONT_BAND + 12; ty <= depth - rearBand - 8; ty += 33) {
    fanCuts.push(translate([holeX, ty, FOOT_H + RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
    fanCuts.push(translate([holeX, ty, FOOT_H + bodyH - RAIL / 2], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
  }
  // ...and the plate rebates: a strip spans rail-to-rail, so one landing on a
  // seat would fill the rebate right back in.
  for (const z0 of [FOOT_H + PLATE_T - SEAT_T, H_TOP - PLATE_T]) {
    fanCuts.push(
      translate([0, 0, z0 - SEAT_SLACK], extrude(seats.pocket, SEAT_T + 2 * SEAT_SLACK)),
    );
  }
  const [sx0, sx1] = xr(0, SIDE_T);
  const [hx] = xr(-OVER, 0);
  const [ppa, ppb] = xr(-OVER, SIDE_T - POCKET_SKIN);
  const holeLenF = SIDE_T + 2 * OVER;
  for (const fan of fans) {
    const spec = FAN_SPECS[fan.size] ?? FAN_SPECS[80]!;
    const half = fan.size / 2 + FAN_BAND_MARGIN;
    const yC = Math.min(Math.max(fan.y, half), depth - half);
    const zC =
      FOOT_H + Math.min(Math.max(fan.z, spec.opening / 2 + 3), bodyH - spec.opening / 2 - 3);
    const y0 = yC - half;
    strips.push(translate([sx0, y0, FOOT_H], cube([sx1 - sx0, 2 * half, bodyH])));
    // Lightening pockets in the strip outside the fan zone.
    const zones: Array<[number, number]> = [
      [FOOT_H + RAIL, zC - half],
      [zC + half, FOOT_H + bodyH - RAIL],
    ];
    for (const [za, zb] of zones) {
      if (zb - za < 15) continue;
      fanCuts.push(translate([ppa, y0 + 4, za], cube([ppb - ppa, 2 * half - 8, zb - za])));
    }
    fanCuts.push(translate([hx, yC, zC], axisCylinder('+x', holeLenF, spec.opening / 2, 64)));
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        fanCuts.push(
          translate(
            [hx, yC + (sy * spec.bolt) / 2, zC + (sz * spec.bolt) / 2],
            axisCylinder('+x', holeLenF, FAN_SCREW_D / 2, 20),
          ),
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
function plateSeatYs(depth: number): number[] {
  const yc = FOOT_INSET + FOOT_LEN / 2;
  const ys = [yc, depth - yc];
  if (depth >= 180) ys.push(depth / 2);
  return ys;
}

/** Distances measured OUTBOARD from a plate edge; negative reaches inboard. */
const D_TIP = SEAT_DEPTH - 1;
const D_ROOT = -2;
const D_LEAD = D_TIP - DART_LEAD;
const D_LAND = D_LEAD - DART_LAND;

interface SeatProfiles {
  /** Bearing lands plus both dart jaws — everything that carries load. */
  solid: Profile;
  /** The outward-facing barb on each jaw: ramp in, land, square return. */
  barb: Profile;
  /** Slots that free the jaws; these cut the FULL plate thickness. */
  relief: Profile;
  /** Blind rebate + the two barb detents, cut into the side panel. */
  pocket: Profile;
}

/**
 * The plate-to-side joint, drawn once as a 2D outline and used three ways: the
 * plate's seats, the slots that free its dart jaws, and the side panel's
 * rebate. The rebate is the *same* outline grown by `SEAT_SLACK`, so fit
 * clearance can never drift away from the shape it is meant to clear.
 *
 * `dir` is +1 when the seat reaches outboard toward +x (the right-hand edge)
 * and -1 for the left, so one builder serves both plate edges and both panels.
 */
function plateSeats(edge: number, dir: 1 | -1, depth: number): SeatProfiles {
  const at = (a: number, b: number, y0: number, y1: number): Profile => {
    const p = edge + dir * a;
    const q = edge + dir * b;
    const [xa, xb] = p < q ? [p, q] : [q, p];
    return pTranslate([xa, y0], rectProfile(xb - xa, y1 - y0));
  };
  const half = SEAT_LEN / 2;
  const jawOut = DART_W / 2;              // outer face of each jaw
  const jawIn = DART_SPLIT / 2;           // inner face, against the central slot
  const landIn = jawOut + DART_RELIEF;    // inner edge of each bearing land
  const xTip = edge + dir * D_TIP;
  const xLead = edge + dir * D_LEAD;
  const solid: Profile[] = [];
  const barb: Profile[] = [];
  const relief: Profile[] = [];
  const pocket: Profile[] = [];
  for (const yC of plateSeatYs(depth)) {
    // Two bearing lands outboard, two dart jaws inboard of them. The jaws run
    // DART_FREE into the deck so their flexing length lives in the plate.
    const bearing = [
      at(D_TIP, D_ROOT, yC - half, yC - landIn),
      at(D_TIP, D_ROOT, yC + landIn, yC + half),
      at(D_TIP, -DART_FREE, yC - jawOut, yC - jawIn),
      at(D_TIP, -DART_FREE, yC + jawIn, yC + jawOut),
    ];
    solid.push(...bearing);
    // Slot each jaw free of its land, and split the pair so they can squeeze.
    relief.push(at(D_TIP + OVER, -DART_FREE, yC - landIn, yC - jawOut));
    relief.push(at(D_TIP + OVER, -DART_FREE, yC + jawOut, yC + landIn));
    relief.push(at(D_TIP + OVER, -DART_FREE, yC - jawIn, yC + jawIn));

    for (const sign of [1, -1] as const) {
      const y0 = yC + sign * jawOut;
      const y1 = y0 + sign * DART_BARB;
      const [ya, yb] = sign > 0 ? [y0, y1] : [y1, y0];
      // Ramp the side cams over on the way in, then a square return face it
      // has to be forced back over to come apart.
      barb.push(poly([[xTip, y0], [xLead, y1], [xLead, y0]]));
      barb.push(at(D_LEAD, D_LAND, ya, yb));
      // Detent the barb springs into, stopping 0.4 mm short of that return
      // face so the joint seats without preload.
      const [da, db] =
        sign > 0
          ? [y0, y1 + SEAT_SLACK]
          : [y1 - SEAT_SLACK, y0];
      pocket.push(at(D_TIP + OVER, D_LAND - 0.4, da, db));
    }
    pocket.push(pOffset(pUnion(bearing), SEAT_SLACK, 'miter'));
  }
  return {
    solid: pUnion(solid),
    barb: pUnion(barb),
    relief: pUnion(relief),
    pocket: pUnion(pocket),
  };
}

/**
 * Top/bottom plate: a vented deck spanning between the sides, seated in their
 * rebates and snapped in by four darts. One printed part serves both ends of
 * the rack — the top is the same plate turned over (see buildRackNodes).
 */
function buildPlate(dims: RackDims): BuildOp {
  const { plateW, depth } = dims;
  const x0 = SIDE_T + SIDE_CLEAR;
  const left = plateSeats(x0, -1, depth);
  const right = plateSeats(x0 + plateW, 1, depth);

  // Airflow: a triangulated rib lattice inside a 15 mm solid rim. The hole
  // grid this replaces was only ~25% open and left the plate heavier than it
  // needed to be; a lattice opens ~55% for a stiffer panel. Each dart's
  // flexing length is kept solid so the jaws stay a clean cantilever.
  const plateOutline = pTranslate([x0, 0], rectProfile(plateW, depth));
  const dartKeepOut: Profile[] = [];
  for (const yC of plateSeatYs(depth)) {
    for (const nearLeft of [true, false]) {
      const a = nearLeft ? x0 : x0 + plateW - DART_FREE - 6;
      dartKeepOut.push(
        pTranslate([a, yC - SEAT_LEN / 2 - 3], rectProfile(DART_FREE + 6, SEAT_LEN + 6)),
      );
    }
  }
  const deck = pDifference([
    plateOutline,
    lightenPocket(plateOutline, { rim: 15, rib: 3.5, pitch: 14, keepOut: dartKeepOut }),
    left.relief,
    right.relief,
  ]);
  // Seats ride on the deck's inner face, so the rebate that receives them can
  // keep solid material outboard of the plate at both ends of the rack.
  const seats = pUnion([left.solid, left.barb, right.solid, right.barb]);
  return union([
    extrude(deck, PLATE_T),
    translate([0, 0, PLATE_T - SEAT_T], extrude(seats, SEAT_T)),
  ]);
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
      cuts.push(translate([rx - OVER, FRONT_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
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
  opts: { frontPlate?: boolean; vented?: boolean } = {},
): BuildOp {
  const { width, depth, plateW } = dims;
  const vented = opts.vented !== false;
  const h = nSlots * SLOT_PITCH - 0.5;
  const d = Math.min(Math.max(60, shelfDepth), depth - FRONT_BAND / 2);
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
  solid.push(translate([deckX0, 0, 0], cube([deckW, d, 3])));
  // Vent the deck with a triangulated rib lattice rather than parallel slots:
  // ~60% open against the slots' ~35% for a stiffer deck, and a side fan can
  // blow diagonally across it instead of only along the slot direction. The
  // end ribs are kept out — the deck overlaps them, and they carry the M5
  // threads.
  if (vented) {
    const ribKeepOut = ribX.map((rx) =>
      pTranslate([rx - 1, -OVER], rectProfile(RIB_W + 2, d + 2 * OVER)),
    );
    cuts.push(
      translate(
        [0, 0, -OVER],
        extrude(
          lightenPocket(pTranslate([deckX0, 0], rectProfile(deckW, d)), {
            rim: 10,
            rib: 3,
            pitch: 14,
            keepOut: ribKeepOut,
          }),
          3 + 2 * OVER,
        ),
      ),
    );
  }
  // Screw holes: front column always; rear column when the shelf is long
  // enough to reach it (matches the sides' rear rib).
  for (let k = 0; k < nSlots; k++) {
    const z = (k + 0.5) * SLOT_PITCH - 0.25;
    for (const rx of ribX) {
      cuts.push(translate([rx - OVER, FRONT_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
      if (d >= LONG_SHELF) {
        cuts.push(translate([rx - OVER, ACC_REAR_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
      }
    }
  }
  cuts.push(...ribChannelCuts(width, ribX, d, h, nSlots, d >= LONG_SHELF));
  // Side vents: perforate the rib walls laterally so a side fan blows
  // straight through the shelf (cross-flow), skipping the screw bosses.
  if (vented) {
    const bossYs = d >= LONG_SHELF ? [FRONT_HOLE_Y, ACC_REAR_HOLE_Y] : [FRONT_HOLE_Y];
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
  solid.push(translate([deckX0, 0, 0], cube([deckW, d, 4])));
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
      cuts.push(translate([rx - OVER, FRONT_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
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

/** Compile the whole rack to one BuildNode per printable part, positioned in
 *  assembly space so the viewport previews the assembled rack. */
export function buildRackNodes(rack: RackParams): BuildNode[] {
  const dims = computeRackDims(rack);
  const nodes: BuildNode[] = [
    { id: 'rack-side-left', op: buildSide(rack, dims, false) },
    { id: 'rack-side-right', op: buildSide(rack, dims, true) },
    { id: 'rack-bottom', op: translate([0, 0, FOOT_H], buildPlate(dims)) },
    // Same printed part, turned over: the seats have to face INTO the rack at
    // both ends, and the plate's y features are symmetric about depth/2 so the
    // flip lands them back on the same rebates.
    {
      id: 'rack-top',
      op: translate(
        [0, dims.depth, FOOT_H + dims.bodyH],
        rotate([180, 0, 0], buildPlate(dims)),
      ),
    },
  ];

  // Accessories stack bottom-up in their mounted positions for the preview.
  let cursor = 0;
  (rack.accessories ?? []).forEach((acc, i) => {
    const n = accessorySlots(acc);
    const z0 = dims.slotZ(Math.min(cursor, Math.max(0, dims.slots - n))) + 0.25;
    cursor += n;
    let op: BuildOp;
    if (acc.type === 'blank') op = buildBlank(dims, n);
    else if (acc.type === 'keystone') op = buildKeystone(dims, n).op;
    else if (acc.type === 'shelf')
      op = buildShelf(dims, n, acc.shelfDepth ?? 123, { frontPlate: acc.frontPlate, vented: acc.vented });
    else op = buildCableTray(dims);
    // Recessed behind the sides' protective front columns (FRONT_RECESS).
    nodes.push({ id: `rack-${acc.type}-${i}`, op: translate([0, FRONT_RECESS, z0], op) });
  });

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
