import type { CaseParameters, BoardProfile } from '@/types';
import { cube, difference, translate, type BuildOp } from './buildPlan';

export interface ShellDims {
  outerX: number;
  outerY: number;
  outerZ: number;
  cavityX: number;
  cavityY: number;
  cavityZ: number;
}

export function computeShellDims(board: BoardProfile, params: CaseParameters): ShellDims {
  const { wallThickness: wall, floorThickness: floor, internalClearance: cl, zClearance } = params;
  const pcb = board.pcb.size;
  const cavityX = pcb.x + 2 * cl;
  const cavityY = pcb.y + 2 * cl;
  const cavityZ = pcb.z + zClearance;
  return {
    outerX: cavityX + 2 * wall,
    outerY: cavityY + 2 * wall,
    outerZ: floor + cavityZ,
    cavityX,
    cavityY,
    cavityZ,
  };
}

export function buildOuterShell(board: BoardProfile, params: CaseParameters): BuildOp {
  const dims = computeShellDims(board, params);
  const { wallThickness: wall, floorThickness: floor } = params;

  const outer = cube([dims.outerX, dims.outerY, dims.outerZ], false);
  // Cavity is open-top: extend slightly above outerZ to ensure clean subtraction.
  const overshoot = 1;
  const cavity = translate(
    [wall, wall, floor],
    cube([dims.cavityX, dims.cavityY, dims.cavityZ + overshoot], false),
  );

  return difference([outer, cavity]);
}
