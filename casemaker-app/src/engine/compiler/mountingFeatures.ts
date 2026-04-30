import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { MountingFeature } from '@/types/mounting';
import { axisCylinder, cube, cylinder, translate, type BuildOp } from './buildPlan';
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

  // Tab is a flat slab: tabWidth (along u) × tabLength (outward) × tabThickness
  // Positioned so its inner edge meets the face plane and the hole is centered.
  const slab = cube([tabWidth, tabLength, tabThickness], false);
  const hole = cylinder(tabThickness + 2, holeDiameter / 2, 24);
  // World origin = frame.origin + uAxis*u + vAxis*v
  const ux = frame.uAxis[0] * feature.position.u;
  const uy = frame.uAxis[1] * feature.position.u;
  const uz = frame.uAxis[2] * feature.position.u;
  const vx = frame.vAxis[0] * feature.position.v;
  const vy = frame.vAxis[1] * feature.position.v;
  const vz = frame.vAxis[2] * feature.position.v;

  // Place slab so its corner sits at face origin offset by (u, v).
  // Outward extent is along outwardAxis: positive direction outward from the case.
  // For simplicity, only -z (bottom-mounted) is fully supported in this slice.
  // Other faces fall back to a translated slab without outward extrusion logic.
  const slabPos: [number, number, number] = [
    frame.origin[0] + ux + vx - tabWidth / 2,
    frame.origin[1] + uy + vy - tabLength / 2,
    frame.origin[2] + uz + vz,
  ];
  // For -z face, push slab below the bottom (outward direction).
  if (frame.outwardAxis[2] === -1) {
    slabPos[2] = -tabThickness;
  } else if (frame.outwardAxis[2] === 1) {
    slabPos[2] = frame.origin[2];
  } else if (frame.outwardAxis[1] === 1) {
    // +y: tab extends in +y
    slabPos[1] = frame.origin[1];
  } else if (frame.outwardAxis[1] === -1) {
    slabPos[1] = -tabLength;
  } else if (frame.outwardAxis[0] === 1) {
    slabPos[0] = frame.origin[0];
  } else if (frame.outwardAxis[0] === -1) {
    slabPos[0] = -tabLength;
  }

  const holePos: [number, number, number] = [
    slabPos[0] + tabWidth / 2,
    slabPos[1] + tabLength * 0.7,
    slabPos[2] - 0.5,
  ];
  return {
    additive: [translate(slabPos, slab)],
    subtractive: [translate(holePos, hole)],
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
 */
export function fourCornerScrewTabs(
  outerX: number,
  outerY: number,
  presetId = 'four-corner-screw-tabs',
): MountingFeature[] {
  const inset = 8;
  const positions: Array<[number, number]> = [
    [inset, inset],
    [outerX - inset, inset],
    [inset, outerY - inset],
    [outerX - inset, outerY - inset],
  ];
  return positions.map((p, i) => ({
    id: `${presetId}-${i}`,
    type: 'screw-tab' as const,
    face: '-z' as const,
    position: { u: p[0], v: p[1] },
    rotation: 0,
    params: { tabLength: 12, tabWidth: 14, tabThickness: 3, holeDiameter: 4.2 },
    enabled: true,
    presetId,
  }));
}
