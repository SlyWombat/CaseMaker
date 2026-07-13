import type { BoardProfile, StandParams } from '@/types';
import {
  cube,
  cylinder,
  difference,
  mesh,
  roundedRectPrism,
  rotate,
  translate,
  union,
  type BuildOp,
} from './buildPlan';

/**
 * Desk stand for a finished display module (BoardProfile.enclosure).
 *
 * Two fused features, printed as ONE part standing on its foot:
 *
 *   FRAME — a plate matching the module's outline. The module's rear body
 *   passes THROUGH the frame's opening; its front flange seats on the frame's
 *   front face; its mounting bosses sink into counterbored pockets so the
 *   flange sits flush. Screws pass from the frame's BACK into the bosses.
 *   The middle is open, so back-facing connectors (the Guition panel plugs its
 *   USB-C straight out the back) stay reachable and nothing traps heat.
 *
 *   FOOT — a plate on the desk, braced to the frame by a gusset at each side.
 *   The gussets live in the frame's side rims, keeping the area behind the
 *   opening clear for cables.
 *
 * Print orientation: as modelled. Standing on the foot, the frame leans back
 * by `tiltAngleDeg`, so its faces sit at (90 - tilt)° to the bed — 75° at the
 * default 15°, comfortably self-supporting. The gussets taper to a point as
 * they rise, so every layer lands on the one below.
 *
 * Frame-local coords (before the tilt is applied):
 *   x: 0..W across the screen        y: 0..H up the screen
 *   z: 0 = BACK face, z = T = FRONT face (the side the module seats against)
 */

/** Rise of the frame's bottom edge into the foot, so the two fuse manifold. */
const FOOT_EMBED = 2;
/** Gussets bite this far into the frame's back face, so they fuse. */
const GUSSET_BITE = 1.5;
/** Pocket clearance around a boss (per side, on the diameter). */
const BOSS_FIT = 0.4;
/** Screw-head counterbore on the frame's back face. */
const HEAD_CLEARANCE = 1.8;
const HEAD_DEPTH = 1.5;
/** Overshoot so cutters punch cleanly through faces. */
const OVER = 1;

export interface StandDims {
  /** Frame plate, before tilting. */
  frameW: number;
  frameH: number;
  frameT: number;
  /** Overall stand envelope once tilted and stood on its foot. */
  outerX: number;
  outerY: number;
  outerZ: number;
}

export function computeStandDims(board: BoardProfile, stand: StandParams): StandDims {
  const t = (stand.tiltAngleDeg * Math.PI) / 180;
  const frameW = board.pcb.size.x + 2 * stand.bezelMargin;
  const frameH = board.pcb.size.y + 2 * stand.bezelMargin;
  const frameT = stand.frameThickness;
  // Tilted frame reaches back by (H·sin t) and its own thickness (T·cos t).
  const reach = frameH * Math.sin(t) + frameT * Math.cos(t);
  return {
    frameW,
    frameH,
    frameT,
    outerX: frameW,
    outerY: Math.max(stand.baseDepth, reach + 2),
    outerZ: stand.baseThickness - FOOT_EMBED + frameH * Math.cos(t) + frameT * Math.sin(t),
  };
}

/**
 * Triangular prism extruded along X, from a triangle given in the (y, z)
 * plane. Vertices are wound so the prism is a closed, outward-facing solid
 * regardless of the caller's ordering.
 */
function triPrismX(
  tri: readonly [[number, number], [number, number], [number, number]], // three (y, z) pairs
  xMin: number,
  xMax: number,
): BuildOp {
  const a = tri[0];
  let b = tri[1];
  let c = tri[2];
  // Force CCW in (y, z) so the caps' winding below is consistent.
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross < 0) {
    const swap = b;
    b = c;
    c = swap;
  }
  const positions: number[] = [];
  for (const [y, z] of [a, b, c]) positions.push(xMin, y, z); // 0,1,2
  for (const [y, z] of [a, b, c]) positions.push(xMax, y, z); // 3,4,5
  const tris = [
    0, 2, 1, // -x cap (outward normal -x → CW seen from +x)
    3, 4, 5, // +x cap
    0, 1, 4, 0, 4, 3, // side a-b
    1, 2, 5, 1, 5, 4, // side b-c
    2, 0, 3, 2, 3, 5, // side c-a
  ];
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

// ---- Wall-mount defaults (see StandParams) ---------------------------------
export const WALL_DEFAULTS = {
  shroudDepth: 22,
  shroudWall: 4,
  plateThickness: 4,
  plateBorder: 12,
  drywallScrewDiameter: 4.4,
  drywallHeadDiameter: 8.5,
} as const;
/** Snap finger: a cantilever standing off the plate with an outward barb. */
const FINGER_H = 12;
const FINGER_T = 2.4;
const FINGER_W = 12;
const BARB_P = 1.5; // how far the barb juts out past the finger face
const BARB_H = 2.5;
/** Plate-to-shroud-cavity clearance, per side. */
const PLATE_FIT = 0.3;

