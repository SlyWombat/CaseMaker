import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
  HingeFeature,
  HingePositioning,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, difference, rotate, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import { faceFrame } from '../coords';
import { computeLidDims } from './lid';
import { clampHinge } from './featureScale';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/**
 * Issue #92 — barrel-hinge geometry compiler.
 *
 * Layout overview
 * ---------------
 *  - The hinge runs along one of the four side faces (±x or ±y).
 *  - `numKnuckles` cylindrical knuckles alternate between the case (even
 *    indices: 0, 2, 4, …) and the lid (odd indices: 1, 3, 5, …) along the
 *    face's u-axis. The end knuckles are case-attached so the lid pivots
 *    between matched pairs and the part stays printable.
 *  - All knuckles share a single axis. The axis lies in the face plane and
 *    is parallel to the face's u-direction, offset OUT of the case envelope
 *    by knuckleOuterDiameter/2 so the knuckle solids sit just past the wall.
 *  - Axis Z = outerZ - knuckleOuterDiameter/2. With this choice, the lid's
 *    bottom edge is the rotation pivot; opening the lid sweeps the upper
 *    cavity rim AWAY from the hinge — the standard barrel-hinge motion.
 *  - A single through-hole is subtracted along the axis spanning the full
 *    hingeLength + 1 mm overshoot (so the hole exits cleanly past both ends
 *    even after manifold rounding).
 *  - For the print-in-place style we also emit a centered pin solid filling
 *    the through-hole, with knuckleClearance/2 of slop on each side.
 *
 * Coordinate frames
 * -----------------
 *  - `caseAdditive` ops are in WORLD coordinates (case shell space).
 *  - `lidAdditive` ops are in LID-LOCAL coordinates: ProjectCompiler does
 *    `translate([0, 0, lidDims.zPosition], lidOp)` after calling buildLid,
 *    so anything we contribute to the lid must subtract that Z.
 *  - `subtractive` ops (through-holes) are in WORLD coordinates and applied
 *    to the SHELL only; manifold's union with the lid's separate knuckle
 *    drills the same hole because the bore axis is shared.
 *
 *    NOTE: in v1 the lid is rendered straight-down in Complete view (not
 *    rotated closed about the hinge axis). The through-hole is shared with
 *    the lid in CLOSED-state world coordinates, so we drill it on the lid
 *    in lid-local coordinates here too — same axis, same radius.
 */

export interface HingeOps {
  caseAdditive: BuildOp[];
  lidAdditive: BuildOp[];
  subtractive: BuildOp[];
  /**
   * Print-in-place pin solid. Emitted as a SEPARATE top-level node so the
   * shell's `difference([shellOp, ...cutoutOps])` doesn't drill it back out.
   *
   * Why a separate node and not union-after-cutout: the pin physically IS a
   * third part — the slicer treats it as a floating cylinder captured by the
   * surrounding knuckles once the case + lid + pin assembly is joined by the
   * print-in-place process. Modeling it as its own node mirrors that reality
   * and keeps the compile pipeline composable (no special "post-cutout
   * additive" lane needed).
   *
   * null when the hinge is disabled or style is 'external-pin'.
   */
  pinNode: BuildOp | null;
}

const EMPTY_OPS: HingeOps = {
  caseAdditive: [],
  lidAdditive: [],
  subtractive: [],
  pinNode: null,
};

/** Tolerance added to the through-hole radius beyond pinDiameter/2 (mm). */
const PIN_HOLE_TOLERANCE = 0.1;

/**
 * Map the face's u-axis to a rotation that aligns +Z (cylinder primitive
 * axis) with that direction. cylinder() runs along +Z; we orient it along
 * the in-plane u-direction of the chosen hinge face.
 *
 *  - ±y faces have uAxis = +x → rotate +Z to +X via rotate([0, 90, 0]).
 *  - ±x faces have uAxis = +y → rotate +Z to +Y via rotate([-90, 0, 0]).
 *
 * Same convention as `axisCylinder()` for ±x / ±y, but inverted: the hinge
 * axis is the face's TANGENT, not its normal.
 */
