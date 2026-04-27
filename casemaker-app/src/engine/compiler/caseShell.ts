import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import { cube, difference, translate, type BuildOp } from './buildPlan';

export interface ShellDims {
  outerX: number;
  outerY: number;
  outerZ: number;
  cavityX: number;
  cavityY: number;
  cavityZ: number;
}

/**
 * Compute the additional internal Z height required by stacked HATs.
 * Each enabled HAT contributes (lift + pcb.z + tallest +z component height).
 * Unknown hatId entries are ignored (defensive — the project store may carry
 * stale references after a HAT is removed).
 */
export function computeStackedHatHeight(
  hats: HatPlacement[] | undefined,
  resolveHat: (id: string) => HatProfile | undefined,
): number {
  if (!hats || hats.length === 0) return 0;
  const ordered = [...hats].sort((a, b) => a.stackIndex - b.stackIndex);
  let total = 0;
  for (const placement of ordered) {
    if (!placement.enabled) continue;
    const profile = resolveHat(placement.hatId);
    if (!profile) continue;
    const lift = placement.liftOverride ?? profile.headerHeight;
    const tallest = profile.components.reduce((m, c) => {
      if (c.facing === '+z') return Math.max(m, c.position.z + c.size.z);
      return m;
    }, profile.pcb.size.z);
    total += lift + tallest;
  }
  return total;
}

export function computeShellDims(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
): ShellDims {
  const { wallThickness: wall, floorThickness: floor, internalClearance: cl, zClearance } = params;
  const pcb = board.pcb.size;
  const cavityX = pcb.x + 2 * cl;
  const cavityY = pcb.y + 2 * cl;
  const stackHeight = computeStackedHatHeight(hats, resolveHat);
  const cavityZ = Math.max(zClearance, stackHeight) + pcb.z;
  return {
    outerX: cavityX + 2 * wall,
    outerY: cavityY + 2 * wall,
    outerZ: floor + cavityZ,
    cavityX,
    cavityY,
    cavityZ,
  };
}

export function buildOuterShell(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall, floorThickness: floor } = params;

  const outer = cube([dims.outerX, dims.outerY, dims.outerZ], false);
  const overshoot = 1;
  const cavity = translate(
    [wall, wall, floor],
    cube([dims.cavityX, dims.cavityY, dims.cavityZ + overshoot], false),
  );

  return difference([outer, cavity]);
}
