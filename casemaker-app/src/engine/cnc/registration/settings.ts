/**
 * The registration tunables (#430), read from the shop's defaults (`location.json`'s `defaults`,
 * `registration.*`) — never constants in the planner. The maintainer's rule (2026-10-15): "That type
 * of setting should be something we keep in our own database and not compiled in". The values a
 * fresh location is seeded with are the 2026-10-15 bench's own; the labelled fallbacks in
 * `defaultsClient.ts`'s registry are used only with no house service.
 */

import { PARK_CLEARANCE_MM, readDefault, type ShopDefaults } from '@/platform/defaultsClient';

export interface RegistrationSettings {
  /** A touch never goes lower than the surface minus this: the scan's travel cap. */
  capBelowSurfaceMm: number;
  coarseStepMm: number;
  fineStepMm: number;
  /** Where the probe waits between touches: this far above the measured surface. */
  parkAboveSurfaceMm: number;
  /** A scan starts this far INSIDE the expected edge. */
  scanInsideMm: number;
  /** ...and gives up this far PAST it without finding the edge. */
  scanReachMm: number;
  /** A scan point stays this far beyond a rounded corner's radius from the corner. */
  cornerClearanceMm: number;
  /** A hit within this of the surface reads as "on the stock"; lower is off it (a jaw, the roll-off). */
  surfaceBandMm: number;
  /**
   * The rim reads stock until its CENTRE is this far past the edge — the EFFECTIVE contact offset,
   * measured on the bench 2026-10-15 (0.70 ± 0.25: the 38.1 mm blank read 39.5 mm wide), not the
   * tip's 1.0 mm radius. The location's note says how.
   */
  tipRadiusMm: number;
  /** How far the stock may sit from where the job expects it before the plan says so. */
  edgeMarginMm: number;
  /** The longest the surface touch may ever travel — a ceiling on the seek the plan computes. */
  surfaceSeekMm: number;
  /** How far the surface may sit from where the job expects it; the seek only travels this band. */
  surfaceToleranceMm: number;
  touchFeed: number;
  surfaceFastFeed: number;
  surfaceSlowFeed: number;
}

const KEYS: Record<keyof RegistrationSettings, string> = {
  capBelowSurfaceMm: 'registration.capBelowSurfaceMm',
  coarseStepMm: 'registration.coarseStepMm',
  fineStepMm: 'registration.fineStepMm',
  parkAboveSurfaceMm: 'registration.parkAboveSurfaceMm',
  scanInsideMm: 'registration.scanInsideMm',
  scanReachMm: 'registration.scanReachMm',
  cornerClearanceMm: 'registration.cornerClearanceMm',
  surfaceBandMm: 'registration.surfaceBandMm',
  tipRadiusMm: 'registration.tipRadiusMm',
  surfaceToleranceMm: 'registration.surfaceToleranceMm',
  edgeMarginMm: 'registration.edgeMarginMm',
  surfaceSeekMm: 'registration.surfaceSeekMm',
  touchFeed: 'registration.touchFeed',
  surfaceFastFeed: 'registration.surfaceFastFeed',
  surfaceSlowFeed: 'registration.surfaceSlowFeed',
};

/** The settings, and which of them are fallbacks (there was no location to read them from). */
export function registrationSettings(defaults: ShopDefaults | null): {
  settings: RegistrationSettings;
  fallbacks: string[];
} {
  const settings = {} as RegistrationSettings;
  const fallbacks: string[] = [];
  for (const [field, key] of Object.entries(KEYS) as [keyof RegistrationSettings, string][]) {
    const d = readDefault(defaults, key);
    settings[field] = d.value;
    if (d.source === 'fallback') fallbacks.push(key);
  }
  return { settings, fallbacks };
}

/** Why these settings cannot plan a safe scan, or null. The bounds of each are `defaults.rs`'s. */
export function settingsProblem(s: RegistrationSettings): string | null {
  if (!(s.surfaceBandMm < s.capBelowSurfaceMm)) {
    return `the surface band (${s.surfaceBandMm} mm) must be less than the touch cap (${s.capBelowSurfaceMm} mm)`;
  }
  if (s.fineStepMm > s.coarseStepMm) return 'the fine step is coarser than the coarse step';
  if (s.parkAboveSurfaceMm < 2) return 'the park height must be at least 2 mm above the surface';
  if (s.surfaceToleranceMm >= s.parkAboveSurfaceMm - PARK_CLEARANCE_MM) {
    return `the surface tolerance (${s.surfaceToleranceMm} mm) must be less than the park height (${s.parkAboveSurfaceMm} mm) less ${PARK_CLEARANCE_MM}`;
  }
  return null;
}
