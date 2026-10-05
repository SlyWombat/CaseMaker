// The scripted engrave path (#248, closing #231 item 1): turn a COMMITTED job document into the
// files the bench needs, through the app's own pipeline — no browser, no throwaway script.
//
// #231 item 1 was that the first real bench job needed a hand-written one-off
// (`scripts/bench-files.ts`) because nothing outside the app turned an `EngraveJob` into a `.nc`
// and a run sheet. This is that entry point, and #248's coupon jobs are its first real caller.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts <job.json> [--out <dir>]
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts --coupon <coupon-spec.json> [--out <dir>]
//
// A job document is exactly what the app saves (`parseEngraveJob`, #200). A coupon spec is a
// `CouponSpec` (#248): it names a parameter, the values to sweep, and the base job to carve the
// cells from — either `base` inline or `basePath` to a committed job document. `couponJob.ts`
// turns it into one program (a depth ladder) or one per value. A minimal spec:
//
//   { "id": "depth-sweep", "title": "Depth sweep", "parameter": "depth",
//     "values": [0.4, 0.8], "basePath": "docs/bench/165-depth-ladder.job.json",
//     "text": { "size": 7, "pitch": 30 }, "origin": { "x": 20, "y": 19 }, "depth": 0.6 }
//
// (`text.size` is the cell text's cap height — keep it ≥ ~7 mm for a 1 mm cutter, or the generator
// warns `item-detail-lost`; `origin` is the first cell's centre, mm from the stock's front-left.)
//
// For each program it writes, into `--out` (default: the document's own directory):
//   <name>.nc             the cut file                        (#206)
//   <name>-frame.nc       the dry-run frame file              (#244)
//   <name>-run-sheet.md   the operator sheet, from buildRunSheet (#207)
//   <name>.job.json       the resolved job document (coupons only — the job input already exists)
// and prints a receipt: stage, feed/verify findings, sim stats and the sheet's hash. A coupon run
// ALSO writes `<id>-coupon-record.json`, a blank verdict per program — the entry point's half of
// #248 item 3 (reading it back into `feeds.ts` touches a file outside this slot's column).
//
// NOTHING here measures anything. It emits INPUTS and the machine's receipt; results are recorded
// by hand on the issue (`docs/bench/`).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { engraveGenerate, type EngraveGenerated } from '../src/workers/sim/engraveGenerate';
import { createSimSession, type SimDiagnostic, type SimLoadOk } from '../src/workers/sim/session';
import { Z1 } from '../src/engine/cnc/machine';
import { jobTool, toSetup } from '../src/engine/cnc/engrave/jobSetup';
import {
  buildRunSheet,
  runSheetFileName,
  runSheetFrameFileName,
} from '../src/engine/cnc/engrave/runSheet';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import { buildCouponPrograms, type CouponSpec } from '../src/engine/cnc/engrave/couponJob';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '../src/engine/fonts/registry';
import type { EngraveJob } from '../src/types/engraveJob';
import { renderRunSheetMarkdown } from './runSheetMarkdown';

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

// Text labels need parsed fonts, and the app loads them by `fetch`ing a static asset — which
// node's fetch cannot do for a `file:` URL. Seed the registry straight off disk, exactly the way
// the vitest setup file (`tests/setup/fonts.ts`) does, so a job with text labels engraves here too.
for (const key of BUNDLED_FONT_KEYS) {
  const bytes = readFileSync(new URL(`../src/engine/fonts/files/${key}.ttf`, import.meta.url));
  registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// ---------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------

interface Args {
  job?: string;
  coupon?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--coupon') args.coupon = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (args.job === undefined) args.job = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return args;
}

function fail(message: string): never {
  console.error(`engrave-job: ${message}`);
  process.exit(1);
}

const USAGE =
  'usage: scripts/engrave-job.ts <job.json> [--out <dir>]\n' +
  '       scripts/engrave-job.ts --coupon <coupon-spec.json> [--out <dir>]';

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\n${USAGE}`);
  throw e; // unreachable; `fail` exits
}
if (!args.job && !args.coupon) fail(USAGE);
if (args.job && args.coupon) fail('pass a job OR --coupon, not both');

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`);
  }
};

// ---------------------------------------------------------------------------------------------
// The pipeline: one job -> .nc + frame + run sheet
// ---------------------------------------------------------------------------------------------

/** Program names written this run, so two coupon programs can never overwrite each other. */
const usedNames = new Set<string>();

function stemFor(job: EngraveJob): string {
  const stem = runSheetFileName(job.name).replace(/\.nc$/, '');
  if (usedNames.has(stem.toLowerCase())) {
    fail(`two programs both write "${stem}.nc" — give the coupon's values distinct labels`);
  }
  usedNames.add(stem.toLowerCase());
  return stem;
}