/**
 * The frame plate, flat, in local coords (z: 0 = BACK, T = FRONT — the front
 * is the face the module's flange seats against). Shared by both mounts.
 */
function buildFrameLocal(board: BoardProfile, stand: StandParams, W: number, H: number, T: number): BuildOp {
  const enc = board.enclosure!;
  const m = stand.bezelMargin;
  const outerR = Math.min(5, W / 4, H / 4);
  const cuts: BuildOp[] = [];

  // Opening: the module's rear body passes straight through.
  const clr = stand.openingClearance;
  const openW = enc.body.width + 2 * clr;
  const openH = enc.body.height + 2 * clr;
  cuts.push(
    translate(
      [m + enc.body.x - clr, m + enc.body.y - clr, -OVER],
      roundedRectPrism(openW, openH, T + 2 * OVER, Math.min(3, openW / 4, openH / 4)),
    ),
  );

  // Per mounting hole: a pocket the boss sinks into (open on the FRONT face),
  // a screw clearance hole through, and a head counterbore on the BACK face.
  const pocketDepth = enc.bossHeight + 0.2;
  for (const h of board.mountingHoles) {
    const hx = m + h.x;
    const hy = m + h.y;
    cuts.push(
      translate(
        [hx, hy, T - pocketDepth],
        cylinder(pocketDepth + OVER, (enc.bossDiameter + BOSS_FIT) / 2, 48),
      ),
    );
    cuts.push(translate([hx, hy, -OVER], cylinder(T + 2 * OVER, stand.screwHoleDiameter / 2, 32)));
    cuts.push(
      translate(
        [hx, hy, -OVER],
        cylinder(HEAD_DEPTH + OVER, (stand.screwHoleDiameter + HEAD_CLEARANCE) / 2, 32),
      ),
    );
  }
  return difference([roundedRectPrism(W, H, T, outerR), ...cuts]);
}

/**
 * Build the desk stand: frame + foot + gussets, fused into a single solid.
 * Returns null when the board isn't a finished enclosure module (a stand has
 * nothing to grip on a bare PCB).
 */
export function buildStandOp(board: BoardProfile, stand: StandParams): BuildOp | null {
  const enc = board.enclosure;
  if (!enc) return null;

  const d = computeStandDims(board, stand);
  const { frameW: W, frameH: H, frameT: T } = d;
  const t = (stand.tiltAngleDeg * Math.PI) / 180;
  const sinT = Math.sin(t);
  const cosT = Math.cos(t);

  const frameLocal = buildFrameLocal(board, stand, W, H, T);

  // ---- Place the frame: lean it back, stand it on the foot ----------------
  // Rotation about world X by (90° - tilt) maps local +y (up the screen) to
  // world +z and tips the top backwards into +y. Derivation:
  //   world.y = y·sin t − z·cos t     world.z = y·cos t + z·sin t
  // so the frame's min y is −T·cos t (bottom-front edge) and min z is 0.
  const rotated = rotate([90 - stand.tiltAngleDeg, 0, 0], frameLocal);
  const frontOffset = 2; // keep the frame's toe just inside the foot's front lip
  const Ty = T * cosT + frontOffset;
  const Tz = stand.baseThickness - FOOT_EMBED;
  const frame = translate([0, Ty, Tz], rotated);

  // ---- Foot ---------------------------------------------------------------
  const baseDepth = Math.max(stand.baseDepth, H * sinT + T * cosT + 12);
  const foot = translate(
    [0, 0, 0],
    roundedRectPrism(W, baseDepth, stand.baseThickness, Math.min(4, W / 6)),
  );

  // ---- Side gussets -------------------------------------------------------
  // The frame's BACK face (local z = 0) sweeps world y = Ty + (z − Tz)·tan t.
  // Anchor the gusset's vertical leg on that plane, biting GUSSET_BITE into it
  // so the union fuses, and run its foot back along the base plate.
  const backFaceY = (z: number) => Ty + (z - Tz) * (sinT / cosT) - GUSSET_BITE;
  const zBot = stand.baseThickness;
  const zTop = stand.baseThickness + stand.gussetHeightFraction * H * cosT;
  const yHeel = baseDepth - 2;
  const tri: [[number, number], [number, number], [number, number]] = [
    [backFaceY(zBot), zBot], // at the frame, on the foot
    [yHeel, zBot], // back of the foot
    [backFaceY(zTop), zTop], // up the frame's back
  ];
  const gussets: BuildOp[] = [];
  if (yHeel > backFaceY(zBot) + 4 && zTop > zBot + 4) {
    const gt = stand.gussetThickness;
    gussets.push(triPrismX(tri, 0, gt));
    gussets.push(triPrismX(tri, W - gt, W));
  }

  // ---- Flush front --------------------------------------------------------
  // The part is printed FACE DOWN: the frame's front face goes on the bed. But
  // the foot's front lip is a VERTICAL face while the frame's front is tilted,
  // so the lip stands proud of the frame's plane (~T·sin t at the top of the
  // foot) and the part would rock on that lip instead of bedding on the frame.
  // Shave everything forward of the frame's front plane, so the frame face and
  // the foot's front edge end up coplanar — one flat surface on the bed.
  const BIG = 500;
  const frontHalfSpace = translate(
    [0, Ty, Tz],
    rotate(
      [90 - stand.tiltAngleDeg, 0, 0],
      translate([-BIG, -BIG, T], cube([W + 2 * BIG, H + 2 * BIG, BIG])),
    ),
  );

  return difference([union([foot, frame, ...gussets]), frontHalfSpace]);
}

