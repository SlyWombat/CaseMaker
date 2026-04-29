import type { Mm } from './units';

export type SnapWall = '+x' | '-x' | '+y' | '-y';

/** Issue #69 — barb cross-sections trade off insertion vs. retention force.
 *
 *   hook            — rectangular barb (current). High retention, sloped insertion.
 *   asymmetric-ramp — rectangular barb with the entry corner chamfered. Lower
 *                     insertion force, retention unchanged.
 *   symmetric-ramp  — triangular barb. Insertion ≈ removal force; service-friendly.
 *   half-round      — half-cylinder barb. Smoother strain, lower retention.
 *   ball-socket     — spherical detent against a hemispherical pocket.
 */
export type BarbType = 'hook' | 'asymmetric-ramp' | 'symmetric-ramp' | 'half-round' | 'ball-socket';

export const BARB_TYPES: ReadonlyArray<BarbType> = [
  'hook',
  'asymmetric-ramp',
  'symmetric-ramp',
  'half-round',
  'ball-socket',
];

export interface SnapCatch {
  id: string;
  wall: SnapWall;
  /** Position along the wall (mm from the lower-corner end of that wall). */
  uPosition: Mm;
  enabled: boolean;
  /** Issue #69 — barb cross-section. Default 'hook' matches pre-#69 behavior. */
  barbType?: BarbType;
  /** Issue #69 — advanced overrides (not surfaced in UI v1). */
  insertionRampDeg?: number;
  retentionRampDeg?: number;
}

/**
 * PLA-default cantilever snap-fit dimensions (issue #29). See docs/snap-fit.md
 * for the strain derivation.
 */
export const SNAP_DEFAULTS = {
  // Issue #80 — geometry was broken by the #77 attempt at a "flush rim"
  // lip. The lip sat 0.8 mm below the rim with the barb dangling 5 mm
  // BELOW the lip's catch face, so the snap could never engage —
  // confirmed in print: lid arms hung deep into the cavity with no
  // contact. Re-derive arm + lip dims so the barb top sits flush with
  // the lip's bottom catch face when seated:
  //
  //   lipBottomZ (catch face) = lidPlateBottom - (armLength - barbLength)
  //   → required LIP_HEIGHT = armLength - barbLength
  //
  // armLength chosen to keep strain at the root within PLA's ~5%
  // elastic budget for a 0.8 mm deflection on a 1.6 mm-thick arm:
  //   strain = 1.5 * 0.8 * 1.6 / L^2 ≤ 0.05  →  L ≥ 6.2 mm  →  L = 6 mm.
  // barbLength shortened to 2 mm so the cantilever doesn't dangle as
  // far into the cavity. LIP_HEIGHT then = 6 - 2 = 4 mm.
  armLength: 6,
  armThickness: 1.6,
  armWidth: 6,
  barbProtrusion: 0.8,
  barbLength: 2,
  pocketDepth: 0.8,
  pocketWidth: 7,
  pocketHeight: 4,
} as const;
