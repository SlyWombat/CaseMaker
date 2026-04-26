import type { Mm } from './units';

export type JointType = 'snap-fit' | 'sliding' | 'screw-down' | 'flat-lid';
export type InsertType = 'self-tap' | 'heat-set-m2.5' | 'heat-set-m3' | 'pass-through';
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
  ventilation: VentilationParams;
  bosses: BossesParams;
}
