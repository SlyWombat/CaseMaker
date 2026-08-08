import type { RackParams, RackAccessory } from '@/types';
import {
  cube,
  cylinder,
  axisCylinder,
  difference,
  mesh,
  roundedRectPrism,
  rotate,
  translate,
  union,
  type BuildNode,
  type BuildOp,
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
/** Screw-column y centers in the side panels. Front column serves every
 *  accessory; the rear column adds support for long shelves (>= LONG_SHELF). */
const FRONT_HOLE_Y = 10;
const REAR_HOLE_Y = 100;
export const LONG_SHELF = 112;
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
const POCKET_SKIN = 6;
const SCREW_BOSS_D = 13;
const TIE_BOSS_D = 10;
/** Accessory rib hollowing: C-channel wall thickness and the boss kept
 *  around each thread hole so screw engagement stays full-width. */
const RIB_WALL = 5;
const RIB_BOSS_D = 12;
/** Top/bottom plates: thickness, snap tab size, tab fit slack. */
const PLATE_T = 5;
const TAB_LEN = 20;
const TAB_DEPTH = 10;
const TAB_SLACK = 0.3;
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
/** Wall mount — french cleat. */
const CLEAT_D = 12;
const CLEAT_H = 30;
const CLEAT_FIT = 0.4;
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
    box(0, SIDE_T, 4, 0, FOOT_LEN, FOOT_H + OVER),
    box(0, SIDE_T, depth - 4 - FOOT_LEN, 0, FOOT_LEN, FOOT_H + OVER),
  ];

  const cuts: BuildOp[] = [];

  // Vent/tie windows between the structural bands, split by the rear-column
  // rib. Sample racks use a truss aesthetic; big rounded windows carry the
  // same airflow + tie-wrap intent with primitive-friendly geometry.
  const spans: Array<[number, number]> = [];
  const rearEdge = depth - rearBand;
  if (depth >= REAR_RIB[1] + 24) {
    spans.push([FRONT_BAND, REAR_RIB[0]]);
    spans.push([REAR_RIB[1], rearEdge]);
  } else {
    spans.push([FRONT_BAND, rearEdge]);
  }
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
      const winZ0 = FOOT_H + RAIL;
      const winZLen = bodyH - 2 * RAIL;
      cuts.push(xWindow(xr(0, SIDE_T)[0], sa + 4, winZ0, sb - sa - 8, winZLen, 6));
    }
  }

  // Screw columns: front (every accessory) + rear (long shelves), one hole
  // per slot, pierced laterally through the panel. Plus tie-wrap holes down
  // the front band.
  const [holeX] = xr(-OVER, SIDE_T + OVER);
  const holeLen = SIDE_T + 2 * OVER;
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    cuts.push(translate([holeX, FRONT_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    cuts.push(translate([holeX, 25, z], axisCylinder('+x', holeLen, TIE_D / 2, 16)));
    if (depth >= REAR_RIB[1] + 24) {
      cuts.push(translate([holeX, REAR_HOLE_Y, z], axisCylinder('+x', holeLen, SCREW_CLEAR_D / 2, 24)));
    }
  }

  // Snap-tab pockets for the top/bottom plates, opening from the INNER face.
  const innerPocket = (yC: number, z0: number): BuildOp => {
    const [a, b] = mirror
      ? [width - SIDE_T - OVER, width - SIDE_T + TAB_DEPTH]
      : [SIDE_T - TAB_DEPTH, SIDE_T + OVER];
    return translate(
      [a, yC - TAB_LEN / 2 - TAB_SLACK, z0 - TAB_SLACK],
      cube([b - a, TAB_LEN + 2 * TAB_SLACK, PLATE_T + 2 * TAB_SLACK]),
    );
  };
  for (const yC of [depth * 0.25, depth * 0.75]) {
    cuts.push(innerPocket(yC, FOOT_H)); // bottom plate seat
    cuts.push(innerPocket(yC, H_TOP - PLATE_T)); // top plate seat
  }

  // Weight-relief pockets in the solid bands, cut from the OUTER face with
  // POCKET_SKIN of inner wall left and solid bosses around every hole. The
  // rear band stays solid whenever the rack wall-mounts (strength package).
  const [pa, pb] = xr(-OVER, SIDE_T - POCKET_SKIN);
  const pocketZ0 = FOOT_H + RAIL;
  const pocketZLen = bodyH - 2 * RAIL;
  const pocketDepthX = pb - pa;
  const frontBosses: BuildOp[] = [];
  for (let k = 0; k < dims.slots; k++) {
    const z = dims.holeZ(k);
    frontBosses.push(translate([pa, FRONT_HOLE_Y, z], axisCylinder('+x', pocketDepthX, SCREW_BOSS_D / 2, 24)));
    frontBosses.push(translate([pa, 25, z], axisCylinder('+x', pocketDepthX, TIE_BOSS_D / 2, 16)));
  }
  cuts.push(
    difference([
      translate([pa, 3, pocketZ0], cube([pocketDepthX, FRONT_BAND - 6, pocketZLen])),
      ...frontBosses,
    ]),
  );
  if ((rack.wallMount ?? 'none') === 'none') {
    cuts.push(
      translate([pa, depth - rearBand + 3, pocketZ0], cube([pocketDepthX, rearBand - 6, pocketZLen])),
    );
  }

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
    // plane near the top rear; everything in the rear band below it is
    // relieved so the rack slides down the wall until the seat lands on the
    // wall cleat's matching sloped top. The seat plane rises toward the wall
    // (rear), so gravity pulls the rack tight against it.
    const notchD = CLEAT_D + CLEAT_FIT;
    const seatZ = FOOT_H + bodyH - 45; // seat height at its front (low) edge
    const [na, nb] = xr(-OVER, SIDE_T + OVER);
    const diag = (notchD + OVER) * Math.SQRT2;
    // Wedge under the seat plane: a cube rotated +45° about x has its former
    // TOP face on the plane z' = y', so pre-dropping the cube by its own
    // diagonal puts the interior exactly below that plane.
    cuts.push(
      translate(
        [na, depth - notchD, seatZ],
        rotate([45, 0, 0], translate([0, 0, -diag], cube([nb - na, diag, diag]))),
      ),
    );
    // Relieve the rest of the rear band below the seat (the wall cleat and
    // the bottom spacer strip occupy this plane against the wall).
    cuts.push(translate([na, depth - notchD, -OVER], cube([nb - na, notchD + OVER, seatZ + 2 + OVER])));
  }

  return difference([union(solid), ...cuts]);
}