function orientAlongFaceU(op: BuildOp, face: HingeFeature['face']): BuildOp {
  if (face === '+y' || face === '-y') return rotate([0, 90, 0], op);
  return rotate([-90, 0, 0], op);
}

/**
 * Issue #110 — normalize HingeFeature based on style. Piano-continuous
 * derives many tightly-spaced knuckles from hingeLength so the user's
 * numKnuckles is overridden. Pip-pivot forces N=2 for the captive-pip
 * mechanism. Other styles pass through.
 *
 * Done as a pure function so the existing computeAxisLayout +
 * buildHingeOps loop body keeps working unchanged.
 */
function normalizeHingeForStyle(hinge: HingeFeature): HingeFeature {
  if (hinge.style === 'piano-continuous') {
    // Tight spacing (knuckle len ≈ knuckle diameter) → many knuckles.
    const targetPitch = hinge.knuckleOuterDiameter + Math.max(hinge.knuckleClearance, 0.4);
    const N = Math.max(5, Math.floor(hinge.hingeLength / targetPitch));
    // Round to odd so case + lid each get an evenly-distributed share.
    const oddN = N % 2 === 0 ? N + 1 : N;
    return { ...hinge, numKnuckles: oddN };
  }
  if (hinge.style === 'pip-pivot') {
    // Two captive pivot bosses near the ends; no centerline pin.
    return { ...hinge, numKnuckles: 3, pinMode: 'separate' };
  }
  return hinge;
}

/**
 * Compute face-plane (u, normal) coordinates for the knuckle axis. World
 * placement is then frame.origin + uAxis*uPos + vAxis*0 + outwardOffset.
 *
 * Returns also the face-length so the caller can clamp `hingeLength`.
 */
interface AxisLayout {
  /** u-position of the FIRST knuckle's u-min edge along the face. */
  uStart: number;
  /** Length of one knuckle along u. */
  knuckleLen: number;
  /** Spacing along u between consecutive knuckle u-min edges (knuckleLen + clearance). */
  pitch: number;
  /** Face length along u; for clamping diagnostics. */
  faceLen: number;
}

function computeAxisLayout(
  hinge: HingeFeature,
  faceLen: number,
): AxisLayout {
  const N = Math.max(3, Math.floor(hinge.numKnuckles));
  const clearance = Math.max(0, hinge.knuckleClearance);
  // Knuckle length: the (hingeLength - (N-1)*clearance) total divided across N
  // segments. clearance is the gap between consecutive knuckles.
  const totalSlots = Math.max(1, hinge.hingeLength - (N - 1) * clearance);
  const knuckleLen = totalSlots / N;
  const pitch = knuckleLen + clearance;
  // Positioning: 'centered' is the default; 'continuous' stretches the whole
  // hingeLength to span the face (we still respect hingeLength as authored
  // and just place the run with u-start at 0); 'pair-at-ends' falls back to
  // centered in v1 — see the issue body's vague spec; flagged as follow-up.
  let uStart: number;
  switch (hinge.positioning as HingePositioning) {
    case 'continuous':
      uStart = 0;
      break;
    case 'pair-at-ends':
      // Two clusters at the face ends. v1 approximation: still a single run,
      // just push it to one end. Full split-into-pairs layout deferred.
      uStart = 0;
      break;
    case 'centered':
    default:
      uStart = (faceLen - hinge.hingeLength) / 2;
      break;
  }
  return { uStart, knuckleLen, pitch, faceLen };
}

/** Build a single knuckle solid placed at the given (x, y, z) origin —
 *  the "start" face of the rotated cylinder along its axis. Caller decides
 *  whether the origin is in WORLD or LID-LOCAL coordinates; this helper is
 *  frame-agnostic. */
function buildKnuckle(
  hinge: HingeFeature,
  origin: [number, number, number],
  knuckleLen: number,
): BuildOp {
  const radius = hinge.knuckleOuterDiameter / 2;
  const cyl = cylinder(knuckleLen, radius, 32);
  return translate(origin, orientAlongFaceU(cyl, hinge.face));
}

