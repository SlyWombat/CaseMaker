/**
 * #1213 — PLANNER v3 SLICE 0: the counts of one `--mem-trace` file, printed as a table.
 *
 * NOT A SPEC — a bench tool, like `tools/samples/run-gdrive-samples.mts`. Measurement only.
 *
 *   npx tsx tools/plan-counts/plan-counts.mts <trace.jsonl> [--json <out.json>] \
 *     [--shadow-csv <out.csv>] [--cutter-csv <out.csv>] [--steps-csv <out.csv>]
 *
 * Reads the JSONL the CLI writes with `--mem-trace <file>`, counts the pipeline rows
 * (`summarize.ts` has the exact rules) and prints them. `--json` also writes the `PlanCounts`
 * object; `--shadow-csv` writes one line per `shadow:candidate` row, for the analyst's agreement
 * table. A missing argument or an unreadable file is one sentence on stderr and exit code 2.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { cutterRows, parseTrace, summarizeTrace, type TraceRow } from './summarize';

const USAGE = 'usage: plan-counts <trace.jsonl> [--json <out.json>] [--shadow-csv <out.csv>] [--cutter-csv <out.csv>] [--steps-csv <out.csv>]';

const fail = (why: string): never => {
  console.error(why);
  process.exit(2);
};

const argv = process.argv.slice(2);
let file: string | undefined;
let jsonOut: string | undefined;
let shadowCsv: string | undefined;
let cutterCsv: string | undefined;
let stepsCsv: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === '--json') {
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    jsonOut = value;
    i += 1;
  } else if (arg === '--shadow-csv') {
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    shadowCsv = value;
    i += 1;
  } else if (arg === '--cutter-csv') {
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    cutterCsv = value;
    i += 1;
  } else if (arg === '--steps-csv') {
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    stepsCsv = value;
    i += 1;
  } else if (arg.startsWith('--')) {
    fail(`plan-counts: unknown flag "${arg}" — ${USAGE}`);
  } else if (file === undefined) {
    file = arg;
  } else {
    fail(`plan-counts: more than one trace file ("${file}" and "${arg}") — ${USAGE}`);
  }
}
if (file === undefined) fail(`plan-counts: no trace file — ${USAGE}`);

let text: string;
try {
  text = readFileSync(file, 'utf8');
} catch {
  fail(`plan-counts: cannot read "${file}"`);
}

const rows = parseTrace(text);
const counts = summarizeTrace(rows);

if (jsonOut !== undefined) {
  writeFileSync(jsonOut, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
}

/** The analyst's agreement table: one line per shadow candidate, in trace order. */
const SHADOW_COLUMNS = [
  'signature',
  'estSeconds',
  'estCutSeconds',
  'estChanges',
  'estLeftoverMm2',
  'unpriced',
  'realSeconds',
  'realEstimateSeconds',
  'realLeftoverCells',
  'realRank',
] as const;

function writeShadowCsv(path: string, rows: readonly TraceRow[]): void {
  const lines = [SHADOW_COLUMNS.join(',')];
  for (const row of rows) {
    if (row.stage !== 'shadow:candidate') continue;
    lines.push(
      SHADOW_COLUMNS.map((column) => {
        const value = row[column];
        if (value === undefined) return '';
        if (column === 'signature') return `"${String(value).replace(/"/g, '""')}"`;
        return String(value);
      }).join(','),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

if (shadowCsv !== undefined) writeShadowCsv(shadowCsv, rows);

/** #1225 — one line per (chain, cutter): the shadow's estimate beside the real planner's seconds. */
function writeCutterCsv(path: string, rows: readonly TraceRow[]): void {
  const lines = ['signature,cutterKey,estSeconds,realSeconds,realChangeSeconds'];
  const cell = (value: number | null): string => (value === null ? '' : String(value));
  for (const r of cutterRows(rows)) {
    lines.push(`"${r.signature.replace(/"/g, '""')}",${r.cutterKey},${cell(r.estSeconds)},${cell(r.realSeconds)},${cell(r.realChangeSeconds)}`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

if (cutterCsv !== undefined) writeCutterCsv(cutterCsv, rows);

/** #1249 stage 2a — one line per `shadow:step` row: the estimate's inputs and the band it left. */
const STEP_COLUMNS = [
  'signature', 'stepIndex', 'kind', 'cutterKey', 'prevCutterKey', 'diameterMm', 'prevDiameterMm',
  'addedAreaMm2', 'depthMm', 'levels', 'feed', 'plungeFeed', 'stepOverMm', 'stepDownMm', 'cutSeconds',
  'bandAreaMm2', 'bandContourLengthMm', 'bandPatches',
] as const;

function writeStepsCsv(path: string, rows: readonly TraceRow[]): void {
  const lines = [STEP_COLUMNS.join(',')];
  for (const row of rows) {
    if (row.stage !== 'shadow:step') continue;
    lines.push(
      STEP_COLUMNS.map((column) => {
        const value = row[column];
        if (value === undefined) return '';
        if (column === 'signature' || column === 'cutterKey' || column === 'prevCutterKey') {
          return `"${String(value).replace(/"/g, '""')}"`;
        }
        return String(value);
      }).join(','),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

if (stepsCsv !== undefined) writeStepsCsv(stepsCsv, rows);

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const lines = [
  `trace rows ${rows.length}`,
  `wall s ${seconds(counts.wallMs)}`,
  `peak RSS MiB ${Math.round(counts.peakRssBytes / 1048576)}`,
  `pipelines ${counts.pipelines}`,
  `pick: runs ${counts.pick.runs} coarse ${counts.pick.coarse} full ${counts.pick.full} wall s ${seconds(counts.pick.wallMs)}`,
  `plans: owned ${counts.plans.owned} ideal ${counts.plans.ideal} wall s ${seconds(counts.plans.wallMs)}`,
  `rank: runs ${counts.rank.runs} candidates ${counts.rank.candidates} inline ${counts.rank.inline} wall s ${seconds(counts.rank.wallMs)}`,
  `chain: runs ${counts.chain.runs} step plans ${counts.chain.stepPlans} candidates considered ${counts.chain.candidatesConsidered} wall s ${seconds(counts.chain.wallMs)}`,
  `ops: planned ${counts.ops.planned} reused ${counts.ops.reused}`,
  `stamps: computed ${counts.stamps.computed} cached ${counts.stamps.cached} failed ${counts.stamps.failed}`,
  `sweeps ${counts.sweeps}`,
  `goal fields ${counts.goalFields}`,
  `shadow: choices ${counts.shadow.choices} agree ${counts.shadow.agree} candidates ${counts.shadow.candidates} errors ${counts.shadow.errors} field s ${seconds(counts.shadow.fieldMs)} estimate s ${seconds(counts.shadow.estimateMs)}`,
  `incomplete ${counts.incomplete ? 'yes' : 'no'}`,
];
for (const line of lines) console.log(line);
