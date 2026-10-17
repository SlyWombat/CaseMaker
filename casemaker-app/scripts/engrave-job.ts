// The scripted engrave path (#248, closing #231 item 1): turn a COMMITTED job document into the
// files the bench needs, through the app's own pipeline — no browser, no throwaway script.
//
// #231 item 1 was that the first real bench job needed a hand-written one-off
// (`scripts/bench-files.ts`) because nothing outside the app turned an `EngraveJob` into a `.nc`
// and a run sheet. This is that entry point, and #248's coupon jobs are its first real caller.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts <job.json> [--out <dir>]
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts --coupon <coupon-spec.json> [--out <dir>]
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts --from-3mf <design.3mf>
//          [--turn ccw|cw] [--tool <key>] [--out <dir>]
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
// `--from-3mf` is the third input (#410): a PrusaSlicer PROJECT file, read as a design rather than
// as a mesh. Its blank, its magnet pocket and one engraving item per `NegativeVolume` are measured
// out of the file's own geometry (`design3mf.ts`), turned onto the jaws (`fromDesign.ts`), and
// built into a job document — which is then written alongside the program, since unlike the other
// two inputs there is no job document to read it from. `--turn` is the quarter turn that puts the
// design across the vise jaws (#383, default `ccw`); `--tool` is the cutter key (default the
// library's `flat-1.0`). Nothing is placed by hand: every number comes out of the file.
//
// `--rest none` keeps this a single-program run. Otherwise the design is cut by two cutters, and the
// second program runs on #436's two numbers — a seam band and the threshold at which a third cutter
// is suggested. NEITHER IS COMPILED IN: both are read from the `defaults` section of the machine's
// own document (`rest.overlapMm`, `rest.thirdToolPct`), seeded at 0.5 mm and 2 % and CHOSEN rather
// than measured, and each is printed with where it came from — the location's own value, or the
// labelled fallback this build carries when there is no document to read. The overlap is also
// DERIVED, per job, from the two cutters that will actually run: the stored 0.5 mm is the FLOOR
// under that derivation, not the band itself. `--overlap <mm>` and `--third-tool <pct>` override
// them for one run and are labelled as typed. The run sheet carries the same provenance, because a
// number an operator acts on has to say what it is.
//
// The machine's own tool documents are read from the same file the desktop app's embedded server
// does (`dirs::data_dir()/casemaker/`), so a job naming a cutter the user OWNS (`inv:…`) resolves
// here instead of failing as an unknown key. SINCE #412 that file is `location.json`, with
// `house.json` — what it was before the location migration — as the fallback; a run on a machine
// that has never been opened by a #412 build is exactly what it always was. Absent files are not an
// error — the built-in tier is what a headless run falls back to, the way the app itself does with
// no house service. `--location <file>` names one instead; the document's own `kind` says which of
// the two it is.
//
// For each program it writes, into `--out` (default: the document's own directory, or the working
// directory for `--from-3mf`, which has no document to sit beside):
//   <name>.nc             the cut file                        (#206)
//   <name>-frame.nc       the dry-run frame file              (#244)
//   <name>-run-sheet.md   the operator sheet, from buildRunSheet (#207)
//   <name>.job.json       the resolved job document (coupons only — the job input already exists)
// and prints a receipt: stage, feed/verify findings, sim stats and the sheet's hash. A coupon run
// ALSO writes `<id>-coupon-record.json` with a blank verdict per program — the entry point's half
// of #248 item 3. The other half is `scripts/feeds-readback.ts`, which reads the filled record
// back and flips the matching `feeds.ts` row to `measured` with the coupon and the cut date.
//
// NOTHING here measures anything. It emits INPUTS and the machine's receipt; the operator records
// the verdicts in the coupon record, and the readback applies them to the table.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { engraveGenerate, type EngraveGenerated } from '../src/workers/sim/engraveGenerate';
import { createSimSession, type SimDiagnostic, type SimLoadOk, type SimSession } from '../src/workers/sim/session';
import { unionRemoval, restMachining } from '../src/workers/sim/engraveRest';
import { restJobFor, roughPick, restToolPick, unroughedItems, type RestPassFacts } from '../src/engine/cnc/engrave/restPass';
import {
  REST_OVERLAP_KEY,
  REST_THIRD_TOOL_KEY,
  restSeamFacts,
  thirdToolAdvice,
  type RestSettingSource,
  type SeamCutter,
  type SeamFactsInput,
} from '../src/engine/cnc/engrave/restSettings';
import type { Tool } from '../src/engine/cnc/tool';
import type { NodeMeshOutput } from '../src/workers/geometry/meshOutput';
import { Z1 } from '../src/engine/cnc/machine';
import { jobTool, toSetup } from '../src/engine/cnc/engrave/jobSetup';
import {
  buildRunSheet,
  runSheetFileName,
  runSheetFrameFileName,
  type RunSheetOptions,
} from '../src/engine/cnc/engrave/runSheet';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import { simErrors, simulationProblem } from '../src/engine/cnc/simGate';
import { buildCouponPrograms, type CouponRecord, type CouponRecordRow, type CouponSpec } from '../src/engine/cnc/engrave/couponJob';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '../src/engine/fonts/registry';
import { ToolLibrarySchema, type ToolLibraryEntry } from '../src/engine/cnc/toolLibrary';
import { entryFor, getTools, setInventoryEntries, setRegistry } from '../src/engine/cnc/toolRegistry';
import {
  finerThan,
  reachabilityFor,
  reachTable,
  shareOf,
  untouchedBy,
  untouchedByAll,
  type Reachability,
  type ReachRow,
} from '../src/engine/cnc/engrave/reachability';
import { MARGIN_DEFAULTS } from '../src/engine/cnc/engrave/depthBounds';
import { engraveRegions, measureEngraving } from '../src/workers/sim/engraveGenerate';
import { cuttingDiameter } from '../src/engine/cnc/tool';
import { feedsFor } from '../src/engine/cnc/feeds';
import { jobMachine } from '../src/engine/cnc/calibration';
import { executeProfile } from '../src/workers/geometry/evaluateOp';
import { engravePreviewSvg } from './lib/engravePreviewSvg';
import { svgToPng } from './lib/svgToPng';
import { InventorySchema, type InventoryItem } from '../src/platform/houseClient';
import { checkLocationImport } from '../src/platform/locationClient';
import { KNOWN_DEFAULTS, readDefault, type ShopDefaults } from '../src/platform/defaultsClient';
import { inventoryEntryFor } from '../src/store/toolRegistryStore';
import { defaultEngraveJob } from '../src/engine/cnc/engrave/defaults';
import { viseForNewJob } from '../src/engine/cnc/fixture';
import { designJobFor, type DesignReadingDirection } from '../src/engine/cnc/engrave/fromDesign';
import { readDesign } from '../src/engine/import/design3mf';
import { parsePrusaThreeMf } from '../src/engine/import/prusa3mf';
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
// The house: the machine's own cutters, read off disk
// ---------------------------------------------------------------------------------------------

/**
 * The shop's tunable defaults, as the document holds them (#416/#417), or null when this run has no
 * document to read them from — a house file from before the section existed, or no file at all. Null
 * is not "no values": it is what {@link readDefault} answers a labelled `fallback` for, which is the
 * same thing the app itself does with no house service. Set by {@link loadDocs}; read below.
 */
let shopDefaults: ShopDefaults | null = null;