/** Issue #121 — small "fairing tab" cube that bridges the lid knuckle's
 *  top arc with the lid plate's underside, giving manifold a volumetric
 *  overlap to fuse instead of single-line contact. Returns null when the
 *  geometry is degenerate.
 *
 *  The cube spans the knuckle's u-extent (knuckleLen), 2·knuckleR in the
 *  outward normal (n) direction, and EMBED in z. It sits with its bottom
 *  face 1 mm BELOW the lid plate underside (overlapping the cylinder
 *  cross-section's top arc) and its top 0.5 mm ABOVE (overlapping the
 *  lid plate). Net visual effect is a small fillet around each knuckle's
 *  attachment to the lid plate — the kind a real hinge has anyway.
 */
function buildKnuckleLidFairing(
  hinge: HingeFeature,
  origin: [number, number, number],
  knuckleLen: number,
): BuildOp | null {
  const knuckleR = hinge.knuckleOuterDiameter / 2;
  const FAIRING_BELOW = 1.0; // overlap into the cylinder
  const FAIRING_ABOVE = 0.5; // overlap into the lid plate
  const fairingHeight = FAIRING_BELOW + FAIRING_ABOVE;
  // Cube dims in the local frame: u along the knuckle axis (= knuckleLen),
  // n perpendicular (= 2·knuckleR), z vertical (= fairingHeight).
  // Translate the cube so its u start matches the knuckle's u start, its
  // n center matches the knuckle's n center (= 0 in the face plane → the
  // origin already places it correctly in n), and its bottom face sits
  // FAIRING_BELOW below z=lid-plate-underside (which is 0 in lid-local
  // coords: the cylinder top is at lid-local z=0; we want bottom at -1).
  // Knuckle u-axis depends on hinge.face — same orientAlongFaceU rule
  // applies. We build a face-local cube and orient it.
  const isPmY = hinge.face === '+y' || hinge.face === '-y';
  // For ±y faces: u = +x. cube dims [u, n, z] = [knuckleLen, 2*r, h].
  // For ±x faces: u = +y. cube dims [n, u, z] = [2*r, knuckleLen, h].
  const cubeOp = isPmY
    ? cube([knuckleLen, 2 * knuckleR, fairingHeight], false)
    : cube([2 * knuckleR, knuckleLen, fairingHeight], false);
  // Place: origin is the knuckle's u-start, the in-plane n=0, z=axis center.
  // Cube min corner offsets:
  //   u axis: 0 (cube starts at the knuckle u-start, same as cylinder)
  //   n axis: -knuckleR (cube spans n=[-r, +r] around the axis center)
  //   z axis: -FAIRING_BELOW (cube z = [axis_z - FAIRING_BELOW + (axis_z to top)])
  // Wait, the knuckle CENTER in z is `origin[2]`; the knuckle TOP is at
  // origin[2] + knuckleR. We want fairing bottom at origin[2] + knuckleR
  // - FAIRING_BELOW and fairing top at origin[2] + knuckleR + FAIRING_ABOVE.
  // So cube z-min = origin[2] + knuckleR - FAIRING_BELOW.
  const zMin = origin[2] + knuckleR - FAIRING_BELOW;
  // For ±y faces, n is +y direction (outward normal); for ±x faces, n is +x.
  // The "outward" sign was already absorbed into outX/outY when building
  // origin, so n=0 here is the knuckle axis — cube must straddle it.
  const nOffset = -knuckleR;
  const xOff = isPmY ? 0 : nOffset;
  const yOff = isPmY ? nOffset : 0;
  return translate([origin[0] + xOff, origin[1] + yOff, zMin], cubeOp);
}

/** Build the through-hole subtractive cylinder spanning the full hinge axis. */
function buildThroughHole(
  hinge: HingeFeature,
  axisStart: [number, number, number],
): BuildOp {
  const radius = hinge.pinDiameter / 2 + PIN_HOLE_TOLERANCE;
  // Overshoot 0.5 mm on each end so the bore exits cleanly past both faces
  // even after manifold rounding (matches the +1 mm convention used by the
  // shell's cavity overshoot in caseShell.ts).
  const length = hinge.hingeLength + 1;
  const cyl = cylinder(length, radius, 24);
  return translate(
    [axisStart[0] - 0.5 * dirX(hinge.face),
     axisStart[1] - 0.5 * dirY(hinge.face),
     axisStart[2]],
    orientAlongFaceU(cyl, hinge.face),
  );
}

