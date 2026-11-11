/**
 * #1222 (planner v3 B4) — THE ROTARY MODULE'S LIMITS, in one place. Five numbers that were
 * constants in the code are shop settings now; this module resolves them from the defaults map,
 * records where each came from, and hands the values to the verifier, the generators and both
 * simulators. With the settings at their recommended values nothing changes.
 */
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { SettingRead } from '@/engine/cnc/mounts/bracket';

/** The rotary module's limits, as the shop states them. */
export interface RotaryLimits {
  jawKeepOutMm: number;
  tailstockBandMm: number;
  turnClearanceMm: number;
  tailstockCentreMm: number;
  tailstockBodyMm: number;
  tailstockHousingRadiusMm: number;
}

export interface RotaryLimitsRead {
  limits: RotaryLimits;
  /** Each number with where it came from. */
  read: SettingRead[];
  /** The keys that are not a measurement (seeded or a fallback). */
  unmeasured: string[];
}

const KEYS = {
  jawKeepOutMm: 'rotary.jawKeepOutMm',
  tailstockBandMm: 'rotary.tailstockBandMm',
  turnClearanceMm: 'rotary.turnClearanceMm',
  tailstockCentreMm: 'rotary.tailstockCentreMm',
  tailstockBodyMm: 'rotary.tailstockBodyMm',
  tailstockHousingRadiusMm: 'rotary.tailstockHousingRadiusMm',
} as const;

export function rotaryLimits(map: ShopDefaults | null): RotaryLimitsRead {
  const read: SettingRead[] = [];
  const v = (key: string): number => {
    const d = readDefault(map, key);
    read.push({ key, value: d.value, source: d.source, note: map?.[key]?.note ?? null });
    return d.value;
  };
  const limits: RotaryLimits = {
    jawKeepOutMm: v(KEYS.jawKeepOutMm),
    tailstockBandMm: v(KEYS.tailstockBandMm),
    turnClearanceMm: v(KEYS.turnClearanceMm),
    tailstockCentreMm: v(KEYS.tailstockCentreMm),
    tailstockBodyMm: v(KEYS.tailstockBodyMm),
    tailstockHousingRadiusMm: v(KEYS.tailstockHousingRadiusMm),
  };
  return { limits, read, unmeasured: read.filter((r) => r.source !== 'measured').map((r) => r.key) };
}
