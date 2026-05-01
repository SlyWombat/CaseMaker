import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
  SnapCatch,
  SnapWall,
  BarbType,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { SNAP_DEFAULTS } from '@/types/snap';
import { cube, cylinder, mesh, rotate, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

/**
 * Issue #75 / #90 / followup — inside-wall snap lip. Trapezoidal prism with
 * a sloped outboard face that gives the lid arm a smooth lead-in: as the
 * lid pushes down, the barb's leading edge contacts the slope and the
 * slope translates downward force into outward force on the arm,
 * flexing it past the lip without requiring the wall to flex. Once the
 * barb clears the lip's bottom face (the catch face), the arm springs
 * back and the barb sits below the lip.
 *
 * Cross-section in (n, z): trapezoid with vertices
 *   (0, 0)             — wall-base
 *   (protrusion, 0)    — outboard-base (full protrusion at the catch face)
 *   (protrusion·k, H)  — outboard-top (narrowed by factor k)
 *   (0, H)             — wall-top
 * where k ≈ 0.2 gives a steep but printable insertion ramp.
 *
 * Coordinate convention: nOff > 0 is CAVITY-BOUND (so the lip protrudes
 * INTO the cavity to engage the lid arm's barb). The local→world basis
 * uses dn = -wallNormalSign · axis because wallNormalSign is the outward
 * normal sign and cavity-bound is the opposite direction.
 *
 * Pre-fix bug: the lip was emitted in the OUTWARD direction (away from
 * the cavity), with EMBED_INTO_WALL providing the only attachment to wall
 * material. The lid arm's barb sat in the cavity with nothing to hook
 * under — geometrically present but functionally non-engaging. AND the
 * mesh winding was hard-coded for one (axis, sign) parity; the other half
 * of the walls produced inverted-orientation triangles that manifold
 * couldn't fuse, leaving loose-piece lips on the +x and -y walls of the
 * snap-fit-test template (and any user case using those walls).
 */
function buildLipWedge(
  origin: { x: number; y: number; z: number },
  wallAxis: 'x' | 'y',
  wallNormalSign: 1 | -1,
  protrusion: number,
  width: number,
  height: number,
): BuildOp {
  const TOP_RATIO = 0.2; // outboard-top is 20% of the base protrusion
  const pMin = protrusion * TOP_RATIO;
  // pushVert maps face-local (uOff, nOff, zOff) → world coords. nOff > 0
  // is cavity-bound (away from outer wall surface, into the case interior).
  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, zOff: number): void {
    const cavityBoundSign = -wallNormalSign;
    if (wallAxis === 'x') {
      const dx = cavityBoundSign * nOff;
      positions.push(origin.x + dx, origin.y + uOff, origin.z + zOff);
    } else {
      const dy = cavityBoundSign * nOff;
      positions.push(origin.x + uOff, origin.y + dy, origin.z + zOff);
    }
  }
  // 8 vertices — base quad (4) + top quad (4).
  pushVert(0, 0, 0);              // 0  A — wall, base
  pushVert(width, 0, 0);          // 1  B — wall, base, far-u
  pushVert(0, protrusion, 0);     // 2  C — outboard, base
  pushVert(width, protrusion, 0); // 3  D — outboard, base, far-u
  pushVert(0, 0, height);         // 4  E — wall, top
  pushVert(width, 0, height);     // 5  F — wall, top, far-u
  pushVert(0, pMin, height);      // 6  G — outboard, top (narrowed)
  pushVert(width, pMin, height);  // 7  I — outboard, top, far-u (narrowed)
  // Reference triangle list (winding for det(local→world) > 0). Every
  // face's right-hand-rule cross product points away from the trapezoid
  // interior so manifold treats the prism as a valid solid:
  //   base   z=0, outside -z
  //   top    z=H, outside +z
  //   wall   n=0, outside -n
  //   outboard slanted, outside +n+z
  //   front  u=0, outside -u
  //   back   u=width, outside +u
  const tris: number[] = [
    0, 3, 1,  0, 2, 3,   // base
    4, 7, 6,  4, 5, 7,   // top
    0, 1, 5,  0, 5, 4,   // wall
    3, 2, 6,  3, 6, 7,   // outboard
    0, 6, 2,  0, 4, 6,   // front cap
    1, 7, 5,  1, 3, 7,   // back cap
  ];
  // The local→world basis (u-axis, n-axis, z) determinant flips sign
  // depending on (wallAxis, wallNormalSign). When negative, every triangle
  // winding is geometrically inverted (outward normal points the wrong
  // way) — manifold then rejects the mesh or unions it as a separate
  // disconnected component. Compute the parity directly so adding new
  // wall axes or sign conventions doesn't silently regress.
  //
  //   axis='x': u-axis=Ŷ, n-axis=cavityBoundSign·X̂, z-axis=Ẑ
  //             det = cavityBoundSign · det(Ŷ, X̂, Ẑ) = cavityBoundSign · -1
  //   axis='y': u-axis=X̂, n-axis=cavityBoundSign·Ŷ, z-axis=Ẑ
  //             det = cavityBoundSign · det(X̂, Ŷ, Ẑ) = cavityBoundSign · +1
  //
  // With cavityBoundSign = -wallNormalSign:
  //   axis='x': det =  wallNormalSign  → inverted when wallNormalSign = -1 (-x wall)
  //   axis='y': det = -wallNormalSign  → inverted when wallNormalSign = +1 (+y wall)
  const inverted =
    (wallAxis === 'x' && wallNormalSign === -1) ||
    (wallAxis === 'y' && wallNormalSign === +1);
  if (inverted) {
    for (let i = 0; i < tris.length; i += 3) {
      const swap = tris[i + 1]!;
      tris[i + 1] = tris[i + 2]!;
      tris[i + 2] = swap;
    }
  }
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

/**
 * Issue #69 / #90 — symmetric (diamond) lip for symmetric-ramp catches.
 * Same primitive-cube fix as buildLipWedge — the original mesh pattern was
 * the same fragile mesh-with-winding approach. Functional difference vs the
 * hook lip is gone (both are now flat cubes); the symmetric-ramp BARB still
 * provides the symmetric insertion/removal force on the lid side.
 */
function buildLipSymmetricPrism(
  origin: { x: number; y: number; z: number },
  wallAxis: 'x' | 'y',
  wallNormalSign: 1 | -1,
  protrusion: number,
  width: number,
  height: number,
): BuildOp {
  return buildLipWedge(origin, wallAxis, wallNormalSign, protrusion, width, height);
}

// ---------------------------------------------------------------------------
// Hook (subtract-tab) snap-fit design.
//
// Departure from the lip-based designs (asymmetric-ramp, symmetric-ramp,
// half-round): instead of an additive lip on the wall + a separate barb on
// the lid that hooks under it, the lid carries a full TAB (cantilever arm
// + integral barb) and the SHELL has the seated-tab volume SUBTRACTED out,
// creating the snap hole. The wall material above the hole forms the catch
// ledge — engagement is purely 90° flat-to-flat retention with no lip.
//
// Tab geometry (in WORLD coords, computed for arbitrary wall):
//
//                    ┌─── lid plate at lidPlateBottomZ
//                    │     ┐
//                    │arm  │ HOOK_TOP_MARGIN (also clamped under recess
//                    │     │   pocket bottom for recessed lids — gives
//                    │     ┘   solid catch material above the barb)
//                    │  ┌──┐ ← barb top (90° flat catch face)
//                    │  │  │
//                    │  │  │ HOOK_BARB_BODY_HEIGHT (vertical retention body)
//                    │  └──┘ ← body bottom
//                    │  /             ─┐
//                    │ /                │ HOOK_BARB_TAPER_HEIGHT (insertion ramp:
//                    │/                 │   collapses outboard protrusion to
//                    │  ← arm bottom    ┘   zero at the tip so the barb's
//                    │                       leading edge enters cleanly)
//
// The arm hugs the inner wall surface (with HOOK_ARM_INSET clearance for
// sliding); the barb extends OUTWARD from the arm's outer face by
// HOOK_BARB_PROTRUSION, INTO the wall material. During insertion the
// tapered face rides up the inner wall surface, deflecting the arm
// inward; at full insertion the body's outer face slides past the inner
// wall surface (touching it); at seated, the body drops into the
// subtracted hole and the arm springs back outward — the body's flat
// 90° top engages the wall material above.
const HOOK_TOP_MARGIN = 1.0;        // mm — barb top sits this far below lid plate / pocket bot
const HOOK_BARB_PROTRUSION = 0.8;   // mm — barb extends this far into wall material
const HOOK_BARB_BODY_HEIGHT = 2.5;  // mm — vertical retention body
const HOOK_BARB_TAPER_HEIGHT = 1.5; // mm — tapered insertion ramp at the bottom
const HOOK_ARM_INSET = 0.2;         // mm — arm outer face to inner wall surface (sliding clearance)
const HOOK_RECESS_CATCH_GUARD = 1.0;// mm — minimum solid wall above barb top below recess pocket
// Issue #121-class — manifold can't reliably fuse solids that meet only at
// coplanar surfaces (no shared volume). Body+arm and body+tip share planes
// by construction, so each barb sub-piece extends INTO the adjacent piece
// by HOOK_TAB_EMBED for a guaranteed volumetric overlap.
const HOOK_TAB_EMBED = 0.3;

interface HookTabFrame {
  /** Bbox-min corner of the arm in world X / Y (X/Y don't differ between
   *  lid-local and world — the lid sits at world X / Y with no offset). */
  armOriginX: number;
  armOriginY: number;
  armSizeX: number;
  armSizeY: number;
  /** Bbox-min corner of the barb body in world X / Y. */
  barbBodyOriginX: number;
  barbBodyOriginY: number;
  barbBodySizeX: number;
  barbBodySizeY: number;
  /** Z values in LID-LOCAL coords (lid plate underside = z=0; arm extends
   *  into negative z). buildHookTab emits in lid-local; the wall subtract
   *  translates by lidPlateBottomZ_world to get the world-coord cut. */
  armBotZ_local: number;       // = -SNAP_DEFAULTS.armLength
  barbTopZ_local: number;
  barbBodyBotZ_local: number;
  barbTipBotZ_local: number;
  /** World Z of the lid plate underside — used to translate the tab into
   *  world coords for the shell subtraction. */
  lidPlateBottomZ_world: number;
  /** Wall geometry (for the tapered-tip mesh winding). */
  wallAxis: 'x' | 'y';
  wallNormalSign: 1 | -1;
}

function computeHookTabFrame(
  c: SnapCatch,
  params: CaseParameters,
  dims: { outerX: number; outerY: number; outerZ: number },
): HookTabFrame {
  const { wallThickness: wall } = params;
  const lidPlateBottomZ_world = params.lidRecess
    ? dims.outerZ - params.lidThickness
    : dims.outerZ;
  const pocketBotZ_world = params.lidRecess
    ? dims.outerZ - (params.lidThickness + 0.5)
    : Infinity;
  // Barb top must be (a) below lid plate by HOOK_TOP_MARGIN and (b) below
  // the recess pocket bottom by HOOK_RECESS_CATCH_GUARD (recessed only)
  // so the catch material above is solid wall, not the partially-carved
  // pocket region. Z values are stored as LID-LOCAL (relative to lid plate
  // underside = 0) so they can union directly into the lid-local lidOp.
  const recessCatchGuard_local = pocketBotZ_world - lidPlateBottomZ_world; // negative or -∞
  const barbTopZ_local = Math.min(
    -HOOK_TOP_MARGIN,
    recessCatchGuard_local - HOOK_RECESS_CATCH_GUARD,
  );
  const barbBodyBotZ_local = barbTopZ_local - HOOK_BARB_BODY_HEIGHT;
  const barbTipBotZ_local = barbBodyBotZ_local - HOOK_BARB_TAPER_HEIGHT;
  const armBotZ_local = -SNAP_DEFAULTS.armLength;
  const armWidth = SNAP_DEFAULTS.armWidth;
  const armThickness = SNAP_DEFAULTS.armThickness;

  let wallAxis: 'x' | 'y';
  let wallNormalSign: 1 | -1;
  let armOriginX: number, armOriginY: number;
  let armSizeX: number, armSizeY: number;
  let barbBodyOriginX: number, barbBodyOriginY: number;
  let barbBodySizeX: number, barbBodySizeY: number;

  switch (c.wall) {
    case '-x': {
      wallAxis = 'x'; wallNormalSign = -1;
      const innerWallX = wall;
      armOriginX = innerWallX + HOOK_ARM_INSET;
      armOriginY = c.uPosition - armWidth / 2;
      armSizeX = armThickness;
      armSizeY = armWidth;
      barbBodyOriginX = armOriginX - HOOK_BARB_PROTRUSION;
      barbBodyOriginY = armOriginY;
      barbBodySizeX = HOOK_BARB_PROTRUSION;
      barbBodySizeY = armWidth;
      break;
    }
    case '+x': {
      wallAxis = 'x'; wallNormalSign = +1;
      const innerWallX = dims.outerX - wall;
      armOriginX = innerWallX - HOOK_ARM_INSET - armThickness;
      armOriginY = c.uPosition - armWidth / 2;
      armSizeX = armThickness;
      armSizeY = armWidth;
      barbBodyOriginX = armOriginX + armThickness;
      barbBodyOriginY = armOriginY;
      barbBodySizeX = HOOK_BARB_PROTRUSION;
      barbBodySizeY = armWidth;
      break;
    }
    case '-y': {
      wallAxis = 'y'; wallNormalSign = -1;
      const innerWallY = wall;
      armOriginX = c.uPosition - armWidth / 2;
      armOriginY = innerWallY + HOOK_ARM_INSET;
      armSizeX = armWidth;
      armSizeY = armThickness;
      barbBodyOriginX = armOriginX;
      barbBodyOriginY = armOriginY - HOOK_BARB_PROTRUSION;
      barbBodySizeX = armWidth;
      barbBodySizeY = HOOK_BARB_PROTRUSION;
      break;
    }
    case '+y': {
      wallAxis = 'y'; wallNormalSign = +1;
      const innerWallY = dims.outerY - wall;
      armOriginX = c.uPosition - armWidth / 2;
      armOriginY = innerWallY - HOOK_ARM_INSET - armThickness;
      armSizeX = armWidth;
      armSizeY = armThickness;
      barbBodyOriginX = armOriginX;
      barbBodyOriginY = armOriginY + armThickness;
      barbBodySizeX = armWidth;
      barbBodySizeY = HOOK_BARB_PROTRUSION;
      break;
    }
  }

  return {
    armOriginX, armOriginY, armSizeX, armSizeY,
    barbBodyOriginX, barbBodyOriginY, barbBodySizeX, barbBodySizeY,
    lidPlateBottomZ_world,
    armBotZ_local, barbTopZ_local, barbBodyBotZ_local, barbTipBotZ_local,
    wallAxis, wallNormalSign,
  };
}

/** Triangular prism for the tapered insertion ramp. The cross-section in
 *  the (n, z) plane is a right triangle:
 *    A = (n=0,                           z=barbBodyBotZ)  — arm-side, top of taper
 *    B = (n=barbProtrusion·outwardSign,  z=barbBodyBotZ)  — outboard, top of taper
 *    C = (n=0,                           z=barbTipBotZ)   — arm-side, tip
 *  Extruded along the wall tangent for armWidth. The hypotenuse B-C is
 *  the slope the inner wall surface rides up during insertion.
 *  Winding parity is computed the same way as buildLipWedge — flip if the
 *  local→world basis Jacobian is negative for the (axis, sign) pair. */
function buildHookTaperedTip(frame: HookTabFrame): BuildOp {
  // Anchor along the wall-NORMAL axis (where "outer" / "into wall" makes
  // sense): the arm's outer face. Anchor along the wall-TANGENT axis is
  // always bbox-min (the start of the armWidth extrusion).
  let normalAnchor: number;   // arm outer face on the wall-normal axis
  let tangentAnchor: number;  // bbox-min along the wall-tangent axis
  let armWidth: number;
  if (frame.wallAxis === 'x') {
    // Wall normal = X; wall tangent = Y. Arm bbox: X=[armOriginX, armOriginX+armSizeX], Y=[armOriginY, armOriginY+armSizeY=armOriginY+armWidth].
    normalAnchor = frame.wallNormalSign === -1
      ? frame.armOriginX
      : frame.armOriginX + frame.armSizeX;
    tangentAnchor = frame.armOriginY;
    armWidth = frame.armSizeY;
  } else {
    // Wall normal = Y; wall tangent = X.
    normalAnchor = frame.wallNormalSign === -1
      ? frame.armOriginY
      : frame.armOriginY + frame.armSizeY;
    tangentAnchor = frame.armOriginX;
    armWidth = frame.armSizeX;
  }
  // Outward = into wall = wallNormalSign on the wall-normal axis.
  const outward = frame.wallNormalSign;

  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, z: number): void {
    if (frame.wallAxis === 'x') {
      // u = world Y; n = world X (with `outward` sign).
      positions.push(normalAnchor + outward * nOff, tangentAnchor + uOff, z);
    } else {
      // u = world X; n = world Y.
      positions.push(tangentAnchor + uOff, normalAnchor + outward * nOff, z);
    }
  }
  // 6 vertices: A, B, C at uOff=0 (front cap) and at uOff=armWidth (back cap).
  // The arm-side anchor (n=0) extends INTO the arm by HOOK_TAB_EMBED for
  // a volumetric overlap so manifold fuses the tip + arm into one solid
  // (coplanar contact alone does not). The tip's TOP face also extends UP
  // into the body by HOOK_TAB_EMBED for the same reason.
  // A: arm-side, top of taper      → (0,                                0, barbBodyBotZ + EMBED)
  // B: outboard, top of taper      → (0,         HOOK_BARB_PROTRUSION, barbBodyBotZ + EMBED)
  // C: arm-side, tip               → (0,                                0, barbTipBotZ)
  // arm-side n offset = -EMBED  (negative n = into the arm, opposite of "into wall")
  pushVert(0,                    -HOOK_TAB_EMBED,         frame.barbBodyBotZ_local + HOOK_TAB_EMBED);  // 0  Af
  pushVert(0,                    HOOK_BARB_PROTRUSION,    frame.barbBodyBotZ_local + HOOK_TAB_EMBED);  // 1  Bf
  pushVert(0,                    -HOOK_TAB_EMBED,         frame.barbTipBotZ_local);   // 2  Cf
  pushVert(armWidth,             -HOOK_TAB_EMBED,         frame.barbBodyBotZ_local + HOOK_TAB_EMBED);  // 3  Ab
  pushVert(armWidth,             HOOK_BARB_PROTRUSION,    frame.barbBodyBotZ_local + HOOK_TAB_EMBED);  // 4  Bb
  pushVert(armWidth,             -HOOK_TAB_EMBED,         frame.barbTipBotZ_local);   // 5  Cb
  // Reference winding (verified by cross-products of every face giving the
  // expected outward normal for the (axis, sign) parity-positive case):
  //   front cap (uOff=0,        outside -u):              0, 2, 1
  //   back cap  (uOff=armWidth, outside +u):              3, 4, 5
  //   top quad  (z=barbBodyBotZ,outside +z): split:       0, 1, 4   and  0, 4, 3
  //   arm-face  (n=arm-side,    outside +arm-toward):     0, 3, 5   and  0, 5, 2
  //   slope     (hypotenuse,    outside (-n, -z)):        1, 5, 4   and  1, 2, 5
  // The slope was the trickiest — its outward direction is OPPOSITE the
  // wedge interior, which sits on the arm-side / top-side of the
  // hypotenuse, so the slope normal points into the cavity AND down. The
  // initial naive winding (1,4,5)/(1,5,2) gave (+n,+z) and made the mesh
  // non-orientable.
  const tris: number[] = [
    0, 2, 1,                    // front cap
    3, 4, 5,                    // back cap
    0, 1, 4,  0, 4, 3,          // top quad
    0, 3, 5,  0, 5, 2,          // arm-face
    1, 5, 4,  1, 2, 5,          // slope
  ];
  const inverted =
    (frame.wallAxis === 'x' && frame.wallNormalSign === -1) ||
    (frame.wallAxis === 'y' && frame.wallNormalSign === +1);
  if (inverted) {
    for (let i = 0; i < tris.length; i += 3) {
      const swap = tris[i + 1]!;
      tris[i + 1] = tris[i + 2]!;
      tris[i + 2] = swap;
    }
  }
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

/** Full lid-side tab: arm + barb body + tapered tip, unioned into one
 *  build op. Result is in WORLD coords; ProjectCompiler offsets it to
 *  lid-local before unioning into the lid mesh. */
function buildHookTab(frame: HookTabFrame): BuildOp {
  // Arm extends UP into the lid plate by HOOK_TAB_EMBED so manifold fuses
  // arm+lid (otherwise the arm's top face is coplanar with the lid plate
  // underside and the union leaves the tab as a loose component).
  const arm = translate(
    [frame.armOriginX, frame.armOriginY, frame.armBotZ_local],
    cube([frame.armSizeX, frame.armSizeY, SNAP_DEFAULTS.armLength + HOOK_TAB_EMBED]),
  );
  // Body extends into the arm by HOOK_TAB_EMBED on the arm-side face so
  // manifold fuses body+arm volumetrically (not just coplanar contact).
  // For ±y walls the arm-side face is y±, for ±x walls it's x±, governed
  // by wallNormalSign (outward), so the embed direction is OPPOSITE
  // (toward the cavity / arm body) = -wallNormalSign.
  const intoArm = -frame.wallNormalSign;
  const bodyOriginX = frame.wallAxis === 'x'
    ? frame.barbBodyOriginX + (intoArm > 0 ? 0 : -HOOK_TAB_EMBED)  // wallNormalSign>0 → barb on +x side, embed extends +x; <0 → barb on -x side, extend -x
    : frame.barbBodyOriginX;
  // Wait — easier: always extend the body's wall-NORMAL extent by HOOK_TAB_EMBED
  // on the side facing the arm. For ±x wall, that's the X axis; for ±y wall,
  // that's the Y axis. Direction is INTO the arm = -wallNormalSign.
  void bodyOriginX;
  const body = (() => {
    let ox = frame.barbBodyOriginX;
    let oy = frame.barbBodyOriginY;
    let sx = frame.barbBodySizeX;
    let sy = frame.barbBodySizeY;
    if (frame.wallAxis === 'x') {
      // Extend by HOOK_TAB_EMBED on the arm-facing side along X.
      // Barb body bbox along X is from barbBodyOriginX (size barbBodySizeX).
      // Arm is on the opposite side from the wall. For -x wall (wallNormalSign=-1),
      // wall is at -X so barb is at -X side of arm; arm is at +X side of barb.
      // Extending the body's +X face into the arm: ox unchanged, sx += EMBED.
      // For +x wall (wallNormalSign=+1), barb is at +X side of arm; arm is at -X side.
      // Extending the body's -X face into the arm: ox -= EMBED, sx += EMBED.
      if (frame.wallNormalSign === -1) sx += HOOK_TAB_EMBED;
      else { ox -= HOOK_TAB_EMBED; sx += HOOK_TAB_EMBED; }
    } else {
      if (frame.wallNormalSign === -1) sy += HOOK_TAB_EMBED;
      else { oy -= HOOK_TAB_EMBED; sy += HOOK_TAB_EMBED; }
    }
    // Also extend the body DOWN by HOOK_TAB_EMBED so it overlaps the tip's
    // top extension (the tip extends UP into the body's footprint).
    return translate([ox, oy, frame.barbBodyBotZ_local - HOOK_TAB_EMBED], cube([sx, sy, HOOK_BARB_BODY_HEIGHT + HOOK_TAB_EMBED]));
  })();
  const tip = buildHookTaperedTip(frame);
  return union([arm, body, tip]);
}

/** Subtract-from-shell volume = the full barb (body + taper) in seated
 *  position. The arm itself is NOT subtracted — it stays in the cavity
 *  during insertion via elastic flex. Subtracting the body+taper carves
 *  the snap hole; the wall material above z=barbTopZ becomes the catch
 *  ledge that engages the barb's flat top on retention. The cavity-side
 *  portion of the body (between arm outer face and inner wall surface,
 *  if any) is already empty so the subtraction is a no-op there. */
function buildHookTabWallSubtract(frame: HookTabFrame): BuildOp {
  // Reuse buildHookTab so the subtraction shape matches the tab exactly
  // (including the arm + the embed slop). The tab is in lid-local Z, so
  // shift it UP into world Z by lidPlateBottomZ_world for the shell op.
  return translate([0, 0, frame.lidPlateBottomZ_world], buildHookTab(frame));
}

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

export function defaultSnapCatchesForCase(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): SnapCatch[] {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const out: SnapCatch[] = [];
  const mid = (n: number) => n / 2;
  const LONG_SIDE_THRESHOLD = 80;
  if (dims.outerY > LONG_SIDE_THRESHOLD) {
    out.push({ id: 'snap-mx-1', wall: '-x', uPosition: dims.outerY / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-mx-2', wall: '-x', uPosition: (2 * dims.outerY) / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-px-1', wall: '+x', uPosition: dims.outerY / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-px-2', wall: '+x', uPosition: (2 * dims.outerY) / 3, enabled: true, barbType: 'hook' });
  } else {
    out.push({ id: 'snap-mx', wall: '-x', uPosition: mid(dims.outerY), enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-px', wall: '+x', uPosition: mid(dims.outerY), enabled: true, barbType: 'hook' });
  }
  if (dims.outerX > LONG_SIDE_THRESHOLD) {
    out.push({ id: 'snap-my-1', wall: '-y', uPosition: dims.outerX / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-my-2', wall: '-y', uPosition: (2 * dims.outerX) / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-py-1', wall: '+y', uPosition: dims.outerX / 3, enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-py-2', wall: '+y', uPosition: (2 * dims.outerX) / 3, enabled: true, barbType: 'hook' });
  } else {
    out.push({ id: 'snap-my', wall: '-y', uPosition: mid(dims.outerX), enabled: true, barbType: 'hook' });
    out.push({ id: 'snap-py', wall: '+y', uPosition: mid(dims.outerX), enabled: true, barbType: 'hook' });
  }
  return out;
}

interface CatchGeometry {
  /**
   * Additive lip on the case wall. Null for detent designs (ball-socket)
   * that use a wall pocket instead.
   */
  lip: BuildOp | null;
  /** Cantilever arm + barb mesh on the lid (always present). */
  armBarb: BuildOp;
  /**
   * Optional subtractive pocket cut into the case wall. Null for lip-based
   * designs.
   */
  wallPocket: BuildOp | null;
}

/** Per-wall frame: where the inside wall surface is, which way is "inward",
 *  and how to orient features along the wall. Computed once per catch. */
interface WallFrame {
  /** World-coord origin of the wedge (wall surface, u-min, lipBottom). */
  lipOrigin: { x: number; y: number; z: number };
  /** Wall normal axis ('x' if wall is ±x, 'y' if wall is ±y). */
  wallAxis: 'x' | 'y';
  /** +1 if outward normal is +axis, -1 if −axis. */
  wallNormalSign: 1 | -1;
  /** World-coord position of the cantilever arm's bbox-min corner. */
  armOrigin: { x: number; y: number; z: number };
  /** Arm bbox size (n is wall-normal, t is along-wall, z is height). */
  armSize: { n: number; t: number; z: number };
  /** Barb world-coord bbox-min and size — same convention as arm. */
  barbOrigin: { x: number; y: number; z: number };
  barbSize: { n: number; t: number; z: number };
}

function computeWallFrame(
  c: SnapCatch,
  params: CaseParameters,
  outerX: number,
  outerY: number,
  lipBottomZ: number,
): WallFrame {
  const { wallThickness: wall } = params;
  const { armLength, armThickness, armWidth, barbProtrusion, barbLength, pocketWidth } = SNAP_DEFAULTS;
  const ARM_INSET = 0.3;
  const armZ = -armLength;
  const wallId: SnapWall = c.wall;
  switch (wallId) {
    case '-x': {
      const armX = wall + barbProtrusion + ARM_INSET;
      return {
        lipOrigin: { x: wall, y: c.uPosition - pocketWidth / 2, z: lipBottomZ },
        wallAxis: 'x',
        wallNormalSign: -1,
        armOrigin: { x: armX, y: c.uPosition - armWidth / 2, z: armZ },
        armSize: { n: armThickness, t: armWidth, z: armLength },
        barbOrigin: { x: armX - barbProtrusion, y: c.uPosition - armWidth / 2, z: armZ },
        barbSize: { n: barbProtrusion, t: armWidth, z: barbLength },
      };
    }
    case '+x': {
      const innerX = outerX - wall;
      const armX = innerX - barbProtrusion - ARM_INSET - armThickness;
      return {
        lipOrigin: { x: innerX, y: c.uPosition - pocketWidth / 2, z: lipBottomZ },
        wallAxis: 'x',
        wallNormalSign: +1,
        armOrigin: { x: armX, y: c.uPosition - armWidth / 2, z: armZ },
        armSize: { n: armThickness, t: armWidth, z: armLength },
        barbOrigin: { x: armX + armThickness, y: c.uPosition - armWidth / 2, z: armZ },
        barbSize: { n: barbProtrusion, t: armWidth, z: barbLength },
      };
    }
    case '-y': {
      const armY = wall + barbProtrusion + ARM_INSET;
      return {
        lipOrigin: { x: c.uPosition - pocketWidth / 2, y: wall, z: lipBottomZ },
        wallAxis: 'y',
        wallNormalSign: -1,
        armOrigin: { x: c.uPosition - armWidth / 2, y: armY, z: armZ },
        armSize: { n: armThickness, t: armWidth, z: armLength },
        barbOrigin: { x: c.uPosition - armWidth / 2, y: armY - barbProtrusion, z: armZ },
        barbSize: { n: barbProtrusion, t: armWidth, z: barbLength },
      };
    }
    case '+y': {
      const innerY = outerY - wall;
      const armY = innerY - barbProtrusion - ARM_INSET - armThickness;
      return {
        lipOrigin: { x: c.uPosition - pocketWidth / 2, y: innerY, z: lipBottomZ },
        wallAxis: 'y',
        wallNormalSign: +1,
        armOrigin: { x: c.uPosition - armWidth / 2, y: armY, z: armZ },
        armSize: { n: armThickness, t: armWidth, z: armLength },
        barbOrigin: { x: c.uPosition - armWidth / 2, y: armY + armThickness, z: armZ },
        barbSize: { n: barbProtrusion, t: armWidth, z: barbLength },
      };
    }
  }
}

/** Build the cantilever arm and translate-place a pre-built barb mesh. */
function buildArm(frame: WallFrame): BuildOp {
  const sz: [number, number, number] =
    frame.wallAxis === 'x'
      ? [frame.armSize.n, frame.armSize.t, frame.armSize.z]
      : [frame.armSize.t, frame.armSize.n, frame.armSize.z];
  return translate([frame.armOrigin.x, frame.armOrigin.y, frame.armOrigin.z], cube(sz));
}

// ---------- Per-barb-type builders (issue #69) ----------
//
// Each builder returns the lip (additive on case wall) and the barb (additive
// under the lid arm). The arm itself is built once outside and unioned in.

function buildHookBarb(frame: WallFrame): BuildOp {
  // Rectangular block at the arm tip. The lip's flat catch face engages the
  // barb's flat top face — high retention, sloped insertion via the lip wedge.
  const sz: [number, number, number] =
    frame.wallAxis === 'x'
      ? [frame.barbSize.n, frame.barbSize.t, frame.barbSize.z]
      : [frame.barbSize.t, frame.barbSize.n, frame.barbSize.z];
  return translate([frame.barbOrigin.x, frame.barbOrigin.y, frame.barbOrigin.z], cube(sz));
}

/**
 * Issue #81 — when the lip's wall-side face is exactly coplanar with the
 * inner wall surface, manifold's union sometimes treats the two solids as
 * non-overlapping (touching only). The result is a "loose" lip that the
 * slicer drops to the build plate. Embedding the lip into the wall by
 * EMBED_INTO_WALL guarantees a volumetric overlap so the union always
 * produces a single connected component.
 */
// Issue #123 — 0.4 mm overlap was insufficient when the trapezoidal-prism
// mesh's slanted outboard face combined with the case-shell's rounded
// inner corners left thin slivers of wall material. Bumped to 1.0 mm —
// still well under the minimum 2 mm wall thickness so the lip never
// breaks through to the outside.
const EMBED_INTO_WALL = 1.0;

/** Shift the wedge origin INTO the wall and add the same amount to the
 *  protrusion so the inward tip stays at the same world location. */
function embedInWall(frame: WallFrame): {
  origin: { x: number; y: number; z: number };
  extraProtrusion: number;
} {
  const { x, y, z } = frame.lipOrigin;
  // Inward direction (cavity-bound) is `-wallNormalSign * axis`. To go
  // INTO the wall we move in the opposite direction: `+wallNormalSign * axis`.
  if (frame.wallAxis === 'x') {
    return {
      origin: { x: x + frame.wallNormalSign * EMBED_INTO_WALL, y, z },
      extraProtrusion: EMBED_INTO_WALL,
    };
  }
  return {
    origin: { x, y: y + frame.wallNormalSign * EMBED_INTO_WALL, z },
    extraProtrusion: EMBED_INTO_WALL,
  };
}

function buildHookLip(frame: WallFrame, height: number): BuildOp {
  const { barbProtrusion, pocketWidth } = SNAP_DEFAULTS;
  const { origin, extraProtrusion } = embedInWall(frame);
  return buildLipWedge(
    origin,
    frame.wallAxis,
    frame.wallNormalSign,
    barbProtrusion + extraProtrusion,
    pocketWidth,
    height,
  );
}

function buildAsymmetricRampBarb(frame: WallFrame): BuildOp {
  // Cube barb with a chamfered entry face. We approximate the chamfer as a
  // shorter, narrower cube that still presents a flat retention face.
  // Visually distinct from hook because the barb is shorter (lower retention
  // edge) and the entry face isn't hidden under a wedge — the asymmetry comes
  // from the *barb*, not just the lip.
  const sz: [number, number, number] =
    frame.wallAxis === 'x'
      ? [frame.barbSize.n, frame.barbSize.t, frame.barbSize.z * 0.7]
      : [frame.barbSize.t, frame.barbSize.n, frame.barbSize.z * 0.7];
  return translate([frame.barbOrigin.x, frame.barbOrigin.y, frame.barbOrigin.z], cube(sz));
}

/** Triangular prism barb: full protrusion at center, tapered top + bottom. */
function buildSymmetricRampBarb(frame: WallFrame): BuildOp {
  // Build a tri-prism mesh in local (n, t, z) space, then translate to barb origin.
  // The prism extrudes along t for armWidth; cross-section in (n, z):
  //   (0, 0) - (n_max, h/2) - (0, h)
  const nMax = frame.barbSize.n;
  const tLen = frame.barbSize.t;
  const h = frame.barbSize.z;
  // Local origin will sit at barbOrigin (the bbox-min corner of the rectangular
  // hook barb). For ±x walls the n-axis aligns with x; for ±y walls, with y.
  const origin = frame.barbOrigin;
  const wallNormalSign = frame.wallNormalSign;
  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, zOff: number) {
    if (frame.wallAxis === 'x') {
      // n is along x (with sign), t is along y, z is up.
      // For the lid-side barb origin already accounts for which side of the
      // arm; here we offset INWARD by nOff. wallNormalSign +1 means +x wall →
      // inward is -x; -1 means -x wall → inward is +x. So x_offset = -wallNormalSign * nOff.
      positions.push(origin.x - wallNormalSign * nOff, origin.y + uOff, origin.z + zOff);
    } else {
      positions.push(origin.x + uOff, origin.y - wallNormalSign * nOff, origin.z + zOff);
    }
  }
  // Vertices (cross-section: tri); extruded along u for tLen.
  pushVert(0, 0, 0);            // 0: u=0, base-wall
  pushVert(tLen, 0, 0);         // 1: u=W, base-wall
  pushVert(0, nMax, h / 2);     // 2: u=0, tip
  pushVert(tLen, nMax, h / 2);  // 3: u=W, tip
  pushVert(0, 0, h);            // 4: u=0, top-wall
  pushVert(tLen, 0, h);         // 5: u=W, top-wall
  const indices: number[] = [
    0, 1, 5,  0, 5, 4,           // wall face
    0, 2, 3,  0, 3, 1,           // bottom slope
    2, 4, 5,  2, 5, 3,           // top slope
    0, 4, 2,                     // front cap
    1, 3, 5,                     // back cap
  ];
  return mesh(new Float32Array(positions), new Uint32Array(indices));
}

function buildHalfRoundBarb(frame: WallFrame): BuildOp {
  // Half-cylinder along the arm's t-axis. Use a full cylinder oriented along t,
  // then position so its axis sits at the wall surface — only the inward half
  // protrudes. cylinder() builds along +Z, so we rotate to align with t.
  const radius = Math.max(frame.barbSize.n, frame.barbSize.z / 2);
  const length = frame.barbSize.t;
  // Cylinder spans Z from 0 to length. Orient along the wall tangent:
  //   +x walls → tangent is y → rotate so cylinder's axis is along +y.
  //   ±y walls → tangent is x → rotate so cylinder's axis is along +x.
  const cyl = cylinder(length, radius, 24);
  const oriented =
    frame.wallAxis === 'x' ? rotate([90, 0, 0], cyl) : rotate([0, 90, 0], cyl);
  // Center the cylinder at (n=0, z=h/2) where n is wall-normal-inward.
  const cz = frame.barbOrigin.z + frame.barbSize.z / 2;
  if (frame.wallAxis === 'x') {
    // After rotate([90,0,0]) cylinder runs along +y starting at y=cylinderOrigin
    // and z stays. We want the cylinder's circular center on the wall surface,
    // which means x at the wall (barbOrigin.x + n_inward_offset_to_hit_wall).
    // Place cylinder center at (cx, ty_min, cz) where cx = barbOrigin.x +
    // wallNormalSign*0 (i.e. the wall surface that the barb origin already
    // sits at, since barbOrigin's n-side is set up for the cube barb).
    // For a half-cylinder we want the round side facing inward.
    const cx = frame.barbOrigin.x; // wall side of barb
    const ty = frame.barbOrigin.y;
    return translate([cx, ty, cz], oriented);
  } else {
    const tx = frame.barbOrigin.x;
    const cy = frame.barbOrigin.y;
    return translate([tx, cy, cz], oriented);
  }
}

function buildBallSocketBarb(frame: WallFrame): BuildOp {
  // Approximate a "ball" with a short, wide cylinder + tapered cap, along the
  // wall normal. Concretely: a cylinder oriented inward, length=barbProtrusion,
  // radius slightly larger than barbLength/3 so the bump reads as a detent.
  // Lower retention than half-round; hand-removable.
  const radius = Math.min(frame.barbSize.t, frame.barbSize.z) / 3;
  const length = frame.barbSize.n; // along wall-normal
  const cyl = cylinder(length, radius, 24);
  // cylinder() runs along +Z; rotate so it runs along the wall normal.
  // Wall normal (inward) is opposite wallNormalSign on the wallAxis.
  let oriented: BuildOp;
  if (frame.wallAxis === 'x') {
    // +x wall: inward is -x → rotate cylinder so +Z → -X. rotate([0, -90, 0]) maps +Z to +X;
    // rotate([0, 90, 0]) maps +Z to -X. wallNormalSign=+1 → inward -x → +90.
    oriented = rotate([0, frame.wallNormalSign * 90, 0], cyl);
  } else {
    oriented = rotate([frame.wallNormalSign * -90, 0, 0], cyl);
  }
  const cx =
    frame.wallAxis === 'x'
      ? frame.barbOrigin.x
      : frame.barbOrigin.x + frame.barbSize.t / 2;
  const cy =
    frame.wallAxis === 'y'
      ? frame.barbOrigin.y
      : frame.barbOrigin.y + frame.barbSize.t / 2;
  const cz = frame.barbOrigin.z + frame.barbSize.z / 2;
  return translate([cx, cy, cz], oriented);
}

interface BarbBuilders {
  buildBarb(frame: WallFrame): BuildOp;
  /**
   * Lip on the case wall (additive). Returns null when the barb design
   * doesn't use a lip — e.g. ball-socket relies on a wall pocket instead.
   */
  buildLip(frame: WallFrame, lipHeight: number): BuildOp | null;
  /**
   * Optional pocket cut INTO the case wall (subtractive). Used by detent
   * designs (ball-socket) where the barb snaps into a recess rather than
   * past a lip. Returns null for lip-based designs.
   */
  buildWallPocket?(frame: WallFrame): BuildOp | null;
}

/**
 * Issue #77 — barb-type ↔ shell-geometry mapping.
 *
 *   hook + asymmetric-ramp: both flat-top barbs that engage the same flat
 *     catch face — sharing buildHookLip is correct, not a bug. The shell
 *     mesh is intentionally identical between these two; the difference
 *     is in the BARB shape on the lid.
 *   symmetric-ramp: triangular prism barb + matching prism lip.
 *   half-round: half-cylinder barb still engages a flat catch face cleanly,
 *     so it shares the hook lip.
 *   ball-socket: detent design — NO lip; the wall has a circular pocket
 *     drilled at the seated-ball Z so the ball clicks IN. This is the fix
 *     for #77's "shell unchanged when ball-socket selected" symptom: the
 *     old code shipped a hook-style lip that the ball just slid past with
 *     nothing to retain it.
 */
const BARB_REGISTRY: Record<BarbType, BarbBuilders> = {
  hook: { buildBarb: buildHookBarb, buildLip: buildHookLip },
  'asymmetric-ramp': { buildBarb: buildAsymmetricRampBarb, buildLip: buildHookLip },
  'symmetric-ramp': {
    buildBarb: buildSymmetricRampBarb,
    buildLip: (frame, lipHeight) => {
      const { barbProtrusion, pocketWidth } = SNAP_DEFAULTS;
      // Issue #81 — embed wall-side into the wall so manifold's union doesn't
      // leave the lip as a loose component (same fix as buildHookLip).
      const { origin, extraProtrusion } = embedInWall(frame);
      return buildLipSymmetricPrism(
        origin,
        frame.wallAxis,
        frame.wallNormalSign,
        barbProtrusion + extraProtrusion,
        pocketWidth,
        lipHeight,
      );
    },
  },
  'half-round': { buildBarb: buildHalfRoundBarb, buildLip: buildHookLip },
  'ball-socket': {
    buildBarb: buildBallSocketBarb,
    buildLip: () => null,
    buildWallPocket: buildBallSocketWallPocket,
  },
};

/**
 * Cylindrical pocket cut into the inside wall at the seated ball position.
 * The cylinder axis runs along the wall outward normal so it bores INTO the
 * wall; depth is chosen so the ball seats flush with the inside surface.
 */
function buildBallSocketWallPocket(frame: WallFrame): BuildOp {
  const { barbLength, armWidth, barbProtrusion } = SNAP_DEFAULTS;
  // Pocket radius matches the ball detent radius computed in
  // buildBallSocketBarb (frame.barbSize.t and .z chosen from armWidth /
  // barbLength). Add a tiny margin so the ball clicks in without grinding.
  const ballRadius = Math.min(armWidth, barbLength) / 3;
  const radius = ballRadius + 0.1;
  const depth = ballRadius + 0.4; // slightly deeper than the ball's protrusion
  // Seated ball center: lipBottomZ - barbLength/2 (derived from the existing
  // seated-arm geometry — the barb's vertical center sits half a barbLength
  // below the lip's bottom face).
  const ballCenterZ = frame.lipOrigin.z - barbLength / 2;
  const cyl = cylinder(depth, radius, 24);
  // cylinder() runs along +Z; rotate so the body extends along the wall
  // outward normal — i.e. INTO the wall material from the inside surface.
  // Rotation around Y by +θ° maps +Z → +X (right-hand rule). For the +x
  // wall (wallNormalSign=+1) we want +Z → +X, so rotate by +90°. For the
  // -x wall we want +Z → -X, so rotate by -90°. Net: wallNormalSign * 90.
  // (Using the OPPOSITE sign would point the cylinder INTO the cavity, and
  // the subtractive op would cut empty air. Caught by advisor review.)
  let oriented: BuildOp;
  let pocketOriginX: number;
  let pocketOriginY: number;
  const tInset = (SNAP_DEFAULTS.pocketWidth - armWidth) / 2;
  if (frame.wallAxis === 'x') {
    oriented = rotate([0, frame.wallNormalSign * 90, 0], cyl);
    pocketOriginX = frame.lipOrigin.x;
    // The lip's u-extent is `pocketWidth` (~7 mm) starting at lipOrigin.y; the
    // catch is centered along that extent, which is also where the barb sits.
    pocketOriginY = frame.lipOrigin.y + tInset + armWidth / 2;
  } else {
    // For ±y walls: rotation around X by ±90° maps +Z → ∓Y. We want the
    // cylinder body to point INTO the wall along the OUTWARD normal:
    //   +y wall (wallNormalSign=+1): outward is +y → +Z → +Y → rotate X by -90.
    //   -y wall (wallNormalSign=-1): outward is -y → +Z → -Y → rotate X by +90.
    // Net: -wallNormalSign * 90.
    oriented = rotate([-frame.wallNormalSign * 90, 0, 0], cyl);
    pocketOriginX = frame.lipOrigin.x + tInset + armWidth / 2;
    pocketOriginY = frame.lipOrigin.y;
  }
  // Suppress an unused-var warning when this code path doesn't reference
  // barbProtrusion directly — keeping it imported documents the design link.
  void barbProtrusion;
  return translate([pocketOriginX, pocketOriginY, ballCenterZ], oriented);
}

export function buildSnapCatch(
  c: SnapCatch,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): CatchGeometry | null {
  if (!c.enabled) return null;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const barbType: BarbType = c.barbType ?? 'hook';
  // 'hook' uses the new subtract-tab design (per-user followup): arm hugs
  // inner wall surface, barb extends OUTWARD into wall material with a
  // tapered insertion bottom + flat 90° top, and the seated barb volume
  // is SUBTRACTED from the shell to create the snap hole. No additive lip.
  if (barbType === 'hook') {
    const tabFrame = computeHookTabFrame(c, params, dims);
    return {
      lip: null,
      armBarb: buildHookTab(tabFrame),
      wallPocket: buildHookTabWallSubtract(tabFrame),
    };
  }
  // Other barb types — additive lip on the case wall, separate barb on
  // lid that hooks under it. Geometry per Issue #80:
  //   barb_top_seated = lid_plate_bottom - armLength + barbLength
  //   LIP_HEIGHT      = armLength - barbLength
  const { armLength, barbLength } = SNAP_DEFAULTS;
  const LIP_HEIGHT = armLength - barbLength;
  const lipTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  const lipBottomZ = lipTopZ - LIP_HEIGHT;
  const frame = computeWallFrame(c, params, dims.outerX, dims.outerY, lipBottomZ);
  const builders = BARB_REGISTRY[barbType];
  const lip = builders.buildLip(frame, LIP_HEIGHT);
  const arm = buildArm(frame);
  const barb = builders.buildBarb(frame);
  const wallPocket = builders.buildWallPocket?.(frame) ?? null;
  return { lip, armBarb: union([arm, barb]), wallPocket };
}

export function buildSnapCatchOps(
  catches: SnapCatch[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): { shellAdd: BuildOp[]; shellSubtract: BuildOp[]; lidAdd: BuildOp[] } {
  if (!catches || params.joint !== 'snap-fit') {
    return { shellAdd: [], shellSubtract: [], lidAdd: [] };
  }
  const shellAdd: BuildOp[] = [];
  const shellSubtract: BuildOp[] = [];
  const lidAdd: BuildOp[] = [];
  for (const c of catches) {
    const g = buildSnapCatch(c, board, params, hats, resolveHat, display, resolveDisplay);
    if (!g) continue;
    if (g.lip) shellAdd.push(g.lip);
    if (g.wallPocket) shellSubtract.push(g.wallPocket);
    lidAdd.push(g.armBarb);
  }
  return { shellAdd, shellSubtract, lidAdd };
}
