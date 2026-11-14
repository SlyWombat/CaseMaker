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
// that has never been opened by a #412 build is exactly what it always was. SINCE #732 Makera's own
// catalogue (`catalogue.json`, #308) is read from the same directory, so the vendor's feed rows —
// not only the starting table — answer for a cutter carrying a Makera id. Absent files are not an
// error — the built-in tier is what a headless run falls back to, the way the app itself does with
// no house service. `--location <file>` names one instead; the document's own `kind` says which of
// the two it is, and the catalogue is sought beside it. The reading — with the wasm module and the
// bundled fonts — is the shared headless bootstrap (#476), so the CLI and the MCP server start the
// same way this script does.
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

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename, isAbsolute } from 'node:path';

import { engraveGenerate, type EngraveGenerated, type EngraveShopOpts } from '../../../src/workers/sim/engraveGenerate';
import { tabChoiceSentence, TAB_CHOICE_FLAG_VALUES } from '../../../src/engine/cnc/cam/model/tabChoice';
// #766 — the measured search: slice A scores a candidate plan, B chooses, C writes the sentences.
// #922 — THE PICK IS THE APP'S OWN: one builder in smartPickRun.ts (the worker's caller uses it
// too) supplies the conditions map, the feed table, the five-argument candidate list and the
// evaluator context. This door no longer assembles its own.
import { inventoryConditions } from '../../../src/engine/cnc/toolCondition';
import { resolvedFeedsTable } from '../../../src/engine/cnc/feeds';
import { drillSettings } from '../../../src/engine/cnc/cam/drillBit';
import { pickCandidates } from '../../../src/workers/sim/smartPickRun';
// #1137 — the finalist evaluations run on a budgeted worker pool; this door owns that decision.
import { pickWithPool } from './pickPool';
import { explainSmartPick } from '../../../src/engine/cnc/engrave/smartPickWords';
import type { ToolLibraryEntry } from '../../../src/engine/cnc/toolLibrary';
import { createSimSession, type SimDiagnostic, type SimLoadOk, type SimSession } from '../../../src/workers/sim/session';
import { unionRemoval, restMachining } from '../../../src/workers/sim/engraveRest';
import { restDepthShortfallFindings, restJobFor, roughPick, restToolPick, unroughedItems, vBitRestRefusal, type RestPassFacts } from '../../../src/engine/cnc/engrave/restPass';
// #762 — the per-item-kind picker: what each item IS before the area-share rule is asked.
import {
  REST_OVERLAP_KEY,
  REST_THIRD_TOOL_KEY,
  REST_VISIBLE_DEPTH_KEY,
  restSeamFacts,
  thirdToolAdvice,
  type RestSettingSource,
  type SeamCutter,
  type SeamFactsInput,
} from '../../../src/engine/cnc/engrave/restSettings';
import type { Tool } from '../../../src/engine/cnc/tool';
import { toolDisplayName } from '../../../src/engine/cnc/toolDisplay';
import type { JobFinding } from '../../../src/engine/cnc/engrave/jobSetup';
import type { LoadedLocation } from '../../../src/platform/headless/bootstrap';
import { bracketPlacementSeedFor } from '../../../src/engine/cnc/registration/mountContext';
import { sheetRegistrationPlan } from '../../../src/engine/cnc/registration/footprintJob';
import { rotarySheetDatumFor } from '../../../src/engine/cnc/rotary/sheetDatum';
import type { SeatSeek } from '../../../src/engine/cnc/registration/footprintJob';
import type { FootprintPlan } from '../../../src/engine/cnc/registration/footprint';
import type { NodeMeshOutput } from '../../../src/workers/geometry/meshOutput';
import { rotaryMapOf } from '../../../src/engine/cnc/rotary/wrap';
import { Z1 } from '../../../src/engine/cnc/machine';
import { fixtureMountOf, jobMount, jobMountObstacles, jobSetups, jobTool, toSetup } from '../../../src/engine/cnc/engrave/jobSetup';
// #835 — each setup's own work, measured and written back into that setup only.
import {
  deadSetupKeys,
  replacementCutter,
  setupWorkJob,
  setupsWithDeadCutters,
  writeSetupPlan,
} from '../../../src/engine/cnc/engrave/setupWork';
import {
  buildRunSheet,
  runSheetFileName,
  runSheetFrameFileName,
  runSheetFaceFileName,
  type RunSheetOptions,
} from '../../../src/engine/cnc/engrave/runSheet';
import { releaseFileName } from '../../../src/engine/cnc/engrave/release';
import { nameRestPrograms } from '../../../src/engine/cnc/engrave/programFiles';
import { parseEngraveJob } from '../../../src/store/engraveJobSchema';
import { simulationProblem } from '../../../src/engine/cnc/simGate';
import {
  attributedDiagnostics,
  sweepPrograms,
  sweepSummary,
  type ProgramSweepOutcome,
  type ProgramSweepSummary,
} from '../../../src/engine/cnc/engrave/programSweep';
import { buildCouponPrograms, type CouponRecord, type CouponRecordRow, type CouponSpec } from '../../../src/engine/cnc/engrave/couponJob';
import { benchCutterFor, entryFor, getTools, NO_TOOL_KEY } from '../../../src/engine/cnc/toolRegistry';
import {
  finerThan,
  reachabilityFor,
  reachTable,
  shareOf,
  untouchedBy,
  untouchedByAll,
  type Reachability,
  type ReachRow,
} from '../../../src/engine/cnc/engrave/reachability';
import { MARGIN_DEFAULTS } from '../../../src/engine/cnc/engrave/depthBounds';
import {
  engraveRegions,
  measureEngraving,
  raisedTextMeasure,
  supportingFloors,
  type EngraveProgressFn,
} from '../../../src/workers/sim/engraveGenerate';
import { cuttingDiameter } from '../../../src/engine/cnc/tool';
import type { CutParams, FeedCatalogueRow } from '../../../src/engine/cnc/feeds';
// #922 — the one call shape feeds/step-down/rpm resolution now goes through, and the table this
// run installed from the location (`bootstrap` → `loadLocation` → `installLocationFeedsTable`),
// read back in the shape `EngraveShopOpts.feeds` wants — the same thing `engraveRunStore` sends the
// worker for the browser's own Generate.
import { engraveFeedsFor, engraveShopOpts } from '../../../src/engine/cnc/engrave/feeds';
import { jobMachine } from '../../../src/engine/cnc/calibration';
import { executeProfile } from '../../../src/workers/geometry/evaluateOp';
import { engravePreviewSvg } from '../engravePreviewSvg';
import { svgToPng } from '../svgToPng';
import { efficiencyThresholds, goalCheckShopOptions, installShopDefaults, KNOWN_DEFAULTS, readDefault } from '../../../src/platform/defaultsClient';
import { plannerDefaultsProvenance } from '../../../src/platform/plannerDefaults';
import { goalCheckForProgram, type SimGoalCheck } from '../../../src/engine/cnc/engrave/goalCheckInput';
import { goalCauseFacts, goalCauseOf } from '../../../src/engine/cnc/engrave/goalCause';
// #1134 — the one cutter-plan write-back (measuredPick's body), shared with the evaluator.
import { applyCutterPlan } from '../../../src/workers/sim/planEvaluate';
// #1134 — the pick's measured owned plan, handed through to the cut.
import type { ModelPlanOutput } from '../../../src/engine/cnc/cam/model/plan';
import { pureGoalObject } from '../../../src/engine/cnc/engrave/jobKind';
import { goalEdgeBreakOptions } from '../../../src/engine/cnc/engrave/edgeBreak';
import { goalInputFor } from '../../../src/workers/sim/goalCheckField';
import type { OracleReport } from '../../../src/engine/cnc/engrave/oracle';
import { bootstrap, loadCatalogue, type LoadedCatalogue } from '../../../src/platform/headless/bootstrap';
import { defaultEngraveJob } from '../../../src/engine/cnc/engrave/defaults';
import { tabSettings } from '../../../src/engine/cnc/cam/tabSettings';
import { planSummary, type PlanSummary } from '../../../src/engine/cnc/engrave/planSummary';
import { buildPcbJob, jobDocumentProblem, type PcbJobFile } from './pcbJob';
import { viseForNewJob } from '../../../src/engine/cnc/fixture';
import { designJobFor, type DesignReadingDirection } from '../../../src/engine/cnc/engrave/fromDesign';
import { readDesign } from '../../../src/engine/import/design3mf';
import { parsePrusaThreeMf } from '../../../src/engine/import/prusa3mf';
import type { EngraveJob } from '../../../src/types/engraveJob';
import { toPartPlan } from '../../../src/engine/cnc/engrave/partPlan';
import { renderRunSheetMarkdown } from '../../runSheetMarkdown';
import { CliExit, isCliExit } from './exit';
import { rankPoolSeam } from './rankPool';
import { commandOutput, HUMAN, type CommandOptions } from './output';
import { fileReceipt } from './receiptFiles';
import { setMemTraceSink, setWasmHeapReader, memTrace } from '../../../src/engine/cnc/memTrace';
import { appendFileSync } from 'node:fs';
import type { LadderRow } from '../../../src/engine/cnc/cam/model/plan';
import {
  diagnostic,
  gateForStage,
  goalBlockFromReport,
  provenance,
  provenanceForDefault,
  RECEIPT_VERSION,
  type EngraveDetails,
  type EngraveGoal,
  type EngraveProgram,
  type Receipt,
  type ReceiptDiagnostic,
  type ReceiptFile,
  type ReceiptProvenance,
  type ReceiptRefusal,
} from '../../../src/platform/headless/receipt';
// #1084 — the app's Save .nc gate for a rotary-held job, quoted by the door that does not apply it.
import { ROTARY_UNMEASURED_REFUSAL } from '../../../src/store/engraveRunGate';
// #1089 — the ideal-vs-owned comparison: the SAME function the card holds, so the sheet, the
// receipt and the card cannot state different lines or numbers.
import { planComparisonStatement, type PlanComparisonStatement } from '../../../src/engine/cnc/cam/model/tradeoff';

// The wasm module, the bundled fonts and the machine's own document are the shared headless
// bootstrap (#476). It runs once the arguments are parsed, below — before ANY job resolves a
// cutter, since `jobTool` reads the registry.

// ---------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------

interface Args {
  job?: string;
  coupon?: string;
  from3mf?: string;
  /** #743 P-4b — the Gerber set (several files, or one .zip) that becomes the board's job. */
  fromGerber?: string[];
  /** #743 P-4b — the blank the board is cut from, mm; the Gerber files do not say. */
  blank?: { length: number; width: number; thickness: number };
  turn?: DesignReadingDirection;
  tool?: string;
  rest?: string;
  overlap?: number;
  /** #436 — the third-tool threshold, as a PERCENT of the design's own removal area. */
  thirdTool?: number;
  location?: string;
  /** #1081 — Makera's catalogue document, when it is not the `--location` file's sibling. */
  catalogue?: string;
  /**
   * #1175 — THE IDEAL'S CANDIDATE SET, as a JSON file of `Tool` objects: the very list the
   * browser's Generate hands its worker (`getTools().map((entry) => entry.tool)`). The house run
   * forwards it so both paths plan the ideal from the same snapshot; absent, the CLI's own
   * registry is used exactly as before.
   */
  tools?: string;
  out?: string;
  /** #1052 — write the per-boundary memory trace (JSONL) to this file. */
  memTrace?: string;
  /**
   * #1151 — the owned plan first: write the programs without planning the ideal half. Off by
   * default, so every committed receipt and docs round-trip is unchanged; the house service asks
   * for it and runs the comparison as its own later child work.
   */
  deferIdeal?: boolean;
  /**
   * #1151 Phase 2 — the ball rank's candidates 2..N on worker threads. Off by default (the serial
   * rank, byte-identical); the house service asks for it on the planning box.
   */
  parallelRank?: boolean;
  /**
   * #1126 — write the run's whole `EngraveGenerated` document (the plain-data result the browser's
   * worker returns) to this file as JSON. The house service asks for it beside the receipt and the
   * programs so the panel can settle a house run exactly as it settles an in-page one; the receipt
   * stays the human/machine summary it has always been.
   */
  generated?: string;
  /** #1046 — measure the standard rest rungs on the owned plan (the virtual ladder). */
  restLadder?: boolean;
  /**
   * #1258 — the operator's answer when the tab rules cannot both be met (`--tab-choice
   * inside-margin|longer-stretch`). Absent, a job that needs it stops with the question and its two
   * answers named; the CLI never picks.
   */
  tabChoice?: 'insideMargin' | 'longerStretch';
}

/** Exported for the CLI's own spec (#1052, #1046): the flag set is pinned by parsing, not by running the wasm pipeline. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--out') args.out = argv[++i];
    else if (a === '--coupon') args.coupon = argv[++i];
    else if (a === '--from-3mf') args.from3mf = argv[++i];
    else if (a === '--from-gerber') {
      const files: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) files.push(argv[++i]!);
      if (files.length === 0) throw new Error('--from-gerber needs at least one Gerber, drill or .zip file');
      args.fromGerber = files;
    } else if (a === '--blank') {
      const v = argv[++i] ?? '';
      const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(v);
      if (m === null) throw new Error(`--blank is <length>x<width>x<thickness> in mm, not "${v}"`);
      args.blank = { length: Number(m[1]), width: Number(m[2]), thickness: Number(m[3]) };
    }
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
    } else if (a === '--defer-ideal') args.deferIdeal = true;
    else if (a === '--parallel-rank') args.parallelRank = true;
    else if (a === '--mem-trace') args.memTrace = argv[++i];
    else if (a === '--generated') args.generated = argv[++i];
    else if (a === '--rest-ladder') args.restLadder = true;
    else if (a === '--tab-choice') {
      const v = argv[++i] ?? '';
      const choice = (TAB_CHOICE_FLAG_VALUES as Record<string, 'insideMargin' | 'longerStretch'>)[v];
      if (choice === undefined) throw new Error(`--tab-choice is "inside-margin" or "longer-stretch", not "${v}"`);
      args.tabChoice = choice;
    }
    else if (a === '--location') args.location = argv[++i];
    else if (a === '--catalogue') args.catalogue = argv[++i];
    else if (a === '--tools') args.tools = argv[++i];
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
  console.error(`casemaker cut: ${message}`);
  throw new CliExit(1);
}

/**
 * #1126 — THE `--events` PROGRESS CALLBACK. The engine already reports its stages as plain
 * `EngraveProgress` objects (`stage`, `label`, `done`, `total`) to the browser's worker; with
 * `--events` the CLI hands the same callback to the generator and writes each object to stderr as
 * one JSON line. Nothing is re-worded or re-derived here: the service's runs API relays these
 * objects, and the panel reads them with the very type it reads the worker's with.
 *
 * Human progress lines (`out.progress`, the pick words and advisories) ride as `note` frames from
 * `commandOutput`, so stderr is JSON and only JSON in this mode.
 */
export function eventProgress(options: CommandOptions): EngraveProgressFn | undefined {
  if (options.events !== true) return undefined;
  return (progress) => {
    process.stderr.write(`${JSON.stringify(progress)}\n`);
  };
}

const USAGE =
  'usage: casemaker cut <job.json> [--out <dir>] [--defer-ideal] [--parallel-rank] [--generated <path>] [--tab-choice inside-margin|longer-stretch]\n' +
  '       casemaker cut --coupon <coupon-spec.json> [--out <dir>]\n' +
  '       casemaker cut --from-gerber <file> [<file> ...] --blank <L>x<W>x<T> [--out <dir>]\n' +
  '       casemaker cut --from-3mf <design.3mf> [--turn ccw|cw] [--tool <key>]\n' +
  '              [--rest <key|none>] [--overlap <mm>] [--third-tool <pct>] [--rest-ladder] [--out <dir>]\n' +
  '       [--location <location.json|house.json>]  (any input; default: the app’s own location)\n' +
  '       [--catalogue <catalogue.json>]  (Makera’s feed rows; default: beside the --location file,\n' +
  '              or the app’s own data directory; CM_CATALOGUE names it too)\n' +
  '       [--tools <tools.json>]  (the ideal plan’s candidate set; the browser Generate’s own list)\n' +
  '       (casemaker engrave is the same command under its old name; the receipt is the same)';

/** A pipeline that stopped, as the receipt needs it (#478). `stage` is null when none ran. */
interface EngraveFailure {
  stage: string | null;
  gate: Receipt['gate'];
  diagnostics: ReceiptDiagnostic[];
  refusals: ReceiptRefusal[];
  /**
   * #1258 — the failed generate result, carried ONLY when the run stopped to ask the tab question, so
   * `--generated` can hand a house-backed run the structured question (`tabChoiceNeeded`, with its
   * stretches and the drawing data) and not just the receipt's sentence.
   */
  generated?: EngraveGenerated;
}

/**
 * #733 item 3 / #732 follow-up — A DOCUMENT THE RUN CANNOT USE IS A RESULT, NOT AN EXCEPTION.
 * `--json` promises stdout is exactly one receipt (#478), and a document the schema refuses is a
 * run that stopped before any stage. The full words still go to stderr for the operator; the
 * receipt carries the same reason as a refusal and as a diagnostic, so a caller can read why
 * without scraping stderr. `code` names WHICH document was refused (`invalid-job`,
 * `invalid-catalogue`) so a caller can tell the two apart without parsing prose.
 */
