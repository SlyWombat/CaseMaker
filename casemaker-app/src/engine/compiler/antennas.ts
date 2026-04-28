import type {
  AntennaPlacement,
  AntennaFacing,
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
} from '@/types';
import { ANTENNA_SPECS } from '@/types/antenna';
import { cylinder, rotate, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

const COUNTERBORE_FLOOR = 1; // leave at least 1mm of wall between counterbore and outside

export interface AntennaCutoutOps {
  subtractive: BuildOp[];
}

/**
 * Find an antenna-connector component in a board profile, if present.
 */
function findAntennaConnector(board: BoardProfile) {
  return board.components.find((c) => c.kind === 'antenna-connector');
}

/**
 * Pick the closest side wall (+x/-x/+y/-y) to a connector position on the PCB.
 * Returns the facing direction and the world-frame coordinate along the chosen
 * wall the antenna body should be centered at.
 */
function resolveFacingForConnector(
  connectorX: number,
  connectorY: number,
  pcbX: number,
  pcbY: number,
): { facing: AntennaFacing; uOffset: number } {
  const dxMinus = connectorX;
  const dxPlus = pcbX - connectorX;
  const dyMinus = connectorY;
  const dyPlus = pcbY - connectorY;
  const m = Math.min(dxMinus, dxPlus, dyMinus, dyPlus);
  if (m === dxMinus) return { facing: '-x', uOffset: connectorY };
  if (m === dxPlus) return { facing: '+x', uOffset: connectorY };
  if (m === dyMinus) return { facing: '-y', uOffset: connectorX };
  return { facing: '+y', uOffset: connectorX };
}

/**
 * Build a default AntennaPlacement[] for a freshly created project given the
 * host board. Uses the board's antenna-connector component (if any) to choose
 * type and wall placement.
 */
export function defaultAntennasForBoard(board: BoardProfile): AntennaPlacement[] {
  const connector = findAntennaConnector(board);
  if (!connector) return [];
  const id = board.id;
  let type: AntennaPlacement['type'] = 'external-mount';
  if (id === 'rpi-5' || id === 'rpi-cm-io') type = 'rpi-external';
  if (id === 'esp32-devkit-v1' || id.startsWith('esp32-wroom')) type = 'internal';

  const { facing, uOffset } = resolveFacingForConnector(
    connector.position.x,
    connector.position.y,
    board.pcb.size.x,
    board.pcb.size.y,
  );
  return [
    {
      id: `ant-${id}`,
      type,
      enabled: true,
      facing,
      uOffset,
    },
  ];
}

/**
 * Compile antenna placements into a list of subtractive cylindrical cutouts.
 * Internal antennas produce no ops. External-mount and rpi-external produce
 * a through-hole sized to the connector body, plus an inside-face counterbore
 * for the retaining nut.
 */
export function buildAntennaOps(
  antennas: AntennaPlacement[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): AntennaCutoutOps {
  if (!antennas || antennas.length === 0) return { subtractive: [] };
  const shell = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall, internalClearance: cl, floorThickness: floor } = params;
  const out: BuildOp[] = [];

  for (const ant of antennas) {
    if (!ant.enabled) continue;
    if (ant.type === 'internal') continue;

    const connector = findAntennaConnector(board);
    const facing =
      ant.facing ??
      (connector
        ? resolveFacingForConnector(
            connector.position.x,
            connector.position.y,
            board.pcb.size.x,
            board.pcb.size.y,
          ).facing
        : '+y');
    const uOffset =
      ant.uOffset ??
      (connector
        ? facing === '+y' || facing === '-y'
          ? connector.position.x
          : connector.position.y
        : 0);

    const spec = ANTENNA_SPECS[ant.type];
    const overshoot = 1;
    // World-frame cutout center along Z: roughly mid-height on the wall, just
    // above the PCB. We place at (floor + pcb.z + 8mm) — comfortably above the
    // host PCB, comfortably below the lid even on small cases.
    // Antenna Z is anchored to the elevated PCB top (floor + standoff + pcb.z).
    const zCenter =
      floor + board.defaultStandoffHeight + board.pcb.size.z + Math.min(8, shell.cavityZ / 2);

    switch (facing) {
      case '+y': {
        const xCenter = wall + cl + uOffset;
        const yMin = wall + cl + board.pcb.size.y - overshoot;
        const cyl = cylinder(wall + 2 * overshoot, spec.holeDiameter / 2 + 0.2, 48);
        const rotated = rotate([-90, 0, 0], cyl);
        out.push(translate([xCenter, yMin, zCenter], rotated));
        // Inside-face counterbore (sits flush at the inside wall, depth = wall - 1)
        if (spec.counterboreDiameter > 0) {
          const cbDepth = Math.max(0, wall - COUNTERBORE_FLOOR);
          if (cbDepth > 0) {
            const cb = cylinder(cbDepth + overshoot, spec.counterboreDiameter / 2, 48);
            const cbRot = rotate([-90, 0, 0], cb);
            out.push(translate([xCenter, wall + cl + board.pcb.size.y - overshoot, zCenter], cbRot));
          }
        }
        break;
      }
      case '-y': {
        const xCenter = wall + cl + uOffset;
        const yMin = -overshoot;
        const cyl = cylinder(wall + 2 * overshoot, spec.holeDiameter / 2 + 0.2, 48);
        const rotated = rotate([-90, 0, 0], cyl);
        out.push(translate([xCenter, yMin, zCenter], rotated));
        break;
      }
      case '+x': {
        const yCenter = wall + cl + uOffset;
        const xMin = wall + cl + board.pcb.size.x - overshoot;
        const cyl = cylinder(wall + 2 * overshoot, spec.holeDiameter / 2 + 0.2, 48);
        const rotated = rotate([0, 90, 0], cyl);
        out.push(translate([xMin, yCenter, zCenter], rotated));
        break;
      }
      case '-x': {
        const yCenter = wall + cl + uOffset;
        const xMin = -overshoot;
        const cyl = cylinder(wall + 2 * overshoot, spec.holeDiameter / 2 + 0.2, 48);
        const rotated = rotate([0, 90, 0], cyl);
        out.push(translate([xMin, yCenter, zCenter], rotated));
        break;
      }
    }
  }

  return { subtractive: out };
}