/**
 * Where the desktop app keeps the machine's own documents — `dirs::data_dir()/casemaker/` on the
 * Rust side, spelled here for the same two platforms: `%APPDATA%` on Windows, `$XDG_DATA_HOME` (or
 * `~/.local/share`) elsewhere. Deliberately the SAME path, so a headless run and the app see one
 * set of cutters; there is no second copy to drift.
 *
 * Two names, tried in order, because #412 moved the user's document from the second to the first
 * (`location.rs`): on a machine the location migration has run on, both files are on disk and only
 * `location.json` is still being edited, so reading the older one would resolve the job against a
 * frozen copy of the cutter list. On a machine it has not run on, `location.json` does not exist and
 * `house.json` is still the truth.
 */
function defaultDocPaths(): string[] {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA
      : (process.env.XDG_DATA_HOME ?? (process.env.HOME ? join(process.env.HOME, '.local', 'share') : undefined));
  if (!base) return [];
  const dir = join(base, 'casemaker');
  return [join(dir, 'location.json'), join(dir, 'house.json')];
}

/**
 * Load the machine's own documents into the tool registry, so `inv:…` keys resolve. The first path
 * that exists wins; nothing existing is not an error (see below).
 *
 * An absent or unreadable file is NOT a failure: a headless run with no document is exactly the app
 * with no house service, and the built-in tier is what both fall back to (#305). A file that is
 * present but does not match the schema IS a failure — reading half of it would put a cutter in the
 * registry that the app itself would refuse, which is worse than having none.
 *
 * A LOCATION is checked by `checkLocationImport`, the very function the panel holds an imported file
 * to (#412): one rule for the document, so a `location.json` this script reads is one the app would
 * have accepted — machine records included, which is the point of checking the whole document rather
 * than the two tiers this run actually wants. Anything of another kind is read as the house, with
 * the same two zod schemas `houseClient` uses on the HTTP path.
 */
function loadDocs(paths: readonly string[]): void {
  const path = paths.find((p) => existsSync(p));
  if (path === undefined) return; // no documents on this machine — the built-ins carry the run
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  let tools: ToolLibraryEntry[];
  let inventory: InventoryItem[];
  let what: string;
  const location = checkLocationImport(raw);
  if (location.kind === 'refused') return fail(`${path}: ${location.reason}`);
  if (location.kind === 'location') {
    tools = location.doc.tools;
    inventory = location.doc.inventory;
    // #436 — the shop's own rest-machining numbers live here, not in the source. A document that
    // predates the section reads as `{}`, which `readDefault` answers with the labelled fallback.
    shopDefaults = location.doc.defaults;
    what = `location "${location.doc.name}"`;
  } else {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      return fail(`${path} is not JSON: ${(e as Error).message}`);
    }
    const doc = json as { tools?: unknown; inventory?: unknown };
    const parsedTools = ToolLibrarySchema.safeParse(doc.tools ?? []);
    if (!parsedTools.success) return fail(`${path}: "tools" is not a tool list:\n  ${parsedTools.error.message}`);
    const parsedInventory = InventorySchema.safeParse(doc.inventory ?? []);
    if (!parsedInventory.success) return fail(`${path}: "inventory" is not an inventory:\n  ${parsedInventory.error.message}`);
    tools = parsedTools.data;
    inventory = parsedInventory.data;
    what = 'house';
  }
  setRegistry(tools);
  setInventoryEntries(inventory.map(inventoryEntryFor));
  console.log(
    `${what}: ${path} — ${tools.length} tool${tools.length === 1 ? '' : 's'} from the user's own ` +
      `list, ${inventory.length} owned cutter${inventory.length === 1 ? '' : 's'}`,
  );
  // #436 — say which rest-machining numbers this run is about to use, and where each came from, so a
  // sheet that reads oddly can be traced back to the document (or to the absence of one) before the
  // program is run. Silent about a key the document simply has not set: `readDefault` falls back and
  // the seam sentence says so where it matters.
  for (const key of [REST_OVERLAP_KEY, REST_THIRD_TOOL_KEY]) {
    const d = shopDefaults?.[key];
    if (d !== undefined) console.log(`  default ${key} = ${String(d.value)}${d.unit ?? ''} (${d.source})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------

interface Args {
  job?: string;
  coupon?: string;
  from3mf?: string;
  turn?: DesignReadingDirection;
  tool?: string;
  rest?: string;
  overlap?: number;
  /** #436 — the third-tool threshold, as a PERCENT of the design's own removal area. */
  thirdTool?: number;
  location?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--coupon') args.coupon = argv[++i];
    else if (a === '--from-3mf') args.from3mf = argv[++i];
    else if (a === '--tool') args.tool = argv[++i];
    else if (a === '--rest') args.rest = argv[++i];
    else if (a === '--overlap') {
      // Checked against the DOCUMENT's own rule for the key this flag overrides — the registry's,
      // which is the same rule `defaults.rs` holds the stored value to — rather than against a
      // second opinion about the same setting. A band the location would refuse cannot be typed
      // past it, and the bounds cannot drift apart because there is only one copy of them
      // (#436 review).
      const parsed = KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.rule.safeParse(Number(argv[++i]));
      if (!parsed.success) {
        const why = parsed.error.issues[0]?.message ?? 'the location’s own rule';
        throw new Error(`--overlap is a seam band in mm (${why}), not "${argv[i]}"`);
      }
      args.overlap = parsed.data;
    } else if (a === '--third-tool') {
      const parsed = KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.rule.safeParse(Number(argv[++i]));
      if (!parsed.success) {
        const why = parsed.error.issues[0]?.message ?? 'the location’s own rule';
        throw new Error(
          `--third-tool is a percentage of the design's removal area (${why}), not "${argv[i]}"`,
        );
      }
      args.thirdTool = parsed.data;
    } else if (a === '--location') args.location = argv[++i];
    else if (a === '--turn') {
      const v = argv[++i];
      if (v !== 'ccw' && v !== 'cw') throw new Error(`--turn must be "ccw" or "cw", not "${v}"`);
      args.turn = v;
    } else if (a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
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
  '       scripts/engrave-job.ts --coupon <coupon-spec.json> [--out <dir>]\n' +
  '       scripts/engrave-job.ts --from-3mf <design.3mf> [--turn ccw|cw] [--tool <key>]\n' +
  '              [--rest <key|none>] [--overlap <mm>] [--third-tool <pct>] [--out <dir>]\n' +
  '       [--location <location.json|house.json>]  (any input; default: the app’s own location)';

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\n${USAGE}`);
  throw e; // unreachable; `fail` exits
}
const inputs = [args.job, args.coupon, args.from3mf].filter((v) => v !== undefined);
if (inputs.length === 0) fail(USAGE);
if (inputs.length > 1) fail('pass a job, --coupon OR --from-3mf — exactly one');
if (!args.from3mf && (args.turn || args.tool || args.rest || args.overlap !== undefined || args.thirdTool !== undefined)) {
  fail('--turn, --tool, --rest, --overlap and --third-tool only apply to --from-3mf');
}

// Before ANY job resolves a cutter: `jobTool` reads the registry, so the machine's own documents
// have to be in it first.
loadDocs(args.location === undefined ? defaultDocPaths() : [args.location]);

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`);
  }
};

// ---------------------------------------------------------------------------------------------
// Which cutter: the reachability table (#410)
// ---------------------------------------------------------------------------------------------

/**
 * Measure every cutter the registry offers against this job's items.
 *
 * The catalogue is `[]`, the same empty list `engraveGenerate` is handed on this path: no Makera
 * feed rows reach a headless run (#324), so the pre-filter asks the starting table and the machine
 * and nothing else. That is a deliberate narrowing, and it is why `--tool` exists — a cutter the
 * house's catalogue alone can vouch for will not be chosen here, but it can still be named.
 *
 * #455's material-list rule therefore cannot fire on this path either: it is the CATALOGUE saying
 * "not for this material", and there is no catalogue here to say it. Nothing is lost from the
 * reporting side — `reachTable` prints a `no-catalogue-row` cutter with the catalogue's own sentence
 * (`CutterReach.excludedNote`), so a caller that HAS rows gets the why in the same table and column
 * as every other exclusion. Loading a catalogue into the CLI would be new plumbing, not this rule.
 */