function invalidDocument(code: string, message: string): EngraveFailure {
  console.error(`casemaker cut: ${message}`);
  return {
    stage: null,
    gate: null,
    diagnostics: [diagnostic(code, 'error', message, 'findings', null)],
    refusals: [{ code, reason: message }],
  };
}

/** A job document the command cannot read or the schema refuses (#733 item 3). */
function invalidJob(message: string): EngraveFailure {
  return invalidDocument('invalid-job', message);
}

/**
 * #749 — AN UNEXPECTED THROW IS A STOPPED RUN, NOT AN EMPTY STDOUT.
 *
 * The kernel (manifold-3d's wasm) throws `RuntimeError: memory access out of bounds` when a CSG
 * tree outgrows its 4 GiB heap. It is not a job-document problem and it is not recoverable here,
 * but it must not escape the command: `--json` promises stdout is exactly one receipt (#478),
 * and an uncaught throw leaves stdout empty — no stage, no reason, nothing for a caller to read
 * (#749: `casemaker cut` on a through cut-out died after ~90 s with a 0-byte stdout).
 *
 * ONLY `WebAssembly.RuntimeError` earns the kernel sentence. Any other throw is a bug in this
 * build, and saying "a fault in the geometry kernel" about a plain `TypeError` would send the
 * operator to the wrong place and throw away the one thing that locates it: the stack. Those are
 * reported as themselves, with the stack on the operator's channel (stderr), while the receipt
 * still names the stage that was running and says plainly that nothing was written.
 *
 * `source` is the receipt's own vocabulary ('findings' where the generator runs, 'simulation'
 * where the sweep does); the refusal code is the same `stage-error` the generator's own stops
 * use, so a caller needs no new vocabulary.
 */
function isKernelCrash(error: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError;
}

function unexpectedStop(
  stage: string,
  gate: Receipt['gate'],
  what: string,
  program: string | null,
  error: unknown,
  source: 'findings' | 'simulation',
): EngraveFailure {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const message = isKernelCrash(error)
    ? `the geometry kernel crashed while ${what} (the ${stage} stage): ${detail}. ` +
      'Nothing was written. This is a fault in the geometry kernel, not a problem with the job.'
    : `the cut stopped on an unexpected error while ${what} (the ${stage} stage): ${detail}. ` +
      'Nothing was written. This is a fault in the command, not a problem with the job.';
  console.error(`casemaker cut: ${message}`);
  // The kernel's own stack is wasm frames and says nothing; a JS throw's stack is the report.
  if (!isKernelCrash(error) && error instanceof Error && error.stack !== undefined) {
    console.error(error.stack);
  }
  return {
    stage,
    gate,
    diagnostics: [diagnostic('stage-error', 'error', message, source, program)],
    refusals: [{ code: 'stage-error', reason: message }],
  };
}

/**
 * Release a session after a crash without letting the release REPLACE the report. The wasm
 * instance that just faulted may fault again on the way out (a corrupt handle, a half-freed
 * mesh); the operator needs the original error and its receipt, not a teardown error.
 */
