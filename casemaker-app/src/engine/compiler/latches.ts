import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
  Latch,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/** Issue #109 — Pelican-style spring-cam latch geometry (v1).
 *
 *  v1 simplifies the cam mechanism: striker is a horizontal cylindrical
 *  post on the case wall; arm is a rectangular plate with a hooked lower
 *  edge and a hinge knuckle at the top that pairs with a knuckle on the
 *  lid edge. The "cam profile" delivering the over-center pull-down
 *  isn't yet modeled — closing engages the hook, but actual preload force
 *  depends on the user supplying the right gasket compression factor.
 *
 *  Refinements deferred to follow-ups:
 *  - True cam profile (cardioid-like) for measured pull-down force
 *  - Spring-loaded latch tongue (TPU insert, separate part)
 *  - Lock-out detent (latch can't accidentally pop open)
 */

const STRIKER_RADIUS = 1.5;
const ARM_THICKNESS = 3;
const HOOK_DEPTH = 4;
const ARM_OFFSET_BELOW_RIM = 8;

export interface LatchOps {
  /** Striker geometry, fused with the case shell. */
  caseAdditive: BuildOp[];
  /** Cam arm parts — each is its own top-level BuildNode (printed as a free part). */
  armNodes: { id: string; op: BuildOp }[];
}

