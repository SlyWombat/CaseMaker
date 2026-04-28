import type { Mm } from './units';

export type SnapWall = '+x' | '-x' | '+y' | '-y';

export interface SnapCatch {
  id: string;
  wall: SnapWall;
  /** Position along the wall (mm from the lower-corner end of that wall). */
  uPosition: Mm;
  enabled: boolean;
}

/**
 * PLA-default cantilever snap-fit dimensions (issue #29). See docs/snap-fit.md
 * for the strain derivation.
 */
export const SNAP_DEFAULTS = {
  // Issue #73 — bumped from anemic defaults (0.8 mm barb / 1 mm lip) so the
  // features are both visually obvious in the viewport and have enough
  // engagement to actually retain on PLA. Strain at the arm root for a
  // 1.5 mm deflection on a 12 mm arm = ~2 %, well within PLA's elastic
  // budget (~5 % yield).
  armLength: 12,
  armThickness: 2.0,
  armWidth: 6,
  barbProtrusion: 1.5,
  barbLength: 4,
  pocketDepth: 1.5,
  pocketWidth: 8,
  pocketHeight: 5,
} as const;
