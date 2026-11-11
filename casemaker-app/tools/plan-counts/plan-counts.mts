/**
 * #1213 — PLANNER v3 SLICE 0: the counts of one `--mem-trace` file, printed as a table.
 *
 * NOT A SPEC — a bench tool, like `tools/samples/run-gdrive-samples.mts`. Measurement only.
 *
 *   npx tsx tools/plan-counts/plan-counts.mts <trace.jsonl> [--json <out.json>]
 *
 * Reads the JSONL the CLI writes with `--mem-trace <file>`, counts the pipeline rows
 * (`summarize.ts` has the exact rules) and prints them. `--json` also writes the `PlanCounts`
 * object. A missing argument or an unreadable file is one sentence on stderr and exit code 2.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { parseTrace, summarizeTrace } from './summarize';

const USAGE = 'usage: plan-counts <trace.jsonl> [--json <out.json>]';

const fail = (why: string): never => {
  console.error(why);
  process.exit(2);
};

const argv = process.argv.slice(2);
let file: string | undefined;
let jsonOut: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === '--json') {
    const value = argv[i + 1];
    if (value === undefined) fail(USAGE);
    jsonOut = value;
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
  `incomplete ${counts.incomplete ? 'yes' : 'no'}`,
];
for (const line of lines) console.log(line);
