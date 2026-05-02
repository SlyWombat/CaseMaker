import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
  Latch,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, difference, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import { pinSpanU, pinCapSpanU, LATCH_PIN_CAP_R } from './latchProtection';
import { clampLatch } from './featureScale';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/** Issue #109 — Pelican-standard spring-cam latch (v2 redesign).
 *
 *  Pelican design (vs. the v1 freestanding-arm placeholder):
 *
 *      ┌──── lid plate ────┐
 *      │                ●──── striker tab + post (additive on lid;
 *      │                       sticks OUT past case envelope so the
 *      │                       cam can hook it)
 *      ├───────────────────
 *      ║ rim (case wall)   ║
 *      ║                   ║
 *      ║                   ╚── ⌒── cam hook at TOP of arm
 *      ║                       │
 *      ║                       │   arm body
 *      ║                       │
 *      ║   ⊙─⊙─⊙ ←──────── 3 knuckles share one pin axis:
 *      ║                       outer two = additive on case wall,
 *      ║                       middle one = on the arm.
 *      ║   pin (separate
 *      ║   top-level part,
 *      ║   print-in-place)
 *      ║                       arm pivots ABOUT the pin axis.
 *      ║                       Closed: arm flat against wall, cam
 *      ║                       wraps over lid striker, lid pulled tight.
 *      ║                       Open:   arm rotates outward, cam
 *      ║                       releases lid striker.
 *
 *  v2 still ships a SIMPLE rectangular cam hook (no over-center
 *  cardioid profile) — the engagement is "captured" but not
 *  preloaded. Adding the over-center pull-down is a follow-up;
 *  for now the gasket compression depends on the user pressing the
 *  lid down before flipping the latch.
 *
 *  Constraint: Pelican-standard latches require lidRecess=false. The
 *  lid plate must sit ON TOP of the rim so the striker tab has clear
 *  air to project outward into. With lidRecess=true, the rim
 *  surrounds the lid plate at its own Z and there's no path for the
 *  striker. The compiler skips latch generation (and logs) when
 *  lidRecess is true so a misconfigured project still loads — UI is
 *  expected to surface the constraint.
 */

// -- Geometry constants ---------------------------------------------------
const KNUCKLE_OUTER_R = 4;            // outer radius of every knuckle
const PIN_R = 1.5;                    // pin diameter = 3 mm
const PIN_CLEAR = 0.4;                // hole-to-pin radial clearance
const KNUCKLE_AXIAL_GAP = 0.3;        // gap between case-knuckle and arm-knuckle (along pin axis)
const KNUCKLE_OFFSET = 4;             // pin axis distance OUT from outer wall surface
const PIVOT_BELOW_RIM = 22;           // pin axis Z = rim top - this
const ARM_KNUCKLE_FRACTION = 0.4;     // arm knuckle takes middle 40% of latch.width
const ARM_PLATE_THICKNESS = 3;        // arm body slab thickness (wall-normal direction)
const HOOK_WALL_OFFSET = 1.0;         // gap between arm inner face and case outer wall
const STRIKER_R = 1.5;                // striker post on lid edge
const STRIKER_TAB_THICKNESS = 3;      // wall-normal extent of the lid-side striker tab
const STRIKER_TAB_HEIGHT = 5;         // vertical extent of the striker tab above lid plate top
const HOOK_VERTICAL = 4;              // vertical extent of the cam hook lip
const EMBED = 0.5;                    // volumetric overlap so manifold fuses sub-pieces
// Cam preload: when the arm is in the closed position, the cam hook's
// catch face sits CAM_PRELOAD mm BELOW the striker top. The arm has to
// flex outward by this much for the hook to slide past the striker
// during closure, then springs back to hold the lid down with a real
// clamping force. Without this the latch is "captured" but unloaded —
// first time you pick the case up by the lid the hook just slides off.
// 0.3 mm is well within PLA's elastic budget for a 6 mm-long, 3 mm-thick
// arm and gives ~10 N of clamping force.
const CAM_PRELOAD = 0.3;

