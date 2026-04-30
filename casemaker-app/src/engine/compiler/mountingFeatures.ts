import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { MountingFeature } from '@/types/mounting';
import { axisCylinder, cube, cylinder, rotate, translate, type BuildOp } from './buildPlan';
import type { Facing } from '@/types';
import { computeShellDims } from './caseShell';
import { faceFrame, type FaceFrame } from '@/engine/coords';

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
): FeatureOpGroups {
  const out: FeatureOpGroups = { additive: [], subtractive: [] };
  if (!features || features.length === 0) return out;
  const dims = computeShellDims(board, params, hats, resolveHat);
  for (const feature of features) {
    if (!feature.enabled) continue;
    const frame = faceFrame(feature.face, dims.outerX, dims.outerY, dims.outerZ);
    let group: { additive: BuildOp[]; subtractive: BuildOp[] };
    switch (feature.type) {
      case 'screw-tab':
        group = generateScrewTab(feature, frame);
        break;
      case 'zip-tie-slot':
        group = generateZipTieSlot(feature, frame);
        break;
      case 'vesa-mount':
        group = generateVesaMount(feature, frame);
        break;
      default:
        continue;
    }
    out.additive.push(...group.additive);
    out.subtractive.push(...group.subtractive);
  }
  return out;
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
