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
  // Issue #76 — printable defaults, sized to two perimeters of 0.4 mm
  // extrusion (= 0.8 mm wall) so the lip and barb don't have major
  // overhangs to print without supports. The slope on the lip's top
  // (issue #75) at 45° (lipHeight = barbProtrusion) prints clean on
  // typical FDM at 0.2 mm layers without bridging. Strain at the arm
  // root for 0.8 mm deflection on a 12 mm arm = 0.7 %, well within
  // PLA's ~5 % elastic budget.
  armLength: 12,
  armThickness: 1.6,
  armWidth: 6,
  barbProtrusion: 0.8,
  barbLength: 3,
  pocketDepth: 0.8,
  pocketWidth: 7,
  pocketHeight: 4,
} as const;