function scanReach(job: EngraveJob): ReturnType<typeof reachabilityFor> {
  return reachabilityFor(job, getTools(), [], (key) => {
    const entry = entryFor(key);
    return entry === null ? [] : measureEngraving(tl, job, entry.tool);
  });
}

/** The table as the operator reads it: one line per cutter, one column per item, in per cent. */
function printReach(reach: ReturnType<typeof reachabilityFor>): void {
  const rows = reachTable(reach);
  if (rows.length === 0) return;
  const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
  console.log('\nwhat each cutter reaches, item by item, and over the design as a whole:');
  console.log(`  ${'cutter'.padEnd(24)} ${'   ⌀'.padEnd(10)} ${reach.items.map((i) => i.name).join(' | ')}`);
  for (const row of rows) {
    const cells = row.shares.map(pct).map((s) => s.padStart(6)).join('  ');
    const verdict =
      row.excluded !== null ? row.excluded : row.qualifies ? 'keeps every item intact' : 'loses detail';
    console.log(
      `  ${row.key.padEnd(24)} ${`${row.diameter} mm`.padStart(9)}  ${cells}   ` +
        `${pct(row.total).padStart(5)} total   ${verdict}`,
    );
  }
  const pick = reach.recommendation.key;
  const finer = pick === null ? null : finerThan(reach, pick);
  if (pick !== null && finer !== null) {
    console.log(
      `  → #211 picks ${pick} (${pct(reach.totalShare.get(pick) ?? 0)} of the design); ${finer.key} reaches ` +
        `${pct(reach.totalShare.get(finer.key) ?? 0)}, so what is left is worth a second program (#410).`,
    );
  } else if (pick !== null) {
    console.log(`  → #211 picks ${pick}, and no smaller cutter reaches more: one program is enough.`);
  }
  // #455 — a caution about the cutter the job NAMES, when it is not one the catalogue recommends.
  // Always null on this path (no catalogue is loaded; see `scanReach`), but printed here rather
  // than in each caller so a run that does have rows cannot silently drop it.
  if (reach.recommendation.selectedNote !== null) console.log(`  ! ${reach.recommendation.selectedNote}`);
}

/**
 * A cutter chosen for one of the two programs: the key the job will carry, the number the sheet
 * prints, and the sentence saying who chose it.
 *
 * The three travel together because the route has two ways to arrive at a cutter — a rule over the
 * reachability table, or a `--tool`/`--rest` on the command line — and every downstream use (the
 * ⌀² × share score, the overlap default, the sheet's prose) needs all three. Passing a bare key
 * around would mean re-deriving the diameter at each of them, which is how two numbers for one
 * cutter get into one run sheet.
 */
interface Chosen {
  key: string;
  /** Cutting diameter, mm. */
  diameter: number;
  reason: string;
}

/** A cutter named on the command line, resolved through the same registry a job resolves one. */
function cutterNamed(key: string, flag: string): Chosen {
  const entry = entryFor(key);
  if (entry === null) fail(`${flag} "${key}" is not in the tool library`);
  const diameter = cuttingDiameter(entry.tool);
  if (diameter === null || !(diameter > 0)) {
    fail(`${flag} "${key}" has no cutting diameter, so it cannot be sized against the design`);
  }
  return { key, diameter, reason: `named on the command line (${flag} ${key})` };
}

/** The library's own `Tool` for a cutter this route chose, or a refusal naming it. */
function toolFor(chosen: Chosen, what: string): Tool {
  const entry = entryFor(chosen.key);
  if (entry === null) fail(`${what} "${chosen.key}" is not in the tool library`);
  return entry.tool;
}

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

/**
 * The receipt for a job that got through. The count is kept beside each list for the run's summary
 * line, but every error is NAMED (#393): a bare count tells the operator that something is wrong
 * and not what, so a program whose cutter reached the jaw reads exactly like one that grazed the
 * stock top. The warnings are the run sheet's business and are carried there.
 *
 * No simulation error reaches here: `runJob` names them and stops before this prints. The count
 * stays on the line anyway (through the same `simErrors` the refusal uses), so the line reads the
 * same whether it is a receipt or a post-mortem.
 */