/**
 * Wall mount — two parts that snap together.
 *
 *   WALL PLATE ("lid"): screws to the drywall. Big open middle so the cable
 *   comes straight out of the wall into the cavity. Two counterbored screw
 *   holes on the vertical centreline (two screws, not one, so it can't
 *   rotate). Four cantilever fingers stand off it, each with an outward barb.
 *
 *   BODY: the same frame the module screws into, plus a shroud — a box of
 *   walls standing off the frame's back that houses the USB plug and the wire
 *   slack. Four windows through the shroud walls receive the plate's barbs.
 *
 * Assembly: plate to the wall first, then push the body on. The shroud's inner
 * walls cam the fingers inward until the barbs spring out into the windows; the
 * barbs' flat undersides then bear on the windows' lower edges and resist pull-
 * off. The barbs show through the windows, so a small screwdriver in each
 * window releases the body.
 *
 * Local Z for both parts: 0 = the wall, +z = out of the wall toward the viewer.
 */
function wallGeom(board: BoardProfile, stand: StandParams) {
  const enc = board.enclosure!;
  const W = board.pcb.size.x + 2 * stand.bezelMargin;
  const H = board.pcb.size.y + 2 * stand.bezelMargin;
  const T = stand.frameThickness;
  const D = stand.shroudDepth ?? WALL_DEFAULTS.shroudDepth;
  const SW = stand.shroudWall ?? WALL_DEFAULTS.shroudWall;
  const P = stand.plateThickness ?? WALL_DEFAULTS.plateThickness;
  // Cavity inside the shroud; the plate drops into it with a slip fit.
  const cavW = W - 2 * SW;
  const cavH = H - 2 * SW;
  const plateW = cavW - 2 * PLATE_FIT;
  const plateH = cavH - 2 * PLATE_FIT;
  const plateX = SW + PLATE_FIT;
  const plateY = SW + PLATE_FIT;
  // Barb sits at the top of each finger.
  const barbZ0 = P + FINGER_H - BARB_H;
  // Fingers: two on the bottom edge, two on the top, at 1/4 and 3/4 across.
  const fingerXs = [plateX + plateW * 0.25 - FINGER_W / 2, plateX + plateW * 0.75 - FINGER_W / 2];
  return { enc, W, H, T, D, SW, P, cavW, cavH, plateW, plateH, plateX, plateY, barbZ0, fingerXs };
}

function buildWallBody(board: BoardProfile, stand: StandParams): BuildOp {
  const g = wallGeom(board, stand);
  const { W, H, T, D, SW, barbZ0, fingerXs } = g;
  const outerR = Math.min(5, W / 4, H / 4);

  // Shroud: a box of walls off the frame's back, open toward the wall.
  const shroud = difference([
    roundedRectPrism(W, H, D, outerR),
    translate(
      [SW, SW, -OVER],
      roundedRectPrism(g.cavW, g.cavH, D + 2 * OVER, Math.max(0.1, outerR - SW)),
    ),
  ]);

  // Frame sits on the shroud's front, its BACK (z = 0 local) facing the wall.
  const frame = translate([0, 0, D], buildFrameLocal(board, stand, W, H, T));

  // Windows through the shroud walls where the plate's barbs land. Their LOWER
  // edge is what the barb's flat underside catches on, so keep the slop small.
  const winZ0 = barbZ0 - 0.15;
  const winH = BARB_H + 2;
  const windows: BuildOp[] = [];
  for (const fx of fingerXs) {
    // bottom wall (y ≈ 0) and top wall (y ≈ H)
    windows.push(
      translate([fx - 1, -OVER, winZ0], cube([FINGER_W + 2, SW + 2 * OVER, winH])),
    );
    windows.push(
      translate([fx - 1, H - SW - OVER, winZ0], cube([FINGER_W + 2, SW + 2 * OVER, winH])),
    );
  }

  return difference([union([shroud, frame]), ...windows]);
}