function receipt(generated: EngraveGenerated, loadDiags: SimDiagnostic[], load: SimLoadOk): void {
  const warn = (findings: { severity: string; code: string; message: string }[]) => {
    for (const f of findings.filter((x) => x.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
  };
  console.log(`  stage      ${generated.stage}, ok=${generated.ok}`);
  console.log(
    `  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ` +
      `${generated.cam?.passes} passes, ~${Math.round(generated.cam?.estimatedSeconds ?? 0)}s`,
  );
  const errs = generated.findings.filter((f) => f.severity === 'error').length;
  console.log(`  findings   ${errs} error, ${generated.findings.length - errs} warning`);
  warn(generated.findings);
  warn(generated.verify?.findings ?? []);
  console.log(
    `  sim        ok=${load.ok}, count=${load.count}, removed=${load.stats.removedVolume.toFixed(2)} mm³, ` +
      `${loadDiags.filter((d) => d.severity === 'error').length} errors`,
  );
  warn(loadDiags);
}

/** What a successful `runJob` wrote, for the coupon record. */
interface JobFiles {
  ok: true;
  ncFile: string;
  frameFile: string | null;
  sheetFile: string;
  hash: string;
}
type JobResult = JobFiles | { ok: false };

/** One coupon program's place in the record file (#248 item 3's entry-point half). */
interface RecordRow {
  program: string;
  values: number[];
  ncFile: string;
  sheetFile: string;
  hash: string;
}

/**
 * Generate, verify, simulate and write one job. Returns `{ok:false}` (and prints why) if the
 * pipeline stops; a stopped job is a document to fix, not a file to hand the machine.
 */
function runJob(job: EngraveJob, outDir: string, opts: { writeJobDocument: boolean; note: string }): JobResult {
  const generated = engraveGenerate(tl, job);
  if (!generated.ok || generated.nc === null) {
    console.error(`\n${job.name}`);
    console.error(
      JSON.stringify({ stage: generated.stage, errors: generated.errors, findings: generated.findings }, null, 2),
    );
    console.error(`  !! stopped at ${generated.stage}`);
    return { ok: false };
  }

  // The generator's own "verified" gate: run the saved text through the session and refuse on an
  // error. The run sheet carries the rest (warnings, coverage) to the operator.
  const tool = jobTool(job);
  if (tool === null) fail(`tool "${job.toolKey}" is not in the tool library`);
  const session = createSimSession(tl);
  const load = session.load(generated.nc, toSetup(job, Z1), tool, Z1.id);
  if (!load.ok) {
    console.error(`\n${job.name}`);
    console.error(JSON.stringify(load.diagnostics, null, 2));
    console.error('  !! simulation refused the file');
    session.dispose();
    return { ok: false };
  }

  const stem = stemFor(job);
  // #243: the run sheet's §8 carries the coverage sentence, so the sheet must be handed the run's
  // outcome and diagnostics — exactly what the Simulate panel would. This run swept.
  const sheet = buildRunSheet(job, generated, { diagnostics: load.diagnostics, outcome: 'swept' });
  if (sheet.header.fileName !== `${stem}.nc`) {
    fail(`run sheet file name drifted: expected ${stem}.nc, got ${sheet.header.fileName}`);
  }

  const ncFile = sheet.header.fileName;
  const frameFile = runSheetFrameFileName(job.name);
  writeFileSync(join(outDir, ncFile), generated.nc);
  if (generated.frameNc !== null) writeFileSync(join(outDir, frameFile), generated.frameNc);
  writeFileSync(join(outDir, `${stem}-run-sheet.md`), renderRunSheetMarkdown(sheet, opts.note));
  if (opts.writeJobDocument) writeFileSync(join(outDir, `${stem}.job.json`), JSON.stringify(job, null, 2) + '\n');

  console.log(`\n${job.name}`);
  console.log(`  file       ${ncFile}  (${generated.nc.length} bytes, ${generated.nc.split('\n').length} lines)`);
  if (generated.frameNc !== null) console.log(`  frame      ${frameFile}  (${generated.frameNc.length} bytes)`);
  receipt(generated, load.diagnostics, load);
  console.log(`  sheet      ${stem}-run-sheet.md  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);
  session.dispose();
  return {
    ok: true,
    ncFile,
    frameFile: generated.frameNc !== null ? frameFile : null,
    sheetFile: `${stem}-run-sheet.md`,
    hash: sheet.header.fileHash,
  };
}

// ---------------------------------------------------------------------------------------------
// Input: an ordinary job document, or a coupon spec
// ---------------------------------------------------------------------------------------------

const COUPON_PARAMS: CouponSpec['parameter'][] = ['depth', 'feed', 'rpm', 'stepDown', 'stepOver'];

/**
 * Normalise a coupon spec from JSON. The `base` job is either inline (the whole `EngraveJob`) or a
 * path in `basePath` — a committed job document is the usual base, and re-typing 4 kB of it into
 * every spec is how the two drift apart. A relative `basePath` is read from the spec's own folder.
 */
function parseCouponSpec(json: unknown, path: string): CouponSpec {
  const raw = json as Partial<CouponSpec> & { base?: unknown; basePath?: unknown };
  if (!raw || typeof raw !== 'object') fail(`${path} is not a JSON object`);
  const baseJson =
    raw.base ??
    (typeof raw.basePath === 'string'
      ? readJson(isAbsolute(raw.basePath) ? raw.basePath : join(dirname(path), raw.basePath))
      : undefined);
  if (baseJson === undefined) fail(`${path} has neither "base" nor "basePath"`);
  const base = parseEngraveJob(baseJson);
  if (!base.ok) fail(`${path}: base job did not parse:\n  ${base.errors.join('\n  ')}`);
  if (!COUPON_PARAMS.includes(raw.parameter as CouponSpec['parameter'])) {
    fail(`${path}: "parameter" must be one of ${COUPON_PARAMS.join(', ')}`);
  }
  if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.some((v) => typeof v !== 'number')) {
    fail(`${path}: "values" must be a non-empty array of numbers`);
  }
  if (!raw.text || typeof raw.text.size !== 'number' || typeof raw.text.pitch !== 'number') {
    fail(`${path}: "text" needs numeric {size, pitch}`);
  }
  if (!raw.origin || typeof raw.origin.x !== 'number' || typeof raw.origin.y !== 'number') {
    fail(`${path}: "origin" needs numeric {x, y}`);
  }
  if (typeof raw.depth !== 'number') fail(`${path}: "depth" must be a number`);
  return {
    id: String(raw.id ?? basename(path).replace(/\.json$/, '')),
    title: String(raw.title ?? raw.id ?? 'coupon'),
    parameter: raw.parameter as CouponSpec['parameter'],
    values: raw.values as number[],
    base: base.job,
    text: raw.text as CouponSpec['text'],
    origin: raw.origin as CouponSpec['origin'],
    depth: raw.depth,
    font: raw.font,
    weight: raw.weight,
  };
}

if (args.job) {
  const path = args.job;
  const parsed = parseEngraveJob(readJson(path));
  if (!parsed.ok) fail(`${path} is not a valid engrave job:\n  ${parsed.errors.join('\n  ')}`);
  const outDir = args.out ?? dirname(path);
  mkdirSync(outDir, { recursive: true });
  const ok = runJob(parsed.job, outDir, {
    writeJobDocument: false,
    note: `*Generated from \`${basename(path)}\` by \`scripts/engrave-job.ts\`; the app’s \`RunSheetView\` renders the same \`buildRunSheet\` structure. No result is recorded here.*`,
  });
  if (!ok.ok) process.exit(1);
} else {
  const path = args.coupon as string;
  const spec = parseCouponSpec(readJson(path), path);
  const outDir = args.out ?? dirname(path);
  mkdirSync(outDir, { recursive: true });

  let programs;
  try {
    programs = buildCouponPrograms(spec);
  } catch (e) {
    fail((e as Error).message);
  }

  console.log(`${spec.title} — ${spec.parameter} sweep over ${spec.values.join(', ')}`);
  console.log(`${programs.length} program${programs.length === 1 ? '' : 's'} into ${outDir}`);
  const rows: RecordRow[] = [];
  let allOk = true;
  for (const program of programs) {
    const result = runJob(program.job, outDir, {
      writeJobDocument: true,
      note:
        `*Coupon program \`${program.id}\` of \`${spec.title}\` (#248): ${program.description}. ` +
        `Generated by \`scripts/engrave-job.ts\`. Fill this program's row in the coupon record — ` +
        `that record is what a measured row in \`feeds.ts\` comes from; nothing is recorded here.*`,
    });
    if (result.ok) {
      rows.push({
        program: program.id,
        values: program.values,
        ncFile: result.ncFile,
        sheetFile: result.sheetFile,
        hash: result.hash,
      });
    } else {
      allOk = false;
    }
  }

  // The ENTRY POINT's half of #248 item 3: a machine-readable record with a blank verdict per
  // program, so the measured result reaches `feeds.ts` through a file rather than a hand edit.
  // Reading it back into the table touches `feeds.ts` (nobody's file; outside this slot) and is
  // reported, not done here.
  const record = {
    coupon: spec.id,
    title: spec.title,
    parameter: spec.parameter,
    material: spec.base.stock.material,
    toolKey: spec.base.toolKey,
    generatedOn: new Date().toISOString().slice(0, 10),
    note: 'Fill "cut" with ok / poor / broke and add a note per program, then read back into feeds.ts.',
    programs: rows.map((r) => ({ ...r, cut: null as string | null, note: '' })),
  };
  const recordStem = spec.id.replace(/[^A-Za-z0-9._-]+/g, '-');
  writeFileSync(join(outDir, `${recordStem}-coupon-record.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`  record     ${recordStem}-coupon-record.json  (${rows.length} row(s) to complete)`);

  console.log(`\nreceipt: ${programs.length} program(s), ${allOk ? 'all generated' : 'SOME STOPPED — see above'}`);
  if (!allOk) process.exit(1);
}
