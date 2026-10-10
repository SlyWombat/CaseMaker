/**
 * Feeds and speeds — the one place every cutting parameter comes from (#202).
 *
 * THREE TIERS, LOWEST FIRST (#310):
 *
 *   1. {@link UNMEASURED_FEEDS_TABLE} — V1's short hardcoded table of conservative starting
 *      values. Nothing in it has been measured on this machine, and it says so: every row is
 *      `status: 'unmeasured'`.
 *   2. Makera's own catalogue ({@link setFeedCatalogue}), the vendor's numbers for the vendor's
 *      own cutters, imported from Studio's database by the house service (#308's reader, #310's
 *      table). It covers the cutters Makera sells and the materials Makera lists, and nothing
 *      else: a cutter of the user's own, or PLA, has no row here and never will.
 *   3. {@link MEASURED_ROWS} — what a coupon cut on THIS machine settled (#248, #284). It is the
 *      top of the stack, and a catalogue row never overrides it.
 *
 * `job.cutOverride` (#205/#246) is applied over whichever tier answered, and the machine's
 * ceilings are the last word on every value that leaves here (#184). The full precedence, highest
 * first, is measured → job.cutOverride → user_feed → catalogue_feed → UNMEASURED_FEEDS_TABLE; the
 * `user_feed` rung — a saved speed row keyed cutter × material — has no writer yet, and arrives
 * with the surface that writes it (#309/#311).
 *
 * WHAT THE CATALOGUE TIER IS NOT. It is a STARTING point, never a measurement, so the panel names
 * it as one and `FieldSource` has a word of its own for it. Three things it does not decide:
 *
 *   - **The step-over.** Makera states its own, in millimetres, and for every flat end mill in
 *     wood it is 63 % of the cutting diameter (measured: `stepOver` 2.0 mm on the 3.175 mm
 *     `112111313812`, 0.63 mm on the 1 mm flat, 3.78 mm on the 6 mm). Our contour-parallel sweep
 *     leaves an uncut spine above 50 % (#191), where the vendor's own pocketing operation does
 *     not, so their number describes their operation and not ours. Step-over therefore comes from
 *     our row — a conservative 45 % of the cutter — as do peck and air, which are this app's
 *     machining decisions rather than anything a vendor table states.
 *   - **The PLA badge job.** No row in `t_MaterialList` is PLA, PETG, nylon or a generic plastic,
 *     so the tier cannot serve it at all (#165's measured numbers remain the only source).
 *   - **The ceiling.** 32 of the catalogue's rows specify 15 000 RPM, and the Z1's spindle stops
 *     at 13 000. They are not dropped or edited: they go through `clampToMachine` like every other
 *     number, which clamps them and says so (#184, #310).
 *
 * AND IT DOES NOT WIDEN COVERAGE. A cutter the starting table has no row for — 6 mm and up, since
 * every wood row stops at 3.2 mm — is still refused before the catalogue is consulted, so a
 * catalogue row for a 6 mm cutter changes nothing today. The tier sits above
 * `UNMEASURED_FEEDS_TABLE` as a source of better NUMBERS; the ranges are still the table's, because
 * the row also supplies our step-over and peck, which no vendor states. Widening the ranges is its
 * own decision with its own evidence, and is not this change.
 *
 * AND IT YIELDS WHERE IT CANNOT ANSWER (#325). A tier that sits ABOVE the default must not VETO it:
 * a vendor row stating a number this app cannot cut with — Studio's `0` in a column it never filled,
 * or a value past the machine's refusal threshold — used to be adopted and then refused by the
 * `<= 0` and clamp checks below, which refused a job the starting table would have cut, and refused
 * it for a reason ("cutting feed must be > 0, got 0 mm/min") that names the vendor's cell and not
 * the vendor. Now the row is screened FIELD BY FIELD before it is adopted: an unusable number is
 * passed over, the starting table answers that field, and a `catalogue-ignored` diagnostic names the
 * row, the number and the reason. A row that answers nothing is not this job's catalogue answer at
 * all (`catalogue: null`), and the panel's `sources` is stamped AFTER the clamp, so a value the
 * machine moved is never labelled Makera's (decision 28). An override still refuses a non-positive
 * value outright — it is what the USER asserted, and `cncFeeds.spec.ts` pins that.
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

import { z } from 'zod';
import { cuttingRadiusForSweep } from './tool';
import type { Tool } from './tool';
import { clampToMachine } from './machine';
import type { ClampDiagnostic, MillProfile } from './machine';
import type { FieldSource, StockMaterial } from '@/types/engraveJob';

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

// ---------------------------------------------------------------------------------------------
// #310 — Makera's own catalogue, as a tier BELOW measurement
// ---------------------------------------------------------------------------------------------
//
// The rows arrive from the house service (`GET /api/v1/feeds`), which read them out of Studio's
// database (`t_MakeraCutterProperties`, 1 328 rows), and they are pushed in here by
// `store/toolRegistryStore.ts` after the tool list. The snapshot DEFAULTS TO EMPTY, which is what
// keeps every Node script, the coupon readback and every existing test on exactly the behaviour
// they had before this existed: no catalogue loaded is the app with no catalogue.

/**
 * One row of Makera's feeds matrix, as the service serves it. Four numbers: the vendor states
 * seven columns and these are the ones this app can honestly use (the module doc says why
 * step-over is not among them and why `coolant` is not either).
 *
 * The row is named by the CUTTER, not by a diameter range: `cutterId` is `t_MakeraCutterList.g_ID`
 * — the 12-digit id the `.nc` header calls `id=` and this app carries as `Tool.id`. So the numbers
 * attach to Makera's cutter wherever it appears: as a `cat:` catalogue entry, as a built-in whose
 * geometry came from a Makera sample (`flat-3.175x12-metal` IS `112111313812`), or as a cutter the
 * user registered from a file of theirs. A cutter with no vendor id — anything this app made up,
 * and PLA regardless — has no row and never picks one up.
 */