/** Top/bottom plate: vented deck spanning between the sides with snap tabs. */
function buildPlate(dims: RackDims): BuildOp {
  const { plateW, depth } = dims;
  const x0 = SIDE_T + SIDE_CLEAR;
  const solid: BuildOp[] = [translate([x0, 0, 0], cube([plateW, depth, PLATE_T]))];
  for (const yC of [depth * 0.25, depth * 0.75]) {
    solid.push(translate([x0 - TAB_DEPTH + 1, yC - TAB_LEN / 2, 0], cube([TAB_DEPTH + 1, TAB_LEN, PLATE_T])));
    solid.push(translate([x0 + plateW - 1, yC - TAB_LEN / 2, 0], cube([TAB_DEPTH + 1, TAB_LEN, PLATE_T])));
  }
  // Airflow hole grid, 15 mm solid rim.
  const cuts: BuildOp[] = [];
  const rim = 15;
  const pitch = 14;
  const r = 4;
  const ux = plateW - 2 * rim;
  const uy = depth - 2 * rim;
  const nx = Math.floor(ux / pitch);
  const ny = Math.floor(uy / pitch);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const cx = x0 + rim + (ux - (nx - 1) * pitch) / 2 + i * pitch;
      const cy = rim + (uy - (ny - 1) * pitch) / 2 + j * pitch;
      cuts.push(translate([cx, cy, -OVER], cylinder(PLATE_T + 2 * OVER, r, 24)));
    }
  }
  return difference([union(solid), ...cuts]);
}

