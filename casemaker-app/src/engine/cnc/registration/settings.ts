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
  /** The rim offset's own spread, ± mm (measured with it): it cancels in a centre, doubles in a width (#429). */
  tipRadiusUncertaintyMm: number;
  /** The tip's outside diameter, mm: an opening narrower than this cannot be entered at all (#429). */
  tipDiameterMm: number;
  /** How far the stock may sit from where the job expects it before the plan says so. */
  edgeMarginMm: number;
  /** The longest the surface touch may ever travel — a ceiling on the seek the plan computes. */
  surfaceSeekMm: number;
  /** How far the surface may sit from where the job expects it; the seek only travels this band. */
  surfaceToleranceMm: number;
  /**
   * #475 — how many surface touches the cut regions' extents get, beyond the registration-point
   * touch. At least 5, so the centre and both extents on each axis are read; seeded 5.
   */
  surfaceTouchCount: number;
  touchFeed: number;
  surfaceFastFeed: number;
  surfaceSlowFeed: number;
  /**
   * #449 — how far the SLOW surface touch may travel. It starts {@link SURFACE_LIFT_MM} above the fast
   * touch's hit, so it must travel further than that to reach the surface again; the rule keeps it
   * small, so the touch stays capped.
   */
  surfaceSlowSeekMm: number;
  /** #449 — how many `?` polls wait for Idle before a touch; each is a round trip of about a second. */
  idlePollLimit: number;
  /** #449/#452 — the run sheet's down-touch scan: how far past the jaw tops a touch may travel. */
  scanMissMarginMm: number;
  /** #449/#452 — the depth two touch readings are told apart by (the dial). */
  readingResolutionMm: number;
}

/** The lift between the fast and the slow surface touch (`G0 Z1`), mm. Compiled: the sequence's own. */
export const SURFACE_LIFT_MM = 1;
/** The furthest the slow surface touch may go past the fast touch's reading, mm (#449 review). Compiled. */
export const SLOW_SEEK_PAST_HIT_MAX_MM = 1;

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
  tipRadiusUncertaintyMm: 'registration.tipRadiusUncertaintyMm',
  tipDiameterMm: 'registration.tipDiameterMm',
  surfaceToleranceMm: 'registration.surfaceToleranceMm',
  surfaceTouchCount: 'registration.surfaceTouchCount',
  edgeMarginMm: 'registration.edgeMarginMm',
  surfaceSeekMm: 'registration.surfaceSeekMm',
  touchFeed: 'registration.touchFeed',
  surfaceFastFeed: 'registration.surfaceFastFeed',
  surfaceSlowFeed: 'registration.surfaceSlowFeed',
  surfaceSlowSeekMm: 'registration.surfaceSlowSeekMm',
  idlePollLimit: 'registration.idlePollLimit',
  scanMissMarginMm: 'registration.scanMissMarginMm',
  readingResolutionMm: 'registration.readingResolutionMm',
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
  // #449 — the slow touch starts SURFACE_LIFT_MM above the fast hit: travelling no further than that, it
  // can never reach the surface again. How far it may go PAST the hit is held to SLOW_SEEK_PAST_HIT_MAX_MM (the key: 2 mm at
  // most, so at most 1 mm past), and both readings must still land in the surface band (`execute.ts`).
  if (!(s.surfaceSlowSeekMm > SURFACE_LIFT_MM)) {
    return `the slow surface touch (${s.surfaceSlowSeekMm} mm) must travel more than the ${SURFACE_LIFT_MM} mm lift before it`;
  }
  if (s.surfaceSlowSeekMm > SURFACE_LIFT_MM + SLOW_SEEK_PAST_HIT_MAX_MM) {
    return `the slow surface touch (${s.surfaceSlowSeekMm} mm) may go more than ${SLOW_SEEK_PAST_HIT_MAX_MM} mm past the fast touch's reading`;
  }
  if (!Number.isInteger(s.idlePollLimit) || s.idlePollLimit < 1) return 'the Idle poll limit must be a whole number of polls, at least 1';
  // #475 — five is the floor, not a preference: a centre plus both extents on each axis is the
  // smallest set that can see a bow in either direction.
  if (!Number.isInteger(s.surfaceTouchCount) || s.surfaceTouchCount < 5) {
    return 'the surface touch count must be a whole number, at least 5';
  }
  return null;
}
