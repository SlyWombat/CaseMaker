import type { CaseParameters, BoardProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

export interface DisplayFootprint {
  /** Effective PCB X for the case, max(host, display) */
  effectiveX: number;
  effectiveY: number;
  /** Additional Z above the host PCB for the display + standoffs */
  topAddedZ: number;
}

export function computeDisplayFootprint(
  board: BoardProfile,
  placement: DisplayPlacement | null | undefined,
  resolveDisplay: (id: string) => DisplayProfile | undefined,
): DisplayFootprint {
  if (!placement || !placement.enabled) {
    return { effectiveX: board.pcb.size.x, effectiveY: board.pcb.size.y, topAddedZ: 0 };
  }
  const profile = resolveDisplay(placement.displayId);
  if (!profile) {
    return { effectiveX: board.pcb.size.x, effectiveY: board.pcb.size.y, topAddedZ: 0 };
  }
  return {
    effectiveX: Math.max(board.pcb.size.x, profile.pcb.size.x),
    effectiveY: Math.max(board.pcb.size.y, profile.pcb.size.y),
    topAddedZ: profile.overallHeight,
  };
}

/**
 * Build the window cutout in the case top for the display's active area.
 * Supported framings in this slice: 'top-window' and 'recessed-bezel'.
 */
export function buildDisplayCutoutOps(
  board: BoardProfile,
  params: CaseParameters,
  placement: DisplayPlacement | null | undefined,
  resolveDisplay: (id: string) => DisplayProfile | undefined,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  if (!placement || !placement.enabled) return { additive: [], subtractive: [] };
  const profile = resolveDisplay(placement.displayId);
  if (!profile) return { additive: [], subtractive: [] };
  const dims = computeShellDims(board, params);
  const { wallThickness: wall, internalClearance: cl } = params;

  // Active-area corner in world frame: PCB origin in world is (wall+cl, wall+cl, ...);
  // active-area is offset by (offsetX, offsetY) within the display's PCB,
  // and the display PCB is offset by `placement.offset` from the host PCB origin.
  const hostBaseX = wall + cl + (placement.offset?.x ?? 0);
  const hostBaseY = wall + cl + (placement.offset?.y ?? 0);
  const aaX = hostBaseX + profile.activeArea.offsetX;
  const aaY = hostBaseY + profile.activeArea.offsetY;

  const subtractive: BuildOp[] = [];
  const additive: BuildOp[] = [];

  if (placement.framing === 'top-window' || placement.framing === 'recessed-bezel') {
    // Cut a rectangular window through the case top equal to the active area.
    const windowZBase = dims.outerZ - params.lidThickness - 1;
    const windowZSpan = params.lidThickness + 2;
    subtractive.push(
      translate(
        [aaX, aaY, windowZBase],
        cube([profile.activeArea.x, profile.activeArea.y, windowZSpan], false),
      ),
    );
  }
  if (placement.framing === 'recessed-bezel') {
    // Carve a shallow pocket sized to PCB outline + small clearance, depth = pcb.z + 0.5.
    const inset = placement.bezelInset ?? 0.4;
    const pocketX = profile.pcb.size.x + 2 * inset;
    const pocketY = profile.pcb.size.y + 2 * inset;
    const pocketZ = profile.pcb.size.z + 0.5;
    const pocketBaseX = hostBaseX - inset;
    const pocketBaseY = hostBaseY - inset;
    const pocketBaseZ = dims.outerZ - pocketZ;
    subtractive.push(
      translate([pocketBaseX, pocketBaseY, pocketBaseZ], cube([pocketX, pocketY, pocketZ + 0.5], false)),
    );
  }
  return { additive, subtractive };
}
