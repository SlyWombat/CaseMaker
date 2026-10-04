/**
 * Feeds and speeds — the one place every cutting parameter comes from (#202).
 *
 * V1 ships a short HARDCODED table of conservative starting values. Nothing in it has been
 * measured on this machine, and it says so: every row is `status: 'unmeasured'`. Makera's own
 * table (`t_MakeraCutterProperties`, 1 328 rows) lives in a SQLite file the web build cannot
 * read (#181), and 32 of its rows specify a spindle speed above the Z1's 13 000 RPM ceiling
 * anyway (#184, and clampToMachine refuses or clamps those). #209 replaces these rows with
 * what the first cut shows.
 *
 * What the starting values rest on (`/Fabrication.md` §1):
 *   - The Z1's limits: 13 000 RPM, 1 200 mm/min cutting feed, a 150 W spindle.
 *   - What Makera Studio itself emits for this machine — `S12000`, cutting `F500`, plunge
 *     `F200` — in the one Z1-generated sample we have (`Z1/TopClamp.nc`, an aluminium job, so
 *     for wood these are slow, which is the safe direction).
 *   - #191's measured rule: contour-parallel step-over must not exceed the tool RADIUS, or an
 *     uncut spine is left down the middle of a stroke.
 *
 * Two refusals rather than approximations:
 *   - A cutter not covered by any row is REFUSED. Never extrapolate.
 *   - A step-over larger than the radius is REFUSED, even by override. An override that leaves
 *     uncut material is a mistake the user must see, not something to clamp silently (#191).
 */

import { cuttingRadiusForSweep } from './tool';
import type { Tool } from './tool';
import { clampToMachine } from './machine';
import type { ClampDiagnostic, MachineProfile } from './machine';
import type { StockMaterial } from '@/types/engraveJob';

export interface CutParams {
  rpm: number;
  feed: number; // mm/min, XY cutting
  plungeFeed: number; // mm/min, Z-
  stepDown: number; // mm per depth pass
  stepOver: number; // mm between contour-parallel loops
  /** M7. */
  air: boolean;
}

export interface FeedsEntry {
  material: StockMaterial;
  /** Applies to flat end mills with cutting diameter in [minDiameter, maxDiameter], mm. */
  minDiameter: number;
  maxDiameter: number;
  /** `stepOverFraction` is a fraction of the cutter DIAMETER, resolved in `feedsFor`. */
  params: Omit<CutParams, 'stepOver'> & { stepOverFraction: number };
  status: 'unmeasured' | 'measured';
  provenance: string;
}

const PROVENANCE =
  'Starting value. rpm/feed/plunge are what Makera Studio emits for the Z1 (TopClamp.nc: S12000, F500, F200); step-down is a conservative guess for a 150 W spindle. Replace from #209.';

/**
 * The V1 table. Every row `unmeasured`. The PLA row is a placeholder for #165, which measures
 * the real one; the softwood/hardwood/MDF step-downs are conservative guesses for a 150 W
 * spindle, not measurements.
 *
 * Range tests are INCLUSIVE at both ends, so a diameter exactly on a shared boundary takes the
 * first matching row (the smaller cutter). 3.175 mm — the shank every sample tool uses — falls
 * in the 1.6-3.2 mm row.
 */
export const FEEDS_TABLE: readonly FeedsEntry[] = [
  {
    material: 'softwood',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'softwood',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1.0, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'hardwood',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 400, plungeFeed: 150, stepDown: 0.3, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'hardwood',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 400, plungeFeed: 150, stepDown: 0.6, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'mdf',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'mdf',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1.0, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'pla',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.3, stepOverFraction: 0.45, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
];

export type FeedsResult =
  | { ok: true; params: CutParams; entry: FeedsEntry; diagnostics: ClampDiagnostic[] }
  | { ok: false; reason: string };

/**
 * Resolve the cutting parameters for a material and a tool, or refuse with a reason.
 *
 * The tool must be one `cuttingRadiusForSweep` accepts — a plain flat end mill — because V1
 * sweeps nothing else (`tool.ts`). The cutter's diameter selects a row; no row means no cut.
 * `override` is applied field by field on top of the row, and then the machine's ceilings are
 * the last word: a modest overage is clamped with a diagnostic, a gross one is refused.
 */
export function feedsFor(
  material: StockMaterial,
  tool: Tool,
  machine: MachineProfile,
  override?: Partial<CutParams>,
): FeedsResult {
  const radius = cuttingRadiusForSweep(tool);
  if (!radius.ok) return { ok: false, reason: radius.reason };
  const diameter = radius.radius * 2;

  const entry = FEEDS_TABLE.find(
    (e) => e.material === material && diameter >= e.minDiameter && diameter <= e.maxDiameter,
  );
  if (!entry) {
    return { ok: false, reason: `no cutting parameters for a ${diameter} mm cutter in ${material}` };
  }

  const params: CutParams = {
    rpm: entry.params.rpm,
    feed: entry.params.feed,
    plungeFeed: entry.params.plungeFeed,
    stepDown: entry.params.stepDown,
    stepOver: entry.params.stepOverFraction * diameter,
    air: entry.params.air,
  };

  if (override) {
    if (override.rpm !== undefined) params.rpm = override.rpm;
    if (override.feed !== undefined) params.feed = override.feed;
    if (override.plungeFeed !== undefined) params.plungeFeed = override.plungeFeed;
    if (override.stepDown !== undefined) params.stepDown = override.stepDown;
    if (override.stepOver !== undefined) params.stepOver = override.stepOver;
    if (override.air !== undefined) params.air = override.air;
  }

  // #191: contour-parallel loops further apart than the radius leave an uncut spine. Refuse,
  // never clamp silently.
  if (params.stepOver > radius.radius) {
    return {
      ok: false,
      reason: `step-over ${params.stepOver} mm exceeds the ${radius.radius} mm radius of the ${diameter} mm cutter: contour-parallel loops would leave an uncut spine (#191), and an override that leaves material is refused rather than clamped`,
    };
  }

  if (params.stepDown <= 0) return { ok: false, reason: `step-down must be > 0, got ${params.stepDown} mm` };
  if (params.feed <= 0) return { ok: false, reason: `cutting feed must be > 0, got ${params.feed} mm/min` };
  if (params.plungeFeed <= 0) return { ok: false, reason: `plunge feed must be > 0, got ${params.plungeFeed} mm/min` };
  if (params.rpm <= 0) return { ok: false, reason: `spindle speed must be > 0, got ${params.rpm} RPM` };

  // The single choke point every value passes through before it reaches a toolpath (#184).
  // The plunge feed has no ceiling of its own, so it goes through as a feed.
  const cutting = clampToMachine(params.feed, params.rpm, machine);
  const plunge = clampToMachine(params.plungeFeed, null, machine);
  const diagnostics = [...cutting.diagnostics, ...plunge.diagnostics];
  const refused = diagnostics.find((d) => d.severity === 'error');
  if (refused) return { ok: false, reason: refused.message };

  params.feed = cutting.feed ?? params.feed;
  params.rpm = cutting.rpm ?? params.rpm;
  params.plungeFeed = plunge.feed ?? params.plungeFeed;

  return { ok: true, params, entry, diagnostics };
}
