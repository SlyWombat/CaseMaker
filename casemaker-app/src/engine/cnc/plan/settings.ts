/**
 * The run plan's phase times (#421, §5.8), from the shop's defaults (`plan.*` in `location.json`) —
 * never constants in the planner (the maintainer's rule, 2026-10-15: "That type of setting should be
 * something we keep in our own database and not compiled in"). The remount and the re-registration
 * after it are the setups planner's own keys (`setups.remountMinutes`, `setups.reregisterMinutes`,
 * #428) and are read through it, not restated here.
 *
 * EVERY TIME CARRIES ITS SOURCE. A stored default says whether it was measured (dated, with a note:
 * `$H`, `M491` and one probe touch were timed in the 2026-10-15 console trace), seeded or chosen; a
 * value read with no location is the build's labelled FALLBACK, and is never shown as anything else.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';

/** Where a phase time came from — what the plan view prints beside every number. */
export type TimeSource = 'measured' | 'chosen' | 'fallback' | 'estimated';

/** A number with its provenance. */
export interface Sourced {
  value: number;
  source: TimeSource;
  /** The shop default's key it was read from. */
  key: string;
}

export interface PlanSettings {
  /** `$H`, seconds. */
  homeSeconds: Sourced;
  /** `M491` — the tool-length touch, seconds. */
  toolLengthSeconds: Sourced;
  /** One registration touch (a probe step), seconds. */
  touchSeconds: Sourced;
  /** Fitting the wired probe by hand, seconds. */
  fitProbeSeconds: Sourced;
  /** Fitting a cutter by hand, seconds. */
  fitCutterSeconds: Sourced;
  /** Vacuum off and the clearance move after a cut, seconds. */
  clearanceSeconds: Sourced;
  /** The end of the job: `M332`, spindle off, `G28`, `M370` when a grid was set, seconds. */
  finishSeconds: Sourced;
  /** The auto-level grid's point count (Studio's own default is 3 × 3). */
  autoLevelPoints: Sourced;
  /** One auto-level point, seconds. */
  autoLevelPointSeconds: Sourced;
  /** A cut shallower than this on stock not known flat wants a grid (Studio's own rule), mm. */
  autoLevelShallowMm: Sourced;
  /** The remount between setups, seconds (`setups.remountMinutes`). */
  remountSeconds: Sourced;
  /** Re-registering with no registration plan to count touches from, seconds (`setups.reregisterMinutes`). */
  reregisterSeconds: Sourced;
}

const KEYS: Record<Exclude<keyof PlanSettings, 'remountSeconds' | 'reregisterSeconds'>, string> = {
  homeSeconds: 'plan.homeSeconds',
  toolLengthSeconds: 'plan.toolLengthSeconds',
  touchSeconds: 'plan.touchSeconds',
  fitProbeSeconds: 'plan.fitProbeSeconds',
  fitCutterSeconds: 'plan.fitCutterSeconds',
  clearanceSeconds: 'plan.clearanceSeconds',
  finishSeconds: 'plan.finishSeconds',
  autoLevelPoints: 'plan.autoLevelPoints',
  autoLevelPointSeconds: 'plan.autoLevelPointSeconds',
  autoLevelShallowMm: 'plan.autoLevelShallowMm',
};

/** A stored default's source as a phase reads it: seeded and chosen are both somebody's choice. */
export function timeSourceOf(source: 'seeded' | 'chosen' | 'measured' | 'fallback'): TimeSource {
  return source === 'measured' ? 'measured' : source === 'fallback' ? 'fallback' : 'chosen';
}

function read(defaults: ShopDefaults | null, key: string, scale = 1): Sourced {
  const d = readDefault(defaults, key);
  return { value: d.value * scale, source: timeSourceOf(d.source), key };
}

export function planSettings(defaults: ShopDefaults | null): PlanSettings {
  const out = {} as PlanSettings;
  for (const [field, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) out[field] = read(defaults, key);
  // The setups planner's own keys (#428), in minutes there.
  out.remountSeconds = read(defaults, 'setups.remountMinutes', 60);
  out.reregisterSeconds = read(defaults, 'setups.reregisterMinutes', 60);
  return out;
}

/** The keys that were build fallbacks (no location to read them from). */
export function planFallbacks(s: PlanSettings): string[] {
  return Object.values(s)
    .filter((v) => v.source === 'fallback')
    .map((v) => v.key);
}
