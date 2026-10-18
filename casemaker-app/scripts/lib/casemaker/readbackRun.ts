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

import { parseRunRecord, isMeasuredRun, type RunRecord } from '../../../src/engine/cnc/engrave/runRecord';
import { mergeMeasuredRuns } from '../../../src/engine/cnc/engrave/runHistory';
import { extractMeasuredRuns, spliceMeasuredRuns } from '../../../src/engine/cnc/engrave/runHistoryRegion';
import { RECEIPT_VERSION } from '../../../src/platform/headless/receipt';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';
import { fileReceipt } from './receiptFiles';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY = join(here, '..', '..', '..', 'src', 'engine', 'cnc', 'engrave', 'runHistory.ts');

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
  throw new CliExit(1);
}

const USAGE = 'usage: scripts/run-readback.ts <record.json> [--history <runHistory.ts>] [--dry-run]';

/**
 * Apply a filled run record to the machine-written region of `runHistory.ts` (#277).
 *
 * Extracted from the former `scripts/run-readback.ts` for #477 so `casemaker readback` and the
 * documented script path run the identical code. `fail()` throws {@link CliExit}; the returned
 * number is the process exit code.
 */
export async function readbackRunMain(
  argv: string[],
  options: CommandOptions = HUMAN,
): Promise<number> {
  try {
    return await readbackRunBody(argv, options);
  } catch (e) {
    if (isCliExit(e)) return e.code;
    throw e;
  }
}

async function readbackRunBody(argv: string[], options: CommandOptions): Promise<number> {
  const out = commandOutput(options);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
    throw e; // unreachable; `fail` exits
  }
  if (!args.record) fail(USAGE);

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
  // into the history, so it is refused here with what to do about it. The null check repeats the
  // guard's own condition so the type narrows for the receipt below.
  if (!isMeasuredRun(run) || run.cutOn === null) {
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

  // The write happens before the receipt describes it, so `replaced` and the region's count are
  // facts about what is on disk rather than a prediction of it (#478).
  const replaced = existing.some((r) => r.ncFile === run.ncFile);
  if (args.dryRun) {
    // Nothing is written; `measuredRuns: null` and `dryRun` are what the renderer reports.
  } else {
    writeFileSync(args.history, next);
  }
  out.emitReceipt({
    version: RECEIPT_VERSION,
    command: 'readback',
    ok: true,
    stage: 'applied',
    gate: null,
    inputs: [fileReceipt(recordPath)],
    outputs: args.dryRun ? [] : [fileReceipt(args.history)],
    diagnostics: [],
    provenance: [],
    refusals: [],
    details: {
      section: 'run',
      record: recordPath,
      target: args.history,
      dryRun: args.dryRun,
      feeds: null,
      run: {
        job: run.job,
        ncFile: run.ncFile,
        ncHash: run.ncHash,
        minutes: run.minutes,
        cutOn: run.cutOn,
        tool: run.tool,
        estimatedSeconds: run.estimatedSeconds,
        depths: run.depths.map((d) => ({ name: d.name, planned: d.planned, measured: d.measured })),
        legible: run.legible,
        finish: run.finish,
        notes: run.notes,
        replaced,
        measuredRuns: args.dryRun ? null : merged.length,
      },
    },
  });
  return 0;
}
