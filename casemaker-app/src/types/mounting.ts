import type { Mm } from './units';

/**
 * Issue #80 — every mounting feature is either EXTERNAL (case-to-surface,
 * extends past the case envelope) or INTERNAL (case-to-board, stays inside
 * the cavity). UI groups by class; geometry generators key off it for
 * collision rules (external must extrude OUT, internal must NOT).
 */
export type MountClass = 'external' | 'internal';

export type MountingFeatureType =
  // External — extend past the case envelope.
  | 'screw-tab'         // legacy plain-tab style (kept for compat)
  | 'end-flange'        // rounded + ribbed Hammond-style screw-down flange (#80)
  | 'zip-tie-slot'
  | 'vesa-mount'
  | 'extrusion-mount'   // bolt holes for a T-nut in 20-series T-slot extrusion (#151)
  // Internal — board-side fixturing.
  | 'aligned-standoff'  // post on the inside floor at a board mount-hole xy (#80)
  | 'saddle';           // pinch-style cradle ridge (#80)

import type { CaseFace } from './case';
export type { CaseFace };

export interface MountingFeatureParams {
  [key: string]: number | string;
}

export interface MountingFeature {
  id: string;
  type: MountingFeatureType;
  /**
   * Issue #80 — required at runtime; the schema migrates legacy v5 entries
   * to 'external'. Generators ignore `face` for internal mounts (they live
   * on the cavity floor, not on a face plane).
   */
  mountClass: MountClass;
  face: CaseFace;
  /** Position in the face's local 2D frame (u along primary, v along secondary). */
  position: { u: Mm; v: Mm };
  /** 0/90/180/270 typical. */
  rotation: number;
  params: MountingFeatureParams;
  enabled: boolean;
  presetId?: string;
}