function disposeAfterCrash(session: { dispose(): void }): void {
  try {
    session.dispose();
  } catch (e) {
    console.error(
      `casemaker cut: the simulation session could not be released after the crash: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
  }
}

/**
 * #749 — THE BODY'S RECEIPT WRITER, HANDED TO THE ENTRY POINT.
 *
 * The entry point's catch must answer a throw from ANY work the stages do not guard
 * (`scanReach`, the `--preview` drawing, the rest pass, `readDesign`, the writers), and that
 * receipt must carry the inputs and outputs the run had already recorded. Those live in the
 * body's own state, so the body registers its `stop` here as soon as it can emit; the catch
 * calls it with the error it caught.
 */
interface RunReceipt {
  stop?: (failure: EngraveFailure) => number;
}

/**
 * The engrave command as a callable function (#477): one job document, coupon spec or 3MF design
 * into the files the bench needs. The body below is the former `scripts/engrave-job.ts`, moved
 * unchanged behind an argument list so the CLI and the script wrapper call the same code.
 *
 * `fail()` reports on stderr and throws {@link CliExit}; nothing here calls `process.exit`, so a
 * dispatcher can run the command without losing the process. The script wrapper turns the returned
 * code into `process.exitCode`.
 */
/**
 * #1059 — THE RECEIPT'S FACE-ANGLE FIELD: the square chuck's levelled A zero, read from the bed
 * profile the job was bound to (its `datums.rotaryFaceAngle`), else — for an unbound job — the
 * machine the job names (`machineId`), else any machine that states the datum. Only a SQUARE
 * section carries one (a round rod has no face to level), and a profile with no datum yields
 * nothing, so those receipts keep their exact shape.
 */
export function faceAngleReceiptFor(
  job: EngraveJob,
  where: LoadedLocation | null,
): { degrees: number; residualMm?: number } | undefined {
  const section = rotaryMapOf(job, where?.defaults ?? null)?.section;
  if (section === undefined || section.kind !== 'rect') return undefined;
  const wantedProfile = job.bed?.profileId;
  const machines = [...(where?.machines ?? [])];
  // #1059 (C's review) — THE JOB'S OWN MACHINE FIRST: a two-machine location must not lend an
  // unbound job the other machine's face angle.
  const own = machines.find((m) => job.machineId !== undefined && m.profileId === job.machineId);
  if (own !== undefined) machines.splice(machines.indexOf(own), 1), machines.unshift(own);
  for (const machine of machines) {
    const profile =
      wantedProfile === undefined
        ? machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId)
        : machine.bedProfiles?.find((p) => p.id === wantedProfile);
    const datum = profile?.datums.rotaryFaceAngle ?? null;
    if (datum === null) continue;
    return datum.residualMm === undefined ? { degrees: datum.value } : { degrees: datum.value, residualMm: datum.residualMm };
  }
  return undefined;
}

/** #1070 — the sheet's bed-held registration: the footprint plan, or the first seat seek. */
export function sheetRegistrationFor(
  job: EngraveJob,
  where: LoadedLocation | null,
): { footprint?: FootprintPlan; seatSeek?: SeatSeek } {
  if (where === null || fixtureMountOf(job) !== 'bracket') return {};
  const machine = where.machines[0];
  const calibration = machine?.calibration;
  if (calibration === undefined || calibration === null) return {};
  const probeAccessory = where.accessories.find((a) => a.kind === 'probe' && !/^3d$/i.test((a.variant ?? '').trim()));
  const unit = (probeAccessory?.unit ?? {}) as Record<string, unknown>;
  const num = (k: string): number | null => (typeof unit[k] === 'number' ? (unit[k] as number) : null);
  const tip =
    probeAccessory === undefined || num('rimOffsetMm') === null
      ? null
      : {
          diameterMm: num('tipDiameterMm') ?? 2,
          rimOffsetMm: num('rimOffsetMm')!,
          rimOffsetUncertaintyMm: num('rimOffsetUncertaintyMm') ?? 0.25,
        };
  const probe =
    probeAccessory === undefined ? null : { id: probeAccessory.id, variant: probeAccessory.variant ?? null, instrument: 'z-only' as const, tip };
  const bed = machine?.bedProfiles?.find((p) => p.id === machine.activeBedProfileId);
  const seat = bed?.datums?.bracketSeatZ ?? null;
  // #1070 (C8) — the seat's own statement travels with it: a seat the press wrote is the surface
  // the stock rests on, so the expected top does not add the under-board again.
  const bracketSeat = seat === null || seat === undefined ? null : { value: seat.value, what: 'bracket seat' as const, measuredAt: seat.measuredAt ?? null, ...(seat.restsOnStock === true ? { restsOnStock: true } : {}) };
  // #1070, 6b's ruling (C8) — THE ONE SEAM: the app's sheet and this one plan their registration
  // through the same function; this wrapper only resolves the boot's location into its arguments.
  // #1070 (C8) — a placed bracket's seed is the bed profile's placement, read by the same helper
  // the app's Cut card uses.
  const placedSeed = bracketPlacementSeedFor(machine ?? null);
  return sheetRegistrationPlan({ job, calibration, defaults: where.defaults, probe, bracketSeat, placedSeed });
}

/** One program as the generator lists it — the CLI's slice of `EngraveGenerated['programs']`. */
type GeneratedProgram = EngraveGenerated['programs'][number];

/**
 * The file names for a job's programs, in cut order (#733, #1093 R1).
 *
 * THE RUN SHEET NAMES THE FILES, so these are the names the sheet is handed: every ENGRAVING
 * program by `releaseFileName` (`<job>-p<n>.nc` when there is more than one, `<job>.nc` when it is
 * the only one), the blank's skim by `runSheetFaceFileName` (`<job>-face.nc`), and each program's
 * frame beside it (`<program stem>-frame.nc`). The CLI, Save-all, the release store and the record
 * all read the same rule, so one program cannot have two names.
 */
export function programFileNames(
  jobName: string,
  programs: readonly GeneratedProgram[],
): { ncFile: string; frameFile: string | null }[] {
  const engravingTotal = programs.filter((p) => (p.kind ?? 'engrave') !== 'facing').length;
  let engravingIndex = 0;
  return programs.map((program) => {
    if ((program.kind ?? 'engrave') === 'facing') {
      // #473 — the skim is its own file; it is never given a frame (its own dry run is the sheet).
      return { ncFile: runSheetFaceFileName(jobName), frameFile: null };
    }
    engravingIndex += 1;
    // #1093 R1 — ONE NAME FOR EVERY PROGRAM, program 1 included (`<stem>-p1.nc` …): the folder
    // sorts in cut order, and nothing names a "first" file by omission of its number.
    const ncFile = releaseFileName(jobName, engravingIndex, engravingTotal);
    return { ncFile, frameFile: `${ncFile.slice(0, -'.nc'.length)}-frame.nc` };
  });
}

/** #1237 — what the run says (and the receipt records) when the location file has no settings section. */
export const NO_SETTINGS_SECTION = 'this location file has no settings section; planned on the recommendations.';

/**
 * #1126 slice 2 — THE RESULT WITHOUT THE BYTES.
 *
 * `--generated` used to write the whole `EngraveGenerated`: 229 MB for the set B tray bottom. WHAT
 * THE WEIGHT ACTUALLY IS, measured on that job (D, 2026-11-10 — the first guess, from a badge, was
 * wrong): `planIdeal` 141.1 MB and `plan` 82.6 MB, almost all of it each setup's `programs` (the
 * ToolpathIR the post consumed); everything else together — programs' nc/verify/cam, predicted,
 * surface3d, statements, findings — is under 25 KB. The NC text is listed as files and the plans'
 * IRs are dropped: the browser reads a plan for its outcome, statements and tradeoff, and the QA
 * window for `perSetup[].notes`; nothing reads `perSetup[].programs` or `camIr`.
 *
 * The TOP-LEVEL ALIASES ARE MATCHED, NOT ASSUMED: the generator's `nc` describes the finishing
 * program of a split goal, not program 1, so `ncProgram`/`frameProgram`/`facingProgram` name the
 * index each alias mirrors — found by the same text match `writeProgram` makes for `sweptIndex`.
 * A reader that rebuilds by "program 1" would hand the store a different program's text.
 *
 * Everything else — findings, verify, cam, plans, goal checks, predicted/designItems — stays: the
 * store settles, gates and prints from those without re-deriving anything.
 */
export const RESULT_VERSION = 2;

export interface ResultFileRef {
  name: string;
  what: 'program' | 'frame';
  index: number;
}

// #1126 — `PlanSummary`/`planSummary` (the allowlist, one shape for the house and the in-page worker) live in
// `src/engine/cnc/engrave/planSummary.ts`, with each field's reader.
export { planSummary, type PlanSummary };

export function resultDocument(
  jobName: string,
  generated: EngraveGenerated,
): Record<string, unknown> & { resultVersion: number; files: ResultFileRef[] } {
  const names = programFileNames(jobName, generated.programs);
  const files: ResultFileRef[] = [];
  const programs = generated.programs.map((program, index) => {
    const { nc: _nc, camIr: _camIr, ...rest } = program as GeneratedProgram & { camIr?: unknown };
    files.push({ name: names[index]!.ncFile, what: 'program', index });
    if (program.frameNc !== null && names[index]!.frameFile !== null) {
      files.push({ name: names[index]!.frameFile!, what: 'frame', index });
    }
    return { ...rest, nc: null, frameNc: null };
  });
  const {
    nc,
    frameNc,
    facingNc,
    camIr: _ir,
    programs: _programs,
    ...rest
  } = generated as EngraveGenerated & { camIr?: unknown };
  const engraving = (program: GeneratedProgram): boolean => (program.kind ?? 'engrave') !== 'facing';
  const match = (predicate: (program: GeneratedProgram) => boolean): number | null => {
    const found = generated.programs.findIndex(predicate);
    return found < 0 ? null : found;
  };
  return {
    ...rest,
    plan: planSummary(generated.plan),
    planIdeal: planSummary(generated.planIdeal),
    resultVersion: RESULT_VERSION,
    nc: null,
    frameNc: null,
    facingNc: null,
    ncProgram: nc === null ? null : match((p) => engraving(p) && p.nc === nc),
    frameProgram: frameNc === null ? null : match((p) => engraving(p) && p.frameNc === frameNc),
    facingProgram: facingNc === null ? null : match((p) => p.nc === facingNc),
    programs,
    files,
  };
}

export async function engraveJobMain(argv: string[], options: CommandOptions = HUMAN): Promise<number> {
  const receipt: RunReceipt = {};
  try {
    return await engraveJobBody(argv, options, receipt);
  } catch (e) {
    if (isCliExit(e)) return e.code;
    // #749 — ONE TOP-LEVEL CATCH OVER THE WHOLE BODY. The stages guard the kernel work they own
    // (generator, sweep, removal union); everything else that calls Manifold/Clipper — the
    // reachability scan, the preview drawing, the rest pass, the design reader, the writers —
    // reaches this. The body registered its receipt writer before it read anything, so the one
    // receipt still carries the inputs and outputs the run had by then.
    if (receipt.stop !== undefined) {
      return receipt.stop(unexpectedStop('cam', 'generated', 'preparing the cut', null, e, 'findings'));
    }
    throw e; // the output channel itself failed; there is nowhere to write a receipt
  }
}

async function engraveJobBody(argv: string[], options: CommandOptions, receipt: RunReceipt): Promise<number> {
  const out = commandOutput(options);
  /** #1126 — present only with `--events`; handed to every generator call below. */
  const engineEvents = eventProgress(options);
  // The run's receipt accumulates as the command works; NOTHING here prints a result line —
  // `out.emitReceipt` renders the whole block from this object at the end (#478).
  const runInputs: ReceiptFile[] = [];
  const runOutputs: ReceiptFile[] = [];
  const runDiagnostics: ReceiptDiagnostic[] = [];
  const runProvenance: ReceiptProvenance[] = [];
  const runRefusals: ReceiptRefusal[] = [];
  const programs: EngraveProgram[] = [];
  /** Where each preview PNG belongs on the receipt: the program that drew it (#478). */
  const imageTargets: { svgFile: string; pngFile: string; program: EngraveProgram }[] = [];
  const provenanceNames = new Set<string>();
  let kind: EngraveDetails['kind'] = 'job';
  let outDir = '';
  let coupon: EngraveDetails['coupon'] = null;
  let pair: EngraveDetails['pair'] = null;
  // #513 — the bed the job was set up on, when the document names one (the design and coupon
  // routes build their own jobs and name none).
  let bed: NonNullable<EngraveDetails['bed']> | null = null;
  // #1059 — the square chuck's levelled face angle from the bound profile's datum, when the job
  // is a square-chuck job and the datum exists (see `faceAngleReceiptFor`).
  let faceAngle: NonNullable<EngraveDetails['faceAngle']> | undefined;
  // #1129 — the model plan's sampling facts (the row sampler's floor, per cutter, and where it came
  // from). Set by the run that generated the programs; absent on a non-model plan.
  let runSampling: EngraveDetails['sampling'] | undefined;
  // #1089 — the run's ideal-vs-owned comparison, for the sheet and the receipt. The first program
  // written is the run's own; a two-tool rest pass never replaces it.
  let runComparison: EngraveDetails['comparison'] | undefined;
  // #1193 — the run's OWN cycle (every posted program), taken from the generated result's seam.
  let runCycle: EngraveDetails['runCycle'] | undefined;
  let runOk = true;
  let runStage: string | null = null;
  /**
   * #1046 — THE LADDER'S MEASURED RUNGS, from the plan that last ran it. They ride the receipt's
   * goal block (`details.goal.ladder`, the CLI's record); absent when `--rest-ladder` was not
   * asked or no rung measured.
   */
  let runLadder: LadderRow[] | null = null;
  let ladderSentencePrinted = false;
  let runGate: Receipt['gate'] = null;

  /** Add a number's provenance once, whatever route reached it. */
  function noteProvenance(entry: ReceiptProvenance): void {
    if (provenanceNames.has(entry.name)) return;
    provenanceNames.add(entry.name);
    runProvenance.push(entry);
  }

  /** Record a file the run read. A missing input is the same refusal it always was, not a crash. */
  function recordInput(path: string): void {
    try {
      runInputs.push(fileReceipt(path));
    } catch (e) {
      fail(`cannot read ${path}: ${(e as Error).message}`);
    }
  }

  /** Record a stopped pipeline. The receipt is the report; the caller returns exit code 1. */
  function recordFailure(failure: EngraveFailure): void {
    // The FIRST stop is the one the receipt names: a coupon sweep that stops three programs is
    // still reported at the stage the first one reached.
    if (runOk) {
      runStage = failure.stage;
      runGate = failure.gate;
    }
    runOk = false;
    runDiagnostics.push(...failure.diagnostics);
    runRefusals.push(...failure.refusals);
  }

  /** Emit the run's one receipt. `ok` is the run's, not a program's. */
  function emit(): void {
    // #953 — the run's goal read: the LAST program whose report carried one, matching
    // `combineOracles` (#948). Undefined for a job with no goal.
    const runGoal = [...programs].reverse().find((p) => p.goal !== undefined && p.goal !== null)?.goal;
    // #1237 — THE PLANNER'S SETTINGS, STATED: with a location, every planner-read key whose value
    // there differs from its recommendation; with none, every key at its recommendation. The
    // receipt then says which shop settings shaped the plan (and that the recommendations did).
    for (const entry of plannerDefaultsProvenance(shopDefaults, { withLocation: boot.location !== null })) {
      noteProvenance(entry);
    }
    out.emitReceipt({
      version: RECEIPT_VERSION,
      command: 'engrave',
      ok: runOk,
      // A completed run reached the generator's terminal stage; a stopped one names where it
      // stopped (`recordFailure`).
      stage: runOk ? (runStage ?? 'done') : runStage,
      gate: runGate,
      inputs: runInputs,
      outputs: runOutputs,
      diagnostics: runDiagnostics,
      provenance: runProvenance,
      refusals: runRefusals,
      // #513 — the bed rides only when the document names one. Omitting the null keeps every
      // receipt for a job without a bed byte-identical to the pre-#513 output (the committed
      // bench receipts rewrite to themselves).
      // #953 — and the RUN's goal read rides only for a goal job: the last program whose report
      // carried one (#948's rule — the final surface's verdict, not the rough's), omitted entirely
      // for a job with no goal so those receipts stay byte-identical.
      details: {
        kind,
        outDir,
        programs,
        coupon,
        pair,
        ...(runGoal === undefined || runGoal === null
          ? {}
          : { goal: { ...runGoal, ...(runLadder === null ? {} : { ladder: runLadder }) } }),
        ...(bed === null ? {} : { bed }),
        ...(faceAngle === undefined ? {} : { faceAngle }),
        ...(runSampling === undefined ? {} : { sampling: runSampling }),
        ...(runComparison === undefined ? {} : { comparison: runComparison }),
        // #1193 — the run's own cycle (every posted program), beside the plan comparison.
        ...(runCycle === undefined ? {} : { runCycle }),
      },
    });
  }

  /**
   * Record a stopped pipeline, emit the receipt and hand back the failure exit code (#478). The
   * caller writes `return stop(...)`, so the stopped run still reports its stage, gate and reason
   * instead of printing nothing and exiting 1.
   */
  function stop(failure: EngraveFailure): number {
    recordFailure(failure);
    emit();
    return 1;
  }

  // #749 — from here on, a throw anywhere in the body is answered by THIS writer, with all the
  // state it closes over. Registered before the first input is read, so a receipt lists it.
  receipt.stop = stop;

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
    throw e; // unreachable; `fail` exits
  }
  // #1052 — THE MEMORY TRACE. Flag or env; rows are appended synchronously so the LAST rows before
  // an abort (exit 134) are on disk — a buffered stream loses exactly the rows a crash investigation
  // needs. Off by default: the sink is null and every memTrace call is one null check.
  const memTracePath = args.memTrace ?? process.env.CASEMAKER_MEM_TRACE;
  if (typeof memTracePath === 'string' && memTracePath !== '') {
    setMemTraceSink((line) => {
      try {
        appendFileSync(memTracePath, line);
      } catch {
        /* the trace must never take the run with it */
      }
    });
  }
  const inputs = [
    args.job,
    args.coupon,
    args.from3mf,
    args.fromGerber === undefined ? undefined : args.fromGerber.join(' '),
  ].filter((v) => v !== undefined);
  if (inputs.length === 0) fail(USAGE);
  if (inputs.length > 1) fail('pass a job, --coupon, --from-3mf OR --from-gerber — exactly one');
  if (!args.from3mf && (args.turn || args.tool || args.rest || args.overlap !== undefined || args.thirdTool !== undefined)) {
    fail('--turn, --tool, --rest, --overlap and --third-tool only apply to --from-3mf');
  }
  if (args.blank !== undefined && args.fromGerber === undefined) fail('--blank only applies to --from-gerber');
  if (args.fromGerber !== undefined && args.blank === undefined) {
    fail('--from-gerber needs --blank <length>x<width>x<thickness> in mm — the files do not say what the board is cut from');
  }
  kind = args.coupon ? 'coupon' : args.from3mf ? 'design' : 'job';
  // The Gerber route records each file as it reads it, below.
  if (args.fromGerber === undefined) recordInput(inputs[0]!);
  // Before ANY job resolves a cutter: `jobTool` reads the registry, so the machine's own documents
  // have to be in it first. The bootstrap reads the document the args named (`--location`) or the
  // machine's own, and validates it exactly as the app's import panel does (#412).
  // #1111 R1 — and the catalogue beside it (or the one `--catalogue` names), so the registry holds
  // the same three tiers the app's does before `engraveShopOpts` takes its snapshot.
  const boot = await bootstrap({ location: args.location, ...(args.catalogue === undefined ? {} : { catalogue: args.catalogue }) }).catch((e: Error) => fail(e.message));
  const tl = boot.manifold;
  // #1052 — the wasm module's own heap, when it exposes one (the 4,096 MB cap is its own source of
  // exit 134). Emscripten's modular build may hide HEAP8; the reader then answers null and the row
  // falls back to `arrayBuffers`, naming which it used.
  setWasmHeapReader(() => {
    const m = tl as unknown as { HEAP8?: { buffer?: ArrayBuffer }; HEAPU8?: { buffer?: ArrayBuffer }; wasmMemory?: WebAssembly.Memory };
    if (m.HEAP8?.buffer !== undefined) return { bytes: m.HEAP8.buffer.byteLength, source: 'HEAP8' as const };
    if (m.HEAPU8?.buffer !== undefined) return { bytes: m.HEAPU8.buffer.byteLength, source: 'HEAPU8' as const };
    if (m.wasmMemory?.buffer !== undefined) return { bytes: m.wasmMemory.buffer.byteLength, source: 'wasmMemory' as const };
    return null;
  });
  /**
   * The shop's tunable defaults, as the document holds them (#416/#417), or null when this run has no
   * document to read them from — a house file from before the section existed, or no file at all. Null
   * is not "no values": it is what {@link readDefault} answers a labelled `fallback` for, which is the
   * same thing the app itself does with no house service.
   */
  const shopDefaults = boot.location?.defaults ?? null;
  // #1237 — THE ONE INSTALL, for the engine readers that still take the source as a default
  // argument (the rotary map, the run totals, the probe residuals — the follow-up audit). The
  // PLANNER does not read this source any more: its seven settings ride ModelPlanInput, built
  // below from the same map, so a location given can never fall back to the recommendations.
  installShopDefaults(() => shopDefaults);
  /**
   * #922 — ONE SHOP OBJECT, ONE BUILDER, FOR BOTH DOORS. `engraveShopOpts` (`engine/cnc/engrave/
   * feeds.ts`) is built field-for-field to match what `engraveRunStore.ts` sends the worker for the
   * browser's own Generate — `tests/unit/pipelineIdentity.spec.ts`'s `appShop` is the reference both
   * now mirror. Before this the CLI's own `shop` literal here set only `tools`, `drill` and `rest`,
   * so every other field a posted program's numbers depend on (the feeds table, `lostDetailWarnRatio`,
   * `peckClearanceMm`, the whole `defaults` map, the condition summaries, and — the one that actually
   * split j13's program in two — the FINISH allowance) fell back to the generator's own labelled
   * fallback instead of the location's real numbers, so `casemaker cut` posted a different program
   * than the app's Generate for the identical job and location (#922).
   *
   * `tools`/`drill` were already resolved here for #432/#733 (the generator's realm has no tool
   * registry, and a drill-shaped cutter needs the shop's own point angle); the builder folds them
   * in too, so this is the one place the CLI assembles the bag the generator reads.
   */
  // #1237 — the location is STATED to the planner only when it states a settings map: a pre-#412 house
  // file has none (`defaults` is null by design, bootstrap.ts) and plans on the recommendations with no
  // location named; a location document always reads as a map, `{}` when it carries no overrides.
  const shop: EngraveShopOpts = engraveShopOpts(shopDefaults, shopDefaults === null ? null : (boot.location?.path ?? null));
  /**
   * #1068 — THE JOB'S MOUNT, DERIVED AS THE APP DERIVES IT. `jobMountObstacles` is the one
   * derivation `engraveRunStore.ts` calls, so the command line and the browser check a bracket
   * job against the same boxes: the two arms, the job's own clamps, the fit, and the job's own
   * obstacles (a hole in the blank, screwed down). Before this the CLI passed NO mount: the plan
   * lifted over nothing, the verifier had no clamps or arms to refuse, and the sweep loaded a
   * setup with no fixture — while the run sheet told the operator to mount the vise.
   *
   * `null` for a vise or a tape job, exactly as the app's run store gets it.
   */
  const mountFor = (job: EngraveJob) => jobMountObstacles(job, shopDefaults);
  /**
   * #922/#947 — THE PICKER'S SHOP, FIELD FOR FIELD. The app's picker
   * (`engravePreviewStore.ts`'s `previewInputs`) hands the measured search a shop WITHOUT the
   * finish allowance (only the posted Generate reads it), with the tool-change cost, and without
   * the fields only Generate reads. `pickForEngrave` searches with exactly this object on both
   * doors, so the sample jobs' cutters agree (they did not while the CLI spread the full run shop
   * in and merely trimmed `finish`). The posted program, once a cutter is chosen, still runs on
   * the full `shop` above unchanged. The app's preview shop also carries per-job `bed` facts; the
   * pick's score does not read them, and they are omitted here rather than built per job.
   */
  const pickShop: EngraveShopOpts = {
    tools: getTools(),
    lostDetailWarnRatio: readDefault(shopDefaults, 'engrave.lostDetailWarnRatio').value,
    toolChangeSeconds: readDefault(shopDefaults, 'toolChange.seconds').value,
    drill: drillSettings(shopDefaults),
    feeds: resolvedFeedsTable().table,
    defaults: shopDefaults,
  };
  /**
   * #1134 — THE PICK'S MEASURED OWNED PLAN, waited for by the run. `chooseCutters` fully evaluates
   * its finalists (a real `engraveGenerate` on the run shop); the winning evaluation's plan IS the
   * owned plan the cut would have planned, so `runJob` hands it through and the owned half is not
   * planned a second time. Reset whenever the chosen plan is invalidated (a setup substitution).
   */
  let reusedOwnedPlan: ModelPlanOutput | null = null;
  if (boot.location !== null) {
    const where = boot.location;
    recordInput(where.path);
    const what = where.kind === 'location' ? `location "${where.name}"` : 'house';
    out.progress(
      `${what}: ${where.path} — ${where.tools.length} tool${where.tools.length === 1 ? '' : 's'} ` +
        `from the user's own list, ${where.inventory.length} owned cutter${where.inventory.length === 1 ? '' : 's'}`,
    );
    // #436 — say which rest-machining numbers this run is about to use, and where each came from, so a
    // sheet that reads oddly can be traced back to the document (or to the absence of one) before the
    // program is run. Silent about a key the document simply has not set: `readDefault` falls back and
    // the seam sentence says so where it matters. The receipt carries the same numbers as provenance.
    for (const key of [REST_OVERLAP_KEY, REST_THIRD_TOOL_KEY, REST_VISIBLE_DEPTH_KEY, 'toolChange.seconds']) {
      const d = shopDefaults?.[key];
      if (d !== undefined) out.progress(`  default ${key} = ${String(d.value)}${d.unit ?? ''} (${d.source})`);
    }
  }

  // #732 — MAKERA'S OWN NUMBERS, READ RATHER THAN AN EMPTY LIST. The house service keeps its
  // catalogue (#308) as `catalogue.json` beside `location.json`; this run reads THAT file — the
  // sibling of the document `--location` named, or the app's own data directory — validates it
  // exactly as the house client validates its responses, and joins each feed row to the geometry
  // of the cutter it names. From here every tier that can use the vendor's numbers gets them:
  // the reachability pre-filter and the "not for this material" caution (#455), the generator's
  // feeds (a thread's S/F included, #445 D6), and the three feed lookups below.
  //
  // A file that is there but wrong STOPS the run (`loadCatalogue` throws): a half-written
  // catalogue read as "no catalogue" would silently swap the vendor's numbers for seeds. No file
  // is not an error — the starting table and the shop's labelled defaults are what a machine that
  // has never synced Makera's library runs on. The stop still answers `--json` with one receipt
  // (#478), naming the catalogue and the validation failure: `fail()` threw before `emit()` and
  // left stdout empty, which is the same hole #733 item 3 closed for the job document.
  // #1081 — AND WHEN THERE IS NONE, THE RUN SAYS SO. This miss used to be silent: the same job
  // posted the shop's starting table while the app's Generate used Makera's rows (the tray
  // bottom's rough: F400 with 0.6 mm levels against the delivered F1000 with 1.0 mm — 44,830 s
  // against 18,619 s, #1074's record). `--catalogue` (or `CM_CATALOGUE`) names the document where
  // the sibling convention cannot; the miss is stated once, in the output and in the receipt, and
  // the run continues on the starting table exactly as it did before.
  const statedCatalogue =
    args.catalogue !== undefined
      ? args.catalogue
      : typeof process.env.CM_CATALOGUE === 'string' && process.env.CM_CATALOGUE.trim() !== ''
        ? process.env.CM_CATALOGUE
        : undefined;
  const siblingCatalogue = boot.location === null ? undefined : join(dirname(boot.location.path), 'catalogue.json');
  let catalogue: LoadedCatalogue | null;
  try {
    catalogue = loadCatalogue(statedCatalogue ?? siblingCatalogue);
  } catch (e) {
    return stop(invalidDocument('invalid-catalogue', `Makera's catalogue ${(e as Error).message}`));
  }
  const catalogueRows: readonly FeedCatalogueRow[] = catalogue?.rows ?? [];
  if (catalogue !== null) {
    recordInput(catalogue.path);
    const cutters = catalogue.tools.length;
    const rows = catalogue.rows.length;
    out.progress(
      `Makera's catalogue: ${catalogue.path} — ${cutters} cutter${cutters === 1 ? '' : 's'}, ` +
        `${rows} feed row${rows === 1 ? '' : 's'}${catalogue.syncedOn === null ? '' : `, synced ${catalogue.syncedOn}`}`,
    );
  } else {
    const where =
      statedCatalogue !== undefined
        ? `no Makera catalogue at ${statedCatalogue} — feeds come from the shop's starting table`
        : siblingCatalogue !== undefined
          ? "no Makera catalogue beside the location — feeds come from the shop's starting table"
          : "no Makera catalogue in the app's data directory — feeds come from the shop's starting table";
    out.progress(where);
    runDiagnostics.push(diagnostic('feeds-no-catalogue', 'info', where, 'findings', null));
  }

  // #1237 — A LOCATION FILE WITH NO SETTINGS SECTION IS SAID, NOT ASSUMED. A pre-#412 house file states no
  // settings (`defaults` is null by design) and names no location to the planner (see `shop` above), so
  // the plan runs on the recommendations: one line says so, and the receipt records it as a run-level
  // diagnostic, so a plan shaped by no shop settings never reads as one shaped by the shop's.
  if (boot.location !== null && boot.location.defaults === null) {
    out.progress(NO_SETTINGS_SECTION);
    runDiagnostics.push(diagnostic('location-no-settings', 'info', NO_SETTINGS_SECTION, 'findings', null));
  }

  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return fail(`cannot read ${path}: ${(e as Error).message}`);
    }
  };

  // #1175 — THE BROWSER'S TOOL LIST, WHEN THE HOUSE RUN FORWARDED ONE. The browser's Generate
  // passes `getTools().map((entry) => entry.tool)` as the ideal plan's candidate set; the service
  // writes that array beside the job and names it here. No file: the registry's own tools are the
  // candidates, which is this command's pre-#1175 behaviour byte for byte.
  let catalogueTools: readonly Tool[] | undefined;
  if (args.tools !== undefined) {
    const raw = readJson(args.tools);
    if (!Array.isArray(raw)) fail(`--tools must name a JSON array of tools, not ${typeof raw}`);
    catalogueTools = raw as Tool[];
    out.progress(
      `the browser's tool list: ${args.tools} — ${catalogueTools.length} cutter${catalogueTools.length === 1 ? '' : 's'} (the ideal plan's candidates)`,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Which cutter: the reachability table (#410)
  // ---------------------------------------------------------------------------------------------

  /**
   * Measure every cutter the registry offers against this job's items.
   *
   * The catalogue is the house's own `catalogue.json` (#308), read beside the machine's document
   * above and annotated with each cutter's geometry (#732): the pre-filter asks the vendor's rows
   * first, then the starting table and the machine, exactly as the app does. So a cutter Makera
   * states a row for is measured in a headless run — and #455's material-list rule can fire here
   * too, as the `not-for-material` caution `printReach` prints below.
   */
  function scanReach(job: EngraveJob): ReturnType<typeof reachabilityFor> {
    // #760 — the raised-text measurement rides the same scan: a cutter that joins a raised
    // label's letters is not one that "keeps every item intact", and the pick must see the gap
    // the finding will quote. One `PartPlan` build serves every candidate.
    const raised = raisedTextMeasure(tl, job, shopDefaults);
    return reachabilityFor(
      job,
      getTools(),
      catalogueRows,
      shopDefaults,
      (key) => {
        const entry = entryFor(key);
        return entry === null ? [] : measureEngraving(tl, job, entry.tool, shopDefaults);
      },
      undefined,
      null,
      (key) => {
        const entry = entryFor(key);
        return entry === null ? [] : raised(entry.tool);
      },
    );
  }

  /** The table as the operator reads it: one line per cutter, one column per item, in per cent. */
  function printReach(reach: ReturnType<typeof reachabilityFor>): void {
    const rows = reachTable(reach);
    if (rows.length === 0) return;
    const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
    out.progress('\nwhat each cutter reaches, item by item, and over the design as a whole:');
    out.progress(`  ${'cutter'.padEnd(24)} ${'   ⌀'.padEnd(10)} ${reach.items.map((i) => i.name).join(' | ')}`);
    for (const row of rows) {
      const cells = row.shares.map(pct).map((s) => s.padStart(6)).join('  ');
      const verdict =
        row.excluded !== null
          ? row.excluded
          : row.qualifies
            ? 'keeps every item intact'
            : row.joinsRaisedText
              ? 'joins the raised text'
              : 'loses detail';
      out.progress(
        `  ${row.key.padEnd(24)} ${`${row.diameter} mm`.padStart(9)}  ${cells}   ` +
          `${pct(row.total).padStart(5)} total   ${verdict}`,
      );
    }
    const pick = reach.recommendation.key;
    const compromise = reach.recommendation.compromise;
    const finer = pick === null || compromise ? null : finerThan(reach, pick);
    if (pick !== null && compromise) {
      // #760 — a compromise is not a clean answer, and "picks X (0% of the design)" for a 0.1 mm
      // cone reads as one. The measured reasons are in the recommendation (`reason`, shown by the
      // panel and the sheet) and in the plan's own note below; this line only names the closest.
      out.progress(`  ! #211 has no clean cutter: the closest is ${pick}.`);
    } else if (pick !== null && finer !== null) {
      out.progress(
        `  → #211 picks ${pick} (${pct(reach.totalShare.get(pick) ?? 0)} of the design); ${finer.key} reaches ` +
          `${pct(reach.totalShare.get(finer.key) ?? 0)}, so what is left is worth a second program (#410).`,
      );
    } else if (pick !== null) {
      out.progress(`  → #211 picks ${pick}, and no smaller cutter reaches more.`);
    }
    // #455 — a caution about the cutter the job NAMES, when it is not one the catalogue recommends.
    // Printed here rather than in each caller so a run that has rows cannot silently drop it.
    if (reach.recommendation.selectedNote !== null) out.progress(`  ! ${reach.recommendation.selectedNote}`);
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

  /** The frame facts both a generated result and a later program carry (`engraveGenerate`'s type). */
  type GeneratedFrame = Pick<EngraveGenerated, 'frameNc' | 'frameVerify' | 'frameError'>;

  /**
   * #747 — THE FRAME'S OWN REPORT, as the frame's: `source: 'frame'`, so the receipt can render it
   * under its own label and no consumer can read one as a finding about the program (review,
   * 2026-10-28). A WITHHELD frame is not a file the machine runs, so an error the verifier raised
   * on it is demoted to a warning — the program it belongs to passed and the run is fine. A frame
   * that WAS handed over keeps the verifier's severity: that file will run.
   */
  function frameDiagnostics(job: EngraveJob, generated: GeneratedFrame): ReceiptDiagnostic[] {
    const withheld = generated.frameNc === null && generated.frameError != null;
    return [
      ...(generated.frameVerify?.findings ?? []).map((f) =>
        diagnostic(
          f.code,
          withheld && f.severity === 'error' ? 'warning' : f.severity,
          f.message,
          'frame',
          job.name,
        ),
      ),
      // ... and WHY the frame is absent when the program itself is good. A warning, not a refusal:
      // the verified program stays runnable.
      ...(generated.frameNc === null && generated.frameError != null
        ? [diagnostic('no-frame', 'warning', generated.frameError, 'frame', job.name)]
        : []),
    ];
  }

  /**
   * The diagnostics a written program's own lists raise (#478). Every error is emitted as data with
   * its code — the run sheet carries the same findings — and the receipt's renderer decides which
   * block each appears under, so a count is never the only trace of a defect (#393).
   */
  function generatedDiagnostics(
    job: EngraveJob,
    generated: EngraveGenerated,
    load: SimLoadOk | null,
  ): ReceiptDiagnostic[] {
    return [
      ...generated.findings.map((f) => diagnostic(f.code, f.severity, f.message, 'findings', job.name)),
      ...(generated.verify?.findings ?? []).map((f) =>
        diagnostic(f.code, f.severity, f.message, 'verify', job.name),
      ),
      ...frameDiagnostics(job, generated),
      ...(load?.diagnostics ?? []).map((d) =>
        diagnostic(d.code, d.severity, d.message, 'simulation', job.name),
      ),
    ];
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
  type JobResult =
    | { ok: true; files: JobFiles; programs: EngraveProgram[]; diagnostics: ReceiptDiagnostic[] }
    | { ok: false; failure: EngraveFailure };

  /** One program's sweep, reduced to the facts a receipt entry and the diagnostics carry (#733). */
  interface ProgramSweep {
    engine: SimLoadOk['stats']['engine'];
    count: number;
    removedVolume: number;
    errorCount: number;
    diagnostics: SimDiagnostic[];
  }

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
    /** The first ENGRAVING program's sweep — the adapter the run sheet and receipt read. */
    load: SimLoadOk;
    /**
     * #733 item 4 — EVERY PROGRAM'S SWEEP, IN CUT ORDER: `sweeps[i]` is `generated.programs[i]`.
     * Program 1's entry repeats `load`; a later program's is its own, taken on the stock the
     * previous one left. Reduced to what a receipt entry prints, so the meshes of programs the
     * caller does not use can be collected.
     */
    sweeps: ProgramSweep[];
    /**
     * #744 — every program's sweep as the RUN SHEET reads it: labels in cut order, each program's
     * engine, whether it had to be swept from the blank, and the summary the coverage sentence
     * counts. `sweeps` above is the receipt's reduction of the same list.
     */
    simPrograms: ProgramSweepSummary[];
    /**
     * The material the run leaves, cumulative — `priorRemoval` (the rest route's seed) plus every
     * program's own removal. Null when nothing was removed.
     */
    removal: NodeMeshOutput | null;
    /**
     * Reports from sweeps that could not start from the previous program's stock (the simulator's
     * own prior-removal refusals), so the receipt says which program was checked from the blank.
     */
    simNotes: ReceiptDiagnostic[];
    /**
     * LIVE, and the caller's to dispose. `load.meshes.removal` is the material the swept program
     * leaves; every program's sweep ran on this session, and only the swept program's meshes are
     * retained here.
     */
    session: SimSession;
    /**
     * #953 — the goal check every program of a goal job carries, or undefined for a job with no
     * goal. The CLI runs it over each program's own live sweep, exactly as the run store does, so
     * the receipt's verdict is the one the Cut card shows.
     */
    goalCheck: SimGoalCheck | undefined;
    /** #953 — each program's own oracle report, in cut order (empty for a job with no goal). */
    goalOracles: { index: number; report: OracleReport }[];
  }
  type PrepareResult = Prepared | { ok: false; failure: EngraveFailure };

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
  async function prepare(
    job: EngraveJob,
    opts: { priorRemoval?: NodeMeshOutput; reusedOwnedPlan?: ModelPlanOutput | null } = {},
  ): Promise<PrepareResult> {
    // #732 — the house catalogue read above is the SAME list the app's worker is handed: the
    // vendor's row for this cutter and material answers before the starting table, and the
    // machine's clamp still has the last word (a thread's S/F comes through #445's
    // `threadSettings`). #733 — `shop.tools` is the registry snapshot; without it a setup's later
    // cutter (a `user:` or `inv:` key) is not on the worker's bench and the run stops at
    // `setup-rest-unavailable`.
    // #749 — the generator builds Clipper/Manifold CSG from the job's own geometry; a kernel
    // crash there is caught (never a bare throw) and answered as a stopped run at `cam`.
    let generated: EngraveGenerated;
    if (args.restLadder === true && !ladderSentencePrinted) {
      // #1046 — THE EXPECTED COST, BEFORE THE RUN. A first CLI run has no previous plan's timings,
      // so the sentence states #1028's MEASURED bounds instead of inventing a number — the ladder
      // re-plans the owned plan and every rung is a finish pass over the remainder.
      ladderSentencePrinted = true;
      console.error(
        'casemaker cut: measuring the standard balls — the ladder re-plans the owned plan and adds a finish pass per standard rung (measured on k3, #1028: a small plate in seconds, the tray ≈ 36 s, the organizer ≈ 23.5 min).',
      );
    }
    try {
      // #881 — the pipeline is async (a pool can plan the roughing levels); the CLI runs it with
      // no pool, so this is the same serial plan it always was.
      // #1068 — the app's Generate sends `mount` inside its shop; the CLI now sends the SAME object
      // (the mount's boxes reach the plan's travel heights and the program's verifier).
      generated = await engraveGenerate(tl, job, jobTool(job), catalogueRows, null, undefined, { ...shop, mount: mountFor(job) },
        // #1126 — with `--events`, the engine's own stage objects go to stderr unchanged; without
        // it this is the same `undefined` the CLI always passed.
        engineEvents,
        // #1111 R1 — THE IDEAL'S CANDIDATE SET, the same list the app sends: every tool the
        // registry holds (the catalogue's `cat:` definitions included, registered at boot). Without
        // it the CLI's ideal plan has no catalogue candidates and its tradeoff line differs from
        // the app's. #1175 — a house run forwards the browser's own list with `--tools`; that list
        // is used verbatim so both paths plan from the same snapshot.
        catalogueTools ?? getTools().map((entry) => entry.tool),
        // #1134 — the pick's winning full plan IS the cut's owned plan: post it, do not re-plan.
        // #1151 — owned plan first when the flag is set (false is today's two-plan run and
        // receipt); the parallel rank seam only when asked (false is the serial rank, byte-identical).
        // #1046 — the ladder choice rides the same object.
        {
          ...(opts.reusedOwnedPlan === undefined || opts.reusedOwnedPlan === null ? {} : { reusedOwnedPlan: opts.reusedOwnedPlan }),
          ...(args.deferIdeal === true ? { deferIdeal: true } : {}),
          ...(args.parallelRank === true ? { measureRankCandidates: rankPoolSeam() } : {}),
          ...(args.restLadder === true ? { restLadder: true } : {}),
          ...(args.tabChoice === undefined ? {} : { tabChoice: { choice: args.tabChoice } }),
        },
      );
      if (args.restLadder === true && generated.plan?.ladderRows !== undefined) runLadder = generated.plan.ladderRows;
    } catch (e) {
      if (isCliExit(e)) throw e;
      return {
        ok: false,
        failure: unexpectedStop('cam', 'generated', 'generating the toolpath', job.name, e, 'findings'),
      };
    }
    if (!generated.ok || generated.nc === null) {
      // #1118 — A VERIFY REFUSAL NAMES ITS FIRST ERROR. The findings already ride the receipt's
      // diagnostics (`generatedDiagnostics` maps `verify.findings` with source 'verify'); the
      // REFUSAL was the bare count ("3 verifier error(s)"), so a card or a terminal reading only
      // the refusals could not say what refused. The sentence keeps the count and adds the first
      // error's own words — code and message — which carry the line/location the verifier found.
      const firstVerifyError =
        generated.stage === 'verify' ? generated.verify?.findings.find((f) => f.severity === 'error') : undefined;
      const stageErrorReason = (message: string): string =>
        firstVerifyError === undefined || !message.includes('verifier error')
          ? message
          : `${message} — the first: ${firstVerifyError.code}: ${firstVerifyError.message}`;
      return {
        ok: false,
        failure: {
          stage: generated.stage,
          gate: gateForStage(generated.stage),
          diagnostics: generatedDiagnostics(job, generated, null),
          refusals:
            // #1258 — THE RUN ASKED: its own code, the question's sentence with each stretch's
            // numbers and the two flag values. Not a stage error, and never answered here.
            generated.tabChoiceNeeded !== undefined
              ? [{ code: 'tab-choice-needed', reason: tabChoiceSentence(generated.tabChoiceNeeded, generated.tabChoiceStale === true) }]
              : [
                  { code: 'stopped', reason: `stopped at ${generated.stage}` },
                  ...generated.errors.map((e) => ({ code: 'stage-error', reason: stageErrorReason(e.message) })),
                ],
          ...(generated.tabChoiceNeeded === undefined ? {} : { generated }),
        },
      };
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
    // #733 item 2 — THE POINT THE PLAN USED, ON TO THE SWEEP. The worker cannot read the location
    // (#382); the browser hands it the drill program's own `simDrillPoint`, or the shop's number for
    // any other load. Without this the sweep refuses a drill-shaped cutter outright
    // (`tool-refused`), which is what stopped every drill job before the fix.
    const shopDrillPoint =
      shop.drill === undefined || shop.drill === null
        ? null
        : { deg: shop.drill.settings.pointAngleDeg, source: shop.drill.sources.pointAngleDeg };

    // #733 item 4 — ONE SWEEP PER PROGRAM, ON THE STOCK THE LAST ONE LEFT. Program 1's sweep has
    // always gated the run; writing every program without sweeping it meant a later cutter's rapid
    // through stock went unchecked (`sim: null` in its receipt entry). Each program is now loaded
    // in cut order, seeded with the cumulative removal so far — the same `priorRemoval` the rest
    // passes have always used — and a program whose sweep fails is refused exactly as program 1 is.
    //
    // THE ONE EXCEPTION IS THE SIMULATOR'S OWN REFUSAL TO SEED A PROGRAM: the column engine (V-bit,
    // drill, thread, wrapped rotary) and an indexed rotary exact sweep cannot start from a previous
    // program's material (`prior-removal-column` / `prior-removal-rotary`; session.ts states why a
    // rest pass against the wrong stock is not a picture of the cut). Those programs are swept from
    // the blank instead — still checked for fixture, stock and rapid collisions — and the receipt
    // carries an info note naming the program, rather than refusing a good drill or V job over a
    // limitation of the sweep.
    // #869 — THE TOP-LEVEL ADAPTER IS THE PROGRAM `nc` DESCRIBES. Usually that is the first
    // ENGRAVING program; a goal split into a flat rough and the ball's finish posts the rough
    // first, and `nc` (with `cam`, `verify` and the run sheet) is the FINISH — the part — which is
    // the second file. Find it by its text, not by its position.
    const sweptIndex = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing' && p.nc === nc);
    if (sweptIndex < 0) {
      fail('the generator did not list the program this run swept');
    }
    /** A program's sweep stopped the run, in the same words program 1 has always used (#393). */
    const simStop = (diagnostics: readonly SimDiagnostic[], problem: string | null): PrepareResult => {
      session.dispose();
      return {
        ok: false,
        failure: {
          stage: 'simulated',
          gate: 'simulated',
          diagnostics: diagnostics.map((d) =>
            diagnostic(d.code, d.severity, d.message, 'simulation', job.name),
          ),
          refusals:
            problem === null
              ? [{ code: 'simulation-refused', reason: 'simulation refused the file' }]
              : [
                  { code: 'simulation-refused', reason: problem },
                  {
                    code: 'nothing-written',
                    reason: 'nothing written: a job the simulation refuses is a document to fix, not a file',
                  },
                ],
        },
      };
    };
    // #744 — THE WALK IS SHARED WITH THE APP. `engine/cnc/engrave/programSweep.ts` owns the cut
    // order, the cumulative seed, each program's own cutter and point, the from-blank retry and the
    // #393 gate; this command supplies its synchronous session load and its own shop drill point.
    // The web run store runs the same function, so the two realms cannot disagree about what
    // "every program swept" means.
    // #953 — THE GOAL CHECK, AS THE RECEIPT CARRIES IT. One input for the run (the goal target and
    // the shop's pass line), and each program's report taken while its own sweep is the live one —
    // the run store's rule, so the CLI and the Cut card judge the same file the same way.
    // #966 — the gate is the job's own shape (`pureGoalObject`), not `generated.surface3d`: the
    // model-engine goal path posts a real `verify` with no `surface3d`, and the old proxy would
    // have read it as an item job and dropped the goal block from the receipt silently. Mirrors
    // the same fix in `engraveRunStore.ts`'s `afterLoad`, so the CLI and the Cut card agree.
    // #961/#1032 — A POSTED PROGRAM'S KEY MUST RESOLVE TO THE BENCH'S CUTTER: `cutterKeyOf`
    // stamps `tool.id ?? tool.name`, and the built-in tier's identity is not its registry key.
    // `benchCutterFor` (`toolRegistry.ts`) is the one rule; the app's run store calls it too, so
    // the CLI and the Cut card cannot disagree about which cutter a posted program names.
    const goalCheck = goalCheckForProgram(job, pureGoalObject(job) !== null, {
      // #1207 — the pass line and the shop's own three goal bands, from the one place every caller of
      // the check reads them (the run store and the plan evaluator too); the CLI used to leave the
      // bands to the registry's recommendations. The LAST band is also #1248's tall band.
      ...goalCheckShopOptions(shopDefaults),
      // #1064 (d) — the plan's own bevel prediction, stated beside the measurement.
      ...(generated.plan?.outcome?.predictedCutIntoMm == null
        ? {}
        : { predictedCutIntoMm: generated.plan.outcome.predictedCutIntoMm }),
      // #955/V2-2 — the edge-break allowance's GATE parameters, from the job's edgeBreak and the
      // tools this run posts (never the CAM's plan, A's R3). No edge break → no allowance.
      ...goalEdgeBreakOptions(
        job,
        (key) => (key === job.toolKey ? tool : benchCutterFor(key)),
        generated.programs.map((p) => p.toolKey),
      ),
    },
      // #1083 — a rotary goal is judged on the map: the map's own radius and section ride along
      // (goalCheckInput must not value-import the CAM, so the caller that has the job supplies it).
      (() => {
        const map = rotaryMapOf(job, shopDefaults);
        return map === null ? null : { radius: map.radius, section: map.section };
      })(),
    );
    const goalOracles: { index: number; report: OracleReport }[] = [];
    const firstEngraving = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing');
    const sweptBox: { load: SimLoadOk | null } = { load: null };
    // #749 — WHICH PROGRAM WAS BEING SWEPT, so a kernel crash can name it. The walk itself is
    // shared with the app and does not catch a load that throws; this boundary does, because the
    // command line owns the session it must then dispose and the receipt it must still emit.
    let sweeping = 'the program';
    let outcome: ProgramSweepOutcome;
    try {
      outcome = await sweepPrograms({
        programs: generated.programs,
        shopDrillPoint,
        // `toolForProgram`'s reading: the job's own snapshot for the job's key, the registry for a
        // setup's later cutter.
        cutterFor: (program) =>
          program.toolKey === job.toolKey ? tool : benchCutterFor(program.toolKey),
        load: async ({ program, index, cutter, drillPoint, priorRemoval, priorFields, priorExactRemoval, fromBlank }) => {
          memTrace('sweep:start', { program: index + 1, kind: program.kind ?? 'engrave', cutter: program.toolKey });
          sweeping =
            (program.kind ?? 'engrave') === 'facing'
              ? `the facing pass (${program.toolKey})`
              : `program ${index + 1} (${program.toolKey})`;
          // #1068 — THE SAME FIXTURE THE APP'S SWEEP LOADS (`engraveRunStore.ts`'s
          // `toSetup(job, machine, mount?.fixture, bed)`). Without it a bracket job's program was
          // swept against no fixture at all, so a cutter through the bracket's arm — or through a
          // hole the job states — was never seen.
          return session.load(program.nc, toSetup(job, Z1, mountFor(job)?.fixture, undefined, undefined, shopDefaults), cutter, Z1.id, {
            // #734 — the CAM posts a through move to `thickness + breakthrough`, so the sweep's floor
            // must be the same: without it a correct through cut's retract reads as a rapid through
            // material (j17 reproduced the bench's `rapid-through-stock` on 7 vertical retracts).
            // Every program gets the floor, not only the first.
            breakthroughMm: job.breakthrough,
            // #744 — the list as the earlier programs left it; the session unions it into the one seed
            // mesh the exact sweeper takes. An empty list is no seed.
            ...(priorRemoval.length === 0 ? {} : { priorRemoval }),
            // #817 — the earlier column programs' remaining tops, in the same frame here.
            ...(priorFields.length === 0 ? {} : { priorFields }),
            ...(priorExactRemoval === undefined ? {} : { priorExactRemoval }),
            // #1040 — a from-blank retry inside the run keeps the run's goal fold.
            continueRun: fromBlank === true,
            ...(drillPoint === null ? {} : { drillPointDefault: drillPoint }),
          });
        },
        afterLoad: ({ index, program, result }) => {
          if (index === sweptIndex) sweptBox.load = result;
          if (goalCheck === undefined) return;
          // The run store's per-program evidence, field for field: the walk's own `predicted`, with
          // the run's top-level list for the first engraving program, and the design items off the
          // generated program (the walk view does not carry them).
          const predicted = program.predicted ?? (index === firstEngraving ? generated.predicted : undefined);
          const designItems =
            generated.programs[index]?.designItems ?? (index === firstEngraving ? generated.designItems : undefined);
          goalOracles.push({
            index,
            // The worker's own conversion, so the CLI samples the goal and pairs it with the live
            // sweep exactly as the app's worker does (`goalInputFor` caches the heightfield).
            report: session.oracle([...(predicted ?? [])], undefined, designItems, goalInputFor(session, goalCheck)),
          });
        },
        initialRemoval: opts.priorRemoval === undefined ? [] : [opts.priorRemoval],
      });
    } catch (e) {
      if (isCliExit(e)) throw e;
      disposeAfterCrash(session);
      return {
        ok: false,
        failure: unexpectedStop('simulated', 'simulated', `simulating ${sweeping}`, job.name, e, 'simulation'),
      };
    }

    if (!outcome.ok) {
      const failure = outcome.failed;
      if (failure === null) {
        // The walk stops before the first program only when its load is cancelled, which this
        // synchronous caller never does. Refuse rather than write a half-checked run.
        session.dispose();
        return {
          ok: false,
          failure: {
            stage: 'simulated',
            gate: 'simulated',
            diagnostics: [],
            refusals: [{ code: 'simulation-refused', reason: 'simulation stopped before the first program' }],
          },
        };
      }
      if (failure.kind === 'no-cutter') {
        session.dispose();
        return {
          ok: false,
          failure: {
            stage: 'simulated',
            gate: 'simulated',
            diagnostics: failure.diagnostics.map((d) =>
              diagnostic(d.code, d.severity, d.message, 'simulation', job.name),
            ),
            refusals: [{ code: 'tool-refused', reason: `cutter ${failure.toolKey} is not in the tool library` }],
          },
        };
      }
      // #393 — THE OTHER HALF OF THE GATE, and the one that was missing. `ok` means the sweep
      // produced material, NOT that the program is safe: a run that drove the cutter 0.97 mm³ into
      // the fixed jaw is `ok: true` with a `tool-into-fixture` ERROR among its diagnostics, because
      // the panel has to be able to DRAW that cut (`simGate.ts`). Trusting `ok` alone wrote four
      // 11.5 mm coupons whose own simulation said they hit the jaw, and receipted them "all
      // generated". The shared walk applies `simulationProblem` to every program; a refusal has no
      // problem sentence, exactly as program 1 has always read.
      return simStop(failure.diagnostics, failure.kind === 'refused' ? null : simulationProblem(failure.diagnostics));
    }

    const sweptLoad = sweptBox.load;
    if (sweptLoad === null) fail('the generator did not list the program this run swept');
    // One receipt entry per program, aligned with `generated.programs` (the writer checks that the
    // two line up). The removal meshes stay behind; only the cumulative stock is returned, below.
    const sweeps: ProgramSweep[] = outcome.sweeps.map((s) => ({
      engine: s.engine,
      count: s.count,
      removedVolume: s.removedVolume,
      errorCount: s.errorCount,
      diagnostics: s.diagnostics,
    }));
    const simNotes: ReceiptDiagnostic[] = outcome.sweeps.flatMap((s) =>
      s.notes.map((d) => diagnostic(d.code, d.severity, d.message, 'simulation', job.name)),
    );
    // The material the run leaves, cumulative: the rest route's seed plus every program's removal,
    // unioned once here. Null when nothing was removed.
    let removal: NodeMeshOutput | null;
    try {
      removal =
        outcome.priorRemoval.length === 0
          ? null
          : outcome.priorRemoval.length === 1
            ? outcome.priorRemoval[0]!
            : unionRemoval(tl, outcome.priorRemoval);
    } catch (e) {
      // #749 — the same boundary as the sweep above: a union of the programs' removal meshes is
      // kernel work, and a crash in it must still answer the one receipt.
      if (isCliExit(e)) throw e;
      disposeAfterCrash(session);
      return {
        ok: false,
        failure: unexpectedStop('simulated', 'simulated', 'combining the programs’ removal', job.name, e, 'simulation'),
      };
    }
    return {
      ok: true,
      job,
      tool,
      nc,
      diameter,
      generated,
      load: sweptLoad,
      sweeps,
      simPrograms: outcome.sweeps.map(sweepSummary),
      removal,
      simNotes,
      session,
      goalCheck,
      goalOracles,
    };
  }

  /**
   * The file names for a job's programs, in cut order (#733, #1093 R1) — now the module-level
   * `programFileNames`, which reads `releaseFileName` for EVERY engraving program.
   */
  /**
   * Write one prepared job: every program it generated, in cut order — each `.nc`, its frame — plus
   * the job's one run sheet and (for the routes that build a document rather than read one) the job
   * JSON. Disposes the session on the way out, so a prepared program cannot outlive its sweep by
   * accident.
   *
   * #733 — THE JOB'S PROGRAM LIST, NOT ITS FIRST PROGRAM. For a one-cutter job the list is
   * `[generated.nc]` and this is the writer it always was. A multi-cutter job's list is every
   * cutter's own file; writing only the adapter dropped the rest of the run.
   */
  /**
   * #1089 — THE COMPARISON THIS RUN CAN STATE, from Generate's own result. With both plans run
   * (the CLI's default), `planTradeoff` carries it; `idealDeferred` means the caller asked for the
   * owned plan first, so the comparison is STATED deferred rather than silently missing; anything
   * else (no goal plan, no catalogue, the catalogue added no cutter) has no comparison at all.
   */
  function comparisonOf(generated: EngraveGenerated): PlanComparisonStatement | null {
    if (generated.planTradeoff !== undefined && generated.planTradeoff !== null) return planComparisonStatement(generated.planTradeoff);
    return generated.idealDeferred === true ? { kind: 'deferred' } : null;
  }
  /** The receipt's own shape of the statement; `comparing` is an app-only state, never the CLI's. */
  function receiptComparison(statement: PlanComparisonStatement): EngraveDetails['comparison'] | undefined {
    if (statement.kind === 'deferred') return { deferred: true };
    if (statement.kind === 'comparing') return undefined;
    return {
      material: statement.kind === 'material',
      line: statement.kind === 'material' ? statement.line : null,
      ownedSeconds: statement.ownedSeconds,
      idealSeconds: statement.idealSeconds,
    };
  }

  function writeProgram(
    prepared: Prepared,
    outDir: string,
    opts: WriteOpts,
  ): { files: JobFiles; programs: EngraveProgram[]; diagnostics: ReceiptDiagnostic[] } {
    const { job, tool, nc, diameter, generated, load, sweeps, simNotes, simPrograms } = prepared;
    // #1089 — the run's comparison, captured once for the receipt and handed to the sheet below.
    const comparison = comparisonOf(generated);
    if (runComparison === undefined && comparison !== null) runComparison = receiptComparison(comparison);
    // #1193 — the run's own cycle, from the seam that saw every posted program.
    if (runCycle === undefined && generated.runCycle !== undefined && generated.runCycle !== null) {
      const r = generated.runCycle;
      runCycle = {
        totalSeconds: r.totalSeconds,
        cuttingSeconds: r.cuttingSeconds,
        changeSeconds: r.changeSeconds,
        changes: r.changes,
        programCount: r.programCount,
        setupCount: r.setupCount,
        flip: r.flip,
      };
    }
    const writeSheet = opts.sheet !== false;
    // The stem is claimed through `stemFor`, which refuses a name already used this run: the rest
    // program of a two-tool job is written from a job named `<name> rest`, so the two programs land
    // as `<stem>.nc` and `<stem>-rest.nc` and a collision is a defect rather than a silent overwrite.
    const stem = stemFor(job);
    const names = programFileNames(job.name, generated.programs);
    // #869 — THE SHEET IS NAMED FOR THE FIRST ENGRAVING PROGRAM (cut order), while the top-level
    // adapter `nc` is the program the generator's summary describes — the FINISHING program when a
    // goal is split, else the first. Both indices are real: the header check reads one, the
    // receipt's `sim` and file entry the other.
    const firstEngraving = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing');
    if (firstEngraving < 0) {
      fail('the generator did not list the program this run swept');
    }
    const sweptIndex = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing' && p.nc === nc);
    if (sweptIndex < 0) {
      fail('the generator did not list the program this run swept');
    }
    // One sweep per program, in the same order (`prepare` walks `generated.programs`).
    if (sweeps.length !== generated.programs.length) {
      fail('the generator’s program list and the sweeps do not line up');
    }
    // #243: the run sheet's §8 carries the coverage sentence, so the sheet must be handed the run's
    // outcome and diagnostics — exactly what the Simulate panel would. This run swept.
    //
    // #733 — `RunSheetProgram.nc` is "the file to load", so the sheet is handed the names this
    // command writes rather than the program texts. Without this a later program's section would
    // paste its whole G-code into the markdown.
    const sheetPrograms = generated.programs.map((program, i) => ({
      ...program,
      nc: names[i]!.ncFile,
      frameNc: program.frameNc === null ? null : names[i]!.frameFile,
    }));
    // #1070 — A BED-HELD JOB'S SHEET PRINTS THE FOOTPRINT PLAN (the same plan the Cut step's
    // attempt runs): read off the job and the loaded house, absent when the house lacks what the
    // plan needs (the machine's calibration or the wired probe), so an older house keeps the old
    // registration section rather than a plan it cannot back.
    const sheetRegistration = sheetRegistrationFor(job, boot.location);
    const footprint = sheetRegistration.footprint;
    const seatSeek = sheetRegistration.seatSeek;
    const sheet = buildRunSheet(
      job,
      { ...generated, programs: sheetPrograms },
      {
        // #744 — EVERY program's diagnostics, under its own label, not only the first file's: a
        // warning raised by program 3 is a fact about this run, and the app's run store builds the
        // same list with the same function, so the sheet and the panel cannot word it differently.
        diagnostics: attributedDiagnostics(simPrograms, generated.programs.length > 1),
        outcome: 'swept',
        engine: load.stats.engine,
        // #744 — and every program's RESULT, so the coverage sentence speaks for the whole run.
        programs: simPrograms,
      },
      // The run's one clock (#484): a caller may pin it so a committed fixture stays byte-stable;
      // absent, this is the wall clock the command has always used.
      options.now ?? new Date(),
      MARGIN_DEFAULTS,
      {
        ...(opts.sheetOptions ?? {}),
        ...(footprint === undefined ? {} : { footprint }),
        ...(seatSeek === undefined ? {} : { seatSeek }),
        efficiencyThresholds: efficiencyThresholds(shopDefaults),
        tapeStripCount: readDefault(shopDefaults, 'tape.stripCount').value,
        // #1244 — the sheet's own rotary/registration checks read the booted location's map.
        defaults: shopDefaults,
        // #1089 — THE IDEAL-VS-OWNED LINE beside the cutter: the same statement the receipt
        // carries, or none when this run had nothing to compare.
        ...(comparison === null ? {} : { comparison }),
        // #1059 — a chuck job's sheet prints the axis and the levelled face angle from the bed
        // profile it was planned on (absent: the sheet says what is not measured).
        rotaryDatum: rotarySheetDatumFor(job, boot.location, shopDefaults),
        // #1068 — §8 names the fixture THIS job's sweep was handed: the bracket's arms and the
        // job's clamps (and its own obstacle boxes), never the vise's jaws. A vise job leaves it
        // absent (the sheet derives the vise's own envelope, as it always did); a tape job says
        // nothing is modelled.
        fixture: jobMount(job) === 'vise' ? undefined : (mountFor(job)?.fixture ?? null),
      },
    );
    if (sheet.header.fileName !== names[firstEngraving]!.ncFile) {
      fail(`run sheet file name drifted: expected ${names[firstEngraving]!.ncFile}, got ${sheet.header.fileName}`);
    }

    // #733 — WRITE THE RUN, IN CUT ORDER. Every program carries its OWN sweep result (#733 item 4):
    // the swept program additionally carries the sheet and the job's preview. A later program's
    // sweep runs on the stock the previous one left, so its entry's number is the material that
    // program removes FROM THAT STOCK, not a second blank.
    const written: EngraveProgram[] = [];
    const laterDiagnostics: ReceiptDiagnostic[] = [];
    // #1165 — THE VERDICT'S CAUSE, read from the staging facts the plan already stated (the
    // goal-unreached finding's top-setup share, the refused finishes' floor/usable pairs). It rides
    // ONLY the block that IS the run's verdict — the last program whose check ran, the same block
    // `emit()` copies to `details.goal` — never an intermediate rough pass's block, whose leftover
    // is by design.
    const causeFacts = goalCauseFacts(prepared.generated.findings, prepared.generated.planStatements ?? []);
    const verdictIndex = prepared.goalOracles.reduce(
      (last, oracle) => (oracle.report.goalCutInto === undefined ? last : Math.max(last, oracle.index)),
      -1,
    );
    const sheetEntry = writeSheet
      ? { file: `${stem}-run-sheet.md`, ncHash: sheet.header.fileHash, estimatedTime: sheet.header.estimatedTime }
      : null;
    generated.programs.forEach((program, i) => {
      const file = names[i]!;
      writeFileSync(join(outDir, file.ncFile), program.nc);
      runOutputs.push(fileReceipt(join(outDir, file.ncFile)));
      const frameFile = program.frameNc === null ? null : file.frameFile;
      if (frameFile !== null) {
        writeFileSync(join(outDir, frameFile), program.frameNc!);
        runOutputs.push(fileReceipt(join(outDir, frameFile)));
      }
      const swept = i === sweptIndex;
      const sweep = sweeps[i]!;
      const cam = program.cam;
      // #953 — this program's own goal verdict, from the report taken while its sweep was live.
      // Undefined for a job with no goal (the field is then omitted); null for a goal job whose
      // program ran no check (a facing pass), never an invented verdict.
      const goalCutInto = prepared.goalOracles.find((o) => o.index === i)?.report.goalCutInto;
      const goalBlock: EngraveGoal | null | undefined =
        prepared.goalCheck === undefined
          ? undefined
          : goalCutInto === undefined
            ? null
            : goalBlockFromReport(
                goalCutInto,
                i === verdictIndex ? goalCauseOf(goalCutInto, causeFacts) : null,
              );
      written.push({
        name: job.name,
        stage: generated.stage,
        ok: generated.ok,
        ncFile: file.ncFile,
        ncLines: program.nc.split('\n').length,
        frameFile,
        cam:
          cam === null
            ? null
            : {
                operations: cam.operations,
                cuttingMoves: cam.cuttingMoves,
                passes: cam.passes,
                estimatedSeconds: cam.estimatedSeconds,
                rapidMm: cam.rapidMm ?? null,
                cutMm: cam.cutMm ?? null,
                baselineRapidMm: cam.baselineRapidMm ?? null,
                // #926 — measured by `summarize`; absent only on a stored result from before it.
                efficiency: cam.efficiency,
              },
        sim: {
          ok: true,
          engine: sweep.engine,
          count: sweep.count,
          removedVolumeMm3: sweep.removedVolume,
          errorCount: sweep.errorCount,
        },
        sheet: swept ? sheetEntry : null,
        previews: [],
        images: [],
        // #953 — the program's own goal check (a goal job only — see `goalBlock` above).
        ...(goalBlock === undefined ? {} : { goal: goalBlock }),
      });
      if (!swept) {
        // The swept program's reports are already in `generatedDiagnostics`; every other program's
        // verifier AND sweep reports have to be carried here or the receipt would drop a warning
        // the file or its sweep raised.
        laterDiagnostics.push(
          ...(program.verify?.findings ?? []).map((f) =>
            diagnostic(f.code, f.severity, f.message, 'verify', job.name),
          ),
          // #747 — a later program's frame report and its withheld reason, on the same rule as the
          // swept program's: every file the machine runs is checked, and every check is carried
          // under the frame's own name (`source: 'frame'`).
          ...frameDiagnostics(job, program),
          ...sweep.diagnostics.map((d) =>
            diagnostic(d.code, d.severity, d.message, 'simulation', job.name),
          ),
        );
      }
    });
    const sweptProgram = written[sweptIndex]!;

    if (writeSheet) {
      writeFileSync(join(outDir, `${stem}-run-sheet.md`), renderRunSheetMarkdown(sheet, opts.note));
      runOutputs.push(fileReceipt(join(outDir, `${stem}-run-sheet.md`)));
    }
    if (opts.writeJobDocument) {
      writeFileSync(join(outDir, `${stem}.job.json`), JSON.stringify(job, null, 2) + '\n');
      runOutputs.push(fileReceipt(join(outDir, `${stem}.job.json`)));
    }
    // The cutter's own number, so the receipt says where each program's width came from.
    noteProvenance(provenance(`tool.${job.toolKey}.diameter`, diameter, 'mm', 'seeded'));
    for (const [i, program] of generated.programs.entries()) {
      if (i === sweptIndex || (program.kind ?? 'engrave') === 'facing') continue;
      const entry = entryFor(program.toolKey);
      const d = entry === null ? null : cuttingDiameter(entry.tool);
      if (d !== null && d > 0) {
        noteProvenance(provenance(`tool.${program.toolKey}.diameter`, d, 'mm', 'seeded'));
      }
    }

    // #410 — THE PREDICTED CUT, DRAWN AT THE CUTTER'S REAL WIDTH. The table says a percentage; a
    // percentage does not show WHICH strokes survive, and that is the thing that decides whether the
    // badge reads. Everything here comes from `engraveRegions`, the ONE place the cut classes are
    // enumerated (#288) — so the opening, the swept trace and the drill in the picture are the ones in
    // the program, and the void rings are the same footprints the depth limit is computed against.
    // It costs one more evaluation of the job, which is why it is opt-in. The picture is the SWEPT
    // program's: it is drawn from the job and cutter that program ran.
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
      runOutputs.push(fileReceipt(join(outDir, svgFile)));
      previews.push({ svg, svgFile, pngFile: `${stem}-preview.png` });
      sweptProgram.previews.push(svgFile);
      for (const p of previews) imageTargets.push({ svgFile: p.svgFile, pngFile: p.pngFile, program: sweptProgram });
    }

    prepared.session.dispose();
    const sweptNames = names[sweptIndex]!;
    return {
      files: {
        ok: true,
        ncFile: sweptNames.ncFile,
        frameFile: generated.programs[sweptIndex]!.frameNc === null ? null : sweptNames.frameFile,
        sheetFile: writeSheet ? `${stem}-run-sheet.md` : null,
        hash: sheet.header.fileHash,
        previews,
      },
      programs: written,
      diagnostics: [...generatedDiagnostics(job, generated, load), ...simNotes, ...laterDiagnostics],
    };
  }

  /** Generate, verify, simulate and write one job — the two calls above, in order. */
  /**
   * #1129 — THE RECEIPT'S SAMPLING ROWS: the plan's `clGrid`, deduped by cutter and sorted, so the
   * value the row sampler stopped at — and whether the job stated it — is on the receipt rather
   * than only in the sheet.
   */
  function samplingRows(generated: EngraveGenerated): EngraveDetails['sampling'] {
    const rows = (generated.plan?.perSetup ?? []).flatMap((setup) => setup.clGrid);
    const byCutter = new Map<string, NonNullable<EngraveDetails['sampling']>[number]>();
    for (const row of rows) {
      const kept = byCutter.get(row.cutterKey);
      if (kept === undefined) {
        byCutter.set(row.cutterKey, {
          cutterKey: row.cutterKey,
          toleranceMm: row.toleranceMm,
          minSpacingMm: row.minSpacingMm,
          maxSpacingMm: row.maxSpacingMm,
          minSpacingSource: row.minSpacingSource,
          minSpacingFromStepOverMm: row.minSpacingFromStepOverMm,
        });
      }
    }
    return byCutter.size === 0 ? undefined : [...byCutter.values()].sort((a, b) => (a.cutterKey < b.cutterKey ? -1 : a.cutterKey > b.cutterKey ? 1 : 0));
  }

  async function runJob(
    job: EngraveJob,
    outDir: string,
    opts: {
      writeJobDocument: boolean;
      note: string;
      reachability?: Reachability;
      unreachable?: { row: ReachRow; cutters: number }[];
      preview?: boolean;
      /** #1134 — the pick's measured owned plan (see `prepare`). */
      reusedOwnedPlan?: ModelPlanOutput | null;
      /** #1126 — write the run's RESULT DOCUMENT here (JSON, `resultDocument`'s v2 shape). */
      generatedFile?: string;
    },
  ): Promise<JobResult> {
    const prepared = await prepare(
      job,
      opts.reusedOwnedPlan === undefined || opts.reusedOwnedPlan === null
        ? {}
        : { reusedOwnedPlan: opts.reusedOwnedPlan },
    );
    if (!prepared.ok) {
      // #1258 — a run that STOPPED TO ASK still writes its generated document: a house-backed run
      // draws the card from it. (Every other failure writes none, as before.)
      if (opts.generatedFile !== undefined && prepared.failure.generated !== undefined) {
        writeFileSync(opts.generatedFile, JSON.stringify(prepared.failure.generated));
      }
      return prepared;
    }
    const sampling = samplingRows(prepared.generated);
    if (sampling !== undefined) runSampling = sampling;
    const written = writeProgram(prepared, outDir, {
      writeJobDocument: opts.writeJobDocument,
      note: opts.note,
      ...(opts.reachability === undefined
        ? {}
        : { sheetOptions: { reachability: opts.reachability, ...(opts.unreachable ? { unreachable: opts.unreachable } : null) } }),
      ...(opts.preview === true ? { preview: true } : null),
    });
    if (opts.generatedFile !== undefined) {
      // #1126 slice 2 — after the programs are written, so every name the result lists exists on
      // disk; the document itself carries no NC text and no `camIr` (see `resultDocument`).
      writeFileSync(opts.generatedFile, JSON.stringify(resultDocument(job.name, prepared.generated)));
    }
    return { ok: true, ...written };
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

  /**
   * #786 slice 4b — THE SEARCH'S OWN VIEW OF THE SHOP, plus the cutter the DOCUMENT names when the
   * location does not list it. A saved job can carry its operator's own cutter (a drill from
   * another bench, a one-off); the split keeps that cutter for its holes, so the search has to be
   * able to see it rather than conclude the job's cutter does not exist.
   */
  function searchToolsFor(job: EngraveJob): ToolLibraryEntry[] {
    const listed = [...getTools()];
    if (job.toolKey === NO_TOOL_KEY || job.tool === undefined || job.tool === null) return listed;
    if (listed.some((e) => e.key === job.toolKey)) return listed;
    return [...listed, { key: job.toolKey, tool: job.tool, provenance: 'the job’s own cutter' }];
  }

  /**
   * #786 slice 4b — A NAMED DRILL BIT OR THREAD MILL WITH OTHER WORK IS SPLIT BY THE SEARCH, not
   * refused. The app's panel applies the same plan before Generate (4c); a headless run asks the
   * same question here, because `drill-mixed-tools` would otherwise refuse a document the app
   * cuts. True when the first candidate plan keeps the job's own cutter and adds another.
   */
  function splitKeepsNamedCutter(job: EngraveJob): boolean {
    if (job.toolKey === NO_TOOL_KEY || job.setups !== undefined) return false;
    // ONLY a drill bit or a thread mill: every ordinary job also has multi-cutter candidates
    // (rough + rest), and those are not a reason to hand the job to the search.
    const tools = searchToolsFor(job);
    const named = job.tool !== undefined && job.tool !== null ? job.tool : tools.find((e) => e.key === job.toolKey)?.tool;
    if (named === undefined || (named.shape !== 'drill' && named.shape !== 'thread')) return false;
    return pickCandidates({
      tl,
      job,
      tools,
      catalogue: catalogueRows,
      conditions: inventoryConditions(),
      shop: pickShop,
      // #940 — the same floors rule; the candidate list is the one the search would measure.
      floors: supportingFloors(tl, toPartPlan(job, { defaults: shopDefaults })),
    }).some(
      (p) => p.cutters.length > 1 && p.cutters[0]?.key === job.toolKey,
    );
  }

  /**
   * #786 slice 6 — `tool-missing`: THE DOCUMENT NAMES A CUTTER THIS BENCH DOES NOT HOLD. A saved
   * job can outlive the library it was written against (an `inv:` row deleted, a `user:` row
   * renamed), and the app's panel answers it by handing the job to the measured search (4c-2).
   * The headless run asks the same question here, so the command line posts the programs the app
   * would instead of stopping on a key that no longer resolves. A document carrying its OWN tool
   * snapshot is not missing — that snapshot IS the cutter (searchToolsFor's rule) — so only a key
   * that resolves to nothing counts.
   */
  function namesMissingCutter(job: EngraveJob): boolean {
    if (job.toolKey === NO_TOOL_KEY || job.setups !== undefined) return false;
    return jobTool(job) === null;
  }

  /**
   * #766/#743 P-4b — THE CUTTERS A JOB DOES NOT NAME, chosen by the measured search.
   *
   * The kind-valid plans are generated (`smartPick`), slice A scores each by what it would cut, and
   * the best POSTING plan is the one written. `--tool`/`--rest` still override (the `--from-3mf`
   * route's rule). Returns null once the job names its plan, or the sentence to stop with.
   * Extracted so the Gerber door (#743 P-4b) asks exactly the same question of the job it builds.
   */
  async function chooseCutters(job: EngraveJob, label: string): Promise<string | null> {
    // #766 — A JOB THAT NAMES NO CUTTER IS GIVEN ONE BY SIMULATION. The rules that came before
    // (area share #762, item kind, the tightest raised gap #760/#765) each failed on a real job;
    // this path now runs the measured search: plausible kind-valid plans are generated
    // (`smartPick`), slice A scores each by what it would cut, and the best POSTING plan is the
    // one written. The search's own sentence is printed, and `--tool`/`--rest` still override.
      if (args.tool === undefined && args.rest === undefined) {
        // #766 — THE CHOICE IS MEASURED, NOT RULED. The search generates the kind-valid plans and
        // slice A simulates each one: fidelity, pinches, time, risk. The chosen plan and its
        // reasons are printed here; the run writes the plan the search chose.
        const searchTools = searchToolsFor(job);
        const searchStart = Date.now();
        // #922 — THE APP'S OWN SEARCH: `pickForEngrave` builds the conditions map, the feed table
        // and the evaluator context for both doors; `pickShop` carries the tool-change cost the
        // panel's picker reads from the same setting.
        // #940 — the document's supporting floors, so a V-carve's reach is measured from the
        // floor it is cut into rather than from the stock top; the one builder carries them.
        const pick = await pickWithPool({
          tl,
          job,
          tools: searchTools,
          catalogue: catalogueRows,
          conditions: inventoryConditions(),
          shop: pickShop,
          // #1134 — the FULL evaluations plan the program the cut would post: the run shop, mount
          // included. The pick's own score keeps the picker's shop (the both-doors rule, #947).
          runShop: { ...shop, mount: mountFor(job) },
          ...(args.tabChoice === undefined ? {} : { tabChoice: { choice: args.tabChoice } }),
          floors: supportingFloors(tl, toPartPlan(job, { defaults: shopDefaults })),
        });
        const searchMs = Date.now() - searchStart;
        // #910 — every cutter refused before a plan existed: the reasons ARE the answer.
        if (pick.refused === true) {
          for (const c of pick.candidates) out.progress(`  refused   ${c.key} — ${c.reason}`);
          return `${label}: ${pick.reason}`;
        }
        const words = explainSmartPick(pick, searchTools, { cutterKeys: true });
        out.progress(`  pick      ${words.verdict}`);
        words.cutters.forEach((line, i) => out.progress(`  cutter ${i + 1}   ${line}`));
        if (words.fallback !== null) out.progress(`  rule       ${words.fallback}`);
        if (words.runnerUp !== null) out.progress(`  also      ${words.runnerUp}`);
        if (words.buyThis !== null) out.progress(`  buy       ${words.buyThis}`);
        for (const note of words.notes) out.progress(`  note      ${note}`);
        if (process.env.CM_PICK_DEBUG === '1') {
          out.progress(`  debug     search ${searchMs} ms over ${pick.considered.length} plans`);
          for (const s of pick.considered) {
            out.progress(
              `  debug     ${s.plan.cutters.map((c) => c.key).join('+')} worst=${s.worstFidelity.toFixed(5)} mean=${s.meanFidelity.toFixed(5)} stand=${s.raisedStandingMm2} counters=${s.counterStandingMm2}${s.evaluation.items.some((i) => i.countersFrom === 'swept') ? '(swept)' : ''} joined=${s.raisedJoined} ok=${s.evaluation.ok} sec=${String(s.evaluation.seconds)} changes=${s.evaluation.toolChanges}${s.evaluation.refusal === null ? '' : ` refusal=${s.evaluation.refusal}`}`,
            );
          }
        }
        // A plan the generator refuses is reported, not run: the search hands back the best plan
        // that POSTS (`runnable`), and C's note names the refused best-measured one.
        const chosen = pick.runnable;
        if (chosen === null) {
          const what =
            job.toolKey === NO_TOOL_KEY
              ? 'names no cutter, and'
              : jobTool(job) === null
                ? 'names a cutter this bench does not hold, and'
                : 'cannot be split into programs, and';
          return `${label} ${what} no plan the search tried can post: ${pick.notes.join(' ') || pick.bestMeasured.evaluation.refusal || 'the generator refuses every candidate'}`;
        }
        // #786 slice 4b — the split is SAID: the cutter the document names keeps its own work and
        // the search adds the one the rest needs.
        if (job.toolKey !== NO_TOOL_KEY && chosen.plan.cutters.length > 1) {
          out.progress(
            `  split     ${job.toolKey} keeps its ${chosen.plan.cutters[0]!.items.length} item(s); ` +
              `${chosen.plan.cutters.slice(1).map((c) => c.key).join(', ')} takes the rest — one program per cutter`,
          );
        }
        // #760/#762/#869/#1134 — THE ONE WRITE-BACK. `applyCutterPlan` is `measuredPick`'s body:
        // the SAME function the evaluator applies before it generates and the Design panel uses
        // when it writes an answer back. The CLI had its own copy, and the copies had already
        // drifted where it matters most: a pure goal with no rough gets `roughToolKey: null`
        // ("ball alone") from the canonical write-back, while this copy DELETED the key ("the
        // engine chooses the rough") — so the cut re-planned a different job than the pick had
        // measured (a curved rough the measured plan did not have). Applying the canonical
        // write-back, in place, makes the job the cut runs the job the pick planned.
        const applied = applyCutterPlan(job, chosen.plan);
        for (const key of Object.keys(job) as (keyof EngraveJob)[]) {
          if (!(key in applied)) delete job[key];
        }
        Object.assign(job, applied);
        // #1134 — the pick's winning full plan is the cut's owned plan: hand it to the run.
        reusedOwnedPlan = chosen.evaluation.ownedPlan ?? null;
        // #1258 — the pick measured this cutter under a PROVISIONAL tab answer (it had none), so its
        // plan is withheld: the cut plans again with this cutter under the operator's answer, or asks.
        if (chosen.evaluation.tabQuestion === true) {
          out.progress(`  tab rule   the pick ranked the cutters under a provisional tab answer; the cut asks the question for this cutter`);
        }
        if (reusedOwnedPlan !== null) {
          out.progress(`  reuse     the pick's plan reused — the cut posts the measured plan, not a re-plan`);
        }
      } else {
        const reach = scanReach(job);
        printReach(reach);
        const restOff = args.rest === 'none';
        const pick = roughPick(reach);
        const first = args.tool ?? (restOff ? reach.recommendation.key : (pick.chosen?.key ?? reach.recommendation.key));
        if (first === null) {
          return `${label} names no cutter, and none in the library can cut it: ${reach.recommendation.reason}`;
        }
        job.toolKey = first;
        out.progress(
          `  cutter 1   ${first} — ${args.tool !== undefined ? 'named on the command line (--tool)' : restOff ? reach.recommendation.reason : pick.reason}`,
        );
        if (!restOff) {
          const rest = args.rest !== undefined ? { key: args.rest, reason: 'named on the command line (--rest)' } : (() => {
            const choice = restToolPick(reach, first);
            return choice.cutter === null ? null : { key: choice.cutter.key, reason: choice.reason };
          })();
          if (rest !== null && rest.key !== first) {
            const setup = jobSetups(job)[0]!;
            job.setups = [{ ...setup, tools: [first, rest.key] }];
            out.progress(`  cutter 2   ${rest.key} — ${rest.reason}`);
          }
        }
      }
    return null;
  }

  if (args.job) {
    const path = args.job;
    // #733 item 3 — read and validate through `invalidJob`, so `--json` still gets its receipt.
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return stop(invalidJob(`${path} cannot be read: ${(e as Error).message}`));
    }
    const parsed = parseEngraveJob(raw);
    if (!parsed.ok) {
      return stop(invalidJob(`${path} is not a valid engrave job:\n  ${parsed.errors.join('\n  ')}`));
    }
    // #1084 — THE APP'S SAVE GATE, STATED BY THE DOOR THAT DOES NOT APPLY IT. This command writes
    // .nc files and never runs `saveBlocker`; for a job held in the rotary chuck the app's Save .nc
    // is disabled until the module's #238 rows are measured. The run still generates (this is the
    // generation door; the bench's run passes the app's Save), and says so once — the same exported
    // sentence the app shows.
    if (parsed.job.workholding.kind === 'rotary-chuck') {
      out.progress(ROTARY_UNMEASURED_REFUSAL);
      runDiagnostics.push(diagnostic('rotary-unmeasured', 'info', ROTARY_UNMEASURED_REFUSAL, 'findings', null));
    }
    outDir = args.out ?? dirname(path);
    mkdirSync(outDir, { recursive: true });
    // #513 — the job's bed binding rides into the receipt, so a run can be matched to the bed it
    // was planned against even when the machine's active profile has changed since.
    bed = parsed.job.bed === undefined ? null : { profileId: parsed.job.bed.profileId, profileVersion: parsed.job.bed.profileVersion };
    // #1059 — A SQUARE CHUCK JOB'S FACE ANGLE, from the bound profile's datum (absent for every
    // other mount and for a job nothing was levelled on).
    faceAngle = faceAngleReceiptFor(parsed.job, boot.location);
    // #766 — A JOB THAT NAMES NO CUTTER IS GIVEN ONE BY SIMULATION. The rules that came before
    // (area share #762, item kind, the tightest raised gap #760/#765) each failed on a real job;
    // this path now runs the measured search: plausible kind-valid plans are generated
    // (`smartPick`), slice A scores each by what it would cut, and the best POSTING plan is the
    // one written. The search's own sentence is printed, and `--tool`/`--rest` still override.
    // #743 P-4b — the same step serves the Gerber door, which builds its own job document.
    // #786 slice 4b — the same question is asked when the document NAMES a drill bit or thread
    // mill and also has other work: the search's split keeps that cutter for its holes/threads and
    // adds the flat for the rest, so a headless run posts the programs the app would.
    const needsSplit = splitKeepsNamedCutter(parsed.job);
    // #786 slice 6 — a key the library no longer holds is `tool-missing`'s, and the measured
    // search is its answer here exactly as in the panel (4c-2).
    const missingCutter = namesMissingCutter(parsed.job);
    if (parsed.job.setups === undefined && (parsed.job.toolKey === NO_TOOL_KEY || needsSplit || missingCutter)) {
      if (args.tool === undefined && args.rest === undefined) {
        const namedKey = missingCutter ? parsed.job.toolKey : null;
        const why = await chooseCutters(parsed.job, path);
        if (why !== null) return stop(invalidJob(why));
        // The substitution is SAID: a document's key that no longer resolves was replaced by the
        // search's measured answer, and the operator reads which key and what cuts instead.
        if (namedKey !== null) {
          out.progress(`  substitute ${namedKey} is not in the tool library; ${parsed.job.toolKey} cuts this job`);
        }
      }
    }
    // #835 — A SETUP'S DEAD CUTTER IS ANSWERED ON THAT SETUP'S OWN WORK. The whole-job search
    // judges ONE setup, so a document that states its setups is measured setup by setup exactly
    // as the panel does (`setupWork`): the sub-job is that setup's work, the plan is written back
    // into THAT setup only, and the replacement is printed in the same substitute line. The
    // setup-less `tool-missing` path above still serves a job that names one cutter.
    if (parsed.job.setups !== undefined) {
      const tools = searchToolsFor(parsed.job);
      for (const setupIndex of setupsWithDeadCutters(parsed.job, tools)) {
        const setup = jobSetups(parsed.job)[setupIndex]!;
        const sub = setupWorkJob(parsed.job, tools, setupIndex);
        if (sub === null) continue;
        // #922 — the same one builder on a dead-cutter substitution; #940 — the sub-job's floors.
        const pick = await pickWithPool({
          tl,
          job: sub,
          tools,
          catalogue: catalogueRows,
          conditions: inventoryConditions(),
          shop: pickShop,
          floors: supportingFloors(tl, toPartPlan(sub, { defaults: shopDefaults })),
        });
        if (pick.refused === true) {
          out.progress(`  setup ${setupIndex + 1}      ${pick.reason}`);
          continue;
        }
        const chosen = pick.runnable;
        if (chosen === null) {
          // No substitute can be measured; the run's own refusal still names the key.
          out.progress(
            `  setup ${setupIndex + 1}      no plan the search tried can post: ${pick.notes.join(' ') || 'the generator refuses every candidate'}`,
          );
          continue;
        }
        for (const dead of deadSetupKeys(parsed.job, tools, setupIndex)) {
          const to = replacementCutter(chosen.plan.cutters, setup, dead);
          out.progress(
            `  substitute setup ${setupIndex + 1}   ${dead} is not in the tool library; ${to.key} cuts that setup’s work`,
          );
        }

        const before = parsed.job;
        parsed.job = writeSetupPlan(parsed.job, tools, setupIndex, chosen.plan.cutters);
        // #1134 — a substituted setup changes the job, so the pick's plan is stale: say so and
        // fall back to planning the cut.
        if (parsed.job !== before && reusedOwnedPlan !== null) {
          out.progress('  reuse     discarded — the setup substitution changed the job; the cut plans it again');
          reusedOwnedPlan = null;
        }
      }
    }
    const result = await runJob(parsed.job, outDir, {
      writeJobDocument: false,
      note: `*Generated from \`${basename(path)}\` by \`casemaker engrave\`; the app’s \`RunSheetView\` renders the same \`buildRunSheet\` structure. No result is recorded here.*`,
      reusedOwnedPlan,
      // #1126 — the house's runs API asks for the whole result beside the receipt and programs.
      ...(args.generated === undefined ? {} : { generatedFile: args.generated }),
    });
    if (result.ok) {
      programs.push(...result.programs);
      runDiagnostics.push(...result.diagnostics);
    } else return stop(result.failure);
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

    let design: ReturnType<typeof readDesign>;
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      design = readDesign(tl, parsePrusaThreeMf(ab));
    } catch (e) {
      if (isCliExit(e)) throw e;
      // #749 — a bad project file is still the usage stop it always was. But `readDesign` also
      // runs Clipper/Manifold, and a KERNEL fault there is not a bad file: it answers the one
      // receipt like every other kernel call.
      if (isKernelCrash(e)) return stop(unexpectedStop('cam', 'generated', 'reading the design', null, e, 'findings'));
      fail(`${path}: ${(e as Error).message}`);
    }

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
    // The reason has two different causes and must not confuse them. `untouchedByAll` counts only
    // MEASURED cutters, and a cutter with no feeds row for this material is never measured — so when
    // the cutter this run names has no numbers for the material (a V-bit on softwood, say), the drop
    // is not "the strokes are finer than the smallest bit". The bit that would cut them simply has no
    // feeds row here, and the sentence has to name that: it is the thing the operator can change.
    const namedKey = args.tool ?? null;
    const named = namedKey === null ? null : entryFor(namedKey);
    const namedFeeds =
      named === null ? null : engraveFeedsFor(shop, catalogueRows, shopDefaults, job.stock.material, named.tool, jobMachine(job), undefined);
    for (const { row, cutters } of unreachable) {
      const item = (job.vectors ?? []).find((v) => v.id === row.itemId);
      if (item) item.enabled = false;
      if (
        namedKey !== null &&
        namedFeeds !== null &&
        !namedFeeds.ok &&
        namedFeeds.reason.startsWith('no cutting parameters')
      ) {
        out.progress(
          `  dropped    ${row.name} (${row.itemId}): the cutter this run names (${namedKey}) has no ` +
            `feeds row for ${job.stock.material} — ${namedFeeds.reason} So none of the ${cutters} ` +
            `cutters that do have parameters reaches any of its ${row.glyphArea.toFixed(2)} mm². It ` +
            'stays in the job, turned off, and the run sheet carries the number.',
        );
        continue;
      }
      out.progress(
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
    out.progress(`  cutter 1   ${tool1Key} — ${roughReason}`);

    const restPicked: Chosen | null = (() => {
      if (restOff) return null;
      if (args.rest !== undefined) return cutterNamed(args.rest, '--rest');
      const choice = restToolPick(cut, tool1Key);
      return choice.cutter === null
        ? null
        : { key: choice.cutter.key, diameter: choice.cutter.diameter, reason: choice.reason };
    })();
    const restPickedTool: Tool | null = restPicked === null ? null : toolFor(restPicked, '--rest');
    // #486 — a V-bit named as the second cutter on a region job is not a rest cutter at all: the rest
    // pass is area-based and the cone's width changes with depth. Say which operation it WOULD be
    // (#221's V-carve) before anything is measured, and generate the one program that is honest,
    // rather than the "0 mm² of the 0 mm² … nothing to clean up" receipt that hides the reason.
    const restRefusal = restPickedTool === null ? null : vBitRestRefusal(job, restPickedTool);
    if (restPicked !== null) {
      out.progress(
        restRefusal !== null
          ? `  cutter 2   ${restPicked.key} — ${restRefusal}`
          : `  cutter 2   ${restPicked.key} — ${restPicked.reason}`,
      );
    }
    if (restRefusal !== null) {
      out.progress('  note       no second program is generated: one program is the whole job (#221)');
    }
    const restChosen: Chosen | null = restRefusal === null ? restPicked : null;
    const restTool: Tool | null = restRefusal === null ? restPickedTool : null;

    // WHAT THE SECOND BIT COULD OPEN, over the design as the FILE asked for it — measured BEFORE
    // program 1's items are turned off, because an item the first bit cannot enter at all is entirely
    // the second one's job and a table measured on the reduced job could not say so. `engraveRegions`
    // is the same measurement the generator itself makes, so the region the rest pass cuts is the
    // region this route reasoned about (#288's one enumeration of the cut classes).
    const restMeasure = restTool === null ? null : engraveRegions(tl, job, restTool);
    const designCuts = restMeasure?.cuts ?? [];
    // #865 — A REST PASS PLANNED SHALLOWER THAN THE DESIGN. `designCuts` carry the depth the REST
    // tool can reach, and a V's region is clamped to its cone — so a rest whose flank ends above
    // the design's floor is planned at the cone's height with nothing said (j20: the 90° chamfer
    // rests a 6 mm pocket at 1.5375 mm). Raised here, tagged as program 2's, and carried onto the
    // sheet and the receipt.
    const restDepthTagged: JobFinding[] =
      restTool === null || restMeasure === null
        ? []
        : restDepthShortfallFindings(restMeasure.plan, restTool).map((f) => ({
            ...f,
            message: `program 2 (${toolDisplayName(restTool).split(' · ')[0]!}): ${f.message}`,
          }));

    // WHAT PROGRAM 1 LEAVES OFF. An item the first bit cannot enter AT ALL is a hard `item-empty`
    // refusal, so with a rest pass it is turned off in program 1 and named — the second program cuts
    // it, and the sheet says which file that is. Without a rest pass NOTHING is turned off: the
    // refusal is then the right answer, because there is no other program to cut the region in, and
    // dropping it quietly is the one thing the issue forbids.
    const unroughed = restChosen === null ? [] : unroughedItems(cut, tool1Key);
    for (const item of unroughed) {
      const v = (job.vectors ?? []).find((x) => x.id === item.id);
      if (v) v.enabled = false;
      out.progress(
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
        out.progress(
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

    outDir = args.out ?? process.cwd();
    mkdirSync(outDir, { recursive: true });
    for (const item of patch.vectors) if (item.name !== undefined) names.add(item.name);
    out.progress(
      `${basename(path)} — ${design.regions.length} item${design.regions.length === 1 ? '' : 's'} ` +
        `(${[...names].join(', ')}), turned ${direction}, ${patch.stock.length} × ${patch.stock.width} × ` +
        `${patch.stock.thickness} mm ${patch.stock.material}`,
    );
    for (const note of patch.notes) out.progress(`  ${note}`);

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
      const result = await runJob(job, outDir, {
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
      if (result.ok) {
        programs.push(...result.programs);
        runDiagnostics.push(...result.diagnostics);
        previews.push(...result.files.previews);
      } else return stop(result.failure);
    } else {
      // ---- PROGRAM 1: the clearing pass ----------------------------------------------------------
      // Nothing is written yet. The rest region cannot be computed until this program has been swept,
      // because it is measured against the material the sweep says was removed — so the pipeline runs
      // twice and only then does anything reach the disk.
      const p1 = await prepare(job);
      if (!p1.ok) return stop(p1.failure);

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
      // step-over — and `engravableProfile` opens away anything narrower than `2·r2`, the second cutter's
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
      const restFeeds = engraveFeedsFor(shop, catalogueRows, shopDefaults, job.stock.material, restTool, jobMachine(job), undefined);
      const stepOver2 = restFeeds.ok ? restFeeds.params.stepOver : null;
      // The FIRST cutter's step-over shapes the residue the band has to make cuttable, so it comes
      // from the same feeds table through the same resolver as the second one — never from a number
      // typed into this file.
      const tool1 = jobTool(job);
      const roughFeeds = tool1 === null ? null : engraveFeedsFor(shop, catalogueRows, shopDefaults, job.stock.material, tool1, jobMachine(job), undefined);
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
      // #478's provenance, exactly where the number is chosen: the band the programs run with, and
      // the threshold the third-tool advice is measured against — each with the source `#436` already
      // tracks (typed when the flag was passed, otherwise the shop default's own).
      noteProvenance(provenanceForDefault(REST_OVERLAP_KEY, overlap, 'mm', overlapSource));
      noteProvenance(provenanceForDefault(REST_THIRD_TOOL_KEY, thirdToolPct, '%', thirdToolSource));
      out.progress(`  overlap    ${overlap.toFixed(3)} mm — ${seam.note}`);
      // "the floor it started from", not "the location's value": the floor is the fallback too on a
      // build with no location to read, and a sentence naming the wrong one is the defect this route
      // exists to avoid.
      if (seam.derivedFromCutters && seam.needed !== null) {
        out.progress(
          `  overlap    raised off the ${overlapRead.value.toFixed(3)} mm floor this run started from: ` +
            `the band this job’s own two cutters need is ${seam.needed.toFixed(3)} mm`,
        );
      }
      // An unknown step-over is a MISSING number, and it is reported as one: "narrower than unknown mm"
      // claimed a comparison that was never made (#436 review).
      if (seam.restStepOver === null) {
        out.progress(
          '  seam       this material states no step-over for the second cutter, so whether the band ' +
            'reaches past its own scallop is not judged here',
        );
      } else if (!seam.coversScallop) {
        out.progress(
          '  seam       a ridge can survive where the two programs meet: the band is narrower than ' +
            `the second cutter’s own scallop (${seam.restStepOver.toFixed(3)} mm)`,
        );
      }
      if (seam.needed !== null && !seam.keepsSlivers) {
        out.progress(
          `  seam       the first cutter leaves slivers about ${seam.sliver.toFixed(3)} mm wide and the ` +
            `second cutter’s opening erases anything under ${seam.restDiameter.toFixed(3)} mm, so a band of about ` +
            `${seam.needed.toFixed(3)} mm is what keeps them cuttable — this one is under it, and they ` +
            'are counted in the leftover instead of being cut',
        );
      }
      const rest1 = restMachining(tl, { removal: p1.load.meshes.removal, cuts: designCuts, overlap });
      for (const n of rest1.notes) out.progress(`  rest       ${n}`);

      // WHICH REST REGIONS THE SECOND BIT CAN ACTUALLY OPEN. A rest region can be a sliver the first
      // cutter could not quite reach, and `engravableProfile` opens away a region narrower than the bit
      // that is supposed to cut it (`offset(-r)` then `offset(+r)`) — down to nothing, which is
      // `item-empty`, a hard refusal that would stop the SECOND program over a region the design was
      // never going to give up anyway. So each region is measured with the same call the generator
      // will make, and the ones that come back empty are dropped here and accounted for in the
      // leftover number below. Nothing is silently lost: it moves from "program 2 cuts this" to "no
      // cutter reaches this", which is a number the sheet prints.
      let kept = rest1.regions;
      if (kept.length > 0) {
        const open = new Set(
          engraveRegions(tl, restJobFor(job, kept, restChosen.key, shopDefaults), restTool)
            .measured.filter((m) => m.openedArea > 0)
            .map((m) => m.labelId),
        );
        const dropped = kept.filter((_, i) => !open.has(`rest-${i + 1}`));
        kept = kept.filter((_, i) => open.has(`rest-${i + 1}`));
        for (const r of dropped) {
          out.progress(
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
        const restJob = restJobFor(job, kept, restChosen.key, shopDefaults);
        roundTrips(restJob, 'rest program');
        // Seeded with program 1's removal: the sweep of the second file starts from the blank program
        // 1 leaves behind, so the prediction, the coverage and the gouge checks are all made against
        // the stock the operator will actually have under the cutter (#410: "Both programs must be
        // simulated together: tool 2's sweep runs on tool 1's result").
        const removal1 = p1.load.meshes.removal;
        const prepared = await prepare(restJob, removal1 === null ? {} : { priorRemoval: removal1 });
        if (!prepared.ok) return stop(prepared.failure);
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
        // #437 item 8 — each program's own cutting numbers, read the SAME way the sheet reads them
        // (`generated.feeds && generated.feeds.ok ? params : null`, `cam?.passes ?? 1`), so the two
        // lines cannot disagree about how a number was arrived at.
        const cutParams = (g: EngraveGenerated): CutParams | null =>
          g.feeds && g.feeds.ok ? g.feeds.params : null;
        const passCount = (g: EngraveGenerated): number => g.cam?.passes ?? 1;
        // #487 — the program's XY travel, present only when the CAM recorded it. An older stored
        // result can arrive with a `cam` that predates the fields; the sheet then omits the step.
        const travelOf = (
          g: EngraveGenerated,
        ): { travel?: { rapidMm: number; cutMm: number; baselineRapidMm: number } } => {
          const cam = g.cam;
          return cam?.rapidMm !== undefined && cam.cutMm !== undefined && cam.baselineRapidMm !== undefined
            ? { travel: { rapidMm: cam.rapidMm, cutMm: cam.cutMm, baselineRapidMm: cam.baselineRapidMm } }
            : {};
        };
        // The trace-only rule is #405's, and the sheet applies it to program 1 from its own plan. It
        // is derived here for each program's OWN job rather than assumed from the kind of program a
        // rest pass writes today: a trace-bearing second program must not print a step-over.
        const traceOnlyOf = (j: EngraveJob): boolean =>
          toPartPlan(j, { defaults: shopDefaults }).engraves.length === 0 &&
          (j.traces?.some((t) => t.enabled && !t.construction) ?? false);
        facts = {
          rough: {
            key: tool1Key,
            diameter: dia1,
            share: share1,
            score: dia1 * dia1 * share1,
            reason: roughReason,
            nc: `${stem1}.nc`,
            frame: p1.generated.frameNc === null ? null : runSheetFrameFileName(job.name),
            // #747 — the height the worker actually traced at, and why a frame was withheld from a
            // program that is still runnable. Both are the worker's, never re-derived here.
            frameZ: p1.generated.frameZ ?? null,
            frameError: p1.generated.frameError ?? null,
            params: cutParams(p1.generated),
            passes: passCount(p1.generated),
            traceOnly: traceOnlyOf(job),
            moves: p1.generated.cam?.cuttingMoves ?? 0,
            seconds: seconds(p1.generated),
            ...travelOf(p1.generated),
            removedVolume: p1.load.stats.removedVolume,
          },
          rest: {
            key: restChosen.key,
            diameter: restChosen.diameter,
            reason: restChosen.reason,
            nc: `${stem2}.nc`,
            frame: p2.generated.frameNc === null ? null : runSheetFrameFileName(restJob.name),
            frameZ: p2.generated.frameZ ?? null,
            frameError: p2.generated.frameError ?? null,
            params: cutParams(p2.generated),
            passes: passCount(p2.generated),
            traceOnly: traceOnlyOf(restJob),
            moves: p2.generated.cam?.cuttingMoves ?? 0,
            seconds: seconds(p2.generated),
            ...travelOf(p2.generated),
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
          // #1093 — the rest pair's own texts become the file names the sheet reads, so each
          // program's Cut section is placed by the same names everything else prints.
          ...(facts === null ? null : { restPass: nameRestPrograms(facts, p1.generated.programs, p1.job.name) }),
          ...(restDepthTagged.length === 0 ? null : { extraFindings: restDepthTagged }),
        },
        preview: true,
      });
      previews.push(...w1.files.previews);
      programs.push(...w1.programs);
      runDiagnostics.push(...w1.diagnostics);

      if (p2 === null || facts === null) {
        out.progress(
          `  rest       nothing to clean up: ${tool1Key} removed every square millimetre ${restChosen.key} ` +
            `could have opened, so ${restChosen.key} would cut air. One program is the whole job.`,
        );
      } else {
        const w2 = writeProgram(p2, outDir, { writeJobDocument: true, note, sheet: false, preview: true });
        previews.push(...w2.files.previews);
        programs.push(...w2.programs);
        runDiagnostics.push(...w2.diagnostics);
        // #865 — the rest program's own depth shortfall, tagged as program 2's, in the receipt.
        runDiagnostics.push(
          ...restDepthTagged.map((f) =>
            diagnostic(f.code, f.severity, f.message, 'findings', p2.generated.programs[0]?.toolKey ?? null),
          ),
        );
        // #478 — the pair is result data. `renderReceipt` prints it, third-tool answer included, from
        // `details.pair`; the numbers here are the ones the sheet's two-tool section was given.
        pair = {
          roughFile: facts.rough.nc,
          roughDiameterMm: facts.rough.diameter,
          restFile: facts.rest.nc,
          restDiameterMm: facts.rest.diameter,
          restRemovedVolumeMm3: facts.restRemovedVolume,
          leftoverAreaMm2: facts.leftover.area,
          thirdToolShare: facts.thirdTool === null ? null : facts.thirdTool.share,
          thirdToolThreshold: facts.thirdTool === null ? null : facts.thirdTool.fraction,
          thirdToolSuggested: facts.thirdTool === null ? null : facts.thirdTool.suggested,
        };
      }
    }

    // The PNG is a BROWSER's job (playwright), so it is rendered out here and not in the pipeline. A
    // machine without chromium still gets the jobs, the sheets and the SVGs — the pictures are the one
    // thing that goes missing, and each says so rather than failing programs that are already written.
    for (const p of previews) {
      try {
        const png = await svgToPng(p.svg);
        writeFileSync(join(outDir, p.pngFile), png);
        runOutputs.push(fileReceipt(join(outDir, p.pngFile)));
        // The picture is result data: it is listed on the program that drew it, and the renderer
        // prints it with its byte count from the receipt's own outputs (#478).
        const target = imageTargets.find((t) => t.svgFile === p.svgFile);
        if (target !== undefined) target.program.images.push(p.pngFile);
      } catch (e) {
        out.progress(
          `  note       ${p.pngFile} was not rendered (${(e as Error).message}) — the SVG beside ` +
            'it is complete and opens in any browser. Playwright needs a browser: `npx playwright install`.',
        );
      }
    }
  } else if (args.fromGerber) {
    // ---------------------------------------------------------------------------------------------
    // Input: a Gerber set (#743 P-4b) — the fourth way in, and the only one that BUILDS a document
    // from the board's own files. The files say nothing about the blank, so `--blank` names it; the
    // rest of the document is the app's default (holding included: a board is taped to the bed).
    // ---------------------------------------------------------------------------------------------
    const paths = args.fromGerber;
    const blank = args.blank!;
    const files: PcbJobFile[] = [];
    for (const path of paths) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (e) {
        fail(`cannot read ${path}: ${(e as Error).message}`);
      }
      recordInput(path);
      files.push({ name: basename(path), bytes: new Uint8Array(bytes) });
    }
    const tabs = tabSettings(shopDefaults).settings;
    const built = await buildPcbJob(tl, files, {
      blank,
      tabs: { count: tabs.count, width: tabs.widthMm, height: tabs.heightMm },
      tapeStripWidthMm: readDefault(shopDefaults, 'tape.stripWidthMm').value, // #1256
      // §3.4 — the engraver and the outline cutter come from the rows that answer PCB first.
      catalogue: catalogueRows,
    });
    if (!built.ok) fail(built.error);
    const docProblem = jobDocumentProblem(built.job);
    if (docProblem !== null) fail(docProblem);

    outDir = args.out ?? dirname(paths[0]!);
    mkdirSync(outDir, { recursive: true });
    const jobStem = built.job.name.replace(/[^A-Za-z0-9._-]+/g, '-');
    const jobFile = `${jobStem}.job.json`;
    writeFileSync(join(outDir, jobFile), JSON.stringify(built.job, null, 2) + '\n');
    runOutputs.push(fileReceipt(join(outDir, jobFile)));
    const holes = built.plan.items.drills.length;
    const second = built.plan.second;
    const itemCount =
      built.plan.items.vectors.length +
      built.plan.items.frames.length +
      holes +
      built.plan.items.cutouts.length +
      (second === null ? 0 : second.items.vectors.length + second.items.frames.length + second.items.cutouts.length);
    out.progress(
      `${jobFile} — the board on a ${blank.length} × ${blank.width} × ${blank.thickness} mm PCB blank: ` +
        `${built.plan.files.length} file${built.plan.files.length === 1 ? '' : 's'}, ` +
        `${itemCount} items (copper${second === null ? '' : ' on both faces'}, isolation${second === null ? '' : 's'}, ` +
        `${holes} hole${holes === 1 ? '' : 's'}, outline${second === null ? ', cut-out' : 's, cut-out'}).`,
    );
    for (const note of built.notes) out.progress(`  ${note}`);
    for (const w of built.warnings) out.progress(`  ! ${w.message}`);

    const why = await chooseCutters(built.job, jobFile);
    if (why !== null) return stop(invalidJob(why));

    const result = await runJob(built.job, outDir, {
      writeJobDocument: false,
      reusedOwnedPlan,
      note:
        `*Built from ${paths.map((p) => `\`${basename(p)}\``).join(', ')} by ` +
        `\`casemaker cut --from-gerber\` (#743 P-4b): the copper, the isolation band, every hole, ` +
        `the outline and the cut-out come out of the files' own geometry. The blank ` +
        `(${blank.length} × ${blank.width} × ${blank.thickness} mm) is the one named on the command line, ` +
        `and the board is held taped to the bed over a board under it.*`,
    });
    if (result.ok) {
      programs.push(...result.programs);
      runDiagnostics.push(...result.diagnostics);
    } else return stop(result.failure);
  } else {
    const path = args.coupon as string;
    const specJson = readJson(path) as { spread?: { axis?: 'x' | 'y'; pitch?: number } };
    const spec = parseCouponSpec(specJson, path);
    outDir = args.out ?? dirname(path);
    mkdirSync(outDir, { recursive: true });

    let couponPrograms;
    try {
      couponPrograms = buildCouponPrograms(spec);
    } catch (e) {
      fail((e as Error).message);
    }
    // A feed/rpm sweep is one program per value, all at `origin` (#248). On a face long enough for
    // the whole ladder, `spread` moves program i's cell i pitches along an axis so the four are cut
    // side by side on one blank instead of on top of each other. The record is unchanged: each
    // program still tests one value, and the readback still adopts one.
    const spread = specJson.spread;
    if (spread !== undefined && typeof spread.pitch === 'number' && spread.pitch > 0) {
      const axis = spread.axis === 'x' ? 'x' : 'y';
      couponPrograms.forEach((p, i) => {
        if (i === 0) return;
        for (const label of p.job.labels) {
          label.position = { ...label.position, [axis]: label.position[axis] + i * spread.pitch! };
        }
      });
    }

    // The cutter's cutting diameter to select a feeds row on readback, so read it
    // from the same tool library `jobTool` the job was built with.
    const couponTool = jobTool(spec.base);
    if (couponTool === null) fail(`tool "${spec.base.toolKey}" is not in the tool library`);
    const cuttingDiameter = couponTool.tipDiameter ?? couponTool.diameter;
    if (typeof cuttingDiameter !== 'number' || !(cuttingDiameter > 0)) {
      fail(`tool "${spec.base.toolKey}" has no cutting diameter (tipdiameter=${couponTool.tipDiameter}, diameter=${couponTool.diameter})`);
    }

    const rows: CouponRecordRow[] = [];
    let allOk = true;
    for (const program of couponPrograms) {
      const result = await runJob(program.job, outDir, {
        writeJobDocument: true,
        note:
          `*Coupon program \`${program.id}\` of \`${spec.title}\` (#248): ${program.description}. ` +
          `Generated by \`scripts/engrave-job.ts\`. Fill this program's verdict in the coupon record — ` +
          `then \`scripts/feeds-readback.ts\` flips the matching \`feeds.ts\` row to measured from it.*`,
      });
      if (result.ok) {
        programs.push(...result.programs);
        runDiagnostics.push(...result.diagnostics);
        // `sheetFile` is nullable since #410 — a two-tool job writes one sheet, for program 1 — but a
        // coupon always asks for its own, and a record row pointing at a sheet that was never written
        // is a field the readback would follow into nothing.
        if (result.files.sheetFile === null) fail(`coupon program "${program.id}" was written without a run sheet`);
        rows.push({
          program: program.id,
          values: program.values,
          ncFile: result.files.ncFile,
          sheetFile: result.files.sheetFile,
          hash: result.files.hash,
          verdict: null,
          chosen: false,
          note: '',
        });
      } else {
        // Every program is attempted: a sweep with one stopped value still reports the rest, and
        // the receipt carries every failure it raised (#478).
        recordFailure(result.failure);
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
    const recordFile = `${recordStem}-coupon-record.json`;
    writeFileSync(join(outDir, recordFile), JSON.stringify(record, null, 2) + '\n');
    runOutputs.push(fileReceipt(join(outDir, recordFile)));
    coupon = {
      title: spec.title,
      parameter: spec.parameter,
      values: spec.values,
      recordFile,
      rowCount: rows.length,
      allOk,
    };
  }
  emit();
  return runOk ? 0 : 1;
}
