import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
  SnapCatch,
  SnapWall,
} from '@/types';
import { SNAP_DEFAULTS } from '@/types/snap';
import { cube, difference, mesh, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

/**
 * Issue #75 — build a triangular-prism wedge for the inside-wall snap lip.
 *
 * The wedge has a flat horizontal base (the catch face — the bottom of the
 * lip, where the lid's barb engages from below) and a sloping top (the
 * insertion ramp — runs from the wall surface at lipTop down to the lip
 * tip at lipBottom). The slope deflects the descending lid barb inward as
 * it passes the lip, so the lid can be pushed down without the barb
 * jamming into a square edge.
 *
 * `wallNormal` is the OUTWARD direction of the wall (e.g. (-1,0,0) for the
 * -x wall). The prism's "wall" face sits at the case's inner wall surface
 * and the "tip" extends inward by `protrusion`.
 */
function buildLipWedge(
  origin: { x: number; y: number; z: number },
  wallAxis: 'x' | 'y',
  wallNormalSign: 1 | -1,
  protrusion: number,
  width: number,
  height: number,
): BuildOp {
  // Local frame: u = along the wall (pocket width direction), n = inward
  // (away from wall, toward cavity), z = up. We build 6 vertices in world
  // coords directly using `origin` as the (wall-surface, u-min, lipBottom)
  // corner.
  //
  //  Cross-section in (n, z) plane (wall on left at n=0):
  //
  //    (0, height) - top-wall corner
  //         |\
  //         | \
  //         |  \  slope (insertion ramp)
  //         |   \
  //         |____\ (protrusion, 0) - lip tip on bottom
  //  (0, 0)         catch face is the horizontal bottom edge
  //
  // Extruded along u for `width`.
  const n = wallAxis === 'x' ? 'x' : 'y';
  const t = wallAxis === 'x' ? 'y' : 'x'; // tangent (along wall)
  // Vertices: name them by (u-end, n-position, z-position)
  //   A0 = (u=0, n=0, z=0)  wall-bottom-front
  //   A1 = (u=W, n=0, z=0)  wall-bottom-back
  //   B0 = (u=0, n=protr, z=0) tip-bottom-front
  //   B1 = (u=W, n=protr, z=0) tip-bottom-back
  //   C0 = (u=0, n=0, z=h) wall-top-front
  //   C1 = (u=W, n=0, z=h) wall-top-back
  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, zOff: number) {
    const dx = (n === 'x' ? wallNormalSign * -nOff : 0) + (t === 'x' ? uOff : 0);
    const dy = (n === 'y' ? wallNormalSign * -nOff : 0) + (t === 'y' ? uOff : 0);
    // wallNormalSign positive (+x wall) means the wall normal points +x =
    // outward → "inward" is -x → nOff subtracted from origin.x gives a
    // smaller x. For -x wall (sign = -1), inward is +x → -1 * -nOff = +nOff.
    // The expression above handles both cases: dx for n='x' is
    // wallNormalSign * -nOff (which is +nOff for sign=-1 and -nOff for
    // sign=+1).
    positions.push(origin.x + dx, origin.y + dy, origin.z + zOff);
  }
  pushVert(0, 0, 0);            // 0: A0
  pushVert(width, 0, 0);        // 1: A1
  pushVert(0, protrusion, 0);   // 2: B0
  pushVert(width, protrusion, 0); // 3: B1
  pushVert(0, 0, height);       // 4: C0
  pushVert(width, 0, height);   // 5: C1

  // 8 triangles — winding chosen so outward normals point AWAY from the
  // prism interior. Manifold tolerates either winding for solid input but
  // we follow standard CCW-from-outside.
  // Bottom (z = 0, normal = -z): A0, B0, B1, A0, B1, A1
  // Wall  (n = 0, normal = wallNormalSign on the wall axis):
  //        A0, A1, C1, A0, C1, C0
  // Slope (the hypotenuse, normal points up-and-inward):
  //        B0, B1, C1, B0, C1, C0  (need to verify winding)
  // Front cap (u = 0, normal = -t): A0, C0, B0
  // Back cap  (u = W, normal = +t): A1, B1, C1
  const indices: number[] = [
    0, 2, 3,  0, 3, 1,   // bottom
    0, 1, 5,  0, 5, 4,   // wall face
    2, 5, 3,  2, 4, 5,   // slope
    0, 4, 2,             // front cap
    1, 3, 5,             // back cap
  ];

  return mesh(new Float32Array(positions), new Uint32Array(indices));
}

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

