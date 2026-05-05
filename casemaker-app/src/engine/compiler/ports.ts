import type { BoardProfile, CaseParameters, PortPlacement } from '@/types';
import { cavityClearance } from '@/engine/coords';
import { type BuildOp } from './buildPlan';
import { buildAxisAlignedCutout } from './roundCutout';

const OVERSHOOT = 1;

export function buildPortCutoutOp(
  port: PortPlacement,
  board: BoardProfile,
  params: CaseParameters,
): BuildOp | null {
  if (!port.enabled) return null;
  if (port.facing === '+z') return null;
  // Issue #100 — antenna-connector components have a known board-local
  // position and are handled by the Antenna feature (antennas.ts), which
  // emits a properly-sized through-hole + counterbore (rpi-external) or
  // a thin RF window (internal/PCB-trace). Skip the generic port cutout
  // so we don't drill a redundant rectangular hole next to the proper one.
  if (port.kind === 'antenna-connector') return null;

  const m = port.cutoutMargin;
  const { wallThickness: wall, floorThickness: floor } = params;
  const cl = cavityClearance(params);
  const pcb = board.pcb.size;

  let xMin = port.position.x - m;
  let xMax = port.position.x + port.size.x + m;
  let yMin = port.position.y - m;
  let yMax = port.position.y + port.size.y + m;
  const zMin = port.position.z - m;
  const zMax = port.position.z + port.size.z + m;

  switch (port.facing) {
    case '-x':
      xMin = -(wall + cl.xMin) - OVERSHOOT;
      break;
    case '+x':
      xMax = pcb.x + cl.xMax + wall + OVERSHOOT;
      break;
    case '-y':
      yMin = -(wall + cl.yMin) - OVERSHOOT;
      break;
    case '+y':
      yMax = pcb.y + cl.yMax + wall + OVERSHOOT;
      break;
  }

  const sizeX = xMax - xMin;
  const sizeY = yMax - yMin;
  const sizeZ = zMax - zMin;
  if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) return null;

  const wx = wall + cl.xMin + xMin;
  const wy = wall + cl.yMin + yMin;
  // Issue #28: the board sits on bosses at floor + standoff; port cutouts must
  // align with the elevated board, not with the case floor.
  const wz = floor + board.defaultStandoffHeight + zMin;

  return buildAxisAlignedCutout(
    port.facing,
    wx,
    wy,
    wz,
    sizeX,
    sizeY,
    sizeZ,
    port.cutoutShape ?? 'rect',
  );
}

export function buildPortCutoutsForProject(
  ports: PortPlacement[],
  board: BoardProfile,
  params: CaseParameters,
): BuildOp[] {
  const out: BuildOp[] = [];
  for (const p of ports) {
    const op = buildPortCutoutOp(p, board, params);
    if (op) out.push(op);
  }
  return out;
}