function buildWallPlate(board: BoardProfile, stand: StandParams): BuildOp {
  const g = wallGeom(board, stand);
  const { P, plateW, plateH, plateX, plateY, barbZ0, fingerXs } = g;
  const border = stand.plateBorder ?? WALL_DEFAULTS.plateBorder;
  const screwD = stand.drywallScrewDiameter ?? WALL_DEFAULTS.drywallScrewDiameter;
  const headD = stand.drywallHeadDiameter ?? WALL_DEFAULTS.drywallHeadDiameter;

  const plate = translate(
    [plateX, plateY, 0],
    roundedRectPrism(plateW, plateH, P, Math.min(4, plateW / 6)),
  );

  const cuts: BuildOp[] = [];
  // Big central opening — the wire comes straight out of the wall through it.
  const openW = plateW - 2 * border;
  const openH = plateH - 2 * border;
  cuts.push(
    translate(
      [plateX + border, plateY + border, -OVER],
      roundedRectPrism(openW, openH, P + 2 * OVER, Math.min(6, openW / 6, openH / 6)),
    ),
  );

  // Two drywall screws on the vertical centreline, in the top and bottom
  // borders (the middle is open). Heads counterbored from the FRONT so the
  // plate still lies flat against the wall.
  const cx = plateX + plateW / 2;
  const headDepth = Math.min(2.5, P - 1.5);
  for (const cy of [plateY + border / 2, plateY + plateH - border / 2]) {
    cuts.push(translate([cx, cy, -OVER], cylinder(P + 2 * OVER, screwD / 2, 32)));
    cuts.push(
      translate([cx, cy, P - headDepth], cylinder(headDepth + OVER, headD / 2, 32)),
    );
  }
  const plateBody = difference([plate, ...cuts]);

  // Snap fingers. Each is a thin cantilever off the plate's front face with an
  // outward barb: flat underside (the catch) and a ramp on top (the lead-in
  // the shroud wall cams against on assembly). Printed plate-down, the ramp
  // rises and the catch is a small 1.5 mm ledge — no supports needed.
  //
  // EMBED matters: a finger that merely TOUCHES the plate's face, or a barb
  // that merely touches the finger's face, is a zero-volume contact — the
  // union leaves them as separate shells and the plate exports as loose
  // pieces. Bite into the parent so the solids actually overlap.
  const EMBED_F = 0.8;
  const parts: BuildOp[] = [plateBody];
  const yBot = plateY;
  const yTop = plateY + plateH;
  for (const fx of fingerXs) {
    // Bottom edge: finger's outer face at y = yBot, barb juts toward -y.
    parts.push(
      translate([fx, yBot, P - EMBED_F], cube([FINGER_W, FINGER_T, FINGER_H + EMBED_F])),
    );
    parts.push(
      triPrismX(
        [
          [yBot + EMBED_F, barbZ0], // inside the finger, so the barb fuses to it
          [yBot - BARB_P, barbZ0], // barb tip — the flat catch face
          [yBot + EMBED_F, barbZ0 + BARB_H], // ramp back into the finger
        ],
        fx,
        fx + FINGER_W,
      ),
    );
    // Top edge: mirrored, barb juts toward +y.
    parts.push(
      translate([fx, yTop - FINGER_T, P - EMBED_F], cube([FINGER_W, FINGER_T, FINGER_H + EMBED_F])),
    );
    parts.push(
      triPrismX(
        [
          [yTop - EMBED_F, barbZ0],
          [yTop + BARB_P, barbZ0],
          [yTop - EMBED_F, barbZ0 + BARB_H],
        ],
        fx,
        fx + FINGER_W,
      ),
    );
  }
  return union(parts);
}

/**
 * The stand's print parts. Desk → one fused part. Wall → the body and the
 * wall plate it snaps onto. Null when the board isn't a finished module.
 */
export function buildStandNodes(
  board: BoardProfile,
  stand: StandParams,
): Array<{ id: string; op: BuildOp }> | null {
  if (!board.enclosure) return null;
  if ((stand.mount ?? 'desk') === 'wall') {
    return [
      { id: 'wall-body', op: buildWallBody(board, stand) },
      { id: 'wall-plate', op: buildWallPlate(board, stand) },
    ];
  }
  const op = buildStandOp(board, stand);
  return op ? [{ id: 'stand', op }] : null;
}
