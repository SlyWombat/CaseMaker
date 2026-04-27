import type {
  Facing,
  HatMountingPosition,
  HatPlacement,
  HatProfile,
  HatRotation,
  PortPlacement,
} from '@/types';

/**
 * Resolve the mounting position to apply for a placement.
 *  - Profile has no mountingPositions → identity (rotation 0, offset 0)
 *  - Placement names a mountingPositionId → that one
 *  - Otherwise the first declared position
 */
export function resolveMountingPosition(
  profile: HatProfile,
  placement: HatPlacement,
): HatMountingPosition {
  if (!profile.mountingPositions || profile.mountingPositions.length === 0) {
    return { id: 'default', label: 'Default', offset: { x: 0, y: 0 }, rotation: 0 };
  }
  const named = placement.mountingPositionId
    ? profile.mountingPositions.find((p) => p.id === placement.mountingPositionId)
    : undefined;
  return named ?? profile.mountingPositions[0]!;
}

const FACING_AT_0: Facing[] = ['+x', '+y', '-x', '-y'];

export function rotateFacing(facing: Facing, rotation: HatRotation): Facing {
  if (facing === '+z') return '+z';
  const idx = FACING_AT_0.indexOf(facing);
  if (idx < 0) return facing;
  const steps = (rotation / 90) | 0; // 0,1,2,3
  return FACING_AT_0[(idx + steps) % 4]!;
}

/**
 * Rotate a port position around the HAT PCB center, then apply the position
 * offset. Size axes swap on 90/270° rotations.
 */
export function applyMountingPosition(
  port: PortPlacement,
  pcb: { x: number; y: number; z: number },
  pos: HatMountingPosition,
): PortPlacement {
  const cx = pcb.x / 2;
  const cy = pcb.y / 2;
  const px = port.position.x - cx;
  const py = port.position.y - cy;
  let rx = px;
  let ry = py;
  let sx = port.size.x;
  let sy = port.size.y;
  switch (pos.rotation) {
    case 0:
      break;
    case 90:
      rx = -py;
      ry = px;
      sx = port.size.y;
      sy = port.size.x;
      break;
    case 180:
      rx = -px;
      ry = -py;
      break;
    case 270:
      rx = py;
      ry = -px;
      sx = port.size.y;
      sy = port.size.x;
      break;
  }
  // After 90/270 rotation, the rotated bbox extends in different X/Y; need to
  // shift so the lower-left of the rotated bbox lands at the rotated origin.
  const offsetForBbox = (() => {
    switch (pos.rotation) {
      case 0:
        return { x: 0, y: 0 };
      case 90:
        return { x: -port.size.y, y: 0 };
      case 180:
        return { x: -port.size.x, y: -port.size.y };
      case 270:
        return { x: 0, y: -port.size.x };
    }
  })();
  return {
    ...port,
    position: {
      x: rx + cx + pos.offset.x + offsetForBbox.x,
      y: ry + cy + pos.offset.y + offsetForBbox.y,
      z: port.position.z,
    },
    size: { x: sx, y: sy, z: port.size.z },
    facing: rotateFacing(port.facing, pos.rotation),
  };
}

/** Apply mounting position to every port in a placement. */
export function transformPlacementPorts(
  placement: HatPlacement,
  profile: HatProfile,
): PortPlacement[] {
  const pos = resolveMountingPosition(profile, placement);
  if (pos.rotation === 0 && pos.offset.x === 0 && pos.offset.y === 0) {
    return placement.ports;
  }
  return placement.ports.map((p) => applyMountingPosition(p, profile.pcb.size, pos));
}