export function buildLatchOps(
  latches: Latch[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): LatchOps {
  const empty: LatchOps = { caseAdditive: [], armNodes: [] };
  if (!latches || latches.length === 0) return empty;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const caseAdditive: BuildOp[] = [];
  const armNodes: { id: string; op: BuildOp }[] = [];
  for (const latch of latches) {
    if (!latch.enabled) continue;
    const built = buildOneLatch(latch, dims, params);
    if (!built) continue;
    caseAdditive.push(built.striker);
    armNodes.push({ id: `latch-arm-${latch.id}`, op: built.arm });
  }
  return { caseAdditive, armNodes };
}

interface OneLatch {
  striker: BuildOp;
  arm: BuildOp;
}

function buildOneLatch(
  latch: Latch,
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
): OneLatch | null {
  // Striker: horizontal cylinder protruding from the OUTSIDE of the wall.
  // Y-axis cylinder for ±x walls; X-axis cylinder for ±y walls. Centered
  // at uPosition along the wall, ARM_OFFSET_BELOW_RIM below the rim top.
  const rimTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  const strikerZ = rimTopZ - ARM_OFFSET_BELOW_RIM;
  const strikerLen = latch.width;
  let strikerOp: BuildOp;
  let armOriginX = 0;
  let armOriginY = 0;
  switch (latch.wall) {
    case '+y': {
      // outer +y face at world y = dims.outerY; striker protrudes in +y.
      const cyl = cylinder(strikerLen, STRIKER_RADIUS, 16);
      // Cylinder default axis = +Z; rotate to +X for an X-axis cylinder
      // running along the wall tangent (parallel to wall length = X).
      // We want the striker axis ALONG the wall (X here), centered at
      // (uPosition, outerY + radius, strikerZ). The cylinder is built
      // along Z; rotate around Y by π/2 to get along X.
      strikerOp = translate(
        [latch.uPosition - strikerLen / 2, dims.outerY, strikerZ],
        rotateAxisYPiHalf(cyl),
      );
      armOriginX = latch.uPosition;
      armOriginY = dims.outerY;
      break;
    }
    case '-y': {
      const cyl = cylinder(strikerLen, STRIKER_RADIUS, 16);
      strikerOp = translate(
        [latch.uPosition - strikerLen / 2, 0, strikerZ],
        rotateAxisYPiHalf(cyl),
      );
      armOriginX = latch.uPosition;
      armOriginY = 0;
      break;
    }
    case '+x': {
      const cyl = cylinder(strikerLen, STRIKER_RADIUS, 16);
      // Cylinder along Y (rotate around X by π/2)
      strikerOp = translate(
        [dims.outerX, latch.uPosition - strikerLen / 2, strikerZ],
        rotateAxisXNegPiHalf(cyl),
      );
      armOriginX = dims.outerX;
      armOriginY = latch.uPosition;
      break;
    }
    case '-x': {
      const cyl = cylinder(strikerLen, STRIKER_RADIUS, 16);
      strikerOp = translate(
        [0, latch.uPosition - strikerLen / 2, strikerZ],
        rotateAxisXNegPiHalf(cyl),
      );
      armOriginX = 0;
      armOriginY = latch.uPosition;
      break;
    }
  }

  // Cam arm: a rectangular plate sitting outside the wall. Top of arm
  // sits at rim Z; arm extends DOWN by latch.height. Bottom of arm
  // wraps under by HOOK_DEPTH to engage the striker. v1: arm is a
  // simple cube; the hook is a smaller cube at the bottom protruding
  // INWARD toward the wall.
  const armOuterDistance = 1.5; // mm gap between wall outer face and arm inner face
  // Issue #121 — plate + hook MUST overlap volumetrically. Original code
  // had plate z=[-height, 0] and hook z=[-height-thickness, -height] —
  // they only TOUCH at z=-height, manifold doesn't fuse coplanar solids
  // reliably (same lesson as the lip embed in 4a16cda). Extend the hook
  // upward into the plate by EMBED mm so they share volume.
  const EMBED = 0.5;
  const armPlate = cube([latch.width, ARM_THICKNESS, latch.height], false);
  const hookCube = cube([latch.width, HOOK_DEPTH + ARM_THICKNESS, ARM_THICKNESS + EMBED], false);
  // Compose arm + hook in arm-local coords (origin = top of arm, inner-face XY corner).
  // Local: x along wall, y outward, z down.
  // Arm plate: x [0, width], y [0, ARM_THICKNESS], z [-height, 0]
  // Hook plate: x [0, width], y [-HOOK_DEPTH, ARM_THICKNESS],
  //   z [-height-ARM_THICKNESS, -height+EMBED]  ← overlaps plate by EMBED
  const armLocal = {
    plate: armPlate,
    hook: translate([0, -HOOK_DEPTH, -latch.height - ARM_THICKNESS], hookCube),
  };
  // Stack both cubes into one buildOp via union — keeps the arm a single
  // mesh in the export.
  // Use simple union (not necessary if manifold treats them well, but
  // explicit is safer).
  // Note: cube() origin is the corner; we don't center.
  // We don't want to import union here — just emit two cubes wrapped in
  // a single mesh by leaning on the existing buildPlan union helper.
  const armBody: BuildOp = {
    kind: 'union',
    children: [armLocal.plate, armLocal.hook],
  };
  // Place arm in WORLD coords. The arm's "inner face" (y=0 in local)
  // sits armOuterDistance OUT FROM the wall outer face. Arm's top is at
  // rimTopZ (so it can pivot down from the lid edge).
  let placedArm: BuildOp;
  switch (latch.wall) {
    case '+y':
      // Wall outer at y = dims.outerY. Arm inner face at y = outerY + armOuterDistance.
      placedArm = translate(
        [armOriginX - latch.width / 2, dims.outerY + armOuterDistance, rimTopZ],
        armBody,
      );
      break;
    case '-y':
      // Wall outer at y = 0. Arm inner face at y = -armOuterDistance.
      // armBody local +y is "outward" — for -y wall, outward is -y, so
      // we mirror via rotating 180° about Z. Cheap workaround: translate
      // such that the arm sits on the -y side; the plate happens to be
      // y-symmetric except for the hook. Hook hooks INWARD which for
      // -y means +y. Easiest: translate the local frame so arm's local
      // +y aligns with world -y by negative-Y translation of the corner
      // before adding plate thickness offset.
      placedArm = translate(
        [armOriginX - latch.width / 2, -armOuterDistance - ARM_THICKNESS, rimTopZ],
        armBody,
      );
      break;
    case '+x':
      placedArm = translate(
        [dims.outerX + armOuterDistance, armOriginY - latch.width / 2, rimTopZ],
        rotateZPiHalf(armBody),
      );
      break;
    case '-x':
      placedArm = translate(
        [-armOuterDistance - ARM_THICKNESS, armOriginY - latch.width / 2, rimTopZ],
        rotateZPiHalf(armBody),
      );
      break;
  }

  return { striker: strikerOp, arm: placedArm };
}

// Inline rotation helpers — keeps callers concise without exporting them.
function rotateAxisYPiHalf(op: BuildOp): BuildOp {
  return { kind: 'rotate', degrees: [0, 90, 0], child: op };
}
function rotateAxisXNegPiHalf(op: BuildOp): BuildOp {
  return { kind: 'rotate', degrees: [-90, 0, 0], child: op };
}
function rotateZPiHalf(op: BuildOp): BuildOp {
  return { kind: 'rotate', degrees: [0, 0, 90], child: op };
}
