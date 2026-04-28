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
export const HOST_HAT_CLEARANCE = 0.5;

function tallestPlusZ(profile: { components: BoardProfile['components']; pcb: BoardProfile['pcb'] }, includePcb: boolean): number {
  // Issue #32: count the Z extent of every component, not just +z-facing ones.
  // A +y-facing connector body (e.g., XLR-3 at z=24mm) still occupies
  // vertical space in the cavity even though it pierces a side wall.
  return profile.components.reduce(
    (m, c) => Math.max(m, c.position.z + c.size.z),
    includePcb ? profile.pcb.size.z : 0,
  );
}

export function computeStackedHatHeight(
  hats: HatPlacement[] | undefined,
  resolveHat: (id: string) => HatProfile | undefined,
  hostBoard?: BoardProfile,
): number {
  if (!hats || hats.length === 0) return 0;
  const ordered = [...hats].sort((a, b) => a.stackIndex - b.stackIndex);
  const hostTallest = hostBoard ? tallestPlusZ(hostBoard, false) : 0;
  let total = 0;
  let firstEnabled = true;
  for (const placement of ordered) {
    if (!placement.enabled) continue;
    const profile = resolveHat(placement.hatId);
    if (!profile) continue;
    let lift = placement.liftOverride ?? profile.headerHeight;
    if (firstEnabled && hostTallest > 0) {
      lift = Math.max(lift, hostTallest + HOST_HAT_CLEARANCE);
    }
    firstEnabled = false;
    const tallest = tallestPlusZ(profile, true);
    total += lift + tallest;
  }
  return total;
}

/**
 * Issue #46 — `hats` and `resolveHat` are required, not optional. Every shell
 * dimension (`outerZ`, `cavityZ`) depends on the HAT stack, so any caller
 * that omits HATs is computing the wrong envelope. Pass `[]` and `() =>
 * undefined` explicitly only when the call site truly has no HATs to resolve.
 */
export function computeShellDims(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: (id: string) => HatProfile | undefined,
): ShellDims {
  const { wallThickness: wall, floorThickness: floor, internalClearance: cl, zClearance } = params;
  const pcb = board.pcb.size;
  const cavityX = pcb.x + 2 * cl;
  const cavityY = pcb.y + 2 * cl;
  const stackHeight = computeStackedHatHeight(hats, resolveHat, board);
  // Issue #66 — host's own tallest +z component must always fit, even with
  // no HATs present. `recommendedZClearance` was set too low on several
  // built-in boards (Pi 4 / Pi 5: USB3 stack is 16 mm tall but
  // recommendedZClearance was 5–8). Compute the host's tallest excursion
  // above the PCB top and use it as a defensive floor for the clearance
  // budget.
  const hostTallestAbovePcb = board.components.reduce(
    (m, c) => Math.max(m, c.position.z + c.size.z - pcb.z),
    0,
  );
  // Issue #74 — guarantee at least lidThickness + 2 mm of solid wall above
  // the tallest cutout so the lid pocket / snap catches don't slice into the
  // port openings. Without this, the placement-validator's rim warning
  // fires on stock projects (e.g. GIGA + DMX, where the XLR cutout reaches
  // 0.7 mm into the rim margin).
  const RIM_MARGIN = 2;
  const tallestAbovePcb = Math.max(hostTallestAbovePcb, stackHeight);
  const rimSafe = tallestAbovePcb + params.lidThickness + RIM_MARGIN;
  const baseClearance = Math.max(zClearance, stackHeight, hostTallestAbovePcb, rimSafe);
  const extra = Math.max(0, params.extraCavityZ ?? 0);
  const cavityZ = board.defaultStandoffHeight + pcb.z + baseClearance + extra;
  // When the lid is recessed (issue #30), the case envelope extends above the
  // cavity by lidThickness + 1mm ledge so the lid drops in flush with the rim.
  const recessExtra = params.lidRecess ? params.lidThickness + 1 : 0;
  return {
    outerX: cavityX + 2 * wall,
    outerY: cavityY + 2 * wall,
    outerZ: floor + cavityZ + recessExtra,
    cavityX,
    cavityY,
    cavityZ,
  };
}

export function buildOuterShell(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: (id: string) => HatProfile | undefined,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall, floorThickness: floor } = params;

  const outer = cube([dims.outerX, dims.outerY, dims.outerZ], false);
  const overshoot = 1;
  const cavity = translate(
    [wall, wall, floor],
    cube([dims.cavityX, dims.cavityY, dims.cavityZ + overshoot], false),
  );

  if (params.lidRecess) {
    // Recess pocket: oversized rectangular cut at the top to receive the lid,
    // sitting on a 1mm ledge above the cavity (issue #30).
    const recessLedge = 1;
    const recessOffset = Math.max(0.5, wall - 0.5);
    const pocketX = dims.cavityX + 2 * recessOffset;
    const pocketY = dims.cavityY + 2 * recessOffset;
    const pocketZ = params.lidThickness + 0.5;
    const pocketOriginX = wall - recessOffset;
    const pocketOriginY = wall - recessOffset;
    const pocketOriginZ = dims.outerZ - pocketZ;
    void recessLedge;
    const pocket = translate(
      [pocketOriginX, pocketOriginY, pocketOriginZ],
      cube([pocketX, pocketY, pocketZ + overshoot], false),
    );
    return difference([outer, cavity, pocket]);
  }

  return difference([outer, cavity]);
}