export interface FeedCatalogueRow {
  /** `Tool.id`: the vendor's own cutter id. */
  cutterId: string;
  /** `t_MaterialList.materialSubcategoryName`, VERBATIM — the vendor's word, mapped below. */
  material: string;
  rpm: number;
  feed: number;
  plungeFeed: number;
  /** mm per depth pass. */
  stepDown: number;
}

/**
 * What `GET /api/v1/feeds` answers, validated rather than trusted (the `ToolLibrarySchema` rule).
 *
 * POSITIVE, not merely finite (#325). Studio writes `0` into a numeric column it never filled, and
 * `0.0` is a perfectly well-formed number — one this app's resolver refuses (`feedsFor`'s `<= 0`
 * checks), so a schema that accepted it would be a lie about what a served row means. The service
 * drops such a row at sync (`catalogue.rs::read_feeds`), which is what keeps this all-or-nothing
 * parse from costing the whole tier over one vendor cell; a row that reaches here with a `0` in it
 * is a service this build does not understand, and saying so is the point.
 */
export const FeedCatalogueSchema = z.array(
  z.object({
    cutterId: z.string().min(1),
    material: z.string().min(1),
    rpm: z.number().finite().positive(),
    feed: z.number().finite().positive(),
    plungeFeed: z.number().finite().positive(),
    stepDown: z.number().finite().positive(),
  }),
);

/**
 * The vendor's material names, mapped to this app's `StockMaterial`. EXACTLY TWO ROWS (#310).
 *
 * `t_MaterialList` names fifteen materials and this app cuts four things, and the overlap is wood:
 * `Hardwood` and `Softwood`. There is no row for `mdf`, none for `pla`, and none for the twelve
 * metals and plastics Makera lists. A name that is not a key here is REFUSED — the row is not used
 * — rather than guessed at by substring, so a future `Hardwood (Oak)` cannot silently become
 * `hardwood` and a `6061 Aluminum` can never be read as anything at all.
 */
export const CATALOGUE_MATERIALS: Readonly<Record<string, StockMaterial>> = {
  Hardwood: 'hardwood',
  Softwood: 'softwood',
};