/** Full-width faceplate + threaded end ribs — shared by blank & keystone. */
function faceplateBase(dims: RackDims, nSlots: number, plateDepth: number): { solid: BuildOp[]; cuts: BuildOp[]; h: number } {
  const { width } = dims;
  const h = nSlots * SLOT_PITCH - 0.5;
  const solid: BuildOp[] = [cube([width, plateDepth, h])];
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
function buildShelf(dims: RackDims, nSlots: number, shelfDepth: number): BuildOp {
  const { width, depth } = dims;
  const h = nSlots * SLOT_PITCH - 0.5;
  const d = Math.min(Math.max(60, shelfDepth), depth - FRONT_BAND / 2);
  const ribX: number[] = [SIDE_T + SIDE_CLEAR, width - SIDE_T - SIDE_CLEAR - RIB_W];
  const solid: BuildOp[] = [];
  const cuts: BuildOp[] = [];
  for (const rx of ribX) solid.push(translate([rx, 0, 0], cube([RIB_W, d, h])));
  // Deck at the bottom so the device opening is maximal.
  const deckX0 = SIDE_T + SIDE_CLEAR + 1;
  const deckW = width - 2 * deckX0;
  solid.push(translate([deckX0, 0, 0], cube([deckW, d, 3])));
  // Vent slots along the deck.
  const rim = 12;
  const slotW = 8;
  const gap = 8;
  const n = Math.floor((deckW - 2 * rim) / (slotW + gap));
  for (let i = 0; i < n; i++) {
    const sx = deckX0 + rim + (deckW - 2 * rim - n * (slotW + gap) + gap) / 2 + i * (slotW + gap);
    cuts.push(translate([sx, rim, -OVER], roundedRectPrism(slotW, Math.max(10, d - 2 * rim), 3 + 2 * OVER, slotW / 2)));
  }
  // Screw holes: front column always; rear column when the shelf is long
  // enough to reach it (matches the sides' rear rib).
  for (let k = 0; k < nSlots; k++) {
    const z = (k + 0.5) * SLOT_PITCH - 0.25;
    for (const rx of ribX) {
      cuts.push(translate([rx - OVER, FRONT_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
      if (d >= LONG_SHELF) {
        cuts.push(translate([rx - OVER, REAR_HOLE_Y, z], axisCylinder('+x', RIB_W + 2 * OVER, SCREW_THREAD_D / 2, 24)));
      }
    }
  }
  cuts.push(...ribChannelCuts(width, ribX, d, h, nSlots, d >= LONG_SHELF));
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
        bosses.push(translate([px0, REAR_HOLE_Y, z], axisCylinder('+x', px1 - px0, RIB_BOSS_D / 2, 24)));
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
  // Vent/drain slots along the deck between the finger rows.
  const rim = 12;
  const slotW = 8;
  const gap = 8;
  const n = Math.floor((deckW - 2 * rim) / (slotW + gap));
  for (let i = 0; i < n; i++) {
    const sx = deckX0 + rim + (deckW - 2 * rim - n * (slotW + gap) + gap) / 2 + i * (slotW + gap);
    cuts.push(translate([sx, rim, -OVER], roundedRectPrism(slotW, Math.max(10, d - 2 * rim), 4 + 2 * OVER, slotW / 2)));
  }
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
    { id: 'rack-top', op: translate([0, 0, FOOT_H + dims.bodyH - PLATE_T], buildPlate(dims)) },
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
    else if (acc.type === 'shelf') op = buildShelf(dims, n, acc.shelfDepth ?? 123);
    else op = buildCableTray(dims);
    nodes.push({ id: `rack-${acc.type}-${i}`, op: translate([0, 0, z0], op) });
  });

  if (rack.wallMount === 'cleat') {
    const seatZ = FOOT_H + dims.bodyH - 45;
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