export interface LatchOps {
  /** Striker geometry on the LID (additive, in lid-local coords — caller
   *  unions with lidOp before the lid is translated to its world Z). */
  lidAdditive: BuildOp[];
  /** Hinge knuckles fused with the case shell (world coords, additive). */
  caseAdditive: BuildOp[];
  /** Pin bores (subtractive on case knuckles; world coords). */
  caseSubtract: BuildOp[];
  /** Cam-arm parts (each is its own top-level BuildNode — printed as a free part). */
  armNodes: { id: string; op: BuildOp }[];
  /** Print-in-place pins (each is its own top-level BuildNode; world coords). */
  pinNodes: { id: string; op: BuildOp }[];
}

const EMPTY: LatchOps = {
  lidAdditive: [], caseAdditive: [], caseSubtract: [], armNodes: [], pinNodes: [],
};

export function buildLatchOps(
  latches: Latch[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): LatchOps {
  if (!latches || latches.length === 0) return EMPTY;
  // Pelican-standard requires lidRecess=false. If the project is misconfigured,
  // skip the latches (don't crash). The placement validator should warn.
  if (params.lidRecess) return EMPTY;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const out: LatchOps = {
    lidAdditive: [], caseAdditive: [], caseSubtract: [], armNodes: [], pinNodes: [],
  };
  for (const rawLatch of latches) {
    if (!rawLatch.enabled) continue;
    // Clamp the user's stored dims to fit the case + stay printable.
    const latch = clampLatch(rawLatch, dims);
    const built = buildOneLatch(latch, dims, params);
    if (!built) continue;
    out.caseAdditive.push(...built.caseAdditive);
    out.caseSubtract.push(...built.caseSubtract);
    out.lidAdditive.push(...built.lidAdditive);
    out.armNodes.push({ id: `latch-arm-${latch.id}`, op: built.arm });
    out.pinNodes.push({ id: `latch-pin-${latch.id}`, op: built.pin });
  }
  return out;
}

interface OneLatch {
  caseAdditive: BuildOp[];
  caseSubtract: BuildOp[];
  lidAdditive: BuildOp[];
  arm: BuildOp;
  pin: BuildOp;
}

interface WallFrame {
  /** World-coord position of the OUTER wall surface on the wall-normal axis. */
  wallOuter: number;
  /** Outward-pointing sign on the wall-normal axis (+1 or -1). */
  outwardSign: 1 | -1;
  /** Which axis is the wall normal. */
  wallAxis: 'x' | 'y';
}

function frameForWall(wall: Latch['wall'], dims: { outerX: number; outerY: number }): WallFrame {
  switch (wall) {
    case '-x': return { wallOuter: 0,            outwardSign: -1, wallAxis: 'x' };
    case '+x': return { wallOuter: dims.outerX,  outwardSign: +1, wallAxis: 'x' };
    case '-y': return { wallOuter: 0,            outwardSign: -1, wallAxis: 'y' };
    case '+y': return { wallOuter: dims.outerY,  outwardSign: +1, wallAxis: 'y' };
  }
}

function buildOneLatch(
  latch: Latch,
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
): OneLatch | null {
  // lidRecess=false guaranteed by caller; rim top sits at outerZ.
  const rimTopZ = dims.outerZ;
  const lidPlateBottomZ = rimTopZ;                    // lid sits ON the rim
  const lidPlateTopZ = lidPlateBottomZ + params.lidThickness;
  const pivotZ = rimTopZ - PIVOT_BELOW_RIM;
  const tolerance = latch.tolerance ?? 0.2;

  const f = frameForWall(latch.wall, dims);
  // World-coord helpers: position vectors that respect the wall axis. For
  // ±x walls the wall-NORMAL axis is X (and the wall-TANGENT is Y); for
  // ±y walls those swap.
  const u0 = latch.uPosition;             // along the wall tangent
  const wallOuter = f.wallOuter;          // wall-normal coord of outer wall surface

  // -- Case knuckles (additive on shell, with pin bores subtracted) -------
  const totalKnuckleSpan = latch.width;   // axial span (along wall tangent) for the 3-knuckle stack
  const armKnuckleLen = ARM_KNUCKLE_FRACTION * totalKnuckleSpan - 2 * KNUCKLE_AXIAL_GAP;
  const caseKnuckleLen = (totalKnuckleSpan - armKnuckleLen - 2 * KNUCKLE_AXIAL_GAP) / 2;
  if (armKnuckleLen <= 0.5 || caseKnuckleLen <= 0.5) return null;
  const armKnuckleU0 = u0 - armKnuckleLen / 2;
  const caseKnuckleAU0 = u0 - latch.width / 2;
  const caseKnuckleBU0 = u0 + armKnuckleLen / 2 + KNUCKLE_AXIAL_GAP;
  // Pin axis position along the wall-normal axis: outside wall by KNUCKLE_OFFSET.
  const pinAxisN = wallOuter + f.outwardSign * KNUCKLE_OFFSET;
  // Each case knuckle = a cylinder along the wall tangent fused with the
  // wall material. EMBED extends the inboard face INTO the wall so manifold
  // fuses knuckle + wall (coplanar contact alone wouldn't, per #121).
  const caseKnuckleA = makeKnuckleAlongTangent(
    f, caseKnuckleAU0, caseKnuckleLen, pinAxisN, pivotZ, KNUCKLE_OUTER_R, EMBED,
  );
  const caseKnuckleB = makeKnuckleAlongTangent(
    f, caseKnuckleBU0, caseKnuckleLen, pinAxisN, pivotZ, KNUCKLE_OUTER_R, EMBED,
  );
  // Pin bore through case knuckles: cylinder of PIN_R + clearance, length
  // covering the full knuckle span. World coord: along wall tangent.
  const pinBore = makeBoreAlongTangent(
    f, u0 - latch.width / 2 - 0.5, latch.width + 1.0, pinAxisN, pivotZ, PIN_R + tolerance + PIN_CLEAR,
  );

  // -- Pin (separate part, runs through every knuckle) --------------------
  // Pin = cylindrical SHAFT + wider CAP at the corner-facing end. The
  // shaft passes through case knuckles + the corner-facing protective
  // rib's through-hole. The cap sits in a counter-sink on the rib's
  // outer face and lands FLUSH with that face when fully inserted —
  // gives the user a thumbnail / paperclip grip without a protruding stub.
  const pinSpan = pinSpanU(latch, dims);
  const pinShaft = makeBoreAlongTangent(
    f, pinSpan.uMin, pinSpan.uMax - pinSpan.uMin, pinAxisN, pivotZ, PIN_R,
  );
  const capSpan = pinCapSpanU(latch, dims);
  const pin = capSpan
    ? union([
        pinShaft,
        makeBoreAlongTangent(
          f, capSpan.uMin, capSpan.uMax - capSpan.uMin, pinAxisN, pivotZ, LATCH_PIN_CAP_R,
        ),
      ])
    : pinShaft;

  // -- Lid-side striker geometry (computed first so the arm hook can be
  // -- positioned relative to the striker). Built later in lid-local coords.
  // Two paths depending on whether the lid is a Pelican-style SHELL (has
  // its own side walls) or a flat plate:
  //   • Shell lid (lidCavityHeight > 0): striker rides DIRECTLY on the
  //     lid's outer side wall — no separate striker tab needed because
  //     there's already a wall there. Striker Z sits a fixed distance up
  //     the lid wall.
  //   • Flat lid: the lid is a thin plate at z=lidPlateBottomZ; we extend
  //     a short tab UP from the plate top to give the striker an anchor.
  const lidShellMode = (params.lidCavityHeight ?? 0) > 0;
  let strikerAxisN: number;
  let strikerZ: number;
  let tabInnerN: number;
  let tabOuterN: number;
  if (lidShellMode) {
    // Striker post: cylinder along wall tangent. Axis at the lid wall's
    // OUTER face (so half overlaps the wall, half protrudes outward) at
    // a Z above the rim.
    const STRIKER_Z_ABOVE_RIM = 6;  // mm — striker sits this far up the lid wall
    strikerAxisN = wallOuter;
    strikerZ = rimTopZ + STRIKER_Z_ABOVE_RIM;
    // No tab in shell mode; the lid wall IS the anchor.
    tabInnerN = wallOuter;
    tabOuterN = wallOuter;
  } else {
    tabInnerN = wallOuter - f.outwardSign * EMBED;
    tabOuterN = wallOuter + f.outwardSign * STRIKER_TAB_THICKNESS;
    strikerAxisN = tabOuterN;
    strikerZ = lidPlateTopZ + STRIKER_TAB_HEIGHT / 2;
  }

  // -- Arm knuckle + body + cam hook --------------------------------------
  // Arm knuckle: cylinder along wall tangent in the middle gap.
  const armKnuckle = makeKnuckleAlongTangent(
    f, armKnuckleU0, armKnuckleLen, pinAxisN, pivotZ, KNUCKLE_OUTER_R, 0,
  );
  // Arm body: rectangular slab extending from the knuckle UPWARD to just
  // above the rim, on the OUTSIDE of the case (offset by HOOK_WALL_OFFSET
  // from outer wall surface). At the top, a cam hook curls inward over
  // the lid striker.
  // Body Z range: [pivotZ - KNUCKLE_OUTER_R + EMBED, hookTopZ] — the body
  // extends UP to the cam hook's TOP so the hook (a horizontal slab off
  // the body's inner face) shares the upper Z slice with the body
  // volumetrically. Bottom edge starts INSIDE the knuckle for fusion.
  const bodyBotZ = pivotZ - KNUCKLE_OUTER_R + EMBED;
  // Catch face = hook bottom. Pre-#X this sat ABOVE the striker top by
  // `tolerance` (no clamping); now sits BELOW by CAM_PRELOAD so the cam
  // physically interferes with the striker when the arm is closed. The
  // arm flexes elastically to accommodate, providing real lid-clamping
  // force against the gasket. `tolerance` is added back as a relief so
  // sloppy printers don't end up with a press fit so tight the latch
  // can't close.
  const hookBotZ = strikerZ + STRIKER_R - CAM_PRELOAD + tolerance;
  const hookTopZ = hookBotZ + HOOK_VERTICAL;
  const bodyTopZ = hookTopZ;
  // Arm body sits on the OUTSIDE of the case; its inner face is at
  // wallOuter + HOOK_WALL_OFFSET + tolerance (engagement gap), outer face
  // at inner + ARM_PLATE_THICKNESS.
  const armBodyInnerN = wallOuter + f.outwardSign * (HOOK_WALL_OFFSET + tolerance);
  const armBodyOuterN = armBodyInnerN + f.outwardSign * ARM_PLATE_THICKNESS;
  const armBody = makeBoxBetween(
    f,
    u0 - latch.width / 2, u0 + latch.width / 2,
    armBodyInnerN, armBodyOuterN,
    bodyBotZ, bodyTopZ,
  );
  // Cam hook at the TOP of the arm: a horizontal extension that turns
  // INWARD from the arm body and hangs OVER the striker post. The hook's
  // BOTTOM face is the catch face — it sits just above the striker's top,
  // pulling the lid down via the striker when the arm is in the closed
  // position.
  // Hook spans wall-normal range from arm body INNER face (with EMBED
  // overlap for volumetric union) INWARD past the striker by HOOK_OVERHANG
  // so the catch face reliably grabs the striker.
  const HOOK_OVERHANG = STRIKER_R + 1.0;  // hook reaches past striker INWARD edge by 1 mm
  const hookInnerN = strikerAxisN - f.outwardSign * HOOK_OVERHANG;
  // Hook's outer end overlaps the arm body by EMBED so manifold fuses
  // body+hook (otherwise coplanar contact at the body inner face leaves
  // the hook as a loose component).
  const hookOuterN = armBodyInnerN + f.outwardSign * EMBED;
  const hook = makeBoxBetween(
    f,
    u0 - latch.width / 2, u0 + latch.width / 2,
    hookInnerN, hookOuterN,
    hookBotZ, hookTopZ,
  );
  const arm = union([armKnuckle, armBody, hook]);

  // -- Striker on the LID (additive in lid-local coords) ------------------
  // Shell mode: a single striker cylinder fused with the lid's outer side
  // wall (no tab — the lid wall provides the anchor).
  // Flat mode: a short tab extends UP from the lid plate top, with the
  // striker post on the tab's outer face.
  const strikerLen = latch.width;
  const striker = makeKnuckleAlongTangent(
    f, u0 - strikerLen / 2, strikerLen, strikerAxisN, strikerZ, STRIKER_R, 0,
  );
  let lidPart: BuildOp;
  if (lidShellMode) {
    lidPart = striker;
  } else {
    const tab = makeBoxBetween(
      f,
      u0 - latch.width / 2, u0 + latch.width / 2,
      tabInnerN, tabOuterN,
      lidPlateTopZ - EMBED, lidPlateTopZ + STRIKER_TAB_HEIGHT,
    );
    lidPart = union([tab, striker]);
  }

  return {
    caseAdditive: [caseKnuckleA, caseKnuckleB],
    caseSubtract: [pinBore],
    lidAdditive: [lidPart],
    arm,
    pin,
  };
}

// -- helpers --------------------------------------------------------------

/** Cylinder along the wall tangent, axis at (n=axisN, z=axisZ), spanning
 *  [u0, u0+len] along the tangent. `embed` extends the cylinder INWARD
 *  toward the wall by axially-symmetric extra radius — used by case
 *  knuckles to overlap wall material volumetrically. */
function makeKnuckleAlongTangent(
  f: WallFrame,
  u0: number,
  len: number,
  axisN: number,
  axisZ: number,
  outerR: number,
  embed: number,
): BuildOp {
  // Build cylinder along its default +Z axis, then rotate so its axis aligns
  // with the wall tangent (Y for ±x walls, X for ±y walls). `embed` shifts
  // the cylinder INWARD by that distance so the inboard edge overlaps wall
  // material volumetrically (otherwise coplanar contact leaves the knuckle
  // as a loose component — #121 pattern).
  const r = outerR;
  const effectiveAxisN = axisN - f.outwardSign * embed;
  const cyl = cylinder(len, r, 24);
  if (f.wallAxis === 'x') {
    // Tangent = Y. Rotate around X by -90 to map +Z→+Y. Then translate so
    // the cylinder's circular center is at (effectiveAxisN, u0, axisZ).
    return translate(
      [effectiveAxisN, u0, axisZ],
      { kind: 'rotate', degrees: [-90, 0, 0], child: cyl },
    );
  }
  // wallAxis === 'y': tangent = X. Rotate around Y by +90 to map +Z→+X.
  return translate(
    [u0, effectiveAxisN, axisZ],
    { kind: 'rotate', degrees: [0, 90, 0], child: cyl },
  );
}

function makeBoreAlongTangent(
  f: WallFrame, u0: number, len: number, axisN: number, axisZ: number, r: number,
): BuildOp {
  return makeKnuckleAlongTangent(f, u0, len, axisN, axisZ, r, 0);
}

/** Rectangular box (cube) spanning [u0,u1] along the wall tangent,
 *  [n0,n1] along the wall normal, [z0,z1] along Z. Handles either sign
 *  ordering of n0/n1. */
function makeBoxBetween(
  f: WallFrame,
  u0: number, u1: number,
  n0: number, n1: number,
  z0: number, z1: number,
): BuildOp {
  const uMin = Math.min(u0, u1);
  const uMax = Math.max(u0, u1);
  const nMin = Math.min(n0, n1);
  const nMax = Math.max(n0, n1);
  const zMin = Math.min(z0, z1);
  const zMax = Math.max(z0, z1);
  if (f.wallAxis === 'x') {
    // n = X axis, u = Y axis.
    return translate([nMin, uMin, zMin], cube([nMax - nMin, uMax - uMin, zMax - zMin]));
  }
  return translate([uMin, nMin, zMin], cube([uMax - uMin, nMax - nMin, zMax - zMin]));
}

// difference is imported above for completeness but currently unused at
// the top level — the pin bore is handled via caseSubtract on the shell.
void difference;