/**
 * The app's material for a vendor material name, or null when the vendor's word is one this map
 * does not carry. `null` is not an error: it is "this app has no such material", and the caller
 * falls back to the tier below.
 */
export function catalogueMaterialFor(vendorName: string): StockMaterial | null {
  if (!Object.prototype.hasOwnProperty.call(CATALOGUE_MATERIALS, vendorName)) return null;
  return CATALOGUE_MATERIALS[vendorName]!;
}

/**
 * The catalogue snapshot, empty until something loads one. Module state rather than a store field,
 * so the panel can read it without a React dependency (the same shape `engine/cnc/toolRegistry.ts`
 * has) — but it is NOT how `feedsFor` gets its rows any more (#324). The resolver takes them as an
 * argument, and this global is only the main thread's copy: a WORKER IS A SEPARATE MODULE REALM, so
 * the worker's copy here is always `[]` however carefully the main thread filled it. The rows reach
 * a worker by structured clone, like the tool registry (#305).
 */
let feedCatalogue: readonly FeedCatalogueRow[] = [];

/**
 * Load Makera's rows, replacing any previous set. Called by the house client after a read, and by
 * tests. An empty array (or {@link clearFeedCatalogue}) is the no-catalogue case. Main thread only:
 * a caller on the other side of a worker boundary hands the rows over instead (#324).
 */
export function setFeedCatalogue(rows: readonly FeedCatalogueRow[]): void {
  feedCatalogue = rows.slice();
}

/** Back to no catalogue. What `toolRegistryStore.reset()` and a lost service both need. */
export function clearFeedCatalogue(): void {
  feedCatalogue = [];
}

/** The rows loaded right now. Read-only: the snapshot is replaced, never mutated in place. */
export function feedCatalogueRows(): readonly FeedCatalogueRow[] {
  return feedCatalogue;
}

/**
 * The catalogue row for a tool and a material, or null. A row is selected only when it names THIS
 * cutter (`Tool.id` — see {@link FeedCatalogueRow}) and its material maps to THIS material. The
 * first match wins; the vendor's table has one row per (cutter, material) pair, and a second one
 * would be a duplicate rather than a preference.
 *
 * `catalogue` is the caller's rows, never the module state: on the far side of a worker boundary
 * that state is an empty array, and reading it there is the #324 defect.
 */
function catalogueRowFor(
  catalogue: readonly FeedCatalogueRow[],
  tool: Tool,
  material: StockMaterial,
): FeedCatalogueRow | null {
  if (tool.id === null || tool.id === '') return null;
  for (const row of catalogue) {
    if (row.cutterId !== tool.id) continue;
    if (catalogueMaterialFor(row.material) === material) return row;
  }
  return null;
}

/** The panel's word for where a field's value came from, and what a catalogue row reads as. */
const CATALOGUE_LABEL = "Makera's catalogue";

/** The four numbers a catalogue row states, and how this file's sentences name each one. */
type CatalogueField = 'rpm' | 'feed' | 'plungeFeed' | 'stepDown';

const CATALOGUE_FIELDS: readonly CatalogueField[] = ['rpm', 'feed', 'plungeFeed', 'stepDown'];

const CATALOGUE_FIELD: Record<CatalogueField, { label: string; unit: string }> = {
  rpm: { label: 'spindle speed', unit: 'RPM' },
  feed: { label: 'cutting feed', unit: 'mm/min' },
  plungeFeed: { label: 'plunge feed', unit: 'mm/min' },
  stepDown: { label: 'step-down', unit: 'mm' },
};

/**
 * A diagnostic about the catalogue tier ITSELF (#325): a row that was not used for a field, and
 * why. Not a `ClampDiagnostic` — `clampToMachine` never emits this, and the type says what it is
 * rather than widening a union that names one machine rule.
 */
export interface CatalogueDiagnostic {
  severity: 'warning';
  code: 'catalogue-ignored';
  message: string;
}

/** Everything {@link feedsFor} can report: the machine's clamp decisions, and the catalogue's. */
export type FeedsDiagnostic = ClampDiagnostic | CatalogueDiagnostic;

