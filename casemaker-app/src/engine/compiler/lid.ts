import type { CaseParameters, BoardProfile } from '@/types';
import { cube, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

export interface LidDims {
  x: number;
  y: number;
  z: number;
  zPosition: number;
}

export function computeLidDims(board: BoardProfile, params: CaseParameters): LidDims {
  const dims = computeShellDims(board, params);
  return {
    x: dims.outerX,
    y: dims.outerY,
    z: params.lidThickness,
    zPosition: dims.outerZ,
  };
}

export function buildFlatLid(board: BoardProfile, params: CaseParameters): BuildOp {
  const lid = computeLidDims(board, params);
  return cube([lid.x, lid.y, lid.z], false);
}
