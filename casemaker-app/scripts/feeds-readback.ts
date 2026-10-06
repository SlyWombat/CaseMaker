// Read a completed coupon record back into `feeds.ts` — the half of #248 item 3 that closes the
// round trip. `scripts/engrave-job.ts --coupon` writes `<id>-coupon-record.json` with a blank
// verdict per program; this reads the filled file, turns the one verdict that held into a
// `FeedsMeasurement`, and writes it into the MACHINE-WRITTEN region of `src/engine/cnc/feeds.ts`.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/feeds-readback.ts <record.json> [--feeds <path>] [--dry-run]
//
// Nothing here measures anything: it only applies a result a person recorded. The record must
// name the date the coupon was CUT (`cutOn`), because a `measured` row must carry its date
// (#248), and exactly one program must have cut `ok` (mark `"chosen": true` when more than one
// did). The matching row is selected the way `feedsFor` selects one — material, then the first
// inclusive diameter range that contains the cutter — so the measured row is the row a job gets.
//
// The edit is confined to the `<feeds-measured>` region: the starting-value table above it is
// never touched, and re-running on the same record replaces its entry rather than duplicating it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { measurementFromRecord, type CouponRecord } from '../src/engine/cnc/engrave/couponJob';
import {
  applyMeasurements,
  UNMEASURED_FEEDS_TABLE,
  type FeedsMeasurement,
} from '../src/engine/cnc/feeds';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FEEDS = join(here, '..', 'src', 'engine', 'cnc', 'feeds.ts');
/** The two comment lines that bound the generated region. Keep in step with `feeds.ts`. */
const BEGIN = '// <feeds-measured>';
const END = '// </feeds-measured>';

interface Args {
  record?: string;
  feeds: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { feeds: DEFAULT_FEEDS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--feeds') args.feeds = resolve(argv[++i] ?? '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--') continue;
    else if (a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (args.record === undefined) args.record = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return args;
}

function fail(message: string): never {
  console.error(`feeds-readback: ${message}`);
  process.exit(1);
}

const USAGE =
  'usage: scripts/feeds-readback.ts <record.json> [--feeds <feeds.ts>] [--dry-run]';

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\n${USAGE}`);
  throw e; // unreachable; `fail` exits
}
if (!args.record) fail(USAGE);

// ---------------------------------------------------------------------------------------------
// The marked region in feeds.ts
// ---------------------------------------------------------------------------------------------

function regionBounds(source: string, path: string): { start: number; end: number } {
  const b = source.indexOf(BEGIN);
  const e = source.indexOf(END);
  if (b < 0 || e < 0 || e < b) fail(`${path} has no ${BEGIN} … ${END} region`);
  return { start: b, end: e + END.length };
}

function extractMeasuredRows(source: string, path: string): FeedsMeasurement[] {
  const { start, end } = regionBounds(source, path);
  const region = source.slice(start, end);
  const m = region.match(/=\s*(\[[\s\S]*\])\s*;/);
  if (!m) fail(`the measured region in ${path} has no array literal`);
  try {
    return JSON.parse(m[1]!) as FeedsMeasurement[];
  } catch (e) {
    return fail(`the measured region in ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function renderRegion(rows: FeedsMeasurement[]): string {
  return [
    BEGIN,
    '// Machine-written by `scripts/feeds-readback.ts` (#248) from a filled coupon record. Do not hand-edit.',
    `const MEASURED_ROWS: readonly FeedsMeasurement[] = ${JSON.stringify(rows, null, 2)};`,
    END,
  ].join('\n');
}

/** The region from `source` with its rows replaced. Pure, so a spec can check the splice. */
export function spliceMeasuredRows(source: string, rows: FeedsMeasurement[]): string {
  const { start, end } = regionBounds(source, 'feeds.ts');
  return source.slice(0, start) + renderRegion(rows) + source.slice(end);
}

/** Re-running on the same record replaces its entry: one coupon contributes one measurement. */
function mergeMeasurement(existing: FeedsMeasurement[], add: FeedsMeasurement): FeedsMeasurement[] {
  const key = (m: FeedsMeasurement) => `${m.coupon}|${m.material}|${m.diameter}|${m.parameter}`;
  return [...existing.filter((m) => key(m) !== key(add)), add];
}

// ---------------------------------------------------------------------------------------------
// Read, apply, write
// ---------------------------------------------------------------------------------------------

const recordPath = args.record;
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(recordPath, 'utf8'));
} catch (e) {
  fail(`cannot read ${recordPath}: ${(e as Error).message}`);
}
if (typeof raw !== 'object' || raw === null) fail(`${recordPath} is not a coupon record object`);

const result = measurementFromRecord(raw as CouponRecord, recordPath);
if (!result.ok) fail(result.reason);
const measurement = result.measurement;

const source = readFileSync(args.feeds, 'utf8');
const existing = extractMeasuredRows(source, args.feeds);
const merged = mergeMeasurement(existing, measurement);
const next = spliceMeasuredRows(source, merged);

// Report what the row becomes, exactly as a caller would resolve it.
const readback = applyMeasurements(UNMEASURED_FEEDS_TABLE, merged);
if (readback.unmatched.length > 0) {
  fail(
    `no feeds row matches ${readback.unmatched[0]!.material} at Ø${readback.unmatched[0]!.diameter} mm; ` +
      `the record's cuttingDiameter or material is wrong for the table`,
  );
}
const row = readback.table.find((e) =>
  e.material === measurement.material &&
  measurement.diameter >= e.minDiameter &&
  measurement.diameter <= e.maxDiameter,
);

console.log(`${recordPath}  ->  ${args.feeds}${args.dryRun ? '  (dry run)' : ''}`);
console.log(
  `  measurement  ${measurement.material} Ø${measurement.diameter} ${measurement.parameter} = ` +
    `${measurement.value}  (coupon "${measurement.coupon}", cut ${measurement.on})`,
);
if (row) {
  console.log(`  row          ${row.material} ${row.minDiameter}-${row.maxDiameter} mm -> ${row.status}`);
  console.log(`  provenance   ${row.provenance}`);
}

if (args.dryRun) {
  console.log('\n(dry run — feeds.ts not written)');
} else {
  writeFileSync(args.feeds, next);
  console.log(`\nwrote ${merged.length} measurement(s) into the feeds.ts region`);
}
