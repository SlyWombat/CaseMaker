import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
  PortPlacement,
} from '@/types';
import { cavityClearance } from '@/engine/coords';
import { type BuildOp } from './buildPlan';
import { buildAxisAlignedCutout } from './roundCutout';
import { computeStackedHatHeight, HOST_HAT_CLEARANCE } from './caseShell';
import { transformPlacementPorts } from './hatOrientation';

const OVERSHOOT = 1;

/**
 * Compute, for each enabled HAT placement, the world-frame Z offset of its PCB
 * bottom (= host PCB top + headerHeight + previous-stack contributions).
 */
export function computeHatBaseZ(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: (id: string) => HatProfile | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  const ordered = [...hats].sort((a, b) => a.stackIndex - b.stackIndex);
  // Issue #32: count Z extent of every component regardless of facing.
  const hostTallest = board.components.reduce(
    (m, c) => Math.max(m, c.position.z + c.size.z),
    0,
  );
  // Host PCB sits on bosses at floor + standoff (issue #28).
  let cursor = params.floorThickness + board.defaultStandoffHeight + board.pcb.size.z;
  let firstEnabled = true;
  for (const placement of ordered) {
    const profile = resolveHat(placement.hatId);
    if (!profile) continue;
    let lift = placement.liftOverride ?? profile.headerHeight;
    if (placement.enabled && firstEnabled && hostTallest > 0) {
      lift = Math.max(lift, hostTallest + HOST_HAT_CLEARANCE);
    }
    if (placement.enabled) firstEnabled = false;
    cursor += lift;
    if (placement.enabled) {
      out.set(placement.id, cursor);
    }
    cursor += profile.pcb.size.z;
    // Issue #32: include Z extent of every HAT component regardless of facing
    // direction (an XLR body that pierces +y is still 24mm tall in Z).
    const tallestPlus = profile.components.reduce(
      (m, c) => Math.max(m, c.position.z + c.size.z),
      0,
    );
    cursor += tallestPlus;
  }
  return out;
}

/**
 * Build wall-piercing cutouts for a HAT placement's enabled ports.
 * Each cutout is sized like a board-port cutout but anchored at the HAT's PCB-Z.
 */
export function buildHatCutoutsForProject(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: (id: string) => HatProfile | undefined,
): BuildOp[] {
  if (!hats || hats.length === 0) return [];
  const baseZ = computeHatBaseZ(board, params, hats, resolveHat);
  const ops: BuildOp[] = [];
  const { wallThickness: wall } = params;
  const cl = cavityClearance(params);
  const pcbXY = board.pcb.size;

  for (const placement of hats) {
    if (!placement.enabled) continue;
    const profile = resolveHat(placement.hatId);
    if (!profile) continue;
    const z0 = baseZ.get(placement.id);
    if (z0 === undefined) continue;
    const offsetX = placement.offsetOverride?.x ?? 0;
    const offsetY = placement.offsetOverride?.y ?? 0;
    const transformedPorts = transformPlacementPorts(placement, profile);

    for (const port of transformedPorts) {
      if (!port.enabled) continue;
      if (port.facing === '+z') continue;
      const m = port.cutoutMargin;
      let xMin = port.position.x + offsetX - m;
      let xMax = port.position.x + offsetX + port.size.x + m;
      let yMin = port.position.y + offsetY - m;
      let yMax = port.position.y + offsetY + port.size.y + m;
      const zMin = z0 + port.position.z - m - profile.pcb.size.z;
      const zMax = z0 + port.position.z + port.size.z + m - profile.pcb.size.z;

      switch (port.facing) {
        case '-x':
          xMin = -(wall + cl.xMin) - OVERSHOOT;
          break;
        case '+x':
          xMax = pcbXY.x + cl.xMax + wall + OVERSHOOT;
          break;
        case '-y':
          yMin = -(wall + cl.yMin) - OVERSHOOT;
          break;
        case '+y':
          yMax = pcbXY.y + cl.yMax + wall + OVERSHOOT;
          break;
      }

      const sizeX = xMax - xMin;
      const sizeY = yMax - yMin;
      const sizeZ = zMax - zMin;
      if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) continue;

      const wx = wall + cl.xMin + xMin;
      const wy = wall + cl.yMin + yMin;
      const wz = zMin;
      ops.push(
        buildAxisAlignedCutout(
          port.facing,
          wx,
          wy,
          wz,
          sizeX,
          sizeY,
          sizeZ,
          port.cutoutShape ?? 'rect',
        ),
      );
    }
  }
  return ops;
}

/** For a HAT placement, derive PortPlacements from the HAT's components. */
export function autoPortsForHat(profile: HatProfile, hatPlacementId: string): PortPlacement[] {
  return profile.components
    .filter((c) => c.facing && c.facing !== '+z')
    .map((c) => ({
      id: `${hatPlacementId}-${c.id}`,
      sourceComponentId: c.id,
      kind: c.kind,
      position: { x: c.position.x, y: c.position.y, z: c.position.z },
      size: { x: c.size.x, y: c.size.y, z: c.size.z },
      facing: c.facing!,
      cutoutMargin: c.cutoutMargin ?? 0.5,
      locked: false,
      enabled: true,
      cutoutShape: c.cutoutShape,
    }));
}

export { computeStackedHatHeight };