/**
 * Default snap-catch placement based on case longest dimension (issue #29):
 *   < 80 mm  → 2 catches (midpoint of each short end)
 *   80–150 → 4 catches (midpoint of each wall)
 *   > 150  → 6 catches (short ends + thirds along the long walls)
 */
export function defaultSnapCatchesForCase(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): SnapCatch[] {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const out: SnapCatch[] = [];
  const mid = (n: number) => n / 2;
  // Issue #73 — every wall always gets at least one catch (no more "two
  // catches on opposite ends, the long sides flap free"). Long sides longer
  // than ~80 mm get two catches at thirds. Discrete points only — no
  // continuous lid-lip ring (also issue #73).
  const LONG_SIDE_THRESHOLD = 80;

  // -x and +x walls: catches positioned along Y
  if (dims.outerY > LONG_SIDE_THRESHOLD) {
    out.push({ id: 'snap-mx-1', wall: '-x', uPosition: dims.outerY / 3, enabled: true });
    out.push({ id: 'snap-mx-2', wall: '-x', uPosition: (2 * dims.outerY) / 3, enabled: true });
    out.push({ id: 'snap-px-1', wall: '+x', uPosition: dims.outerY / 3, enabled: true });
    out.push({ id: 'snap-px-2', wall: '+x', uPosition: (2 * dims.outerY) / 3, enabled: true });
  } else {
    out.push({ id: 'snap-mx', wall: '-x', uPosition: mid(dims.outerY), enabled: true });
    out.push({ id: 'snap-px', wall: '+x', uPosition: mid(dims.outerY), enabled: true });
  }
  // -y and +y walls: catches positioned along X
  if (dims.outerX > LONG_SIDE_THRESHOLD) {
    out.push({ id: 'snap-my-1', wall: '-y', uPosition: dims.outerX / 3, enabled: true });
    out.push({ id: 'snap-my-2', wall: '-y', uPosition: (2 * dims.outerX) / 3, enabled: true });
    out.push({ id: 'snap-py-1', wall: '+y', uPosition: dims.outerX / 3, enabled: true });
    out.push({ id: 'snap-py-2', wall: '+y', uPosition: (2 * dims.outerX) / 3, enabled: true });
  } else {
    out.push({ id: 'snap-my', wall: '-y', uPosition: mid(dims.outerX), enabled: true });
    out.push({ id: 'snap-py', wall: '+y', uPosition: mid(dims.outerX), enabled: true });
  }
  return out;
}

interface CatchGeometry {
  /** Issue #70 — small lip extruded INWARD from the inside of the case wall
   *  (additive, world coords). The lid's barb catches under this lip. */
  lip: BuildOp;
  /** Cantilever arm + barb attached under the lid (additive, lid-local Z). */
  armBarb: BuildOp;
}

/**
 * Build geometry for one snap catch.
 *
 * The case carries an INSIDE lip — a small additive bump on the inner wall
 * surface near the rim. The lid carries the cantilever arm with a barb at
 * its tip. During assembly the barb deflects outward to clear the lip, then
 * springs back inward and is captured under the lip's flat bottom face.
 *
 * Compared to the original through-wall pocket implementation: no holes are
 * cut through the case wall (better aesthetic + waterproofing), and the
 * snap features all live on the parts that mate, not in free air.
 */
