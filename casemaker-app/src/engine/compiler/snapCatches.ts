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
 * where k ≈ 0.2 gives a steep but printable insertion ramp. Trapezoid
 * (NOT triangle) avoids the thin-apex issue at z=H that fragmented the
 * earlier triangular-prism wedge in #90 — there's always at least
 * protrusion·k of material along every z slice.
 *
 * Mesh winding verified for outward normals: base −z, top +z, wall −n,
 * slanted outboard +n+z, front cap −u (front = u=0), back cap +u.
 * Every face's right-hand-rule cross product points away from the
 * trapezoid interior so manifold treats the prism as a valid solid.
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
  // pushVert maps face-local (uOff, nOff, zOff) → world coords. wallAxis
  // chooses which world axis hosts u and n; wallNormalSign flips the n
  // direction so n>0 is always cavity-bound.
  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, zOff: number): void {
    if (wallAxis === 'x') {
      const dx = wallNormalSign * nOff;
      positions.push(origin.x + dx, origin.y + uOff, origin.z + zOff);
    } else {
      const dy = wallNormalSign * nOff;
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
  const indices = new Uint32Array([
    // Issue #121 — base + top triangle windings were INVERTED. Verified by
    // hand: tri (0,1,3) cross product = (0, 0, +W·P) which points +z, but
    // the base's outward direction is -z; manifold rejected the whole
    // mesh as non-orientable ("Not manifold" error on snap-fit-test).
    // Reversed: base 0,3,1 / 0,2,3; top 4,7,6 / 4,5,7. The other 8
    // triangles already wound correctly.
    // base z=0, outside -z
    0, 3, 1,  0, 2, 3,
    // top z=H, outside +z
    4, 7, 6,  4, 5, 7,
    // wall n=0, outside -n
    0, 1, 5,  0, 5, 4,
    // slanted outboard, outside +n+z
    3, 2, 6,  3, 6, 7,
    // front cap u=0, outside -u
    0, 6, 2,  0, 4, 6,
    // back cap u=width, outside +u
    1, 7, 5,  1, 3, 7,
  ]);
  // Note: wallNormalSign=+1 (outward +x or +y) means n>0 is cavity-bound,
  // so the trapezoid still sits "inside" the cavity for both wall signs.
  // For -1 the same holds because we multiply nOff by wallNormalSign.
  return mesh(new Float32Array(positions), indices);
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
// Bumped 0.2 → 0.4 mm so manifold's union has more volumetric overlap to
// fuse the trapezoidal-prism lip with the wall. Still well under the
// minimum 1.0 mm wall thickness so the lip never breaks through.
const EMBED_INTO_WALL = 0.4;

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
  const { armLength, barbLength } = SNAP_DEFAULTS;
  // Issue #80 — LIP_HEIGHT is determined by arm geometry, not by
  // barbProtrusion. The lip's bottom (catch face) must align with the
  // barb's top in the seated position:
  //
  //   barb_top_seated = lid_plate_bottom - armLength + barbLength
  //   lipBottom must equal barb_top_seated
  //   → lipTop - LIP_HEIGHT = lid_plate_bottom - armLength + barbLength
  //   → LIP_HEIGHT = (lipTop - lid_plate_bottom) + (armLength - barbLength)
  //
  // For a non-recessed lid, lid_plate_bottom and lipTop both = outerZ.
  // For a recessed lid, the lid drops into a pocket so
  //   lid_plate_bottom = outerZ - lidThickness
  // and the lip should sit just below the pocket (which is at
  // outerZ - lidThickness). In both cases the (lipTop - lid_plate_bottom)
  // term cancels, so LIP_HEIGHT = armLength - barbLength.
  const LIP_HEIGHT = armLength - barbLength;
  // Issue #80 — when the lid is recessed it sits IN a pocket at
  // (outerZ - lidThickness). The lip on the wall has to drop with it
  // or the barb engages thin air.
  const lipTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  const lipBottomZ = lipTopZ - LIP_HEIGHT;
  const frame = computeWallFrame(c, params, dims.outerX, dims.outerY, lipBottomZ);
  const barbType: BarbType = c.barbType ?? 'hook';
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
