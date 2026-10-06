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
import type { ClampDiagnostic, MillProfile } from './machine';
import type { StockMaterial } from '@/types/engraveJob';

export interface CutParams {
  rpm: number;
  feed: number; // mm/min, XY cutting
  plungeFeed: number; // mm/min, Z-
  stepDown: number; // mm per depth pass
  stepOver: number; // mm between contour-parallel loops
  /**
   * Peck depth for plunge drilling (#220), mm — how far the feed goes before the tool rapids
   * out to clear chips. Only drilling reads it; pocketing has no use for it. Resolved from the
   * row's `peckFraction` times the cutter diameter, PROVISIONAL at one diameter until a real
   * peck cycle measures it (#208/#209).
   */
  peck: number;
  /** M7. */
  air: boolean;
}

/**
 * A coupon measurement of ONE feeds-table field (#248 item 3). A coupon tests a single
 * parameter at a time (`couponJob.CouponParam`), so a measurement names the field it settles,
 * the value adopted, the date the coupon was cut and the coupon record it came from. The
 * readback (`scripts/feeds-readback.ts`) turns a filled `<id>-coupon-record.json` into these
 * and writes them into the generated `MEASURED_ROWS` region below; `applyMeasurements` folds
 * them into `FEEDS_TABLE`. Nothing hand-edits a measured row.
 *
 * `depth` is deliberately NOT a parameter here: a depth coupon measures the job's achievable
 * depth (the #165 ladder, `/Fabrication.md` §7.2), not a column of this table.
 */
export interface FeedsMeasurement {
  /** Which row this measures: the material and the cutting diameter that selected it. */
  material: StockMaterial;
  /** Cutting diameter of the coupon's tool, mm — resolved against the row's range like `feedsFor`. */
  diameter: number;
  /** The feeds field the coupon settled. `stepOver` is stored here in mm, a fraction in the table. */
  parameter: 'feed' | 'rpm' | 'stepDown' | 'stepOver';
  /** The adopted value, in the parameter's OWN unit (mm for `stepOver`). */
  value: number;
  /** ISO date (YYYY-MM-DD) the coupon was cut. A measured row must carry its date. */
  on: string;
  /** The coupon record id the verdicts came from. */
  coupon: string;
  /** The record file, for a reader that wants the raw per-cell verdicts. */
  record?: string;
}

export interface FeedsEntry {
  material: StockMaterial;
  /** Applies to flat end mills with cutting diameter in [minDiameter, maxDiameter], mm. */
  minDiameter: number;
  maxDiameter: number;
  /**
   * `stepOverFraction` and `peckFraction` are fractions of the cutter DIAMETER, resolved in
   * `feedsFor`: a row states them per-diameter so one row covers a range of cutters.
   */
  params: Omit<CutParams, 'stepOver' | 'peck'> & { stepOverFraction: number; peckFraction: number };
  status: 'unmeasured' | 'measured';
  provenance: string;
  /**
   * The coupons that have measured this row (#248). Absent = still the starting values.
   * `status` flips to `measured` as soon as any field is settled; this list is the exact
   * evidence — which fields, from which coupon, on which date.
   */
  measured?: FeedsMeasurement[];
}

const PROVENANCE =
  'Starting value. rpm/feed/plunge are what Makera Studio emits for the Z1 (TopClamp.nc: S12000, F500, F200); step-down is a conservative guess for a 150 W spindle. Replace from #209.';

/**
 * The V1 table's STARTING VALUES. Every row `unmeasured`. The PLA row is a placeholder for
 * #165, which measures the real one; the softwood/hardwood/MDF step-downs are conservative
 * guesses for a 150 W spindle, not measurements. A coupon never edits this literal — it
 * appends to `MEASURED_ROWS` below, and `FEEDS_TABLE` folds the two together (#248 item 3).
 *
 * Range tests are INCLUSIVE at both ends, and the FIRST matching row wins. So a diameter
 * exactly on a shared boundary — 1.6 mm between the 0.8-1.6 and 1.6-3.2 rows — takes the
 * smaller-diameter row, which is the conservative side (a 1.6 mm cutter gets the 0.5 mm
 * step-down, not 1.0). 3.175 mm — the shank every sample tool uses — falls in the 1.6-3.2 row.
 */