export function buildSnapCatch(
  c: SnapCatch,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): CatchGeometry | null {
  if (!c.enabled) return null;
  const dims = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall } = params;
  const {
    armLength,
    armThickness,
    armWidth,
    barbProtrusion,
    barbLength,
    pocketWidth,
  } = SNAP_DEFAULTS;

  // Lip placement (world Z): just below the wall top. lipBottomZ aligns with
  // the barb's top in the engaged position so the barb catches cleanly.
  // Barb top in lid-local coords = -armLength + barbLength = -8.
  // Lid is positioned at outerZ + liftAboveShell (=2), so barb top world Z =
  // outerZ + 2 - 8 = outerZ - 6. Put lip bottom at outerZ - 6 to match.
  // Issue #76 — lip cross-section is print-sized: barbProtrusion-wide × same
  // height (45° slope on the hypotenuse, just on the edge of bridge-free
  // FDM printing). The barb engages 0.8 mm of catch face — enough to
  // retain a hand-removable PLA case, not enough to need supports.
  const LIP_HEIGHT = barbProtrusion;
  const ARM_INSET = 0.3; // clearance between arm body and lip's inward tip
  // Issue #77 — lip is FLUSH WITH THE RIM (top edge of the case wall).
  // Earlier the lip sat 5–6 mm below the rim with a chunk of solid wall
  // above it; that wasted material and made the cavity feel cramped. Now
  // the lip's top sits at outerZ and the catch face hangs LIP_HEIGHT
  // below — the rim itself becomes the slope's top edge.
  const lipTopZ = dims.outerZ;
  const lipBottomZ = lipTopZ - LIP_HEIGHT;

  const wallId: SnapWall = c.wall;
  let lip: BuildOp;
  let armBarb: BuildOp;

  // Issue #75 — sloped triangular lip (replaces the rectangular block). The
  // wedge has a flat horizontal catch face on the bottom and a slope on top
  // running from wall (high) down to lip tip (low), so the lid barb is
  // deflected inward as it descends past the lip rather than jamming into
  // a square outer corner.
  switch (wallId) {
    case '-x': {
      lip = buildLipWedge(
        { x: wall, y: c.uPosition - pocketWidth / 2, z: lipBottomZ },
        'x',
        -1, // -x wall: outward normal is -x, so inward (into cavity) is +x
        barbProtrusion,
        pocketWidth,
        LIP_HEIGHT,
      );
      const armX = wall + barbProtrusion + ARM_INSET;
      const arm = translate(
        [armX, c.uPosition - armWidth / 2, -armLength],
        cube([armThickness, armWidth, armLength]),
      );
      const barb = translate(
        [armX - barbProtrusion, c.uPosition - armWidth / 2, -armLength],
        cube([barbProtrusion, armWidth, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '+x': {
      const innerX = dims.outerX - wall;
      lip = buildLipWedge(
        { x: innerX, y: c.uPosition - pocketWidth / 2, z: lipBottomZ },
        'x',
        +1, // +x wall: outward normal is +x, so inward is -x
        barbProtrusion,
        pocketWidth,
        LIP_HEIGHT,
      );
      const armX = innerX - barbProtrusion - ARM_INSET - armThickness;
      const arm = translate(
        [armX, c.uPosition - armWidth / 2, -armLength],
        cube([armThickness, armWidth, armLength]),
      );
      const barb = translate(
        [armX + armThickness, c.uPosition - armWidth / 2, -armLength],
        cube([barbProtrusion, armWidth, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '-y': {
      lip = buildLipWedge(
        { x: c.uPosition - pocketWidth / 2, y: wall, z: lipBottomZ },
        'y',
        -1,
        barbProtrusion,
        pocketWidth,
        LIP_HEIGHT,
      );
      const armY = wall + barbProtrusion + ARM_INSET;
      const arm = translate(
        [c.uPosition - armWidth / 2, armY, -armLength],
        cube([armWidth, armThickness, armLength]),
      );
      const barb = translate(
        [c.uPosition - armWidth / 2, armY - barbProtrusion, -armLength],
        cube([armWidth, barbProtrusion, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '+y': {
      const innerY = dims.outerY - wall;
      lip = buildLipWedge(
        { x: c.uPosition - pocketWidth / 2, y: innerY, z: lipBottomZ },
        'y',
        +1,
        barbProtrusion,
        pocketWidth,
        LIP_HEIGHT,
      );
      const armY = innerY - barbProtrusion - ARM_INSET - armThickness;
      const arm = translate(
        [c.uPosition - armWidth / 2, armY, -armLength],
        cube([armWidth, armThickness, armLength]),
      );
      const barb = translate(
        [c.uPosition - armWidth / 2, armY + armThickness, -armLength],
        cube([armWidth, barbProtrusion, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
  }

  void difference;
  void lipTopZ;
  return { lip, armBarb };
}

export function buildSnapCatchOps(
  catches: SnapCatch[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): { shellAdd: BuildOp[]; shellSubtract: BuildOp[]; lidAdd: BuildOp[] } {
  if (!catches || params.joint !== 'snap-fit') {
    return { shellAdd: [], shellSubtract: [], lidAdd: [] };
  }
  const shellAdd: BuildOp[] = [];
  const shellSubtract: BuildOp[] = [];
  const lidAdd: BuildOp[] = [];
  for (const c of catches) {
    const g = buildSnapCatch(c, board, params, hats, resolveHat);
    if (!g) continue;
    // Issue #70 — inside-wall lip is additive; no through-wall pocket.
    shellAdd.push(g.lip);
    lidAdd.push(g.armBarb);
  }
  return { shellAdd, shellSubtract, lidAdd };
}
