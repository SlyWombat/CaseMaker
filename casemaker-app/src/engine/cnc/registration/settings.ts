/**
 * The registration tunables (#430), read from the shop's defaults (`location.json`'s `defaults`,
 * `registration.*`) — never constants in the planner. The maintainer's rule (2026-10-15): "That type
 * of setting should be something we keep in our own database and not compiled in". The values a
 * fresh location is seeded with are the 2026-10-15 bench's own; the labelled fallbacks in
 * `defaultsClient.ts`'s registry are used only with no house service.
 */

import { PARK_CLEARANCE_MM, readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { ProbeSpec } from './plan';

export interface RegistrationSettings {
  /** A touch never goes lower than the surface minus this: the scan's travel cap. */
  capBelowSurfaceMm: number;
  coarseStepMm: number;
  fineStepMm: number;
  /** Where the probe waits between touches: this far above the measured surface. */
  parkAboveSurfaceMm: number;
  /**
   * #1059 — the largest tilt the face-angle step will turn out of a square stock, degrees. A
   * larger reading is a wrong touch or a wrong mounting, so it is refused, never turned.
   */
  faceAngleMaxDeg: number;
  /** A footprint/reference scan starts this far INSIDE the expected edge. */
  scanInsideMm: number;
  /** ...and gives up this far PAST it without finding the edge. */
  scanReachMm: number;
  /**
   * #1133 — the EDGE-FIND BAND: every stock-edge scan spans the expected edge ± this, mm. The
   * maintainer's rule (2026-11-09): "if it was looking for the edge, it should not have been near
   * the holes." The band is the stock's own size error, the mount's repeat (0.05 mm) and fit
   * (0.1 mm), plus margin: an edge find approaches from OUTSIDE the stock and stops at the first
   * touch, and never walks inward over the stock where bores, pockets and clamps are.
   */
  edgeBandMm: number;
  /** #1199 field 7 — the least a probe top touch's footprint is shrunk below the blank outline. */
  probeFootprintShrinkMm?: number;
  /** #1199 field 7 — a cutter's region grows beyond the blank's outline by its radius plus this. */
  cutterFootprintGrowMm?: number;
  /** #1199 field 7 — each hold's own placement uncertainty, in mm (analyst 2026-11-11). */
  visePlacementAcrossJawsMm?: number;
  visePlacementAlongJawsMm?: number;
  tapePlacementMm?: number;
  tapePlacementRotationDeg?: number;
  /** #1199 field 7 — the bracket's own fit (its placement uncertainty), from `bracket.fitMm`. */
  bracketFitMm?: number;
  /**
   * #1199 field 7 (e) — THE BED-SETUP JAW TAP (the only place a jaw is touched now): how far below
   * the stored jaw top its search may go, mm. Touched by the move to setup mode, so a shop key
   * (#1207), not a constant. OPTIONAL on a plan stored before the key existed; the bed-setup tap
   * reads it from fresh settings, and a job never uses it.
   */
  mountTapFloorMm?: number;
  /**
   * #1199 field 7 (e) — how far from the stored jaw top a bed-setup reading may land before the run
   * SAYS it moved (the datum is still refreshed; the words this far apart are worth reading).
   */
  mountTapSlackMm?: number;
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
   * #1179 B — how far apart two surface readings may be and still AGREE on a blank that has been
   * cut, mm (the analyst's 0.1): a cut floor, an old hole or a chip cannot agree with the real top
   * to this. At most the surface tolerance — an out-of-band pair is refused anyway. OPTIONAL on a
   * plan stored before the key existed; {@link CUT_BLANK_AGREE_FALLBACK_MM} answers then.
   */
  cutBlankAgreeMm?: number;
  /**
   * #1179 amendment (2026-11-10) — a check reading ABOVE the band is a reading (something lying on
   * the blank: chips, a burr) up to this far above the band's ceiling; the run records it and moves
   * on. Beyond it, it is a clamp or a fixture and still stops. OPTIONAL on an older stored plan;
   * {@link CUT_BLANK_ABOVE_BAND_FALLBACK_MM} answers then.
   */
  cutBlankAboveBandMm?: number;
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

/**
 * #1179 B — the agreement an old stored plan without `cutBlankAgreeMm` falls back to, mm. The shop
 * key's own labelled fallback (`defaultsClient.ts`) is the same number; a NEW plan always carries
 * the shop's value, and only a plan approved before the key existed reads this.
 */
export const CUT_BLANK_AGREE_FALLBACK_MM = 0.1;

/**
 * #1179 amendment — the labelled fallback for the above-band limit, mm: an older stored plan has no
 * key; the shop's own default (`registration.cutBlankAboveBandMm`) is the same number.
 */
export const CUT_BLANK_ABOVE_BAND_FALLBACK_MM = 5;

/** The lift between the fast and the slow surface touch (`G0 Z1`), mm. Compiled: the sequence's own. */
export const SURFACE_LIFT_MM = 1;
/** The furthest the slow surface touch may go past the fast touch's reading, mm (#449 review). Compiled. */
export const SLOW_SEEK_PAST_HIT_MAX_MM = 1;

const KEYS: Record<keyof RegistrationSettings, string> = {
  capBelowSurfaceMm: 'registration.capBelowSurfaceMm',
  coarseStepMm: 'registration.coarseStepMm',
  fineStepMm: 'registration.fineStepMm',
  parkAboveSurfaceMm: 'registration.parkAboveSurfaceMm',
  faceAngleMaxDeg: 'registration.faceAngleMaxDeg',
  scanInsideMm: 'registration.scanInsideMm',
  scanReachMm: 'registration.scanReachMm',
  edgeBandMm: 'registration.edgeBandMm',
  probeFootprintShrinkMm: 'registration.probeFootprintShrinkMm',
  cutterFootprintGrowMm: 'registration.cutterFootprintGrowMm',
  visePlacementAcrossJawsMm: 'registration.vise.placementAcrossJawsMm',
  visePlacementAlongJawsMm: 'registration.vise.placementAlongJawsMm',
  tapePlacementMm: 'registration.tape.placementMm',
  tapePlacementRotationDeg: 'registration.tape.placementRotationDeg',
  bracketFitMm: 'bracket.fitMm',
  mountTapFloorMm: 'registration.mountTapFloorMm',
  mountTapSlackMm: 'registration.mountTapSlackMm',
  cornerClearanceMm: 'registration.cornerClearanceMm',
  surfaceBandMm: 'registration.surfaceBandMm',
  tipRadiusMm: 'registration.tipRadiusMm',
  tipRadiusUncertaintyMm: 'registration.tipRadiusUncertaintyMm',
  tipDiameterMm: 'registration.tipDiameterMm',
  surfaceToleranceMm: 'registration.surfaceToleranceMm',
  cutBlankAgreeMm: 'registration.cutBlankAgreeMm',
  cutBlankAboveBandMm: 'registration.cutBlankAboveBandMm',
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
export function registrationSettings(defaults: ShopDefaults | null, probe?: ProbeSpec | null): {
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
  // #598 — a checked-out probe resolves the tip/rim values from the instrument, not the shop fallback.
  // The shop keys stay the no-probe fallback (unchanged), and `fallbacks` still reports them.
  // #525 — an UNMEASURED probe (tip null) resolves nothing: the planner refuses the plan, and using
  // the shop's wired-probe numbers here would hand it a plausible-looking radius that is not this
  // instrument's.
  if (probe != null && probe.tip !== null) {
    settings.tipDiameterMm = probe.tip.diameterMm;
    settings.tipRadiusMm = probe.tip.rimOffsetMm;
    settings.tipRadiusUncertaintyMm = probe.tip.rimOffsetUncertaintyMm;
  }
  return { settings, fallbacks };
}

/** Why these settings cannot plan a safe scan, or null. The bounds of each are `defaults.rs`'s. */
export function settingsProblem(s: RegistrationSettings): string | null {
  if (!(s.surfaceBandMm < s.capBelowSurfaceMm)) {
    return `the surface band (${s.surfaceBandMm} mm) must be less than the touch cap (${s.capBelowSurfaceMm} mm)`;
  }
  if (s.fineStepMm > s.coarseStepMm) return 'the fine step is coarser than the coarse step';
  // #1133 — a scan with no band would start exactly on the expected edge: no span to seek in.
  if (!(s.edgeBandMm > 0)) return 'the edge-find band must be above 0 mm';
  // #1199 field 7 — a plan (or a caller) without the hold's figures cannot be run or planned: the
  // executors and planner refuse rather than assume a value.
  for (const [key, v] of [
    ['registration.probeFootprintShrinkMm', s.probeFootprintShrinkMm],
    ['registration.cutterFootprintGrowMm', s.cutterFootprintGrowMm],
    ['registration.vise.placementAcrossJawsMm', s.visePlacementAcrossJawsMm],
    ['registration.vise.placementAlongJawsMm', s.visePlacementAlongJawsMm],
    ['registration.tape.placementMm', s.tapePlacementMm],
    ['registration.tape.placementRotationDeg', s.tapePlacementRotationDeg],
    ['bracket.fitMm', s.bracketFitMm],
  ] as const) {
    if (v === undefined || !(v >= 0)) return `${key} is not stated (or is below 0) — the hold’s figures are required`;
  }
  // #1199 field 7 (e) — the bed-setup jaw tap's own two figures (#1207 keys). Optional so a plan
  // stored before them still loads; when stated they must be usable.
  if (s.mountTapFloorMm !== undefined && !(s.mountTapFloorMm > 0)) return 'the jaw tap’s search floor must be above 0 mm';
  if (s.mountTapSlackMm !== undefined && !(s.mountTapSlackMm >= 0)) return 'the jaw tap’s slack must be 0 mm or more';
  if (s.parkAboveSurfaceMm < 2) return 'the park height must be at least 2 mm above the surface';
  // #1059 — a zero limit would refuse every face-angle turn; the bound is `defaults.rs`'s.
  if (!(s.faceAngleMaxDeg > 0)) return 'the face-angle limit must be above 0°';
  // #1179 B — an agreement wider than the band would accept a reading the band already refuses,
  // and a zero agreement could never pass two touches.
  if (
    s.cutBlankAgreeMm !== undefined &&
    (!(s.cutBlankAgreeMm > 0) || s.cutBlankAgreeMm > s.surfaceToleranceMm)
  ) {
    return `the cut-blank agreement (${s.cutBlankAgreeMm} mm) must be above 0 and at most the surface tolerance (${s.surfaceToleranceMm} mm)`;
  }
  // #1179 amendment — a non-positive limit would turn every above-band reading into a stop,
  // including the chips the amendment exists for.
  if (s.cutBlankAboveBandMm !== undefined && !(s.cutBlankAboveBandMm > 0)) {
    return 'the cut-blank above-band limit must be above 0 mm';
  }
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