export const UNMEASURED_FEEDS_TABLE: readonly FeedsEntry[] = [
  {
    material: 'softwood',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'softwood',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1.0, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'hardwood',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 400, plungeFeed: 150, stepDown: 0.3, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'hardwood',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 400, plungeFeed: 150, stepDown: 0.6, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'mdf',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'mdf',
    minDiameter: 1.6,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1.0, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
  {
    material: 'pla',
    minDiameter: 0.8,
    maxDiameter: 1.6,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.3, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    status: 'unmeasured',
    provenance: PROVENANCE,
  },
];

// ---------------------------------------------------------------------------------------------
// #248 item 3 — the measured overlay, written by `scripts/feeds-readback.ts`
// ---------------------------------------------------------------------------------------------
//
// The region between these two markers is MACHINE-WRITTEN. A completed coupon record is read
// back into it by the entry point; no one edits it by hand, and the row above is never touched.
// It is plain JSON inside a `const`, so the reader can parse the region as text without running
// the app. Empty today: no row has been measured on the machine yet (#209/#208 are the bench).

// <feeds-measured>
// Machine-written by `scripts/feeds-readback.ts` (#248) from a filled coupon record. Do not hand-edit.
const MEASURED_ROWS: readonly FeedsMeasurement[] = [];
// </feeds-measured>

export interface MeasurementReadback {
  /** The merged table: the starting values with every matched measurement folded in. */
  table: FeedsEntry[];
  /** Measurements that found a row and were applied. */
  applied: FeedsMeasurement[];
  /** Measurements that matched no row — never silently dropped. */
  unmatched: FeedsMeasurement[];
}

/**
 * Fold coupon measurements into a table (#248 item 3). Pure. A measurement selects its row
 * exactly as `feedsFor` does — material, then the first row whose inclusive range contains the
 * cutter diameter — so a measured row is the same row a job would resolve. It sets the swept
 * field, flips `status` to `measured`, and records the measurement (date + coupon) in
 * `measured`, so the provenance the panel shows is the evidence and not a re-typed string.
 */
export function applyMeasurements(
  base: readonly FeedsEntry[],
  measurements: readonly FeedsMeasurement[],
): MeasurementReadback {
  const byRow = new Map<number, FeedsMeasurement[]>();
  const unmatched: FeedsMeasurement[] = [];
  for (const m of measurements) {
    const i = base.findIndex(
      (e) => e.material === m.material && m.diameter >= e.minDiameter && m.diameter <= e.maxDiameter,
    );
    if (i < 0) {
      unmatched.push(m);
      continue;
    }
    const list = byRow.get(i);
    if (list) list.push(m);
    else byRow.set(i, [m]);
  }

  const applied: FeedsMeasurement[] = [];
  const table = base.map((row, i) => {
    const ms = byRow.get(i);
    if (!ms || ms.length === 0) return row; // untouched rows keep their identity
    applied.push(...ms);
    const params = { ...row.params };
    for (const m of ms) {
      switch (m.parameter) {
        case 'feed': params.feed = m.value; break;
        case 'rpm': params.rpm = m.value; break;
        case 'stepDown': params.stepDown = m.value; break;
        case 'stepOver': params.stepOverFraction = m.value / m.diameter; break;
      }
    }
    return { ...row, params, status: 'measured' as const, measured: ms, provenance: measuredProvenance(ms) };
  });

  return { table, applied, unmatched };
}

const FIELD_LABEL: Record<FeedsMeasurement['parameter'], string> = {
  feed: 'cutting feed',
  rpm: 'spindle speed',
  stepDown: 'step-down',
  stepOver: 'step-over',
};
const SWEEPABLE: FeedsMeasurement['parameter'][] = ['feed', 'rpm', 'stepDown', 'stepOver'];

/** The provenance string a measured row shows: which fields, from which coupon, on which date. */
function measuredProvenance(ms: FeedsMeasurement[]): string {
  const parts = ms.map((m) => `${FIELD_LABEL[m.parameter]} ${m.value} from coupon "${m.coupon}" (${m.on})`);
  const covered = new Set(ms.map((m) => m.parameter));
  const remaining = SWEEPABLE.filter((p) => !covered.has(p));
  const tail = remaining.length
    ? ` Still starting values: ${remaining.map((p) => FIELD_LABEL[p]).join(', ')}.`
    : '';
  return `Measured on a coupon: ${parts.join('; ')}.${tail}`;
}

/** The table every caller resolves against: a coupon's stack of values, then the rest. */
export const FEEDS_TABLE: readonly FeedsEntry[] =
  applyMeasurements(UNMEASURED_FEEDS_TABLE, MEASURED_ROWS).table;

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
  machine: MillProfile,
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
    peck: entry.params.peckFraction * diameter,
    air: entry.params.air,
  };

  if (override) {
    if (override.rpm !== undefined) params.rpm = override.rpm;
    if (override.feed !== undefined) params.feed = override.feed;
    if (override.plungeFeed !== undefined) params.plungeFeed = override.plungeFeed;
    if (override.stepDown !== undefined) params.stepDown = override.stepDown;
    if (override.stepOver !== undefined) params.stepOver = override.stepOver;
    if (override.peck !== undefined) params.peck = override.peck;
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
  if (params.peck <= 0) return { ok: false, reason: `peck depth must be > 0, got ${params.peck} mm` };
  if (params.stepOver <= 0) return { ok: false, reason: `step-over must be > 0, got ${params.stepOver} mm` };
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
