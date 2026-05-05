import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cavityOriginXY } from '@/engine/coords';
import { cube, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

// Issue #53 — DisplayFootprint + computeDisplayFootprint deleted. They were
// never wired into the compile pipeline (computeShellDims uses host PCB
// dims only) and gave a misleading impression that the engine handled
// display-bigger-than-host correctly. The real-world gap (e.g. Pi 7" Touch
// on a Pi 4B) is tracked separately as a follow-up issue. Until that's
// implemented we shouldn't carry unused public API.

/**
 * Build the window cutout in the case top for the display's active area.
 * Supported framings in this slice: 'top-window' and 'recessed-bezel'.
 */
export function buildDisplayCutoutOps(
  board: BoardProfile,
  params: CaseParameters,
  placement: DisplayPlacement | null | undefined,
  resolveDisplay: (id: string) => DisplayProfile | undefined,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): { additive: BuildOp[]; subtractive: BuildOp[] } {
  if (!placement || !placement.enabled) return { additive: [], subtractive: [] };
  const profile = resolveDisplay(placement.displayId);
  if (!profile) return { additive: [], subtractive: [] };
  const dims = computeShellDims(board, params, hats, resolveHat);
  const origin = cavityOriginXY(params);

  // Active-area corner in world frame: PCB origin in world comes from
  // cavityOriginXY (already accounting for any per-side clearance tweaks);
  // active-area is offset by (offsetX, offsetY) within the display's PCB,
  // and the display PCB is offset by `placement.offset` from the host PCB origin.
  const hostBaseX = origin.x + (placement.offset?.x ?? 0);
  const hostBaseY = origin.y + (placement.offset?.y ?? 0);
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