/**
 * Why THIS job cannot use one of a row's numbers, as a short clause — or null when it can (#325).
 *
 * The catalogue sits ABOVE the starting table, so it must YIELD, never veto: a vendor value this
 * app cannot use has to leave its field to the tier below, and must not refuse a job the starting
 * table would have cut. Two ways a row's number is unusable:
 *
 *   - it is not a positive number. Studio writes `0` into a column it never filled, and a 0 RPM or
 *     0 mm/min feed is not a slow cut. `feedsFor`'s own `<= 0` refusals below still refuse a
 *     non-positive value someone ASSERTED (an override, a typed feeds-table row — `cncFeeds.spec.ts`
 *     pins that); what changes here is that a vendor table does not get to assert for the user.
 *   - the machine REFUSES it rather than clamping it — more than {@link CLAMP_REFUSE_FRACTION} past
 *     the ceiling. That question is put to `clampToMachine`, the one choke point, so the band is not
 *     restated here. A row within the band is clamped and kept (32 of Makera's rows state 15 000 RPM
 *     on a 13 000 RPM spindle); a row far past it is the vendor's table answering about a machine
 *     that is not this one.
 *
 * `stepDown` has no ceiling to be past — nothing in this stack clamps a depth of cut — so it is
 * screened for positivity alone. Step-over is not screened at all: it comes from our row (#310).
 */
function catalogueRefusal(field: CatalogueField, value: number, machine: MillProfile): string | null {
  if (!Number.isFinite(value) || value <= 0) return 'it is not a positive number';
  if (field === 'stepDown') return null;
  const probe =
    field === 'rpm' ? clampToMachine(null, value, machine) : clampToMachine(value, null, machine);
  return probe.diagnostics.some((d) => d.severity === 'error')
    ? `the ${machine.name} refuses a ${CATALOGUE_FIELD[field].label} that high rather than clamping it`
    : null;
}

/**
 * The sentence the panel shows for a row whose four numbers are Makera's. It names what is the
 * vendor's and what is ours, because the split is real: a `stepOver` on the same panel is this
 * app's, and nothing here has been cut on the machine.
 *
 * `ignored` are the fields the row could not answer for THIS job (#325). They belong in this
 * sentence, not only in `diagnostics`: the panel renders the CLAMP diagnostics (the tag #317 added)
 * and not a `catalogue-ignored`, so the one place a user learns that Makera's number was passed
 * over is here.
 */
function catalogueProvenance(
  row: FeedCatalogueRow,
  tool: Tool,
  entry: FeedsEntry,
  ignored: readonly CatalogueField[],
): string {
  const material = catalogueMaterialFor(row.material) ?? row.material;
  const fromCoupon = entry.status === 'measured';
  const passedOver = ignored.length
    ? ` Not used for this job: the row's ${ignored
        .map((f) => CATALOGUE_FIELD[f].label)
        .join(' and ')} — the starting table answers ${ignored.length > 1 ? 'those fields' : 'it'} ` +
      `instead (see the diagnostic, which names the number).`
    : '';
  return (
    `${CATALOGUE_LABEL} for ${tool.name} in ${material}: S${row.rpm}, F${row.feed}, plunge ` +
    `F${row.plungeFeed}, ${row.stepDown} mm step-down. A vendor's starting point for a cutter ` +
    `Makera sells — nothing here has been cut on this machine. Step-over, peck and air are this ` +
    `app's, not the table's.` +
    (fromCoupon ? ' A coupon has measured this row; those fields win.' : '') +
    passedOver
  );
}

export type FeedsResult =
  | {
      ok: true;
      params: CutParams;
      entry: FeedsEntry;
      /**
       * The catalogue row that supplied numbers, or null when the entry answered on its own. The
       * panel reads it to say "Makera's numbers" rather than "computed".
       */
      catalogue: FeedCatalogueRow | null;
      /**
       * Per field, where the RESOLVED value came from — before any `job.cutOverride`, which the
       * panel stamps from the job's own `sources`. Only `computed`, `catalogue` and `measured` can
       * come out of here (`user` is an asserted value, which this function never produces), and a
       * measured field is only `measured` if a coupon settled THAT field (#248).
       */
      sources: Record<keyof CutParams, FieldSource>;
      /** One sentence for the panel: where this row's numbers came from. */
      provenance: string;
      /**
       * What the machine moved, and what the catalogue could not answer (#325). Both are warnings
       * by construction: an error is a refusal and returns `ok: false` instead.
       */
      diagnostics: FeedsDiagnostic[];
    }
  | { ok: false; reason: string };

