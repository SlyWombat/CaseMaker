import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { MountingFeature } from '@/types/mounting';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { axisCylinder, cube, cylinder, mesh, rotate, translate, type BuildOp } from './buildPlan';
import type { Facing } from '@/types';
import { computeShellDims } from './caseShell';
import { faceFrame, type FaceFrame } from '@/engine/coords';

type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

export interface FeatureOpGroups {
  additive: BuildOp[];
  subtractive: BuildOp[];
}

function num(params: MountingFeature['params'], key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Generate a flanged screw tab extending outward from the chosen face with a
 * single through-hole. The tab is positioned by (u, v) in the face's local
 * frame.
 */
function generateScrewTab(
  feature: MountingFeature,
  frame: FaceFrame,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  const tabLength = num(feature.params, 'tabLength', 12);
  const tabWidth = num(feature.params, 'tabWidth', 14);
  const tabThickness = num(feature.params, 'tabThickness', 3);
  const holeDiameter = num(feature.params, 'holeDiameter', 4.2);
  // Issue #80 — `position.u/v` is the LATERAL center of the tab on the face;
  // the tab itself extrudes OUTWARD from the face plane along the outward
  // normal. Old code put the slab inside the case footprint and let the
  // through-hole pierce the case shell. New layout:
  //   - slab in-plane: centered at (u, v), spanning tabWidth × tabLength.
  //   - slab out-of-plane: from face plane to face plane + tabThickness in
  //     the outward direction.
  //   - hole: same in-plane position, length = tabThickness + a tiny
  //     overshoot, span confined to the slab so it never carves the shell.

  // Slab cube dims in world space depend on which axis is outward.
  const outerLetter = frame.outwardLetter;
  const sx = outerLetter === 'x' ? tabThickness : tabWidth;
  const sy = outerLetter === 'y' ? tabThickness : (outerLetter === 'x' ? tabLength : tabWidth);
  const sz = outerLetter === 'z' ? tabThickness : tabLength;
  // Heuristic: the longer in-plane dimension follows the secondary v-axis,
  // shorter follows u. This matches the original code's "tabLength × tabWidth"
  // convention where length is the projection direction in the face plane;
  // for ±z faces the tab runs along v (Y), for side faces it runs along v (Z),
  // exactly as before. The above sx/sy/sz expressions encode that.

  const slab = cube([sx, sy, sz], false);

  // Slab world position: center the in-plane (u, v) extent, place the
  // out-of-plane edge ON the face plane and extrude outward by tabThickness.
  const centerWorld: [number, number, number] = [
    frame.origin[0] + frame.uAxis[0] * feature.position.u + frame.vAxis[0] * feature.position.v,
    frame.origin[1] + frame.uAxis[1] * feature.position.u + frame.vAxis[1] * feature.position.v,
    frame.origin[2] + frame.uAxis[2] * feature.position.u + frame.vAxis[2] * feature.position.v,
  ];
  const slabPos: [number, number, number] = [
    centerWorld[0] - sx / 2,
    centerWorld[1] - sy / 2,
    centerWorld[2] - sz / 2,
  ];
  // Push the slab so its inner face sits ON the case face plane and it
  // extrudes outward by tabThickness.
  if (outerLetter === 'x') {
    slabPos[0] = centerWorld[0] + (frame.outwardSign === 1 ? 0 : -tabThickness);
  } else if (outerLetter === 'y') {
    slabPos[1] = centerWorld[1] + (frame.outwardSign === 1 ? 0 : -tabThickness);
  } else {
    slabPos[2] = centerWorld[2] + (frame.outwardSign === 1 ? 0 : -tabThickness);
  }

  // Hole: cylinder of length tabThickness + 0.4 (slight overshoot for clean
  // boolean), oriented along the outward normal, centered at the tab center
  // mid-thickness so it pierces only the slab.
  const holeLength = tabThickness + 0.4;
  const holeRadius = holeDiameter / 2;
  const baseCyl = cylinder(holeLength, holeRadius, 24);
  // Cylinder primitive runs along +Z. Rotate so its body extends along the
  // OUTWARD axis (i.e. away from the case, through the slab).
  let oriented: BuildOp = baseCyl;
  if (outerLetter === 'x') {
    oriented = rotate([0, frame.outwardSign === 1 ? 90 : -90, 0], baseCyl);
  } else if (outerLetter === 'y') {
    oriented = rotate([-frame.outwardSign * 90, 0, 0], baseCyl);
  } else if (frame.outwardSign === -1) {
    // -z face: flip cylinder so its body extends in -Z (down into the slab
    // beneath the case bottom). Without this, the body extends in +Z and
    // gouges into the case floor — the symptom #80 reported.
    oriented = rotate([180, 0, 0], baseCyl);
  }
  // Hole start = the face plane offset back into the wall by 0.2 mm (clean
  // boolean overshoot). After rotate, the cylinder body extends OUTWARD from
  // here, through the slab's full thickness.
  const holeStart: [number, number, number] = [centerWorld[0], centerWorld[1], centerWorld[2]];
  if (outerLetter === 'x') {
    holeStart[0] = centerWorld[0] - frame.outwardSign * 0.2;
  } else if (outerLetter === 'y') {
    holeStart[1] = centerWorld[1] - frame.outwardSign * 0.2;
  } else {
    holeStart[2] = centerWorld[2] - frame.outwardSign * 0.2;
  }
  return {
    additive: [translate(slabPos, slab)],
    subtractive: [translate(holeStart, oriented)],
  };
}

function generateZipTieSlot(
  feature: MountingFeature,
  frame: FaceFrame,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  const slotLength = num(feature.params, 'slotLength', 15);
  const slotWidth = num(feature.params, 'slotWidth', 4);
  const wall = num(feature.params, 'wallThickness', 2);
  const slot = cube([slotLength, slotWidth, wall + 2], false);

  const ux = frame.uAxis[0] * feature.position.u;
  const uy = frame.uAxis[1] * feature.position.u;
  const uz = frame.uAxis[2] * feature.position.u;
  const vx = frame.vAxis[0] * feature.position.v;
  const vy = frame.vAxis[1] * feature.position.v;
  const vz = frame.vAxis[2] * feature.position.v;

  const slotPos: [number, number, number] = [
    frame.origin[0] + ux + vx - slotLength / 2,
    frame.origin[1] + uy + vy - slotWidth / 2,
    frame.origin[2] + uz + vz - 1,
  ];

  return {
    additive: [],
    subtractive: [translate(slotPos, slot)],
  };
}

function generateVesaMount(
  feature: MountingFeature,
  frame: FaceFrame,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  const pattern = num(feature.params, 'patternSize', 75);
  const holeDiameter = num(feature.params, 'holeDiameter', 5);
  const subs: BuildOp[] = [];
  // Four holes in a square pattern centered at (u, v) on the face.
  const half = pattern / 2;
  const offsets: Array<[number, number]> = [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ];
  // Issue #45 — drill perpendicular to the face along its outward axis. The
  // earlier code used a fixed Z-axis cylinder for every face; on +x/-x/+y/-y
  // faces that ships a 20mm tall slug at the corner that doesn't pierce the
  // wall. axisCylinder + the face's outward direction now gives a real
  // through-hole.
  const holeRadius = holeDiameter / 2;
  const holeLength = 20;
  for (const [du, dv] of offsets) {
    const u = feature.position.u + du;
    const v = feature.position.v + dv;
    const ux = frame.uAxis[0] * u;
    const uy = frame.uAxis[1] * u;
    const uz = frame.uAxis[2] * u;
    const vx = frame.vAxis[0] * v;
    const vy = frame.vAxis[1] * v;
    const vz = frame.vAxis[2] * v;
    // Determine the cylinder axis from the face's outward axis. Reverse the
    // outward direction so the cylinder body extends *into* the case from the
    // face plane, then offset by half its length so the through-hole is
    // centered on the face.
    const outward = frame.outwardAxis;
    const facing: Facing | '-z' =
      outward[2] === 1 ? '+z' :
      outward[2] === -1 ? '-z' :
      outward[1] === 1 ? '+y' :
      outward[1] === -1 ? '-y' :
      outward[0] === 1 ? '+x' : '-x';
    // axisCylinder accepts only Facing (no -z); fall back to Z-axis for -z
    // (the cylinder primitive is already Z-axis).
    const hole = facing === '-z'
      ? cylinder(holeLength, holeRadius, 24)
      : axisCylinder(facing, holeLength, holeRadius, 24);
    // Translate to the hole center, then offset back along the face normal so
    // the cylinder spans the wall (half above, half below the face plane).
    const cx = frame.origin[0] + ux + vx - outward[0] * holeLength / 2;
    const cy = frame.origin[1] + uy + vy - outward[1] * holeLength / 2;
    const cz = frame.origin[2] + uz + vz - outward[2] * holeLength / 2;
    subs.push(translate([cx, cy, cz], hole));
  }
  return { additive: [], subtractive: subs };
}

export function buildMountingFeatureOps(
  features: MountingFeature[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): FeatureOpGroups {
  const out: FeatureOpGroups = { additive: [], subtractive: [] };
  if (!features || features.length === 0) return out;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  for (const feature of features) {
    if (!feature.enabled) continue;
    const frame = faceFrame(feature.face, dims.outerX, dims.outerY, dims.outerZ);
    let group: { additive: BuildOp[]; subtractive: BuildOp[] };
    switch (feature.type) {
      case 'screw-tab':
        group = generateScrewTab(feature, frame);
        break;
      case 'end-flange':
        group = generateEndFlange(feature, frame, params);
        break;
      case 'zip-tie-slot':
        group = generateZipTieSlot(feature, frame);
        break;
      case 'vesa-mount':
        group = generateVesaMount(feature, frame);
        break;
      // Internal mounts (slice 4) — no-op until generators land.
      case 'aligned-standoff':
      case 'saddle':
        continue;
      default:
        continue;
    }
    out.additive.push(...group.additive);
    out.subtractive.push(...group.subtractive);
  }
  return out;
}

/**
 * Hammond-style end-flange: rounded outboard end + reinforcing rib + M3
 * clearance hole (issue #80). The flange is a horizontal plate that
 * projects laterally from a side wall (±x or ±y); the rounded outboard
 * end is a half-disc tangent to the rectangular plate body.
 *
 * Geometry assumptions:
 *   • Wall is vertical (±x or ±y) — the plate top/bottom faces are
 *     parallel to the wall's u-axis × outward-normal plane.
 *   • Plate thickness extends along the face's v-axis (vertical).
 *   • Bolt hole is parallel to v (the plate's thickness axis).
 *
 * For ±z faces the plate would be a vertical fin that doesn't make
 * mechanical sense; falls back to an empty op group there.
 */
function generateEndFlange(
  feature: MountingFeature,
  frame: FaceFrame,
  caseParams: CaseParameters,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  // Side walls only for now — top/bottom face flanges don't have a sensible
  // "horizontal plate that bolts the case to a wall" interpretation.
  if (frame.outwardLetter === 'z') return { additive: [], subtractive: [] };

  const projection = num(feature.params, 'projection', 12);
  const width = num(feature.params, 'width', 12);
  const thickness = num(feature.params, 'thickness', Math.max(3, caseParams.wallThickness));
  const holeDiameter = num(feature.params, 'holeDiameter', 3.4);

  // Plate body: rectangle (width × (projection - width/2)) + half-disc (radius
  // = width/2) at the outboard end. We approximate via cube + full cylinder
  // unioned; the inboard half of the cylinder is hidden inside the rect.
  const rectLen = projection - width / 2;
  // Rectangle in face-local (uLocal, nLocal, vLocal) coords:
  //   uLocal ∈ [-width/2, width/2]
  //   nLocal ∈ [0, rectLen]   (outward from the wall)
  //   vLocal ∈ [-thickness/2, thickness/2]
  // Cube primitive extends in +x/+y/+z from origin; we'll position into world.
  const outLetter = frame.outwardLetter;
  const outSign = frame.outwardSign;
  // World-axis directions for the three local axes:
  //   uAxis (along wall) is frame.uAxis
  //   nAxis (outward) is frame.outwardAxis
  //   vAxis (along wall, vertical) is frame.vAxis

  // Compute world dimensions for the cube. uAxis × nAxis × vAxis maps to
  // exactly one of the three world axes per dimension because frames are
  // axis-aligned.
  function worldSize(uVal: number, nVal: number, vVal: number): [number, number, number] {
    const sx =
      Math.abs(frame.uAxis[0]) * uVal +
      Math.abs(frame.outwardAxis[0]) * nVal +
      Math.abs(frame.vAxis[0]) * vVal;
    const sy =
      Math.abs(frame.uAxis[1]) * uVal +
      Math.abs(frame.outwardAxis[1]) * nVal +
      Math.abs(frame.vAxis[1]) * vVal;
    const sz =
      Math.abs(frame.uAxis[2]) * uVal +
      Math.abs(frame.outwardAxis[2]) * nVal +
      Math.abs(frame.vAxis[2]) * vVal;
    return [sx, sy, sz];
  }

  // Issue #101 — end-flanges are always FLUSH WITH THE CASE BOTTOM. The
  // plate underside sits at world z=0 (= floor underside) so the case can
  // sit flat on a panel and the flange is single-pass on the build plate
  // alongside the case wall (no support material). Ignore the user-supplied
  // feature.position.v for this feature type; v anchor = thickness/2 so the
  // plate center is at z = thickness/2 → underside at z=0.
  // For ±x or ±y walls, frame.vAxis is +z and frame.origin.z is 0, so the
  // anchor in face-local v coords is exactly thickness/2.
  const vAnchor = thickness / 2;
  function localToWorld(uOff: number, nOff: number, vOff: number): [number, number, number] {
    return [
      frame.origin[0] +
        frame.uAxis[0] * (feature.position.u + uOff) +
        frame.vAxis[0] * (vAnchor + vOff) +
        frame.outwardAxis[0] * nOff,
      frame.origin[1] +
        frame.uAxis[1] * (feature.position.u + uOff) +
        frame.vAxis[1] * (vAnchor + vOff) +
        frame.outwardAxis[1] * nOff,
      frame.origin[2] +
        frame.uAxis[2] * (feature.position.u + uOff) +
        frame.vAxis[2] * (vAnchor + vOff) +
        frame.outwardAxis[2] * nOff,
    ];
  }

  const rectSize = worldSize(width, rectLen, thickness);
  const rectCenter = localToWorld(0, rectLen / 2, 0);
  const rectCorner: [number, number, number] = [
    rectCenter[0] - rectSize[0] / 2,
    rectCenter[1] - rectSize[1] / 2,
    rectCenter[2] - rectSize[2] / 2,
  ];
  const rect = translate(rectCorner, cube(rectSize, false));

  // Half-disc cap: a Z-axis cylinder of radius=width/2 and height=thickness,
  // rotated so its axis aligns with the v-axis (plate thickness direction),
  // then translated to the outboard tip of the rectangle.
  const capRadius = width / 2;
  const capCyl = cylinder(thickness, capRadius, 32);
  const capOriented: BuildOp = capCyl;
  // The cylinder's axis after rotation should align with the face's v-axis.
  // For ±x or ±y walls, vAxis is +z (vertical), so the un-rotated Z-axis
  // cylinder is already aligned. We just need to center it on the v range.
  void capOriented;
  const capCenter = localToWorld(0, rectLen, 0);
  const capCornerOffset: [number, number, number] = [
    capCenter[0] - capRadius - (frame.vAxis[0] !== 0 ? -capRadius : 0),
    capCenter[1] - capRadius - (frame.vAxis[1] !== 0 ? -capRadius : 0),
    capCenter[2],
  ];
  // Simpler placement: the Z-axis cylinder spans from corner z to z+thickness.
  // For side walls, vAxis is +z. Plate vertical extent is [v - t/2, v + t/2]
  // in world z; cylinder height runs in +z, so cylinder corner (its z=0 face)
  // sits at world z = vCenter - thickness/2.
  const capPos: [number, number, number] = [
    capCenter[0],
    capCenter[1],
    capCenter[2] - thickness / 2,
  ];
  void capCornerOffset;
  const cap = translate(capPos, capCyl);

  // Bolt hole: cylinder along v (vertical), centered on the cap circle.
  const holeLen = thickness + 0.4;
  const hole = cylinder(holeLen, holeDiameter / 2, 24);
  const holePos: [number, number, number] = [
    capCenter[0],
    capCenter[1],
    capCenter[2] - holeLen / 2,
  ];
  // Suppress unused-var warning when only some branches use these.
  void outLetter;
  void outSign;

  // Issue #80 / #102 — reinforcing ribs on top of the plate.
  // Each rib is a triangular prism: vertical leg along the wall (h=ribH),
  // horizontal leg along the plate top (length=ribL), hypotenuse from the
  // outboard rib end at plate-top up to the wall at plate-top+ribH.
  //
  // #102 — ribs MUST NOT cross the screw hole. The hole sits at u=0 with
  // radius holeDiameter/2, so a single centered rib (the previous design)
  // covered the hole and blocked the fastener seat. We now place TWO ribs,
  // one on each side of the hole along the u-axis, with a clearance gap.
  // If the flange is too narrow for two ribs we fall back to one single
  // rib OFFSET to the side of the hole (still no overlap with the bore).
  const ribEnabled = num(feature.params, 'ribEnabled', 1) !== 0;
  const additive: BuildOp[] = [rect, cap];
  if (ribEnabled) {
    const ribL = num(feature.params, 'ribLength', projection * 0.7);
    const ribH = num(feature.params, 'ribHeight', projection * 0.5);
    const ribT = num(feature.params, 'ribThickness', Math.max(2, caseParams.wallThickness));
    const RIB_HOLE_CLEARANCE = 0.5;
    // Each rib occupies u ∈ [uCenter - ribT/2, uCenter + ribT/2]. To clear
    // the hole circle (centered u=0, radius holeDiameter/2) we need
    //   |uCenter| - ribT/2  ≥  holeDiameter/2 + RIB_HOLE_CLEARANCE
    // and the rib stays within the plate u extent [-width/2, +width/2]:
    //   |uCenter| + ribT/2  ≤  width/2.
    const uMin = holeDiameter / 2 + RIB_HOLE_CLEARANCE + ribT / 2;
    const uMax = width / 2 - ribT / 2;
    if (uMax >= uMin) {
      // Two-rib layout — one on each side of the hole, midway between the
      // hole-clearance edge and the plate edge.
      const uCenter = (uMin + uMax) / 2;
      additive.push(buildRibGusset(frame, feature, +uCenter, ribL, ribH, ribT, thickness));
      additive.push(buildRibGusset(frame, feature, -uCenter, ribL, ribH, ribT, thickness));
    } else if (width / 2 - ribT / 2 >= holeDiameter / 2 + RIB_HOLE_CLEARANCE + ribT / 2) {
      // Tight flange — only fits a single rib offset to one side of the hole.
      const uCenter = (uMin + width / 2 - ribT / 2) / 2;
      additive.push(buildRibGusset(frame, feature, +uCenter, ribL, ribH, ribT, thickness));
    }
    // else: flange is too narrow for any rib that clears the bore — emit
    // none. Better to skip the gusset than to print a rib stub blocking
    // the fastener.
  }

  return {
    additive,
    subtractive: [translate(holePos, hole)],
  };
}

/**
 * Triangular-prism reinforcing rib that sits on top of the end-flange plate
 * and leans against the wall. Issue #80 — stiffens the flange against bolt
 * torque, mirroring the gusset on commercial enclosures (Hammond / Polycase).
 */
function buildRibGusset(
  frame: FaceFrame,
  feature: MountingFeature,
  uCenter: number,
  ribLength: number,
  ribHeight: number,
  ribThickness: number,
  plateThickness: number,
): BuildOp {
  // Face-local triangular prism profile (in n-v plane), extruded along u
  // by ribThickness, centered at uCenter (#102 — ribs offset to clear the
  // screw hole at u=0; multiple ribs sit on either side of the bore).
  // Triangle vertices (n, v):
  //   A: (0, vTop)             — wall, at plate-top level
  //   B: (ribLength, vTop)     — outboard end, at plate-top level
  //   C: (0, vTop + ribHeight) — wall, top of rib
  // The plate's underside is anchored to the case bottom (z=0) per #101,
  // so the rib's vTop reference must match — vTop is plate-thickness above
  // z=0 in world coords, i.e. vTop = plateThickness in v-axis units (the
  // localToWorld in generateEndFlange uses vAnchor=plateThickness/2 already
  // so adding plateThickness/2 puts us at the plate top face).
  const vTop = plateThickness / 2;
  const tu = ribThickness / 2;
  const positions: number[] = [];
  // Mirror the flush-bottom anchor used in generateEndFlange — ignore
  // feature.position.v entirely so the rib sits on the plate top regardless
  // of saved feature position.
  const vAnchor = plateThickness / 2;
  function pushVert(uOff: number, nOff: number, vOff: number): void {
    positions.push(
      frame.origin[0] +
        frame.uAxis[0] * (feature.position.u + uCenter + uOff) +
        frame.outwardAxis[0] * nOff +
        frame.vAxis[0] * (vAnchor + vOff),
      frame.origin[1] +
        frame.uAxis[1] * (feature.position.u + uCenter + uOff) +
        frame.outwardAxis[1] * nOff +
        frame.vAxis[1] * (vAnchor + vOff),
      frame.origin[2] +
        frame.uAxis[2] * (feature.position.u + uCenter + uOff) +
        frame.outwardAxis[2] * nOff +
        frame.vAxis[2] * (vAnchor + vOff),
    );
  }
  // Front cap (u = -tu): A=0, B=1, C=2
  pushVert(-tu, 0, vTop);
  pushVert(-tu, ribLength, vTop);
  pushVert(-tu, 0, vTop + ribHeight);
  // Back cap (u = +tu): A=3, B=4, C=5
  pushVert(+tu, 0, vTop);
  pushVert(+tu, ribLength, vTop);
  pushVert(+tu, 0, vTop + ribHeight);
  // Triangles wound CCW from outside the prism. The wall side (n=0) is
  // unioned with the case shell so its winding is for outward-facing normal
  // (away from the wall material into the rib body — i.e. -n direction
  // would be into the wall; we want the EXPOSED rib face). Manifold's union
  // handles fusion regardless, but valid manifold-ness requires every
  // triangle wound consistently outward.
  const indices: number[] = [
    // Front cap (u = -tu, normal -u, CCW from -u view): A C B
    0, 2, 1,
    // Back cap (u = +tu, normal +u, CCW from +u view): A B C
    3, 4, 5,
    // Wall side (n=0, normal -n outward): A → A' → C' → C
    // 0 → 3 → 5 → 2 wound CCW from -n view (looking toward +n from inside cavity)
    0, 3, 5,  0, 5, 2,
    // Plate-top side (v=vTop, normal -v outward): A → B → B' → A'
    // 0 → 1 → 4 → 3 wound CCW from -v view (looking up toward the plate top)
    0, 1, 4,  0, 4, 3,
    // Hypotenuse (B → C → C' → B'): 1 → 2 → 5 → 4 — outward normal +n+v
    1, 2, 5,  1, 5, 4,
  ];
  return mesh(new Float32Array(positions), new Uint32Array(indices));
}

/**
 * Pair-at-each-end preset: two flanges per wall on a chosen pair of opposite
 * walls (default ±y). Each flange sits ~1/4 from the corresponding wall end,
 * mid-height of the wall.
 */
export function endFlangesPreset(
  outerX: number,
  outerY: number,
  outerZ: number,
  walls: ('+x' | '-x' | '+y' | '-y')[] = ['+y', '-y'],
  presetId = 'pair-end-flanges',
): MountingFeature[] {
  const features: MountingFeature[] = [];
  // Issue #101 — flanges sit FLUSH WITH THE BOTTOM. The plate underside is
  // pinned to z=0 by generateEndFlange regardless of this v value, but
  // emit thickness/2 here so the saved position matches what gets rendered.
  const flangeThickness = 3;
  const flushV = flangeThickness / 2;
  void outerZ;
  for (const wall of walls) {
    const wallLen = wall === '+x' || wall === '-x' ? outerY : outerX;
    // Place flanges 1/4 and 3/4 along the wall length so they sit roughly at
    // each end without bumping into the corner snap features.
    for (const u of [wallLen / 4, (3 * wallLen) / 4]) {
      features.push({
        id: `${presetId}-${wall}-${Math.round(u)}`,
        type: 'end-flange',
        mountClass: 'external',
        face: wall,
        position: { u, v: flushV },
        rotation: 0,
        params: {
          projection: 12,
          width: 12,
          thickness: flangeThickness,
          holeDiameter: 3.4,
        },
        enabled: true,
        presetId,
      });
    }
  }
  return features;
}

/**
 * Stamp the four-corner-screw-tabs preset onto a case's bottom face.
 *
 * Issue #80 — tabs project LATERALLY outside the case footprint instead of
 * sitting underneath it. Each tab is centered at its corner (u=0 or outerX,
 * v=0 or outerY); the slab extends ±width/2, ±length/2 around that center,
 * so half the slab is outside the footprint in each axis. The hole sits at
 * the tab center (the corner) — a tiny inboard portion overlaps the case so
 * the union produces a single connected component, but the bolt clearance
 * is in clear space.
 */
export function fourCornerScrewTabs(
  outerX: number,
  outerY: number,
  presetId = 'four-corner-screw-tabs',
): MountingFeature[] {
  const positions: Array<[number, number]> = [
    [0, 0],
    [outerX, 0],
    [0, outerY],
    [outerX, outerY],
  ];
  return positions.map((p, i) => ({
    id: `${presetId}-${i}`,
    type: 'screw-tab' as const,
    mountClass: 'external' as const,
    face: '-z' as const,
    position: { u: p[0], v: p[1] },
    rotation: 0,
    params: { tabLength: 12, tabWidth: 14, tabThickness: 3, holeDiameter: 4.2 },
    enabled: true,
    presetId,
  }));
}