/**
 * For the print-in-place style: a centered pin solid sized to spin freely
 * inside the through-hole. Diameter = pinDiameter - knuckleClearance so
 * there's knuckleClearance/2 of slop on each side.
 *
 * The pin extends the full hingeLength and is placed coaxial with the
 * through-hole. Slicers print this as a separate floating cylinder that the
 * surrounding knuckles capture once the boolean union with the through-hole
 * is applied (the hole is wider than the pin).
 */
function buildPrintInPlacePin(
  hinge: HingeFeature,
  axisStart: [number, number, number],
): BuildOp {
  const radius = Math.max(
    0.1,
    hinge.pinDiameter / 2 - hinge.knuckleClearance / 2,
  );
  const cyl = cylinder(hinge.hingeLength, radius, 24);
  return translate(axisStart, orientAlongFaceU(cyl, hinge.face));
}

/** Sign of the u-axis in world X. +y/-y faces have uAxis = +x → 1; ±x → 0. */
function dirX(face: HingeFeature['face']): number {
  return face === '+y' || face === '-y' ? 1 : 0;
}
function dirY(face: HingeFeature['face']): number {
  return face === '+x' || face === '-x' ? 1 : 0;
}

export function buildHingeOps(
  hingeRaw: HingeFeature | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): HingeOps {
  if (!hingeRaw || !hingeRaw.enabled) return EMPTY_OPS;
  // Auto-scale: clamp the user's stored hinge dims to fit the case + stay
  // printable. As the case shrinks, the hinge run + knuckle OD shrink
  // with it; floors prevent the hardware from dropping below FDM-reliable
  // sizes.
  const dimsForScale = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const hingeFitted = clampHinge(hingeRaw, dimsForScale);
  // Issue #110 — normalize numKnuckles per style. piano-continuous derives
  // many tightly-spaced knuckles from the hingeLength; pip-pivot forces 2.
  // Other styles use the user-set numKnuckles as-is.
  const hinge = normalizeHingeForStyle(hingeFitted);
  const lidDims = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay);
  // Reuse the dims block — same as the one used for clampHinge above.
  const dims = dimsForScale;
  const frame = faceFrame(hinge.face, dims.outerX, dims.outerY, dims.outerZ);
  // Face length along u: ±x face's u maps to world Y, so faceLen = outerY.
  // ±y face's u maps to world X, so faceLen = outerX.
  const faceLen = hinge.face === '+x' || hinge.face === '-x'
    ? dims.outerY
    : dims.outerX;
  const layout = computeAxisLayout(hinge, faceLen);
  const knuckleR = hinge.knuckleOuterDiameter / 2;
  // Axis Z: lid's bottom edge sits at outerZ for a flat lid, or
  //   outerZ - lidThickness for a recessed lid (lid drops into the pocket).
  // Using lidDims.zPosition (= outerZ for flat, outerZ - lidThickness for
  // recessed) keeps the pivot at the lid plate's bottom edge in both modes.
  const axisZ = lidDims.zPosition - knuckleR;
  // Outward offset: knuckle protrudes past the face plane by knuckleR so
  // the knuckle's centerline sits at the wall-outside surface + knuckleR.
  // BUT the wall-outside-surface is frame.origin (already on the face),
  // and we want the knuckle CYLINDER (a cylinder primitive whose body sits
  // along its axis from u-min to u-min+knuckleLen) centered on the axis Z.
  // Since cylinder() runs along its primitive +Z (which we rotated to lie
  // along +u), the cylinder's perpendicular plane is the (n, z) plane and
  // we don't need to offset on Z to "center" — translate puts the start
  // face. We DO need outwardOffset = knuckleR along the face's outward
  // normal so the knuckle body sticks out past the wall.
  const outX = frame.outwardAxis[0] * knuckleR;
  const outY = frame.outwardAxis[1] * knuckleR;

  const caseAdditive: BuildOp[] = [];
  const lidAdditive: BuildOp[] = [];
  const subtractive: BuildOp[] = [];
  let pinNode: BuildOp | null = null;
  const N = Math.max(3, Math.floor(hinge.numKnuckles));

  // Single shared through-hole world-space anchor (used by both the shell
  // subtractive and a lid-local mirror that pre-drills the lid knuckles).
  const holeStartX = frame.origin[0] + frame.uAxis[0] * layout.uStart + outX;
  const holeStartY = frame.origin[1] + frame.uAxis[1] * layout.uStart + outY;
  const lidLocalAxisZ = axisZ - lidDims.zPosition;

  for (let i = 0; i < N; i++) {
    const uMin = layout.uStart + i * layout.pitch;
    // World-coord start of THIS knuckle: frame.origin + uAxis*uMin + outward*knuckleR,
    // at axis Z in world.
    const startX = frame.origin[0] + frame.uAxis[0] * uMin + outX;
    const startY = frame.origin[1] + frame.uAxis[1] * uMin + outY;
    const startZ = axisZ;
    if (i % 2 === 0) {
      // Even indices belong to the case (rim-attached). World coordinates.
      caseAdditive.push(
        buildKnuckle(hinge, [startX, startY, startZ], layout.knuckleLen),
      );
    } else {
      // Odd indices belong to the lid. ProjectCompiler translates the lid
      // op by [0, 0, lidDims.zPosition] before emitting it, so to land at
      // the same world Z we build the knuckle at lid-local Z = world Z -
      // lidDims.zPosition. X / Y are not translated by the lid wrap so they
      // stay in world coords.
      // Pre-drill the through-hole here because cutoutOps only run against
      // the shell — the lid is unioned separately. Drilling locally keeps
      // the lid knuckle hollow at the pin axis.
      const knuckle = buildKnuckle(
        hinge,
        [startX, startY, lidLocalAxisZ],
        layout.knuckleLen,
      );
      const holeForLid = buildThroughHole(
        hinge,
        [holeStartX, holeStartY, lidLocalAxisZ],
      );
      lidAdditive.push(difference([knuckle, holeForLid]));
      // Issue #121 — fairing tab between the lid knuckle's top and the
      // lid plate's underside. Without this they touch at exactly
      // z=lidLocalAxisZ + knuckleR (= 0 by the convention that the lid
      // plate underside is at lid-local z=0): one line of contact, not
      // a volumetric overlap, manifold leaves them as separate
      // components — the lid splits into [plate, knuckle1, knuckle2, …].
      // The fairing is a small cube spanning the knuckle's u-extent,
      // 2·knuckleR perpendicular, that overlaps both the cylinder
      // (by 1 mm below z=0) and the lid plate (by 0.5 mm above z=0).
      const fairingTab = buildKnuckleLidFairing(
        hinge,
        [startX, startY, lidLocalAxisZ],
        layout.knuckleLen,
      );
      if (fairingTab) lidAdditive.push(fairingTab);
    }
  }

  // Shell-side through-hole (subtracted from the unified shell op).
  subtractive.push(buildThroughHole(hinge, [holeStartX, holeStartY, axisZ]));

  // Issue #110 — pin generation for the new styles maps to existing modes:
  //   piano-continuous + piano-segmented: same as external-pin or
  //     print-in-place per the user's pinMode. No extra pin geometry needed.
  //   pip-pivot: no centerline pin at all (the two knuckles act as captive
  //     pivot bosses with paired sockets on the lid side). Skip pin emission.
  const emitsPin =
    hinge.style === 'print-in-place' ||
    (hinge.pinMode === 'print-in-place' &&
      (hinge.style === 'piano-continuous' || hinge.style === 'piano-segmented'));

  if (emitsPin && hinge.style !== 'pip-pivot') {
    // Centered pin solid threads through both case and lid knuckles. Emit
    // it as a SEPARATE TOP-LEVEL NODE — see the HingeOps comment for the
    // rationale. Putting it in caseAdditive would let the shell's
    // through-hole difference drill the pin out (hole radius = pinD/2 + 0.1
    // exceeds pin radius = pinD/2 - clearance/2 by clearance/2 + 0.1 mm),
    // which is what we WANT for the surrounding knuckle but NOT the pin.
    pinNode = buildPrintInPlacePin(hinge, [holeStartX, holeStartY, axisZ]);
  }

  return { caseAdditive, lidAdditive, subtractive, pinNode };
}
