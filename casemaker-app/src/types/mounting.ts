import type { Mm } from './units';

export type MountingFeatureType =
  | 'screw-tab'
  | 'zip-tie-slot'
  | 'vesa-mount';

import type { CaseFace } from './case';
export type { CaseFace };

export interface MountingFeatureParams {
  [key: string]: number | string;
}

export interface MountingFeature {
  id: string;
  type: MountingFeatureType;
  face: CaseFace;
  /** Position in the face's local 2D frame (u along primary, v along secondary). */
  position: { u: Mm; v: Mm };
  /** 0/90/180/270 typical. */
  rotation: number;
  params: MountingFeatureParams;
  enabled: boolean;
  presetId?: string;
}
