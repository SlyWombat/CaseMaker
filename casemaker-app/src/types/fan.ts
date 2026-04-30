import type { Mm } from './units';

export type FanSize = '30x30x10' | '40x40x10' | '40x40x20' | '50x50x10' | '60x60x15';
export type FanGrille = 'cross' | 'spiral' | 'honeycomb' | 'concentric' | 'open';

import type { CaseFace } from './case';
export type { CaseFace };

export interface FanSpec {
  size: FanSize;
  faceMm: Mm;            // square face dimension
  depthMm: Mm;
  screwSpacingMm: Mm;    // center-to-center for the 4 mounting screws
  screwHoleMm: Mm;       // diameter for M3 self-tap is typical
  bladeRadiusMm: Mm;     // approximate blade-tip radius
}

export const FAN_SPECS: Record<FanSize, FanSpec> = {
  '30x30x10': { size: '30x30x10', faceMm: 30, depthMm: 10, screwSpacingMm: 24, screwHoleMm: 3.2, bladeRadiusMm: 13 },
  '40x40x10': { size: '40x40x10', faceMm: 40, depthMm: 10, screwSpacingMm: 32, screwHoleMm: 3.2, bladeRadiusMm: 18 },
  '40x40x20': { size: '40x40x20', faceMm: 40, depthMm: 20, screwSpacingMm: 32, screwHoleMm: 3.2, bladeRadiusMm: 18 },
  '50x50x10': { size: '50x50x10', faceMm: 50, depthMm: 10, screwSpacingMm: 40, screwHoleMm: 3.2, bladeRadiusMm: 23 },
  '60x60x15': { size: '60x60x15', faceMm: 60, depthMm: 15, screwSpacingMm: 50, screwHoleMm: 3.2, bladeRadiusMm: 28 },
};

export interface FanMount {
  id: string;
  size: FanSize;
  face: CaseFace;
  position: { u: Mm; v: Mm };
  grille: FanGrille;
  /** mm gap between blade and grille bars (finger safety). */
  bladeStandoff: Mm;
  /** Whether to add 4 mounting bosses for screwing the fan to the case. */
  bossesEnabled: boolean;
  enabled: boolean;
}
