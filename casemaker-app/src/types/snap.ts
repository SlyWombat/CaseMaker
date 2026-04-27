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
  armLength: 12,
  armThickness: 1.6,
  armWidth: 5,
  barbProtrusion: 0.8,
  barbLength: 4,
  pocketDepth: 1.0,
  pocketWidth: 6,
  pocketHeight: 5,
} as const;
