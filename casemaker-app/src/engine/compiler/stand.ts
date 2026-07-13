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
  tri: [number, number][], // three (y, z) pairs
  xMin: number,
  xMax: number,
): BuildOp {
  let [a, b, c] = tri;
  // Force CCW in (y, z) so the caps' winding below is consistent.
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross < 0) [b, c] = [c, b];
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

/**
 * Build the stand: frame + foot + gussets, fused into a single solid.
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
  const m = stand.bezelMargin;

  // ---- Frame, flat in local coords (z: 0 = back, T = front) ----------------
  const outerR = Math.min(5, W / 4, H / 4);
  const frameParts: BuildOp[] = [roundedRectPrism(W, H, T, outerR)];

  const cuts: BuildOp[] = [];
  // Opening: the module's rear body passes straight through.
  const clr = stand.openingClearance;
  const openW = enc.body.width + 2 * clr;
  const openH = enc.body.height + 2 * clr;
  const openX = m + enc.body.x - clr;
  const openY = m + enc.body.y - clr;
  cuts.push(
    translate(
      [openX, openY, -OVER],
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
    cuts.push(
      translate([hx, hy, -OVER], cylinder(T + 2 * OVER, stand.screwHoleDiameter / 2, 32)),
    );
    cuts.push(
      translate(
        [hx, hy, -OVER],
        cylinder(HEAD_DEPTH + OVER, (stand.screwHoleDiameter + HEAD_CLEARANCE) / 2, 32),
      ),
    );
  }
  const frameLocal = difference([union(frameParts), ...cuts]);

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
  const tri: [number, number][] = [
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

  return union([foot, frame, ...gussets]);
}