/**
 * Resolve the cutting parameters for a material and a tool, or refuse with a reason.
 *
 * The tool must be one `cuttingRadiusForSweep` accepts — a plain flat end mill — because V1
 * sweeps nothing else (`tool.ts`). The cutter's diameter selects a row; no row means no cut.
 *
 * THE TIERS, in the order this function consults them (#310's precedence, minus the rung that has
 * no writer yet): the row a coupon measured answers alone; otherwise Makera's catalogue answers —
 * for the four numbers it states, where this job can use them, and FIELD BY FIELD, because a number
 * it cannot use is passed over rather than refusing the job (#325); otherwise the starting table
 * answers. `override` is applied field by field on top, and then the machine's ceilings are the last
 * word: a modest overage is clamped with a diagnostic, a gross one is refused.
 *
 * `catalogue` is REQUIRED and is the caller's own rows — {@link feedCatalogueRows} on the main
 * thread, the array handed across the boundary in a worker (#324). It is a parameter rather than a
 * read of this module's state because a worker is a separate realm: `setFeedCatalogue` on the main
 * thread cannot reach it, so the worker's copy read empty, the panel showed Makera's numbers and
 * the `.nc` — and the run sheet printed beside it — carried the starting table's. Making the
 * argument required is what makes that mistake a compile error instead of a silent one, the same
 * shape `toolForIn` has for the same reason (#305).
 *
 * `table` is the table to resolve against, `FEEDS_TABLE` unless a caller has its own: a test
 * exercising the measured tier passes the output of {@link applyMeasurements}, which is the only
 * way a measured row can be put in front of this function without hand-editing a machine-written
 * region of this file.
 */
