import type { Mm } from './units';
import type { SnapCatch } from './snap';

export type JointType = 'snap-fit' | 'screw-down' | 'flat-lid';
export type InsertType =
  | 'self-tap'
  | 'heat-set-m2.5'
  | 'heat-set-m3'
  | 'pass-through'
  | 'none';
export type VentilationPattern = 'none' | 'slots' | 'hex';

export interface BossesParams {
  enabled: boolean;
  insertType: InsertType;
  outerDiameter: Mm;
  holeDiameter: Mm;
}

export interface VentilationParams {
  enabled: boolean;
  pattern: VentilationPattern;
  coverage: number;
}

export interface CaseParameters {
  wallThickness: Mm;
  floorThickness: Mm;
  lidThickness: Mm;
  cornerRadius: Mm;
  internalClearance: Mm;
  zClearance: Mm;
  joint: JointType;
  /** Recessed-lid mode: lid drops into a pocket at the top of the shell, flush with the rim. */
  lidRecess?: boolean;
  ventilation: VentilationParams;
  bosses: BossesParams;
  /**
   * Optional cantilever snap-fit catches (issue #29). Only consulted when
   * joint === 'snap-fit'; auto-populated by createDefaultProject when the
   * joint is changed to snap-fit.
   */
  snapCatches?: SnapCatch[];
}
