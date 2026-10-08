// Read a completed run record back into the app (#277) — the second half of the round trip
// `scripts/feeds-readback.ts` closes for feeds. `Save .nc…` in the panel writes
// `<job>-run.json` beside the program with its measured half blank; this reads the filled file,
// validates it with the app's own `parseRunRecord`, and writes the record into the
// MACHINE-WRITTEN region of `src/engine/cnc/engrave/runHistory.ts`, which is what the panel's
// cycle estimate reads its "last measured" line from.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/run-readback.ts <record.json> [--history <path>] [--dry-run]
//
// Nothing here measures anything: it only applies a result a person recorded. A record with no
// `cutOn` date is refused — that is #277's rule, and it is enforced in `parseRunRecord` as well as
// here, so a hand-edited reading cannot reach the app by either road. The edit is confined to the
// `<runs-measured>` region, and re-running on the same record REPLACES its entry rather than
// appending a second copy, so running it twice on one file changes nothing the second time.
//
// The app can do the same round trip without a rebuild: the panel's "Open run record…" parses the
// file with the same function and keeps it for this browser (#277). This script is the ARCHIVED
// form — the record lands in the source tree, where git carries it between machines.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRunRecord, isMeasuredRun, type RunRecord } from '../src/engine/cnc/engrave/runRecord';
import { mergeMeasuredRuns } from '../src/engine/cnc/engrave/runHistory';
import { extractMeasuredRuns, spliceMeasuredRuns } from '../src/engine/cnc/engrave/runHistoryRegion';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY = join(here, '..', 'src', 'engine', 'cnc', 'engrave', 'runHistory.ts');

interface Args {
  record?: string;
  history: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { history: DEFAULT_HISTORY, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--history') args.history = resolve(argv[++i] ?? '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--') continue;
    else if (a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (args.record === undefined) args.record = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return args;
}

function fail(message: string): never {
  console.error(`run-readback: ${message}`);
  process.exit(1);
}

const USAGE = 'usage: scripts/run-readback.ts <record.json> [--history <runHistory.ts>] [--dry-run]';

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\n${USAGE}`);
  throw e; // unreachable; `fail` exits
}
if (!args.record) fail(USAGE);

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/** `14 min 20 s` — the same shape the run sheet formats a duration in. */
function formatMinutes(minutes: number): string {
  const s = Math.round(minutes * 60);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
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

const parsed = parseRunRecord(raw);
if (!parsed.ok) fail(`${recordPath}: ${parsed.reason}`);
const run = parsed.run;

// The one thing this script adds to `parseRunRecord`: a file that is still blank is not an error in
// the app (the panel shows nothing and says nothing), but reading it back would write a non-run
// into the history, so it is refused here with what to do about it.
if (!isMeasuredRun(run)) {
  fail(
    `${recordPath} has no cutOn date — this record is still blank. Fill the measured half in at the ` +
      'bench and date the cut before reading it back.',
  );
}

let source: string;
let existing: RunRecord[];
let merged: RunRecord[];
let next: string;
try {
  source = readFileSync(args.history, 'utf8');
  existing = extractMeasuredRuns(source, args.history);
  merged = mergeMeasuredRuns(existing, run);
  next = spliceMeasuredRuns(source, merged, args.history);
} catch (e) {
  fail((e as Error).message);
  throw e; // unreachable; `fail` exits
}

console.log(`${recordPath}  ->  ${args.history}${args.dryRun ? '  (dry run)' : ''}`);
console.log(`  run          ${run.job}  (${run.ncFile}, hash ${run.ncHash || 'unknown'})`);
console.log(
  `  measured     ${run.minutes === null ? 'no wall-clock time recorded' : formatMinutes(run.minutes)} ` +
    `on ${run.cutOn}${run.tool === null ? '' : `  ·  ${run.tool}`}`,
);
if (run.estimatedSeconds !== null) {
  const est = Math.round(run.estimatedSeconds);
  console.log(
    `  estimate     ${formatMinutes(est / 60)} (${est} s) — the measured figure shows BESIDE it, never instead of it`,
  );
}
for (const d of run.depths) {
  console.log(
    `  depth        ${d.name}: posted ${d.planned} mm` +
      (d.measured === null ? ', not measured' : `, measured ${d.measured} mm`),
  );
}
console.log(
  `  outcome      ${run.legible === null ? 'legibility not recorded' : run.legible ? 'legible' : 'NOT legible'}` +
    ` · ${run.finish ?? 'finish not recorded'}` +
    (run.notes === '' ? '' : ` · “${run.notes}”`),
);

if (args.dryRun) {
  console.log('\n(dry run — runHistory.ts not written)');
} else {
  writeFileSync(args.history, next);
  const replaced = existing.some((r) => r.ncFile === run.ncFile);
  console.log(
    `\n${replaced ? 'replaced' : 'added'} the record for ${run.ncFile}; ` +
      `${merged.length} measured run(s) in the region`,
  );
}