export function feedsFor(
  catalogue: readonly FeedCatalogueRow[],
  material: StockMaterial,
  tool: Tool,
  machine: MillProfile,
  override?: Partial<CutParams>,
  table: readonly FeedsEntry[] = FEEDS_TABLE,
): FeedsResult {
  const radius = cuttingRadiusForSweep(tool);
  if (!radius.ok) return { ok: false, reason: radius.reason };
  const diameter = radius.radius * 2;

  const entry = table.find(
    (e) => e.material === material && diameter >= e.minDiameter && diameter <= e.maxDiameter,
  );
  if (!entry) {
    return { ok: false, reason: `no cutting parameters for a ${diameter} mm cutter in ${material}` };
  }

  // #310 — the catalogue rung. A row a coupon has measured is NOT eligible: "a catalogue row never
  // overrides a measured row" is the rule this tier exists under, and it is the difference between
  // a vendor's starting point and this machine's own answer.
  const row = entry.status === 'measured' ? null : catalogueRowFor(catalogue, tool, material);

  const params: CutParams = {
    rpm: entry.params.rpm,
    feed: entry.params.feed,
    plungeFeed: entry.params.plungeFeed,
    stepDown: entry.params.stepDown,
    stepOver: entry.params.stepOverFraction * diameter,
    peck: entry.params.peckFraction * diameter,
    air: entry.params.air,
  };

  // The four numbers Makera states, over the starting values — FIELD BY FIELD, and only where this
  // job can use them (#325). A row that states 0 mm/min for the cutting feed answers nothing about
  // the cutting feed: that number is passed over, the starting table's answer stands, and the
  // diagnostic below says which of the two happened and why. A row that answers no field at all is
  // not the catalogue's answer for this job either (`catalogue: null` below).
  const diagnostics: FeedsDiagnostic[] = [];
  const used = new Set<CatalogueField>();
  const ignored: CatalogueField[] = [];
  if (row) {
    // The vendor's own material word, or this app's when the map knows it: the sentence below names
    // the material the way the panel does.
    const vendorMaterial = catalogueMaterialFor(row.material) ?? row.material;
    for (const field of CATALOGUE_FIELDS) {
      const value = row[field];
      const why = catalogueRefusal(field, value, machine);
      if (!why) {
        params[field] = value;
        used.add(field);
        continue;
      }
      ignored.push(field);
      const { label, unit } = CATALOGUE_FIELD[field];
      diagnostics.push({
        severity: 'warning',
        code: 'catalogue-ignored',
        message: `${CATALOGUE_LABEL} states a ${label} of ${value} ${unit} for ${tool.name} in ${vendorMaterial}, which this job cannot use — ${why} — so the starting table's ${params[field]} ${unit} answers it`,
      });
    }
  }

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
  diagnostics.push(...cutting.diagnostics, ...plunge.diagnostics);
  const refused = diagnostics.find((d) => d.severity === 'error');
  if (refused) return { ok: false, reason: refused.message };

  // Which fields the machine MOVED. Read off the choke point's own answer rather than compared
  // against a remembered copy: `clampToMachine` returns the value it settled on, and a ceiling that
  // is not this machine's would move it.
  const moved = new Set<keyof CutParams>();
  if (cutting.feed !== null && cutting.feed !== params.feed) moved.add('feed');
  if (cutting.rpm !== null && cutting.rpm !== params.rpm) moved.add('rpm');
  if (plunge.feed !== null && plunge.feed !== params.plungeFeed) moved.add('plungeFeed');

  params.feed = cutting.feed ?? params.feed;
  params.rpm = cutting.rpm ?? params.rpm;
  params.plungeFeed = plunge.feed ?? params.plungeFeed;

  // Where each RESOLVED value came from — stamped HERE, after the clamp (#325). A field the machine
  // moved is not the tier's number any more: a 15 000 RPM row on a 13 000 RPM spindle shows 13 000,
  // and Makera never said 13 000 (decision 28, the `fieldSource` doc). Which fields a coupon
  // actually settled is its own question (#248): a measured ROW is not seven measured fields, and a
  // field still sitting on its starting value must not read as a bench reading.
  const measured = new Set((entry.measured ?? []).map((m) => m.parameter));
  const settled = (p: FeedsMeasurement['parameter']): FieldSource =>
    entry.status === 'measured' && measured.has(p) && !moved.has(p) ? 'measured' : 'computed';
  /**
   * One of the row's four fields, and the ladder behind it: Makera's number if the job could use it
   * and the machine left it alone; otherwise a coupon's, if one settled that field; otherwise this
   * app's starting value.
   */
  const fieldSource = (f: CatalogueField): FieldSource => {
    if (used.has(f) && !moved.has(f)) return 'catalogue';
    // A coupon settles feed, rpm, step-down and step-over (#248) and has nothing to say about a
    // plunge feed, so that field is either Makera's or the starting table's.
    return f === 'plungeFeed' ? 'computed' : settled(f);
  };
  const sources: Record<keyof CutParams, FieldSource> = {
    rpm: fieldSource('rpm'),
    feed: fieldSource('feed'),
    stepDown: fieldSource('stepDown'),
    // A coupon's step-over measurement lands in the row's `stepOverFraction` (#248), so this one is
    // measurable — while peck and air are not a coupon's business and are always this app's. The
    // catalogue cannot be the source here at all: its step-over is its own operation's (module doc).
    stepOver: settled('stepOver'),
    plungeFeed: fieldSource('plungeFeed'),
    peck: 'computed',
    air: 'computed',
  };

  // The row answers this job only if at least one of its numbers survived (#325): a row we passed
  // over entirely supplied nothing, and `catalogue: null` is how the panel is told so.
  const answered = row !== null && used.size > 0;
  const provenance = answered && row ? catalogueProvenance(row, tool, entry, ignored) : entry.provenance;

  // The row DID answer (`answered`) rather than merely existing: a vendor row whose numbers were
  // all passed over supplied nothing, and the panel's "Makera's numbers" label would be false.
  return { ok: true, params, entry, catalogue: answered ? row : null, sources, provenance, diagnostics };
}