function receipt(generated: EngraveGenerated, loadDiags: SimDiagnostic[], load: SimLoadOk): void {
  const warn = (findings: { severity: string; code: string; message: string }[]) => {
    for (const f of findings.filter((x) => x.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
  };
  console.log(`  stage      ${generated.stage}, ok=${generated.ok}`);
  console.log(
    `  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ` +
      `${generated.cam?.passes} passes, ~${Math.round(generated.cam?.estimatedSeconds ?? 0)}s`,
  );
  const errs = generated.findings.filter((f) => f.severity === 'error');
  console.log(`  findings   ${errs.length} error, ${generated.findings.length - errs.length} warning`);
  for (const f of errs) console.log(`     ERROR ${f.code}: ${f.message}`);
  warn(generated.findings);
  warn(generated.verify?.findings ?? []);
  console.log(
    `  sim        ok=${load.ok}, engine=${load.stats.engine}, count=${load.count}, ` +
      `removed=${load.stats.removedVolume.toFixed(2)} mm³, ${simErrors(loadDiags).length} errors`,
  );
  warn(loadDiags);
}

/** What a successful `runJob` wrote, for the coupon record. */
interface JobFiles {
  ok: true;
  ncFile: string;
  frameFile: string | null;
  /** Null only when the caller asked for no sheet — the rest program of a two-tool job. */
  sheetFile: string | null;
  hash: string;
  /**
   * #410 — the predicted cut as a picture, when the caller asked for one, ONE PER PROGRAM. The SVG
   * is returned as TEXT rather than only written, because the PNG is made by a browser and
   * `writeProgram` is synchronous: the caller awaits that render and the sheet's own writer never
   * has to know about chromium.
   */
  previews: { svg: string; svgFile: string; pngFile: string }[];
}
type JobResult = JobFiles | { ok: false };

/** A program that has been generated, verified and simulated — and not yet written anywhere. */
interface Prepared {
  /**
   * The discriminant is stated rather than inferred: `{ok:false}` has no `job`/`tool`/… to narrow
   * on, so a union of `Prepared | {ok:false}` would leave every field below optional at the use
   * site and `if (!prepared.ok) process.exit(1)` would narrow nothing.
   */
  ok: true;
  job: EngraveJob;
  tool: Tool;
  /** The program text, already known non-null — `prepare` refuses a job that produced none. */
  nc: string;
  /** `cuttingDiameter(tool)`, resolved once here so no caller re-derives it (#410's two programs). */
  diameter: number;
  generated: EngraveGenerated;
  load: SimLoadOk;
  /**
   * LIVE, and the caller's to dispose. It is handed back rather than disposed here because a
   * two-tool job needs what it owns: `load.meshes.removal` is the material the SECOND program's
   * sweep has to start from (`priorRemoval`), and a mesh that was freed with the session cannot
   * seed anything.
   */
  session: SimSession;
}
type PrepareResult = Prepared | { ok: false };

/** How a program is written, once it is known to be good. */
interface WriteOpts {
  writeJobDocument: boolean;
  note: string;
  /** Extra sections for the sheet (#410: the reachability table, the two-tool narrative). */
  sheetOptions?: RunSheetOptions;
  /** Also write `<stem>-preview.svg`, drawn at the cutter's real width. Off by default. */
  preview?: boolean;
  /**
   * Write the run sheet. FALSE for the second program of a two-tool job: this sheet IS the setup's
   * sheet — its header names program 1's file and hash — and the rest pass is a step of it, so a
   * second document for the same block would be two sheets with one truth.
   */
  sheet?: boolean;
}

/**
 * Generate, verify and simulate one job. Returns `{ok:false}` (and prints why) if the pipeline
 * stops; a stopped job is a document to fix, not a file to hand the machine.
 *
 * Split out from `writeProgram` for #410's two-tool pass: the rest program's geometry cannot be
 * computed until the FIRST program has been swept, because the rest region is measured against the
 * material that sweep says was removed. So the pipeline runs twice, with the second sweep seeded by
 * the first's result, and only then is anything written.
 */
function prepare(job: EngraveJob, opts: { priorRemoval?: NodeMeshOutput } = {}): PrepareResult {
  // No Makera feed rows in a headless run (#324): the catalogue tier needs a house service.
  const generated = engraveGenerate(tl, job, jobTool(job), []);
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
  const diameter = cuttingDiameter(tool);
  if (diameter === null || !(diameter > 0)) {
    fail(`tool "${job.toolKey}" has no cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})`);
  }
  const nc = generated.nc;
  const session = createSimSession(tl);
  const load = session.load(
    generated.nc,
    toSetup(job, Z1),
    tool,
    Z1.id,
    opts.priorRemoval === undefined ? {} : { priorRemoval: opts.priorRemoval },
  );
  if (!load.ok) {
    console.error(`\n${job.name}`);
    console.error(JSON.stringify(load.diagnostics, null, 2));
    console.error('  !! simulation refused the file');
    session.dispose();
    return { ok: false };
  }

  // #393 — THE OTHER HALF OF THE GATE, and the one that was missing. `load.ok` means the sweep
  // produced material, NOT that the program is safe: a run that drove the cutter 0.97 mm³ into the
  // fixed jaw is `ok: true` with a `tool-into-fixture` ERROR among its diagnostics, because the
  // panel has to be able to DRAW that cut (`simGate.ts`). Trusting `ok` alone wrote four 11.5 mm
  // coupons whose own simulation said they hit the jaw, and receipted them "all generated".
  const simProblem = simulationProblem(load.diagnostics);
  if (simProblem !== null) {
    console.error(`\n${job.name}`);
    for (const d of simErrors(load.diagnostics)) console.error(`  ERROR ${d.code}: ${d.message}`);
    console.error(`  !! ${simProblem}`);
    console.error(`  !! nothing written: a job the simulation refuses is a document to fix, not a file`);
    session.dispose();
    return { ok: false };
  }

  return { ok: true, job, tool, nc, diameter, generated, load, session };
}

/**
 * Write one prepared program: the `.nc`, its frame, its run sheet, and — for the routes that build
 * a document rather than read one — the job JSON. Disposes the session on the way out, so a
 * prepared program cannot outlive its sweep by accident.
 */
function writeProgram(prepared: Prepared, outDir: string, opts: WriteOpts): JobFiles {
  const { job, tool, nc, diameter, generated, load } = prepared;
  const writeSheet = opts.sheet !== false;
  // The stem is claimed through `stemFor`, which refuses a name already used this run: the rest
  // program of a two-tool job is written from a job named `<name> rest`, so the two programs land
  // as `<stem>.nc` and `<stem>-rest.nc` and a collision is a defect rather than a silent overwrite.
  const stem = stemFor(job);
  // #243: the run sheet's §8 carries the coverage sentence, so the sheet must be handed the run's
  // outcome and diagnostics — exactly what the Simulate panel would. This run swept.
  const sheet = buildRunSheet(
    job,
    generated,
    { diagnostics: load.diagnostics, outcome: 'swept', engine: load.stats.engine },
    new Date(),
    MARGIN_DEFAULTS,
    opts.sheetOptions ?? {},
  );
  if (sheet.header.fileName !== `${stem}.nc`) {
    fail(`run sheet file name drifted: expected ${stem}.nc, got ${sheet.header.fileName}`);
  }

  const ncFile = sheet.header.fileName;
  const frameFile = runSheetFrameFileName(job.name);
  writeFileSync(join(outDir, ncFile), nc);
  if (generated.frameNc !== null) writeFileSync(join(outDir, frameFile), generated.frameNc);
  if (writeSheet) writeFileSync(join(outDir, `${stem}-run-sheet.md`), renderRunSheetMarkdown(sheet, opts.note));
  if (opts.writeJobDocument) writeFileSync(join(outDir, `${stem}.job.json`), JSON.stringify(job, null, 2) + '\n');

  // #410 — THE PREDICTED CUT, DRAWN AT THE CUTTER'S REAL WIDTH. The table says a percentage; a
  // percentage does not show WHICH strokes survive, and that is the thing that decides whether the
  // badge reads. Everything here comes from `engraveRegions`, the ONE place the cut classes are
  // enumerated (#288) — so the opening, the swept trace and the drill in the picture are the ones in
  // the program, and the void rings are the same footprints the depth limit is computed against.
  // It costs one more evaluation of the job, which is why it is opt-in.
  const previews: JobFiles['previews'] = [];
  if (opts.preview === true) {
    const drawn = engraveRegions(tl, job, tool);
    const head = drawn.plan.stock.keepOuts.map((ko) => {
      const cs = executeProfile(tl, ko.footprint);
      try {
        return { id: ko.id, name: ko.name, polygons: cs.toPolygons() as [number, number][][] };
      } finally {
        cs.delete();
      }
    });
    const svgFile = `${stem}-preview.svg`;
    const svg = engravePreviewSvg({
      job,
      cuts: drawn.cuts,
      diameter,
      ratios: new Map(drawn.measured.map((m) => [m.labelId, m.ratio] as const)),
      keepOuts: head,
    });
    writeFileSync(join(outDir, svgFile), svg);
    previews.push({ svg, svgFile, pngFile: `${stem}-preview.png` });
  }

  console.log(`\n${job.name}`);
  console.log(`  file       ${ncFile}  (${nc.length} bytes, ${nc.split('\n').length} lines)`);
  if (generated.frameNc !== null) console.log(`  frame      ${frameFile}  (${generated.frameNc.length} bytes)`);
  receipt(generated, load.diagnostics, load);
  if (writeSheet) {
    console.log(`  sheet      ${stem}-run-sheet.md  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);
  }
  for (const p of previews) console.log(`  preview    ${p.svgFile}  (the caller renders the PNG)`);
  prepared.session.dispose();
  return {
    ok: true,
    ncFile,
    frameFile: generated.frameNc !== null ? frameFile : null,
    sheetFile: writeSheet ? `${stem}-run-sheet.md` : null,
    hash: sheet.header.fileHash,
    previews,
  };
}

/** Generate, verify, simulate and write one job — the two calls above, in order. */
function runJob(
  job: EngraveJob,
  outDir: string,
  opts: {
    writeJobDocument: boolean;
    note: string;
    reachability?: Reachability;
    unreachable?: { row: ReachRow; cutters: number }[];
    preview?: boolean;
  },
): JobResult {
  const prepared = prepare(job);
  if (!prepared.ok) return { ok: false };
  return writeProgram(prepared, outDir, {
    writeJobDocument: opts.writeJobDocument,
    note: opts.note,
    ...(opts.reachability === undefined
      ? {}
      : { sheetOptions: { reachability: opts.reachability, ...(opts.unreachable ? { unreachable: opts.unreachable } : null) } }),
    ...(opts.preview === true ? { preview: true } : null),
  });
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
} else if (args.from3mf) {
  const path = args.from3mf;
  const direction = args.turn ?? 'ccw';
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
  const names = new Set<string>();

  const design = (() => {
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return readDesign(tl, parsePrusaThreeMf(ab));
    } catch (e) {
      return fail(`${path}: ${(e as Error).message}`);
    }
  })();

  const patch = designJobFor(design, { direction });
  // The blank and the items are the design's; everything else (the vise, the margins, the sacrificial
  // setup) is the shipped default, because the 3MF says nothing about how the block is held. It is a
  // PATCH for exactly that reason — see `fromDesign.ts` — and `--tool` is the one thing the operator
  // overrides here, since the design states no cutter.
  // The blank is 3.81 mm thick and `DEFAULT_VISE`'s shipped 4 mm working height is taller than the
  // whole part, so a job built straight from the shipped default is refused outright
  // (`vise-stock-proud-exceeds-thickness`, #231 item 2). `viseForNewJob` is the seam that exists for
  // exactly this: it re-derives `stockProud` from the stock — 0.71 mm here, the blank seated on the
  // soft jaws' ledges — instead of the flat working height. A new job in the panel goes through the
  // same function; this is not a special case for the 3MF route.
  const base = defaultEngraveJob(viseForNewJob(undefined, patch.stock));
  // The patch states a material only when the file's own `filament_type` names one this app knows
  // (#456); otherwise it omits the key, and the job keeps the material the default job gives — the
  // same PLA this script built before, rather than an omission the schema would refuse.
  const stock: EngraveJob['stock'] = {
    ...patch.stock,
    material: patch.stock.material ?? base.stock.material,
  };
  const job: EngraveJob = {
    ...base,
    name: patch.name,
    stock,
    // All three text items arrive as measured VECTOR items: the file carries the outlines, not the
    // strings, so nothing here is re-rendered from a font. Leaving the default job's demo labels in
    // would cut `CASE`/`MAKER` into the maintainer's badge.
    labels: [],
    vectors: patch.vectors,
    keepOuts: patch.keepOut ? [patch.keepOut] : [],
    sources: { ...base.sources, ...patch.sources },
    ...(args.tool ? { toolKey: args.tool } : {}),
  };

  // WHICH CUTTERS (#410, and the maintainer's scope note of 2026-10-15). The design states none, so
  // the questions are asked here, in the order the panel asks them — and since that note there are
  // TWO of them: which bit takes the FIRST bite, and whether a second one earns a program of its own
  // for what the first could not reach.
  //
  // The FIRST bit. With a rest pass the design wants the cutter that moves the most material —
  // `⌀² × share`, the rule `roughPick` states and ranks. Without one it wants #211's single-cutter
  // answer, exactly as this route chose before the scope note, so `--rest none` reproduces the
  // earlier run programme for programme. `--tool` names the bit either way.
  //
  // The SECOND bit. `reachability.ts`'s `finerThan` already answers it — the smallest cutter that
  // reaches strictly more of the design — and `--rest <key>` overrides that. `--rest none` skips the
  // pass entirely, which is what a design one bit can cut wants.
  const scanned = scanReach(job);
  printReach(scanned);

  // WHAT NOTHING CAN CUT. A region no owned cutter reaches is not a bad choice of cutter — it is
  // detail finer than anything on the bench, and #201 makes it a hard `item-empty` refusal that no
  // `--tool` can clear. Left enabled it stops the whole program for a fact about the DESIGN, so the
  // item is turned OFF and named: it stays in the document with its volume's name, drawing nothing,
  // and the run sheet's reachability section is where the number is written down. This is the one
  // place the design route edits what the file said, and it says so.
  const unreachable = untouchedByAll(scanned);
  for (const { row, cutters } of unreachable) {
    const item = (job.vectors ?? []).find((v) => v.id === row.itemId);
    if (item) item.enabled = false;
    console.log(
      `  dropped    ${row.name} (${row.itemId}): none of the ${cutters} measured cutters reaches any ` +
        `of its ${row.glyphArea.toFixed(2)} mm² — the strokes are finer than the smallest bit on the ` +
        'bench. It stays in the job, turned off, and the run sheet carries the number.',
    );
  }

  // MEASURE THE JOB, NOT THE FILE — and only when the two differ. The table above is the file's: it
  // has a column for a region nothing reaches, which is the whole reason the drop happened. But a
  // share is a fraction of the design, and once a region is off the design is smaller, so leaving
  // the table as the picker's input would recommend a bit for a job one column wider than the one
  // that gets cut. The second pass is skipped when nothing was dropped, so an ordinary file costs
  // exactly what it always did.
  const cut = unreachable.length === 0 ? scanned : scanReach(job);

  const pick = roughPick(cut);
  const restOff = args.rest === 'none';
  const auto1 = restOff ? cut.recommendation.key : (pick.chosen?.key ?? cut.recommendation.key);
  const tool1Key = args.tool ?? auto1;
  if (tool1Key === null) fail(`no cutter in the library can cut this design: ${cut.recommendation.reason}`);
  job.toolKey = tool1Key;
  // The sentence the run sheet prints for the first bit. When the rule chose it, the rule's own
  // sentence — it carries this design's share and score, which is the whole reason to trust it. When
  // `--tool` overrode the rule, that, plus what the rule would have taken: a sheet that presented an
  // override as the rule's answer would be telling the operator something untrue about their own job.
  const roughReason =
    args.tool === undefined
      ? restOff
        ? cut.recommendation.reason
        : pick.reason
      : `named on the command line (--tool ${tool1Key})` +
        (pick.chosen !== null && !restOff && pick.chosen.key !== tool1Key
          ? `; the clearance rule would have taken ${pick.chosen.key} (⌀² × share = ${pick.chosen.score.toFixed(2)})`
          : '');
  console.log(`  cutter 1   ${tool1Key} — ${roughReason}`);

  const restChosen: Chosen | null = (() => {
    if (restOff) return null;
    if (args.rest !== undefined) return cutterNamed(args.rest, '--rest');
    const choice = restToolPick(cut, tool1Key);
    return choice.cutter === null
      ? null
      : { key: choice.cutter.key, diameter: choice.cutter.diameter, reason: choice.reason };
  })();
  if (restChosen !== null) console.log(`  cutter 2   ${restChosen.key} — ${restChosen.reason}`);
  const restTool: Tool | null = restChosen === null ? null : toolFor(restChosen, '--rest');

  // WHAT THE SECOND BIT COULD OPEN, over the design as the FILE asked for it — measured BEFORE
  // program 1's items are turned off, because an item the first bit cannot enter at all is entirely
  // the second one's job and a table measured on the reduced job could not say so. `engraveRegions`
  // is the same measurement the generator itself makes, so the region the rest pass cuts is the
  // region this route reasoned about (#288's one enumeration of the cut classes).
  const designCuts = restTool === null ? [] : engraveRegions(tl, job, restTool).cuts;

  // WHAT PROGRAM 1 LEAVES OFF. An item the first bit cannot enter AT ALL is a hard `item-empty`
  // refusal, so with a rest pass it is turned off in program 1 and named — the second program cuts
  // it, and the sheet says which file that is. Without a rest pass NOTHING is turned off: the
  // refusal is then the right answer, because there is no other program to cut the region in, and
  // dropping it quietly is the one thing the issue forbids.
  const unroughed = restChosen === null ? [] : unroughedItems(cut, tool1Key);
  for (const item of unroughed) {
    const v = (job.vectors ?? []).find((x) => x.id === item.id);
    if (v) v.enabled = false;
    console.log(
      `  left to 2  ${item.name} (${item.id}): ${tool1Key} cannot enter any of its ` +
        `${item.area.toFixed(2)} mm², so the first program leaves it off and ${restChosen?.key} cuts it ` +
        `at ${item.depth.toFixed(2)} mm.`,
    );
  }

  // The other 0 % case, and a different sentence: THIS cutter misses the item, and something else
  // does not. With a rest pass the item is one the second program will cut and the note above has
  // already said so; without one, nothing is turned off and the job is refused by `item-empty` as it
  // always was, so the reason is a cutter choice the operator can change rather than a fact.
  if (restChosen === null) {
    for (const row of untouchedBy(cut, job.toolKey)) {
      const finer = cut.cutters
        .filter((c) => c.excluded === null)
        .map((c) => ({ key: c.key, row: c.rows.find((r) => r.itemId === row.itemId) }))
        .find((c) => c.row !== undefined && c.row.ratio > 0);
      console.log(
        `  note       ${job.toolKey} reaches none of ${row.name}` +
          (finer ? `; ${finer.key} reaches ${Math.round((finer.row?.ratio ?? 0) * 100)} % of it` : '') +
          ' — the generator will refuse this job until it is cut with a finer bit or turned off.',
      );
    }
  }

  // Round the assembled document through the SAME schema the app loads with, and require it to come
  // back UNCHANGED. A field the schema does not know is SILENTLY STRIPPED (`library/schema.ts`'s
  // trap, #254), so a job built here and a job loaded from the document this run writes would
  // differ — and the difference would only show up as an item that is missing at the bench. Sorted
  // keys, so a reordered object is not mistaken for a lost field.
  //
  // A function since #410, because the rest program is a second document this route BUILDS and
  // writes, and a schema that strips a field out of it is the same defect one file further along.
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  const roundTrips = (doc: EngraveJob, what: string): void => {
    const reparsed = parseEngraveJob(JSON.parse(JSON.stringify(doc)));
    if (!reparsed.ok) fail(`the ${what} built from ${path} does not parse:\n  ${reparsed.errors.join('\n  ')}`);
    if (JSON.stringify(canonical(reparsed.job)) !== JSON.stringify(canonical(doc))) {
      fail(
        `the job schema does not round-trip the ${what} built from ${path} — a field it does not know ` +
          'is stripped on load, so this document would lose it. Add it to the schema first.',
      );
    }
  };
  roundTrips(job, 'job');

  const outDir = args.out ?? process.cwd();
  mkdirSync(outDir, { recursive: true });
  for (const item of patch.vectors) if (item.name !== undefined) names.add(item.name);
  console.log(
    `${basename(path)} — ${design.regions.length} item${design.regions.length === 1 ? '' : 's'} ` +
      `(${[...names].join(', ')}), turned ${direction}, ${patch.stock.length} × ${patch.stock.width} × ` +
      `${patch.stock.thickness} mm ${patch.stock.material}`,
  );
  for (const note of patch.notes) console.log(`  ${note}`);

  const note =
    `*Built from \`${basename(path)}\` by \`scripts/engrave-job.ts --from-3mf\` (#410): the blank, the ` +
    `magnet pocket and each item were measured out of the project file and turned 90° ` +
    `${direction === 'ccw' ? 'counter-clockwise' : 'clockwise'} onto the jaws (#383). No number here ` +
    'was typed in by hand.*';

  // Every program this run wrote, so the caller can render each PNG once both files exist.
  const previews: JobFiles['previews'] = [];

  // ONE PROGRAM. Either no second cutter was measured (`restToolPick` says which), or `--rest none`
  // asked for the single-program answer — which is byte-for-byte what this route wrote before the
  // scope note, so the earlier acceptance still holds over the same input.
  if (restChosen === null) {
    const ok = runJob(job, outDir, {
      writeJobDocument: true,
      // #410 — the measurements this route already made ARE the run sheet's reachability section, and
      // they are handed over rather than re-measured: the sheet must print the numbers that chose the
      // bit. `cut` is the job as it will be generated; `unreachable` is what left it, which `cut` can
      // no longer say because the region is not in the table at all.
      reachability: cut,
      unreachable,
      // The design route is the one that asks for the picture: the file's regions are imported
      // outlines, so the ideal outline this draws is the design's own, not a re-typesetting of it.
      preview: true,
      note,
    });
    if (!ok.ok) process.exit(1);
    previews.push(...ok.previews);
  } else {
    // ---- PROGRAM 1: the clearing pass ----------------------------------------------------------
    // Nothing is written yet. The rest region cannot be computed until this program has been swept,
    // because it is measured against the material the sweep says was removed — so the pipeline runs
    // twice and only then does anything reach the disk.
    const p1 = prepare(job);
    if (!p1.ok) process.exit(1);

    // ---- WHAT PROGRAM 1 LEFT ---------------------------------------------------------------
    // Against its own SIMULATED REMOVAL, not against its offsets (#410's scope note: "computed from
    // tool 1's simulated removal, not from its offset alone").
    //
    // THE BAND IS DERIVED PER JOB, AND ITS FLOOR IS THE SHOP'S OWN DOCUMENT (#436; the maintainer,
    // 2026-10-16: "~0.5 mm, worked out per job", and "That type of setting should be something we
    // keep in our own database and not compiled in"). The stored `rest.overlapMm` — read from
    // `location.json`'s `defaults`, seeded at 0.5 mm, CHOSEN rather than measured (Q19), to be
    // updated from the first two-tool cut — is the LEAST the band may be; what the job's own pair of
    // cutters needs sets it when that is wider. `--overlap` is an operator's override of both and is
    // used exactly as typed. The source travels with the number, so the sheet says which of them the
    // operator is reading — and what the pair says about it either way, including when the answer is
    // "this band is too narrow". `restSettings.ts` is where every part of that judgement lives.
    //
    // WHAT A BAND HAS TO BEAT, measured on the badge blank (#410). The rest region is a RESIDUE: the
    // slivers tool 1's scalloped boundary left behind, plus every feature too narrow for it to
    // enter. A residue sliver is about `r1 − √(r1² − s1²/4)` wide — 0.107 mm for ⌀2 mm at a 0.9 mm
    // step-over — and `engravableProfile` closes anything narrower than `2·r2`, the second cutter's
    // own diameter. A sliver therefore survives to be cut only when `sliver + overlap ≥ diameter2`,
    // so the band THIS pair needs is about 0.493 mm: at a 0.1 mm band the badge left 12.24 mm²
    // (3.41 % of what it asks to remove) standing, and at 0.6 mm only 0.79 mm² (0.22 %) — so the
    // 0.5 mm the shop now seeds is the value that derivation points at, which is why it is the seed
    // and not the old 0.1. Nothing narrower than the residues need reaches this route through the
    // document: the derivation raises the band past the seed, and only a typed `--overlap` can put a
    // too-narrow band in front of the operator — which is exactly when the sheet has to say so. The
    // sheet reports the gap and the leftovers per item, in mm², whichever band the run used.
    //
    // WHAT IT COSTS AT THE BAND THE RESIDUES NEED, also measured: the grown region is 233.9 mm²
    // where only 101.5 mm² of it was ever standing material, so the second program re-traverses the
    // seam band at fine-bit pace — 21 min 35 s against the first program's 94 s, for a pair total of
    // 23 min 9 s where one ⌀0.6 mm program takes 22 min 21 s. The split is a wash on a design whose
    // rest is the STROKES; it pays where the rest is a few compact regions and the wide bit does
    // most of the design.
    // `restChosen` is non-null in this branch, so `restTool` resolved — this is the type's own guard,
    // and it fails rather than falling through, because a rest program without its cutter is not one.
    if (restTool === null) fail(`--rest "${restChosen.key}" did not resolve to a cutter`);
    const restFeeds = feedsFor([], job.stock.material, restTool, jobMachine(job), undefined);
    const stepOver2 = restFeeds.ok ? restFeeds.params.stepOver : null;
    // The FIRST cutter's step-over shapes the residue the band has to make cuttable, so it comes
    // from the same feeds table through the same resolver as the second one — never from a number
    // typed into this file.
    const tool1 = jobTool(job);
    const roughFeeds = tool1 === null ? null : feedsFor([], job.stock.material, tool1, jobMachine(job), undefined);
    const stepOver1 = roughFeeds !== null && roughFeeds.ok ? roughFeeds.params.stepOver : null;
    // The stored number and where it came from, together — never the number alone (#436).
    const overlapRead = readDefault(shopDefaults, REST_OVERLAP_KEY);
    const roughCutter: SeamCutter = { key: tool1Key, diameter: p1.diameter, stepOver: stepOver1 };
    const restCutter: SeamCutter = {
      key: restChosen.key,
      diameter: restChosen.diameter,
      stepOver: stepOver2,
    };
    // THE BAND THIS JOB CUTS WITH IS DERIVED, and the stored number is the FLOOR under it (#436
    // review item 1). The maintainer's rule is "~0.5 mm, worked out per job": a pair whose residues
    // need more than the shop stores gets the wider band, and one that needs less keeps the shop's,
    // which is the number the shop has a reason for. `--overlap` is an operator's override of both
    // and is used exactly as typed, so a deliberately narrow band is a measurement rather than a
    // no-op. `overlapForJob` is where that choice lives; nothing here re-decides it.
    const overlapSource: RestSettingSource = args.overlap === undefined ? overlapRead.source : 'user';
    const thirdToolRead = readDefault(shopDefaults, REST_THIRD_TOOL_KEY);
    const thirdToolPct = args.thirdTool ?? thirdToolRead.value;
    const thirdToolSource: RestSettingSource = args.thirdTool === undefined ? thirdToolRead.source : 'user';
    const seam = restSeamFacts({
      stored: overlapRead.value,
      ...(args.overlap === undefined ? null : { typed: args.overlap }),
      source: overlapSource,
      rough: roughCutter,
      rest: restCutter,
    } satisfies SeamFactsInput);
    // The band the programs are actually handed — not the stored number, which is only its floor.
    const overlap = seam.overlap;
    console.log(`  overlap    ${overlap.toFixed(3)} mm — ${seam.note}`);
    // "the floor it started from", not "the location's value": the floor is the fallback too on a
    // build with no location to read, and a sentence naming the wrong one is the defect this route
    // exists to avoid.
    if (seam.derivedFromCutters && seam.needed !== null) {
      console.log(
        `  overlap    raised off the ${overlapRead.value.toFixed(3)} mm floor this run started from: ` +
          `the band this job’s own two cutters need is ${seam.needed.toFixed(3)} mm`,
      );
    }
    // An unknown step-over is a MISSING number, and it is reported as one: "narrower than unknown mm"
    // claimed a comparison that was never made (#436 review).
    if (seam.restStepOver === null) {
      console.log(
        '  seam       this material states no step-over for the second cutter, so whether the band ' +
          'reaches past its own scallop is not judged here',
      );
    } else if (!seam.coversScallop) {
      console.log(
        '  seam       a ridge can survive where the two programs meet: the band is narrower than ' +
          `the second cutter’s own scallop (${seam.restStepOver.toFixed(3)} mm)`,
      );
    }
    if (seam.needed !== null && !seam.keepsSlivers) {
      console.log(
        `  seam       the first cutter leaves slivers about ${seam.sliver.toFixed(3)} mm wide and the ` +
          `second cutter closes anything under ${seam.restDiameter.toFixed(3)} mm, so a band of about ` +
          `${seam.needed.toFixed(3)} mm is what keeps them cuttable — this one is under it, and they ` +
          'are counted in the leftover instead of being cut',
      );
    }
    const rest1 = restMachining(tl, { removal: p1.load.meshes.removal, cuts: designCuts, overlap });
    for (const n of rest1.notes) console.log(`  rest       ${n}`);

    // WHICH REST REGIONS THE SECOND BIT CAN ACTUALLY OPEN. A rest region can be a sliver the first
    // cutter could not quite reach, and `engravableProfile` closes a region narrower than the bit
    // that is supposed to cut it (`offset(-r)` then `offset(+r)`) — down to nothing, which is
    // `item-empty`, a hard refusal that would stop the SECOND program over a region the design was
    // never going to give up anyway. So each region is measured with the same call the generator
    // will make, and the ones that come back empty are dropped here and accounted for in the
    // leftover number below. Nothing is silently lost: it moves from "program 2 cuts this" to "no
    // cutter reaches this", which is a number the sheet prints.
    let kept = rest1.regions;
    if (kept.length > 0) {
      const open = new Set(
        engraveRegions(tl, restJobFor(job, kept, restChosen.key), restTool)
          .measured.filter((m) => m.openedArea > 0)
          .map((m) => m.labelId),
      );
      const dropped = kept.filter((_, i) => !open.has(`rest-${i + 1}`));
      kept = kept.filter((_, i) => open.has(`rest-${i + 1}`));
      for (const r of dropped) {
        console.log(
          `  too fine   ${r.name ?? r.id}: the rest of it is ${r.area.toFixed(3)} mm² of corner, and ` +
            `${restChosen.key} closes it to nothing — the second program would refuse the whole job ` +
            'over it, so it is left standing and counted.',
        );
      }
    }

    let p2: Prepared | null = null;
    let facts: RestPassFacts | null = null;
    if (kept.length > 0) {
      // ---- PROGRAM 2: the clean-up pass ------------------------------------------------------
      const restJob = restJobFor(job, kept, restChosen.key);
      roundTrips(restJob, 'rest program');
      // Seeded with program 1's removal: the sweep of the second file starts from the blank program
      // 1 leaves behind, so the prediction, the coverage and the gouge checks are all made against
      // the stock the operator will actually have under the cutter (#410: "Both programs must be
      // simulated together: tool 2's sweep runs on tool 1's result").
      const removal1 = p1.load.meshes.removal;
      const prepared = prepare(restJob, removal1 === null ? {} : { priorRemoval: removal1 });
      if (!prepared.ok) process.exit(1);
      p2 = prepared;

      // ---- WHAT NEITHER PROGRAM TOUCHES ------------------------------------------------------
      // The same measurement, on the UNION of the two removals with an overlap of zero: `restArea`
      // is then the design material still standing after both programs, per item, at its own floor.
      // This is the issue's "anything neither tool reaches is still reported in numbers".
      const both = unionRemoval(tl, [removal1, p2.load.meshes.removal]);
      const left = restMachining(tl, { removal: both, cuts: designCuts, overlap: 0 });

      const reached = new Set(kept.map((r) => r.id));
      const stem1 = runSheetFileName(job.name).replace(/\.nc$/, '');
      const stem2 = runSheetFileName(restJob.name).replace(/\.nc$/, '');
      const dia1 = p1.diameter;
      const share1 = shareOf(cut, tool1Key);
      const seconds = (g: EngraveGenerated): number => Math.round(g.cam?.estimatedSeconds ?? 0);
      facts = {
        rough: {
          key: tool1Key,
          diameter: dia1,
          share: share1,
          score: dia1 * dia1 * share1,
          reason: roughReason,
          nc: `${stem1}.nc`,
          frame: p1.generated.frameNc === null ? null : runSheetFrameFileName(job.name),
          moves: p1.generated.cam?.cuttingMoves ?? 0,
          seconds: seconds(p1.generated),
          removedVolume: p1.load.stats.removedVolume,
        },
        rest: {
          key: restChosen.key,
          diameter: restChosen.diameter,
          reason: restChosen.reason,
          nc: `${stem2}.nc`,
          frame: p2.generated.frameNc === null ? null : runSheetFrameFileName(restJob.name),
          moves: p2.generated.cam?.cuttingMoves ?? 0,
          seconds: seconds(p2.generated),
          removedVolume: p2.load.stats.removedVolume,
        },
        // The items program 1 leaves off AND program 2 really does cut — the other direction (left
        // off by the first, closed to nothing by the second) is the leftover list's business.
        unroughed: unroughed.filter((u) => reached.has(u.id)),
        regions: kept.map((r) => ({
          name: r.name ?? r.id,
          depth: r.depth,
          area: r.area,
          cutArea: r.cutArea,
          clearedArea: r.clearedArea,
        })),
        // cutArea/clearedArea are over EVERY region the second tool could open — they answer "how
        // much of this design did the pair get?" — while restArea is what the second program will
        // actually traverse, so a dropped region is counted once, in the leftover.
        cutArea: rest1.cutArea,
        clearedArea: rest1.clearedArea,
        restArea: kept.reduce((sum, r) => sum + r.area, 0),
        overlap,
        seam,
        // #436 — the share is taken over `rest1.cutArea`, the area this design asks the SECOND tool
        // to open, which is the denominator the rest numbers above are already measured against. The
        // numerator is the same design measured on the union of both removals, so the two are areas
        // of one object and the ratio means what it says.
        // The threshold is the shop's own, at `rest.thirdToolPct` (a PERCENT in the document, a
        // fraction here, which is the unit the comparison is written in). `--third-tool` wins.
        // The seam goes in with it, because a remainder that is really the band's own shortfall is
        // not a reason for another cutter — the advice says to widen the band instead (#436 review).
        thirdTool: thirdToolAdvice(
          left.restArea,
          rest1.cutArea,
          { thirdToolFraction: thirdToolPct / 100, source: thirdToolSource },
          seam,
        ),
        restRemovedVolume: p2.load.stats.removedVolume,
        leftover: {
          area: left.restArea,
          byItem: left.regions
            .map((r) => ({ name: r.name ?? r.id, depth: r.depth, area: r.area }))
            .sort((a, b) => b.area - a.area),
        },
      };
    }

    // ---- NOW WRITE, program 1 first ---------------------------------------------------------
    // The sheet is program 1's, and it is the whole setup's: its header names program 1's file and
    // hash, the two-tool section says which bit cuts what, and §7 carries the swap. Program 2 gets
    // no sheet of its own — two sheets for one block is two documents with one truth.
    const w1 = writeProgram(p1, outDir, {
      writeJobDocument: true,
      note,
      sheetOptions: {
        reachability: cut,
        unreachable,
        ...(facts === null ? null : { restPass: facts }),
      },
      preview: true,
    });
    previews.push(...w1.previews);

    if (p2 === null || facts === null) {
      console.log(
        `  rest       nothing to clean up: ${tool1Key} removed every square millimetre ${restChosen.key} ` +
          `could have opened, so ${restChosen.key} would cut air. One program is the whole job.`,
      );
    } else {
      const w2 = writeProgram(p2, outDir, { writeJobDocument: true, note, sheet: false, preview: true });
      previews.push(...w2.previews);
      console.log(
        `\n  pair       ${facts.rough.nc} (⌀${facts.rough.diameter} mm) then ${facts.rest.nc} ` +
          `(⌀${facts.rest.diameter} mm) — the second program removed ` +
          `${facts.restRemovedVolume.toFixed(2)} mm³ on top of the first, and ` +
          `${facts.leftover.area.toFixed(2)} mm² of the design is left standing between them.`,
      );
      // #436 — the threshold's answer, at the terminal as well as on the sheet: the operator
      // choosing a third cutter is standing at the machine, not reading the sheet.
      if (facts.thirdTool !== null) {
        console.log(
          `  leftover   ${(facts.thirdTool.share * 100).toFixed(2)} % of what the design asks for ` +
            `(threshold ${(facts.thirdTool.fraction * 100).toFixed(2)} %): ` +
            (facts.thirdTool.suggested
              ? 'a third cutter is suggested for it'
              : 'too small to act on — no third cutter suggested'),
        );
      }
    }
  }

  // The PNG is a BROWSER's job (playwright), so it is rendered out here and not in the pipeline. A
  // machine without chromium still gets the jobs, the sheets and the SVGs — the pictures are the one
  // thing that goes missing, and each says so rather than failing programs that are already written.
  for (const p of previews) {
    try {
      const png = await svgToPng(p.svg);
      writeFileSync(join(outDir, p.pngFile), png);
      console.log(`  image      ${p.pngFile}  (${png.length} bytes — the predicted cut at the real cutter width)`);
    } catch (e) {
      console.log(
        `  note       ${p.pngFile} was not rendered (${(e as Error).message}) — the SVG beside ` +
          'it is complete and opens in any browser. Playwright needs a browser: `npx playwright install`.',
      );
    }
  }
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

  // The record needs the cutter's cutting diameter to select a feeds row on readback, so read it
  // from the same tool library `jobTool` the job was built with.
  const couponTool = jobTool(spec.base);
  if (couponTool === null) fail(`tool "${spec.base.toolKey}" is not in the tool library`);
  const cuttingDiameter = couponTool.tipDiameter ?? couponTool.diameter;
  if (typeof cuttingDiameter !== 'number' || !(cuttingDiameter > 0)) {
    fail(`tool "${spec.base.toolKey}" has no cutting diameter (tipdiameter=${couponTool.tipDiameter}, diameter=${couponTool.diameter})`);
  }

  const rows: CouponRecordRow[] = [];
  let allOk = true;
  for (const program of programs) {
    const result = runJob(program.job, outDir, {
      writeJobDocument: true,
      note:
        `*Coupon program \`${program.id}\` of \`${spec.title}\` (#248): ${program.description}. ` +
        `Generated by \`scripts/engrave-job.ts\`. Fill this program's verdict in the coupon record — ` +
        `then \`scripts/feeds-readback.ts\` flips the matching \`feeds.ts\` row to measured from it.*`,
    });
    if (result.ok) {
      // `sheetFile` is nullable since #410 — a two-tool job writes one sheet, for program 1 — but a
      // coupon always asks for its own, and a record row pointing at a sheet that was never written
      // is a field the readback would follow into nothing.
      if (result.sheetFile === null) fail(`coupon program "${program.id}" was written without a run sheet`);
      rows.push({
        program: program.id,
        values: program.values,
        ncFile: result.ncFile,
        sheetFile: result.sheetFile,
        hash: result.hash,
        verdict: null,
        chosen: false,
        note: '',
      });
    } else {
      allOk = false;
    }
  }

  // The ENTRY POINT's half of #248 item 3: a machine-readable verdict file the operator fills at
  // the bench. `scripts/feeds-readback.ts` reads it back and flips the matching feeds.ts row to
  // `measured` with this coupon and the cut date — the round trip is closed there, not by a hand
  // edit of the table.
  const record: CouponRecord = {
    coupon: spec.id,
    title: spec.title,
    parameter: spec.parameter,
    material: spec.base.stock.material,
    toolKey: spec.base.toolKey,
    cuttingDiameter,
    generatedOn: new Date().toISOString().slice(0, 10),
    cutOn: null,
    baseOverride: spec.base.cutOverride ?? {},
    note:
      'Fill "verdict" (ok / poor / broke), "cutOn" (YYYY-MM-DD) and any note per program. If more ' +
      'than one program cut ok, mark exactly one "chosen": true. Then run scripts/feeds-readback.ts on this file.',
    programs: rows,
  };
  const recordStem = spec.id.replace(/[^A-Za-z0-9._-]+/g, '-');
  writeFileSync(join(outDir, `${recordStem}-coupon-record.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(`  record     ${recordStem}-coupon-record.json  (${rows.length} row(s) to complete)`);

  console.log(`\nreceipt: ${programs.length} program(s), ${allOk ? 'all generated' : 'SOME STOPPED — see above'}`);
  if (!allOk) process.exit(1);
}
