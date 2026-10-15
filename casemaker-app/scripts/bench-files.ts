// Bench-trip file generator (#230, slot 4): produce, through the app's OWN pipeline, the files
// the first bench session needs — and record nothing. #165 is an experiment; its numbers do not
// exist yet, so this writes INPUTS (.nc, run sheet, the job document), never results.
//
//   * #165 depth ladder — a real engrave job (two rows of six 5 × 5 mm squares at
//     0.6 / 0.8 / 1.0 / 1.2 / 1.4 / 1.6 mm on the 76.2 × 38.1 × 3.81 mm badge blank) run through
//     #206's `engraveGenerate` (findings → feeds → cam → post → verify), simulated through #182's
//     `createSimSession`, and rendered from #207's `buildRunSheet`.
//   * #176's bounded G32 test — ONE 60 mm `line` trace along the 76.2 mm length (#219's trace
//     CAM), same blank, same frame, same cutter. The two console lines the test needs (`G32`
//     before `play`, `M370` after) cannot be IN the file — the upload gate refuses anything the
//     verifier does not know (#386) and `G32` is not in the post's dialect — so the sheet carries
//     them as an operator step, marked unverified, with the grid parameters blank until desk item
//     6 reads them off Studio's Auto-Level MDI log.
//   * #284's PLA feed coupon — the SPEC, written here so its geometry comes from the same
//     as-clamped constants as the ladder; the programs come from `scripts/engrave-job.ts --coupon`
//     (#248's own entry point, which owns the coupon record). One more command, printed at the end.
//   * #185's V-groove file — hand-written, because our pipeline cannot make it: a V-bit has no
//     sweep (`cuttingRadiusForSweep` refuses a non-flat tool), so no job can generate it. It is
//     handed to the app's OWN verifier here before it is written, so the file that reaches the
//     bench is one the upload gate would accept.
//   * #208 D1's air program — `tests/e2e/fixtures/three-strokes.nc` (#199) with every motion Z
//     raised 25 mm, so nothing touches. Checked like the V-groove file, and against the placement
//     the file's own header implies (#395): the raise is what decides whether it stays inside the
//     machine's Z travel, so the check measures the headroom the blank has to give it, writes that
//     number into the file's own note, and then runs the verifier and the sweep AGAIN at that
//     placement — a finding that survives it is a defect, and nothing is written.
//
// Outputs land in `docs/bench/`. Run from `casemaker-app/`:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/bench-files.ts
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts --coupon ../docs/bench/284-pla-feed.json
//
// No default in `src/` is changed and nothing here measures anything.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { Z1 } from '@/engine/cnc/machine';
import { parseGcode, setupFromHeader, stubSetup, type Setup } from '@/engine/cnc';
import { toolFromMkrRecord } from '@/engine/cnc/tool';
import type { Vec3 } from '@/types/units';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import {
  buildRunSheet,
  runSheetDiagramSvg,
  runSheetFrameFileName,
  type RunSheet,
  type RunSheetStep,
} from '@/engine/cnc/engrave/runSheet';
import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import { DEFAULT_JAW_CLEARANCE_MM, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';
import { simErrors, simulationProblem } from '@/engine/cnc/simGate';
import type { CouponSpec } from '@/engine/cnc/engrave/couponJob';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';
import { version as CAM_VERSION } from '../package.json';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const appRoot = join(here, '..');
const outDir = join(repoRoot, 'docs', 'bench');
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');
const tl = await ManifoldModule({ locateFile: () => wasmPath });
tl.setup();

const fmt = (n: number): string => String(Number(n.toFixed(3)));

// ---------------------------------------------------------------------------------------------
// #165 — the depth ladder
// ---------------------------------------------------------------------------------------------

// `samples/badge-blank/make_badge.py` defaults (#165): 76.20 × 38.10 × 3.810 mm badge.
//
// AS CLAMPED (#383, bench 2026-10-12): the blank's 38.1 mm side spans the jaws (X) and its 76.2 mm
// side runs along them (Y). The job is written in that frame, so the app's vise model (jaws at the
// stock's X ends) matches the bench. The magnet pocket is centred, so the 90° turn is symmetric.
const BADGE = { length: 38.1, width: 76.2, thickness: 3.81 } as const;
// Each row is a column of six 5 mm squares, 2 mm gaps, 40 mm span, centred along Y (76.2 mm):
// Y centres 20.6..55.6, inside the 45 mm pocket's 15.6..60.6.
const Y_CENTRES = [20.6, 27.6, 34.6, 41.6, 48.6, 55.6] as const;
const DEPTHS = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6] as const;
// Row A over the 45 × 13 magnet pocket, on its centre line (X 12.55..25.55); Row B 12 mm towards
// the moving jaw, in the clear band (squares X 28.55..33.55, 4.55 mm from the blank's edge).
const ROW_A_X = 19.05;
const ROW_B_X = 31.05;
// The fitted cutter (bench plan, 2026-10-12): yellow-box single-flute O, `C1-BIT-O-FLUTE-2-12`,
// 2 mm cutting, 12 mm flute, 1/8" shank. Label values; caliper still to do (runbook A1).
const O_FLUTE_2_12 = {
  number: 1,
  id: 'C1-BIT-O-FLUTE-2-12',
  name: 'Spiral O single flute 2 × 12',
  typeText: 'Flat End',
  shape: 'flat',
  handleDiameter: 3.175,
  tipDiameter: 2,
  diameter: 2,
  cornerRadius: 0,
  angle: null,
  halfAngle: null,
  fluteLength: 12,
  // null, not 12 (a3, 2026-10-12): the file must not state a shoulder the house inventory does
  // not have. The inventory row for `kz-o-flute-2-12` leaves shoulderLength null and the LABEL's
  // flute length is not a shoulder measurement; runbook A1 calipers the cutter at tomorrow's
  // opening and that number replaces this one. Until then the honest value is "unknown", and the
  // holder check's warning (if it raises one) is the honest consequence.
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
} as const;
// Measured 2026-10-08 (`Z1-Firmware-Dialect.md` §11.8): the top face stands 1.07–1.21 mm proud.
const STOCK_PROUD = 1.2;

function ladderShape(row: 'A' | 'B', i: number): EngraveRectShape {
  const depth = DEPTHS[i] as number;
  return {
    // Deterministic ids so the committed .nc is reproducible run to run.
    id: `shp-${row.toLowerCase()}-${fmt(depth)}`,
    kind: 'rect',
    // The item NAME flows into every operation name on the run sheet, so it carries the one fact
    // the job document cannot model: Row A (over the magnet pocket) vs Row B (the clear band).
    name: row === 'A' ? `A over pocket ${depth.toFixed(1)}` : `B clear ${depth.toFixed(1)}`,
    position: { x: row === 'A' ? ROW_A_X : ROW_B_X, y: Y_CENTRES[i] as number },
    rotation: 0,
    depth,
    enabled: true,
    width: 5,
    height: 5,
    cornerRadius: 0,
  };
}

function ladderJob(row: 'A' | 'B'): EngraveJob {
  return {
    schemaVersion: 2,
    name: `165 depth ladder row ${row}`,
    // Both of these are required on `EngraveJob` and were missing from this literal: `tsx` strips
    // types, so nothing complained, but the committed `.job.json` was a document the app's own
    // parser had to fill in. Stating them is what makes the file on disk the job the pipeline ran.
    machineId: Z1.id,
    // The shipped default (1.0), same as `engraveJobSchema`'s `.default`, so the value in the file is
    // the value the sheet was built with rather than a number that appeared at parse time.
    jawClearance: DEFAULT_JAW_CLEARANCE_MM,
    // Printed PLA blank (100 % infill), not wood — #165 is the two-colour badge experiment.
    stock: { length: BADGE.length, width: BADGE.width, thickness: BADGE.thickness, material: 'pla' },
    labels: [],
    // One file per row: the bench plan probes Z0 at each row's centre (decided 2026-10-12).
    shapes: DEPTHS.map((_, i) => ladderShape(row, i)),
    // Vise: the blank is only 3.81 mm thick, so the shipped DEFAULT_VISE (stockProud 4) reads as
    // "nothing left in the jaws" (`vise-stock-proud-exceeds-thickness`, an ERROR) and stops the
    // pipeline. stockProud is the MEASURED proud height here, not a chosen margin: the printed
    // blank's top face stands 1.07-1.21 mm above the jaw tops (`Z1-Firmware-Dialect.md` §11.8), so
    // 1.2 is what the bench actually clamps. The two consequences ride on the sheet as warnings
    // rather than hiding: only `thickness - stockProud` = 2.61 mm of the part is gripped below the
    // jaw tops (`vise-grip-shallow`, under 3 mm), and the deepest floor (1.6 mm below the top face)
    // is 0.4 mm BELOW the declared jaw tops — harmless for these squares, which run down the blank's
    // centre at X 19.05/31.05 and never reach a jaw face at X 0 / 38.1, which is exactly what
    // `itemReachesJaws` (#369) decides before it charges a depth. A3/A5 measured the vise itself on
    // 2026-10-13/15 (#208), so the dimensions here are the calipered product set and the band is
    // ±0.5; what is still `default` is the SOURCE — nobody has measured THIS machine's vise — and
    // `validateVise` says exactly that on the sheet.
    workholding: { kind: 'vise', vise: { ...DEFAULT_VISE, stockProud: STOCK_PROUD } },
    // The job's own snapshot (`tool`) is what it generates with (#305 design point 2); `toolKey` is
    // the name it is filed under, and the two must not disagree. `flat-1.0` was the builtin default
    // and said the OPPOSITE of `tool`: this job is cut with the fitted 2 mm O-flute, a physical
    // cutter in the house inventory, so it is named by that entry's key (`inventoryKey` mints
    // `inv:<id>`; the key does not have to resolve here — the snapshot wins in `jobTool` — but the
    // .nc header's `;@CM|TOOL|key=` line carries it, and a file that says `flat-1.0` while cutting
    // with a 2 mm bit is the wrong fact to hand the next operator).
    toolKey: 'inv:kz-o-flute-2-12',
    tool: { ...O_FLUTE_2_12 },
    minFloor: 1.0,
    edgeMargin: 1.0,
    sacrificial: noneSacrificial(),
    breakthrough: DEFAULT_BREAKTHROUGH,
    customFonts: [],
  };
}

/**
 * Write the dry-run FRAME file (#244) the run sheet's §6 sends the operator to, and return its name.
 *
 * `engraveGenerate` produces both programs from one job; `engrave-job.ts` writes both. This script
 * wrote only the cutting one, so every sheet here told the operator to load a file nobody had
 * written — a bench step that cannot be taken (a3's review of 3bc11ee, 2026-10-12). The sheet NAMES
 * the frame from the job (`runSheetFrameFileName`), so the name this writes is checked against the
 * program's own stem: the two must be the same file.
 */
function writeFrameFile(job: EngraveJob, base: string, frameNc: string | null): string {
  const name = runSheetFrameFileName(job.name);
  if (name !== `${base}-frame.nc`) {
    throw new Error(`frame file name drifted: the run sheet loads ${name}, the program is ${base}.nc`);
  }
  if (frameNc === null) {
    throw new Error(`${base}: the pipeline produced no frame program, but the run sheet's dry run loads one`);
  }
  writeFileSync(join(outDir, name), frameNc);
  return name;
}

// ---------------------------------------------------------------------------------------------
// #207 run sheet -> Markdown (the app's structure, rendered for the bench binder)
// ---------------------------------------------------------------------------------------------

function renderStep(step: RunSheetStep, i: number): string {
  let text = step.bold ? `**${step.text}**` : step.text;
  if (step.value !== undefined) text += ` — **${step.value}**`;
  if (step.record !== undefined) text += ` — \\_\\_\\_\\_\\_\\_\\_\\_  *(${step.record})*`;
  if (step.unverified !== undefined) text += `  ⚠ *Not yet confirmed on the machine (${step.unverified}).*`;
  return `${i + 1}. ${text}`;
}

function renderRunSheetMarkdown(
  s: RunSheet,
  opts: { before?: string; footer?: string[] } = {},
): string {
  const out: string[] = [];
  out.push(`# Run sheet — ${s.header.jobName}`);
  out.push('');
  out.push(
    `Generated ${s.header.generatedOn} · file \`${s.header.fileName}\` · ` +
      `sha256 \`${s.header.fileHash}\` · estimated cutting time ${s.header.estimatedTime} ` +
      `(${s.header.estimatedTimeNote})`,
  );
  if (opts.before !== undefined && opts.before !== '') {
    out.push('');
    out.push(opts.before.trimEnd());
  }
  for (const section of s.sections) {
    out.push('');
    out.push(`## ${section.title}`);
    out.push('');
    out.push(section.steps.map(renderStep).join('\n'));
    if (section.id === 'origin') {
      out.push('');
      out.push(runSheetDiagramSvg(s.diagram));
    }
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push(
    '*Rendered from `buildRunSheet` (#207) by `casemaker-app/scripts/bench-files.ts`; the app’s ' +
      '`RunSheetView` renders the same structure. No result is recorded here.*',
  );
  for (const paragraph of opts.footer ?? []) {
    out.push('');
    out.push(paragraph);
  }
  return out.join('\n') + '\n';
}

/** #165's ladder: what the row names carry, and where its numbers go. */
const LADDER_FOOTER = [
  '*This is the sheet for #165’s depth ladder on the printed badge blank — its blanks are filled ' +
    'at the machine and the results go to #165 / `docs/bench/2026-10-bench-day-1.md` (E).*',
  '*Row A (“A over pocket”) is centred on the 45 × 13 mm magnet pocket — the unsupported-' +
    'membrane test. Row B (“B clear”) is 12 mm behind it in the clear band. The job document has ' +
    'no field for the pocket, so the row names and the operator, not the diagram, carry that ' +
    'distinction (logged on #206’s dogfood issue).*',
];


for (const row of ['A', 'B'] as const) {
const job = ladderJob(row);
// No Makera feed rows in a headless run (#324): the catalogue tier needs a house service.
const generated = engraveGenerate(tl, job, jobTool(job), []);
if (!generated.ok || generated.nc === null) {
  console.error(JSON.stringify({ stage: generated.stage, errors: generated.errors, findings: generated.findings }, null, 2));
  throw new Error(`#165 ladder did not generate (stopped at ${generated.stage})`);
}

// #206's "simulated" gate: run the saved text through the session and require zero errors.
const tool = jobTool(job);
if (tool === null) throw new Error('the ladder job names no tool');
const session = createSimSession(tl);
const simLoad = session.load(generated.nc, toSetup(job, Z1), tool, 'Z1');
if (!simLoad.ok) {
  console.error(JSON.stringify(simLoad.diagnostics, null, 2));
  throw new Error('#165 ladder simulation refused');
}
// #393 — an error-severity diagnostic refuses the file even though `ok` is true: `ok` means the
// sweep produced material, not that the program is safe (`simGate.ts`). The same predicate the
// coupon generator and the app's Save gate use. Checked BEFORE the sheet is built and before
// anything is written, so a job the simulation refuses leaves no half a job on disk.
const simProblem = simulationProblem(simLoad.diagnostics);
session.dispose();
if (simProblem !== null) {
  for (const d of simErrors(simLoad.diagnostics)) console.error(`  ERROR ${d.code}: ${d.message}`);
  throw new Error(`row ${row}: ${simProblem}`);
}

const sheet = buildRunSheet(job, generated, { diagnostics: simLoad.diagnostics });
const base = `165-depth-ladder-row-${row}`;
if (sheet.header.fileName !== `${base}.nc`) {
  throw new Error(`run sheet file name drifted: ${sheet.header.fileName}`);
}
console.log(`#165 depth ladder, row ${row}`);
console.log(`  file       ${base}.nc  (${generated.nc.length} bytes, ${generated.nc.split('\n').length} lines)`);
console.log(`  stage      ${generated.stage}, ok=${generated.ok}`);
console.log(`  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ${generated.cam?.passes} passes, ~${generated.cam?.estimatedSeconds}s`);
console.log(`  findings   ${generated.findings.filter((f) => f.severity === 'error').length} error, ${generated.findings.filter((f) => f.severity === 'warning').length} warning`);
for (const f of generated.findings.filter((f) => f.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  verify     ${generated.verify?.findings.filter((f) => f.severity === 'error').length ?? '?'} error, ${generated.verify?.findings.filter((f) => f.severity === 'warning').length ?? '?'} warning`);
for (const f of generated.verify?.findings.filter((f) => f.severity === 'warning') ?? []) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  sim        ok=${simLoad.ok}, count=${simLoad.count}, removed=${fmt(simLoad.stats.removedVolume)} mm³, ${simErrors(simLoad.diagnostics).length} errors, ${simLoad.diagnostics.length - simErrors(simLoad.diagnostics).length} warnings`);
for (const d of simLoad.diagnostics.filter((x) => x.severity !== 'error')) console.log(`     warn  ${d.code}: ${d.message}`);
console.log(`  sheet      ${sheet.header.fileName}  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);

writeFileSync(join(outDir, `${base}.nc`), generated.nc);
writeFileSync(join(outDir, `${base}.job.json`), JSON.stringify(job, null, 2) + '\n');
console.log(`  frame      ${writeFrameFile(job, base, generated.frameNc)}  (${generated.frameNc?.length ?? 0} bytes)`);
writeFileSync(join(outDir, `${base}-run-sheet.md`), renderRunSheetMarkdown(sheet, { footer: LADDER_FOOTER }));
}

// ---------------------------------------------------------------------------------------------
// #176 — the bounded G32 test: ONE 60 mm stroke along the 76.2 mm length
// ---------------------------------------------------------------------------------------------

// Bench plan S3 step 3: one 60 mm stroke with `G32` active, depth measured at both ends and the
// centre, on its own blank (the ladder blank's rows sit exactly where the stroke runs). The
// 38.1 mm side cannot hold 60 mm, so the stroke runs along the blank's LENGTH — the plan's own
// constraint, and the reason the blank is clamped the way #383 has it.
const STROKE_LENGTH = 60;
// 0.8 mm: the badge's own reveal depth (#166), so the number the caliper reads is the depth the
// acceptance run cuts at, not a coupon-only depth.
const STROKE_DEPTH = 0.8;
// The clear band Row B already uses: solid material the whole length, no magnet pocket under it
// (the pocket spans X 12.55..25.55), 7.05 mm off the moving jaw's face at X 38.1.
const STROKE_X = ROW_B_X;
// Centred on the blank: 8.1 mm of clearance at each end, symmetric, so a Z error at either end of
// the travel is not confounded with starting or ending off the part.
const STROKE_Y0 = (BADGE.width - STROKE_LENGTH) / 2;

function strokeJob(): EngraveJob {
  // Same stock, workholding, cutter and frame as the ladder — one frame for the whole trip.
  const base = ladderJob('A');
  return {
    ...base,
    // Names the file (`176-g32-stroke.nc`) and the `;@MKR|TOOLPATH` line.
    name: '176 g32 stroke',
    labels: [],
    shapes: [],
    traces: [
      {
        id: 'trc-g32-stroke',
        kind: 'line',
        // A trace's centre follows the path, so the stroke IS the cutter's width (2 mm, #219).
        name: 'g32 stroke 60mm',
        position: { x: STROKE_X, y: STROKE_Y0 },
        rotation: 0,
        depth: STROKE_DEPTH,
        enabled: true,
        points: [
          [0, 0],
          [0, STROKE_LENGTH],
        ],
        closed: false,
      },
    ],
  };
}

/**
 * The console steps the stroke file cannot carry (#176, bench plan S3 step 3).
 *
 * This block is written by the GENERATOR, not by the app's `buildRunSheet`: the run sheet has no
 * section for a step the operator types, and `G32`/`M370` cannot go in the program — the upload
 * gate refuses anything the verifier does not pass (#386) and neither word is in the post's
 * dialect (`G_ALLOWED` is G0 G1 G21 G28 G53 G90). #176's own item is to give the sheet such a
 * section; until then this is where the step lives, marked unverified, because it has never been
 * typed on the machine either.
 */
const STROKE_CONSOLE_STEPS = `## Console steps this file cannot carry — #176

*Typed here by \`bench-files.ts\`, not rendered by the app's run sheet (no job field holds a
console step, and \`G32\`/\`M370\` must not be in the program: the upload gate refuses a file the
verifier does not pass, #386). If the app's own sheet is used at the bench instead of this one,
steps 1–3 are the part it is missing; step 4 is its §9 record.*

1. **BEFORE \`play\`** — with the blank clamped and Z0 probed: send Studio's Auto-Level line,
   \`G32 R1\` with its grid parameters filled from the Auto-Level MDI log (desk item 6, unread):
   \`G32 R1 X\\_\\_\\_\\_ Y\\_\\_\\_\\_ \\_\\_\\_\\_\`.  ⚠ *Not yet confirmed on the machine (the grid
   parameters have never been read off Studio; that desk step is still open).*
2. **Run this file** (\`play\`).
3. **AFTER the program ends** — send \`M370\` from the console to clear the auto-level state.
   ⚠ *Not yet confirmed on the machine (whether \`M02\` already clears it is not known).*
4. **Measure** — caliper the stroke's depth at both ends and at its centre (three readings each
   way, six in total) and write them into \`docs/bench/2026-10-bench-day-1.md\`. The test's
   question is whether the depth holds along a 60 mm move, not whether the stroke exists.`;

{
  const job = strokeJob();
  const generated = engraveGenerate(tl, job, jobTool(job), []);
  if (!generated.ok || generated.nc === null) {
    console.error(JSON.stringify({ stage: generated.stage, errors: generated.errors, findings: generated.findings }, null, 2));
    throw new Error(`#176 stroke did not generate (stopped at ${generated.stage})`);
  }
  const tool = jobTool(job);
  if (tool === null) throw new Error('the stroke job names no tool');
  const session = createSimSession(tl);
  const simLoad = session.load(generated.nc, toSetup(job, Z1), tool, 'Z1');
  if (!simLoad.ok) {
    console.error(JSON.stringify(simLoad.diagnostics, null, 2));
    throw new Error('#176 stroke simulation refused');
  }
  // #393 — checked before the sheet and before any file, like the ladder above.
  const simProblem = simulationProblem(simLoad.diagnostics);
  session.dispose();
  if (simProblem !== null) {
    for (const d of simErrors(simLoad.diagnostics)) console.error(`  ERROR ${d.code}: ${d.message}`);
    throw new Error(`#176 stroke: ${simProblem}`);
  }

  const sheet = buildRunSheet(job, generated, { diagnostics: simLoad.diagnostics });
  const base = '176-g32-stroke';
  if (sheet.header.fileName !== `${base}.nc`) {
    throw new Error(`run sheet file name drifted: ${sheet.header.fileName}`);
  }
  console.log('\n#176 bounded G32 stroke');
  console.log(`  file       ${base}.nc  (${generated.nc.length} bytes, ${generated.nc.split('\n').length} lines)`);
  console.log(`  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ~${generated.cam?.estimatedSeconds}s`);
  console.log(`  findings   ${generated.findings.filter((f) => f.severity === 'error').length} error, ${generated.findings.filter((f) => f.severity === 'warning').length} warning`);
  for (const f of generated.findings.filter((f) => f.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
  console.log(`  sim        ok=${simLoad.ok}, count=${simLoad.count}, removed=${fmt(simLoad.stats.removedVolume)} mm³, ${simErrors(simLoad.diagnostics).length} errors`);
  console.log(`  sheet      ${sheet.header.fileName}  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);

  writeFileSync(join(outDir, `${base}.nc`), generated.nc);
  writeFileSync(join(outDir, `${base}.job.json`), JSON.stringify(job, null, 2) + '\n');
  console.log(`  frame      ${writeFrameFile(job, base, generated.frameNc)}  (${generated.frameNc?.length ?? 0} bytes)`);
  writeFileSync(
    join(outDir, `${base}-run-sheet.md`),
    renderRunSheetMarkdown(sheet, {
      before: STROKE_CONSOLE_STEPS,
      footer: [
        '*This is #176’s bounded G32 test (bench plan S3 step 3): ONE 60 mm stroke along the ' +
          'blank’s 76.2 mm length at X 31.05 (the clear band, solid material, no magnet pocket ' +
          'under it), 0.8 mm deep, on its OWN blank. Its numbers go to `docs/bench/2026-10-bench-day-1.md`.*',
        '*A null result here is a null result about a LONG MOVE ALONG Y, not about the dome: the ' +
          'blank’s warp is strongest ACROSS its 38.1 mm width (the axis no straight 60 mm line can ' +
          'follow, #165’s row A vs row B is the test that spans it).*',
      ],
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// #284 — the PLA feed coupon SPEC (the programs come from `engrave-job.ts --coupon`)
// ---------------------------------------------------------------------------------------------

/** The spec JSON `engrave-job.ts --coupon` consumes: a `CouponSpec` with `basePath` instead of inline `base`. */
type CouponSpecFile = Omit<CouponSpec, 'base'> & { basePath: string; note: string };

/**
 * #284's first coupon: the PLA 1.6–3.2 mm feed row, measured on the fitted 2 mm O-flute. Written
 * from the SAME constants as the ladder, because every number here was measured against the
 * as-clamped badge blank and the fitted cutter rather than chosen:
 *
 *  - `origin` is the REAR clear band (Y 60.6..76.2), which is empty on this part: the cell sits on
 *    solid material, so a membrane (row A) cannot confound a feed reading, and it is clear of both
 *    cut rows and of #185's V-groove strip (which is left of row A in the FRONT band, X 2.5..11.5 ×
 *    Y 4..14 — the two share this blank, so neither may sit where the other cuts).
 *  - `text.size` 11.0 mm in Barlow BOLD is the cap height this coupon ships at: the largest the app
 *    accepted on this blank WHEN IT WAS SIZED (0116f36 — the ceiling has moved since; see the note
 *    after this list). Two limits set it and the tighter one was the vise: the fixed jaw's face is
 *    at work X 0 and the moving jaw's at X 38.1, and the collision check grows each by the vise's own
 *    band, which was then the 2 mm an unmeasured default carried (#208). So the cutter's body had to
 *    stay inside X 2.0..36.1, and the ink box with it — its own edge is as far as the cutter's body
 *    reaches, the label CAM sweeping INSIDE the glyph outline — a **34.1 mm** ceiling, against
 *    `edgeMargin`'s looser 36.1. At 11.5 mm the ink was 35.0 mm wide and the sim reported it as it
 *    should — `tool-into-fixture`, the cutter driving 2.2 and 3.4 mm³ into the fixed jaw. At 11.0 mm
 *    the ink is 33.49 × 11.30 mm, X 2.31..35.79 — 0.31 mm inside the band the app then carried — and
 *    the sim is clean.
 *  - …and it is the one face that survives this cutter at all: Barlow bold at 11.0 loses 18 % of its
 *    area to the 2 mm opening (`item-detail-lost`, a warning the run sheet carries), while every
 *    other bundled face at any size that FITS loses the label entirely (`item-empty`) or a whole
 *    character. The cell is a label, not a pocket (#248), so the cutter's reach decides how large
 *    the value text can be — and on a 38.1 mm blank it is the jaws or the job's own edge inset that
 *    sets the ceiling, never the text.
 *  - `values` bracket the row's own 500 (the number a readback adopts), and the row's own value must
 *    be cut or there is nothing to adopt (`measurementFromRecord`).
 *  - `depth` 0.8 mm is the badge's reveal depth (#166), so the feed is judged at the depth the
 *    acceptance run cuts at.
 *
 * A3/A5 calipered the vise on 2026-10-13/15, so its band is ±0.5 and the vise's own ceiling moved
 * out to an ink 37.1 mm wide (X 0.5..37.6). The tighter limit is now `edgeMargin`, at 36.1 — where
 * the vise held it to 34.1 — so a cell up to ~11.86 mm of cap height passes where 11.0 was the cap
 * (measured 2026-10-15: 11.85 mm writes its program, 12 mm stops at findings with
 * `item-outside-stock`). The cell stays 11.0 mm anyway: that is what the four committed files were
 * generated at, and re-sizing it would change what the coupon's own value text measures. Enlarging
 * it is a bench decision, not a consequence of the caliper.
 */
const COUPON_SPEC: CouponSpecFile = {
  id: '284-pla-feed',
  title: '284 PLA feed coupon',
  parameter: 'feed',
  values: [350, 500, 700, 900],
  basePath: '165-depth-ladder-row-A.job.json',
  text: { size: 11, pitch: 16 },
  origin: { x: 19.05, y: 68 },
  depth: 0.8,
  font: 'sans-default',
  weight: 'bold',
  note:
    'One program per feed value, one labelled cell each, on the as-clamped badge blank with the ' +
    '2 mm O-flute (the PLA 1.6-3.2 row, #284). The row measures FEED, so every other parameter ' +
    'comes from the base job unchanged and the record must be read back with feeds-readback.ts. ' +
    'Mark the value to adopt "chosen": true. The cell text is 11 mm because the UNMEASURED vise ' +
    'sets that ceiling (its 2 mm band leaves 34.1 mm of the blank across the jaws) and Barlow bold ' +
    'is the only bundled face that survives this cutter; the 18 % area loss is the warning in §8.',
};

writeFileSync(join(outDir, '284-pla-feed.json'), JSON.stringify(COUPON_SPEC, null, 2) + '\n');
console.log('\n#284 PLA feed coupon spec written: 284-pla-feed.json');
console.log('  generate its programs with (this script runs from casemaker-app/, the spec is in the repo):');
console.log('    npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts --coupon ../docs/bench/284-pla-feed.json');

// ---------------------------------------------------------------------------------------------
// #185 — the V-groove reach test: HAND-WRITTEN, because the pipeline cannot generate it
// ---------------------------------------------------------------------------------------------

// A V-bit has no sweep: `cuttingRadiusForSweep` refuses a non-flat tool, so `feedsFor` refuses it
// and no job can generate a program for one. The bench still needs the file (#185 asks for four
// grooves at #165's first four depths, calipered against `w(d) = tip + 2·d·tan(halfAngle)`), so it
// is written here and handed to the app's OWN verifier before it is written — the same gate the
// upload path uses (#386), so what reaches the bench is what the app would have accepted.
const V_BIT_30_0_3 = {
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.3',
  // ASCII only, like the post's own names: the machine's header reader is given no glyphs to trip on.
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  // The house inventory's own fields for this cutter (`kz-engrave-30-0-3` in the local
  // `tool-labels/kazoo-house.json`): `diameter` is the SHANK there and the cutting diameter is
  // `tipDiameter` — which is the number #185's formula starts from.
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: 0,
  angle: null,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
} as const;

const V_TIP = 0.3;
const V_HALF_ANGLE_DEG = 15;
/** The INCLUDED angle the header states: the bit's own name is "30°", so 2 × the half angle. */
const V_INCLUDED_ANGLE_DEG = 2 * V_HALF_ANGLE_DEG;
/** The cutter's house-inventory key, as the ladder's job carries its own (`#332`'s `;@CM|` record). */
const V_BIT_KEY = 'inv:kz-engrave-30-0-3';
/**
 * #185's own formula, the thing the caliper is checked against: `w(d) = tip + 2·d·tan(halfAngle)`.
 *
 * THE WIDTH IT GIVES IS THE TOP OPENING, NOT THE FLOOR. A V-bit's floor is its flat tip — 0.3 mm at
 * every depth — so the caliper on the groove's floor would read the tip however deep the groove is,
 * and the formula above would be checked against the wrong edge of the groove.
 */
const vOpeningWidth = (depth: number): number => V_TIP + 2 * depth * Math.tan((V_HALF_ANGLE_DEG * Math.PI) / 180);

// The free section LEFT OF ROW A, on the fixed-jaw side — the maintainer's placement (2026-10-12,
// bench plan S3 step 6, #185): "about X 2–11.5 in the job frame, full thickness, clear of the
// magnet pocket". The brief's original "the same X/Y band as Row B" had put them at X 6..30, where
// the X 30 groove sits in Row B's own band (squares X 28.55..33.55) — which the first bench session
// cut into this blank. The strip left of Row A is untouched.
//
// Still along +Y and still 10 mm long (Y 4, in front of the magnet pocket's 15.6 front edge), four
// grooves 3 mm apart across that window, SHALLOWEST FIRST so the file's own order says which groove
// is which. Both bounds are properties of the blank and the vise, not taste:
//
//   * LEFT. The fixed jaw's face is declared at work X 0 and the vise — calipered 2026-10-13/15, so
//     its band is ±0.5, not the ±2 an unmeasured default carried (#208, `uncertaintyFor('default')`)
//     — grows each jaw box, so the free section begins at X 0.5. X 2.5 is the brief's own "about X 2"
//     and the 0.6 mm groove's cone is 0.31 mm half-wide there (tip half-width 0.15 mm + d·tan 15°),
//     so its edge sits at X 2.19: 1.69 mm clear of the grown jaw, where the ±2 band the plan was
//     written under left 0.19 mm. Both margins are against the app's BOX, and what made the old thin
//     one safe to cut is the box's TOP: the jaws' tops stand 1.2 mm BELOW the stock's top face
//     (`stockProud`), and at ±0.5 the grown top is 0.7 mm below it — still under the 0.6 mm groove's
//     floor. Nothing here is close to a jaw: the deepest groove is also the furthest from it.
//   * RIGHT. The magnet pocket's left wall is at work X 12.55 (the 13 mm pocket dimension, centred).
//     X 11.5 leaves 0.58 mm between the widest top opening (0.943 mm, the 1.2 mm groove) and that
//     wall. The whole strip is full 3.81 mm thickness — no membrane under any of it.
const V_Y0 = 4;
const V_Y1 = 14;
const V_FEED = 500;
const V_PLUNGE = 200;
const V_RPM = 12000;
const V_GROOVES = [
  { x: 2.5, depth: 0.6 },
  { x: 5.5, depth: 0.8 },
  { x: 8.5, depth: 1.0 },
  { x: 11.5, depth: 1.2 },
] as const;

/** The job that supplies the verifier's context — stock, vise, frame. It generates nothing. */
function vGrooveCtxJob(): EngraveJob {
  return {
    ...ladderJob('A'),
    name: '185 v-groove',
    labels: [],
    shapes: [],
    toolKey: V_BIT_KEY,
    tool: { ...V_BIT_30_0_3 },
  };
}

/** A hand estimate: cutting moves at the stated F, rapids at the profile's own rates, no accel term. */
function vGrooveSeconds(): number {
  const xy = Z1.rapidEstimate.xyMmPerMin;
  const z = Z1.rapidEstimate.zMmPerMin;
  let seconds = 0;
  // `number`, not the literal the `as const` tuple's first entry carries: the loop reassigns it.
  let prevX: number = V_GROOVES[0].x; // the opening rapid lands on the first groove's start
  for (const g of V_GROOVES) {
    const xyTravel = Math.hypot(g.x - prevX, V_Y1 - V_Y0); // from the last groove's END point
    if (g !== V_GROOVES[0]) seconds += (xyTravel / xy) * 60;
    seconds += (4 / z) * 60; // safe height down to hop height
    seconds += ((1 + g.depth) / V_PLUNGE) * 60; // hop height down to depth, at the plunge feed
    seconds += ((V_Y1 - V_Y0) / V_FEED) * 60; // the groove itself
    seconds += ((1 + g.depth) / z) * 60; // back up to hop height
    seconds += (4 / z) * 60; // hop height up to safe
    prevX = g.x;
  }
  return Math.round(seconds);
}

function vGrooveNc(): string {
  const vTool = `number=${V_BIT_30_0_3.number}|id=${V_BIT_30_0_3.id}|name=${V_BIT_30_0_3.name}` +
    `|type=${V_BIT_30_0_3.typeText}|handlediameter=${V_BIT_30_0_3.handleDiameter}` +
    `|sticklength=0|shoulderlength=0|flutelength=0|diameter=${V_BIT_30_0_3.diameter}` +
    `|tipdiameter=${V_BIT_30_0_3.tipDiameter}|cornerradius=0|angle=${V_INCLUDED_ANGLE_DEG}|halfAngle=${V_BIT_30_0_3.halfAngle}`;

  const header = [
    ';@MKR|BEGIN',
    ';@MKR|SCHEMA|v=1.0.0',
    `;@MKR|MACHINE|id=${Z1.id}|name=${Z1.name}`,
    `;@MKR|MATERIAL|id=0|name=${jobMaterialName()}`,
    `;@MKR|STOCK|id=cuboid|length=${BADGE.length}|width=${BADGE.width}|height=${BADGE.thickness}|diameter=1`,
    `;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=${fmt(-BADGE.length / 2)}|y=${fmt(-BADGE.width / 2)}|z=${fmt(BADGE.thickness / 2)}`,
    `;@MKR|CAM|id=CaseMaker|name=Case Maker|v=${CAM_VERSION}`,
    ';@MKR|UNIT|value=MM',
    `;@MKR|TOOL|${vTool}`,
    `;@CM|TOOL|key=${V_BIT_KEY}`,
    `;@MKR|TIME|seconds=${vGrooveSeconds()}`,
    '; hand-written: the app cannot generate a V-bit program (no sweep; see the comment in the body)',
    '; TIME is a hand estimate with no accel term, so it reads a little low',
    ...V_GROOVES.map(
      (g, i) =>
        `;@MKR|TOOLPATH|number=${i + 1}|tool_number=${V_BIT_30_0_3.number}` +
        `|name=[T1]V-groove ${g.depth.toFixed(1)} deep at X ${g.x}, predicted top opening ${fmt(vOpeningWidth(g.depth))}mm`,
    ),
    ';@MKR|END',
  ];

  const body: string[] = [
    'G90 G21',
    '',
    `; T1-${V_BIT_30_0_3.name}`,
    ';',
    '; #185 V-groove reach test, HAND-WRITTEN by casemaker-app/scripts/bench-files.ts.',
    '; Our pipeline cannot emit this file: a V-bit has no sweep (cuttingRadiusForSweep refuses a',
    '; non-flat tool), so no engrave job can generate a program for one. It was checked by the',
    '; app\'s own verifier (verifyProgram) before being written, the same gate the upload path uses.',
    ';',
    '; Cut it on the LADDER blank in the free section LEFT OF ROW A (the fixed-jaw side), after',
    '; #165\'s ladder and #176\'s stroke, with the 30 V-bit in T1 (M491, plan S3 step 6). Four',
    '; grooves, 10 mm long along +Y (Y 4..14, in front of the magnet pocket\'s 15.6 front edge), at',
    '; #165\'s first four depths, shallowest first.',
    ';',
    '; The section is full 3.81 mm thickness — the magnet pocket\'s left wall is at X 12.55 — and the',
    '; grooves are 3 mm apart across it. The section is bounded by the vise and the pocket, not by',
    '; taste: the jaws\' ±0.5 band (calipered 2026-10-13/15, #208) starts at X 0.5, and the pocket',
    '; wall ends the strip at X 11.5. The four grooves sit inside that window, the first at X 2.5.',
    ';',
    '; CALIPER the TOP OPENING width of each groove (across the top, not the floor) and compare it',
    '; with',
    ';   w(d) = tip + 2 d tan(halfAngle)   (tip 0.3 mm, half angle 15 deg):',
    ...V_GROOVES.map(
      (g) =>
        `;   X ${String(g.x).padStart(2)}  d ${g.depth.toFixed(1)} mm  ->  predicted ${fmt(vOpeningWidth(g.depth))} mm` +
        `${g.depth === 0.8 ? '   <-- the 0.81 mm reveal depth: #185\'s own reading' : ''}`,
    ),
    ';',
    '; Every groove\'s FLOOR is the tip\'s own 0.3 mm flat, at every depth: that is why the check',
    '; above is on the opening. The tip and the included angle are MEASURED under a loupe first',
    '; (#185 step 1, plan desk item 3): w(d) above is only as good as the tip they report.',
    '; Stage 1 of #185 — the morphological opening over the bundled fonts - needs no machine; it',
    '; is docs/bench/185-font-opening.md.',
    ';',
    `T1 M6`,
    'M331',
    // #384's machine-frame lift: `Z-3` is `Z1.toolChange.clearanceZ`, the same constant the post
    // writes, so a hand-written file cannot drift from the generated ones.
    `G53 G0 Z${fmt(Z1.toolChange.clearanceZ)}`,
    '',
  ];
  // #384's own order: the head is lifted in the MACHINE frame first, then XY, then the spindle,
  // then Z stated at the safe height - the same sequence the post writes, so the file is safe to
  // run from an unknown head position.
  body.push(`G0 X${fmt(V_GROOVES[0].x)} Y${V_Y0}`, `S${V_RPM} M3`, 'G0 Z5');
  V_GROOVES.forEach((g, i) => {
    body.push(`;@MKR|TOOLPATH_START|toolpath_number=${i + 1}`);
    body.push(`; groove ${i + 1} of ${V_GROOVES.length}: ${g.depth.toFixed(1)} mm deep at X ${g.x}, top opening ${fmt(vOpeningWidth(g.depth))} mm`);
    // The post's own shape: the FIRST op is seeded by the head lines above (XY already set), every
    // later one restates it. Matching it keeps a hand-written file indistinguishable from a
    // generated one at the machine.
    body.push(i === 0 ? `G0 Z${HOP_Z}` : `G0 X${fmt(g.x)} Y${V_Y0} Z${HOP_Z}`);
    body.push(`G1 Z${fmt(-g.depth)} F${V_PLUNGE}`);
    body.push(`G1 Y${V_Y1} F${V_FEED}`);
    body.push(`G0 Z${HOP_Z}`);
    body.push('G0 Z5');
  });
  body.push('G0 Z15', 'M332', 'M05', 'G28', 'M02');
  return [...header, '', ...body].join('\n') + '\n';
}

/** The material name the V-groove file's header carries — the same `pla` the ladder's does. */
function jobMaterialName(): string {
  return ladderJob('A').stock.material;
}

{
  const ctxJob = vGrooveCtxJob();
  const vTool = jobTool(ctxJob);
  if (vTool === null) throw new Error('the V-groove context job names no tool');
  const nc = vGrooveNc();
  const report = verifyProgram(nc, {
    setup: toSetup(ctxJob, Z1),
    machine: Z1,
    tool: vTool,
    // The stock alone: the grooves are in the front clear band, so no void's membrane is in play,
    // and this is the same limit the job's own `minFloor` implies (3.81 − 1.0 = 2.81 mm).
    depthLimit: stockDepthLimit(ctxJob.stock, ctxJob.minFloor),
    minRapidZ: HOP_Z,
  });
  console.log('\n#185 V-groove file (hand-written, checked by the app\'s verifier)');
  console.log(`  file      185-v-groove.nc  (${nc.length} bytes, ${nc.split('\n').length} lines)`);
  console.log(`  verify     ok=${report.ok}, ${report.findings.filter((f) => f.severity === 'error').length} error, ${report.findings.filter((f) => f.severity === 'warning').length} warning`);
  for (const f of report.findings) console.log(`     ${f.severity === 'error' ? 'ERR ' : 'warn'} ${f.code}${f.line === null ? '' : ` (line ${f.line})`}: ${f.message}`);
  console.log(`  moves      ${report.stats.cuttingMoves} cutting moves, deepest Z ${fmt(report.stats.deepestZ)}`);
  console.log(`  predicted  top opening ${V_GROOVES.map((g) => `d${g.depth.toFixed(1)}->w${fmt(vOpeningWidth(g.depth))}`).join(', ')} mm`);
  if (!report.ok) throw new Error('#185 V-groove file FAILED the app\'s verifier — do not hand it to the machine');
  writeFileSync(join(outDir, '185-v-groove.nc'), nc);
}


// ---------------------------------------------------------------------------------------------
// #208 D1 — the air program: three-strokes.nc with every motion Z raised 25 mm
// ---------------------------------------------------------------------------------------------

const fixturePath = join(appRoot, 'tests', 'e2e', 'fixtures', 'three-strokes.nc');
const fixture = readFileSync(fixturePath, 'utf8');
const AIR_RISE = 25;

/**
 * Raise every motion `Z` word by `dz`. Header/comment lines (`;@MKR|…`, including `ORIGIN … z=3`)
 * are skipped: the ORIGIN is the reference the motion is measured from, so raising it too would
 * cancel the move and put the cutter back in the stock.
 *
 * A `G53` line is skipped for the same reason it exists (#384): its Z is absolute in the MACHINE
 * frame, not a work height to be lifted clear of the stock, and `clearanceZ` is already the
 * controller's own known-clear position. Raising it would command the machine 25 mm above its
 * tool-change height, past the top of the Z travel.
 */
function raiseMotionZ(text: string, dz: number): string {
  return text
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith(';') || line.includes('G53')
        ? line
        : line.replace(/Z(-?\d+(?:\.\d+)?)/g, (_m, n: string) => `Z${fmt(Number(n) + dz)}`),
    )
    .join('\n');
}

/** The ceiling on the headroom search. Past this the raise does not fit any placement (see below). */
const MAX_HEADROOM = 60;

/**
 * The air file's own note, GENERATED from the measurement that gates the write (#395 follow-up 4).
 *
 * WHY GENERATED. The note states a requirement — how far below the tool-change safe height the
 * blank's top face has to sit — and it used to state it as literals (`-40`, `20 mm`) sitting a few
 * lines above a `headroom` the check computed. Two statements of one number, which drift the moment
 * the raise changes. The requirement is now filled in from the number the verifier measures, so the
 * file cannot ask the bench for something the app did not verify, and cannot stay quiet about
 * something it did.
 *
 * The MEASURED paragraph is the one part that is NOT generated: it is a citation of a dated bench
 * trace (`docs/bench/traces/2026-10-12-console.log`), and those numbers are the trace's.
 */
function airNote(headroom: number, topMoveZ: number | null): string[] {
  const safeZ = Z1.toolChange.safeZ;
  const travel = `(the enclosure is ${fmt(Z1.envelope.z.min)}..${fmt(Z1.envelope.z.max)})`;
  const required =
    headroom > 0 && topMoveZ !== null
      ? [
          `;   REQUIRED: the blank's top face (work Z0) at machine Z ${fmt(safeZ - headroom)} or lower — at least ${fmt(headroom)} mm below`,
          `;   the ${fmt(safeZ)} tool-change SAFE height. Above that, the topmost move (\`G0 Z${fmt(topMoveZ)}\`) leaves the Z travel`,
          `;   ${travel}.`,
        ]
      : [
          `;   REQUIRED: nothing. With the blank's top face at the ${fmt(safeZ)} tool-change SAFE height every move is`,
          `;   already inside the Z travel ${travel}, so the fixture's own height will do.`,
        ];
  return [
    `; #208 D1 air tip. Every motion Z below is the #199 fixture's, raised ${fmt(AIR_RISE)} mm, so nothing`,
    '; touches. The raise is what this file needs room for:',
    ';',
    ...required,
    ';',
    ';   MEASURED 2026-10-12: the bench set work Z0 to machine Z -56.544 (`G10 L2 P1 ... Z-56.544`,',
    ';   `traces/2026-10-12-console.log`; the probe touched at -56.107). `G0 Z40` therefore lands at',
    ';   ~-16.5 machine, ~16.5 mm inside the travel.',
  ];
}

/** Place `note` just after `G90 G21`, so it sits above every motion and travels WITH the file. */
function withAirNote(text: string, note: readonly string[]): string {
  return text
    .split('\n')
    .flatMap((line) => (line.trim() === 'G90 G21' ? [line, ...note] : [line]))
    .join('\n');
}

const airBase = raiseMotionZ(fixture, AIR_RISE);

/**
 * The machine point a breach names — `a move to machine (x, y, z) leaves the …'s envelope` — or
 * null when the line did not resolve one (the runner writes `?` per unknown axis, which parses to
 * NaN and is reported as unknown here rather than guessed).
 */
function breachedPoint(message: string): Vec3 | null {
  const m = /a move to machine \(([^)]+)\)/.exec(message);
  if (m === null) return null;
  const n = (m[1] as string).split(',').map((t) => Number(t.trim()));
  if (n.length !== 3 || n.some((v) => !Number.isFinite(v))) return null;
  return [n[0]!, n[1]!, n[2]!];
}

/**
 * Whether a breach is one the BLANK can cure by sitting lower: a move above the TOP of Z travel.
 *
 * This is the carve-out, and it is now by axis rather than by message prefix (#395 follow-up 2).
 * `outside-envelope` says nothing about which axis was breached, and the drop the blank gives shifts
 * machine Z and nothing else — so an X or Y breach, and one below the travel's floor, are never
 * cured by lowering the blank, and a breach the runner could not resolve is not assumed to be the
 * curable kind. Under the old prefix rule all four were excused, and a file that breached X was
 * written after the loop ran out at 65 and printed "REQUIRED >= 65".
 */
function isRaiseBreach(message: string): boolean {
  const p = breachedPoint(message);
  return p !== null && p[2] > Z1.envelope.z.max;
}

// #395: CHECKED BEFORE IT IS WRITTEN, like the V-groove file above — this one used to be the only
// file here that went to `docs/bench/` unread, and it is the file the bench actually plays.
//
// It is also the only one with no `EngraveJob` behind it: it is the #199 fixture, raised. So the
// placement comes from the file's OWN header, which is the path the app takes for a program it did
// not write (`tests/unit/simFixtures.spec.ts` loads the same fixture this way, and the e2e drives
// it). Nothing is hand-built: `stubSetup` fits the header's 60 × 30 × 6 stock into the machine, and
// its own docstring is honest about what that is — a stub, whose top face lands at the profile's
// tool-change safe height. A real placement comes from probing (decisions 26 and 28).
{
  const parsedAir = parseGcode(airBase);
  const airPart = setupFromHeader(parsedAir.header).patch.part;
  const airToolRec = parsedAir.header?.records.find((r) => r.tag === 'TOOL');
  if (!airPart || airPart.kind !== 'prism' || airPart.outline.kind !== 'p-rect' || !airToolRec) {
    throw new Error("#208 D1: the air file's header does not prefill a cuboid stock and a tool");
  }
  const airTool = toolFromMkrRecord(airToolRec);
  const airSetup = stubSetup(airPart, { kind: 'tape-down', contact: airPart.outline }, { startingTool: 1 }, Z1);
  // The stock alone, on the shipped floor (#345's default): the air file cuts nothing, so this
  // limit is not what the verdict turns on — the depth checks simply need a limit to run against.
  const airLimit = stockDepthLimit(
    { length: airPart.outline.size[0], width: airPart.outline.size[1], thickness: airPart.thickness },
    MARGIN_DEFAULTS.minFloor,
  );

  /**
   * The stub's placement with the blank's top face `drop` mm lower. This is what a bench operator
   * sets with a probe; the drop moves the WORK origin and the stock's seat together, so the program
   * reads the same in work coordinates and only its machine Z changes.
   */
  const setupAt = (drop: number): Setup => {
    const shift = (v: Vec3): Vec3 => [v[0], v[1], v[2] - drop];
    return {
      ...airSetup,
      placement: { ...airSetup.placement, origin: shift(airSetup.placement.origin) },
      wcs: { ...airSetup.wcs, origin: shift(airSetup.wcs.origin) },
    };
  };
  /** One program text, verified as the bench would have it: the blank `drop` mm lower. */
  const verifyAt = (text: string, drop: number) =>
    verifyProgram(text, { setup: setupAt(drop), machine: Z1, tool: airTool, depthLimit: airLimit, minRapidZ: HOP_Z });

  // THE HEADROOM, MEASURED (#395 follow-up 2). How far below the tool-change height the blank's top
  // face has to sit before every move is inside the machine's Z travel — and only that clause: the
  // raise is what puts it there (the fixture's own `G0 Z15` becomes `G0 Z40`, 20 mm above the top of
  // travel at the stub placement), so a breach the drop cannot cure must not be excused by it.
  let headroom = 0;
  const atRaise = verifyAt(airBase, 0);
  // The move that decides it, as the PROGRAM names it. The breach is measured in machine
  // coordinates at the stub placement, whose top face IS the tool-change safe height (`stubSetup`),
  // so the work Z a reader sees in the file is the machine Z less that height: the topmost move is
  // `G0 Z40` in the file, and at the stub it lands 20 mm above the top of travel — which is why
  // exactly 20 mm of drop is required.
  const topMoveWorkZ = Math.max(
    Number.NEGATIVE_INFINITY,
    ...atRaise.findings
      .filter((f) => f.severity === 'error' && isRaiseBreach(f.message))
      .map((f) => (breachedPoint(f.message)?.[2] ?? Number.NEGATIVE_INFINITY) - Z1.toolChange.safeZ),
  );
  for (; headroom <= MAX_HEADROOM; headroom += 5) {
    if (!verifyAt(airBase, headroom).findings.some((f) => f.severity === 'error' && isRaiseBreach(f.message))) break;
  }
  // RUNNING OUT IS A REFUSAL, not a larger number to print (#395 follow-up 2). Past the ceiling
  // there is no placement this file fits, so the raise itself is wrong and the file must not be
  // written — where the old loop left `headroom` at 65, printed "REQUIRED >= 65 mm" and wrote it.
  if (headroom > MAX_HEADROOM) {
    throw new Error(
      `#208 D1 air file: even with the blank's top face ${MAX_HEADROOM} mm below the safe height ${Z1.toolChange.safeZ}, a move is still above the top of Z travel (${Z1.envelope.z.max}) — the raise does not fit the machine, so this is not a placement the bench can set`,
    );
  }
  // The note carries the requirement the loop just measured, and is part of the file from here on —
  // so everything below verifies the bytes that get written, notes and line numbers included.
  const air = withAirNote(airBase, airNote(headroom, Number.isFinite(topMoveWorkZ) ? topMoveWorkZ : null));

  const report = verifyAt(air, headroom);
  const errors = report.findings.filter((f) => f.severity === 'error');
  console.log('\n#208 D1 air program (checked before it is written — #395)');
  console.log(`  file      208-D1-three-strokes-air.nc  (${air.length} bytes, ${air.split('\n').length} lines)`);
  console.log(`  place     wcs ${JSON.stringify(airSetup.wcs.origin)} — the stub fits the header's stock with its top face at the safe Z ${Z1.toolChange.safeZ}, checked ${headroom} mm below it`);
  console.log(`  verify    ok=${report.ok}, ${errors.length} error, ${report.findings.length - errors.length} warning`);
  for (const f of report.findings) console.log(`     ${f.severity === 'error' ? 'ERR ' : 'warn'} ${f.code}${f.line === null ? '' : ` (line ${f.line})`}: ${f.message}`);
  console.log(`  moves     ${report.stats.cuttingMoves} cutting moves, deepest Z ${fmt(report.stats.deepestZ)} (work)`);
  if (headroom > 0) {
    console.log(`  headroom  REQUIRED: the blank's top face (work Z0) at machine Z ${Z1.toolChange.safeZ - headroom} or lower — >= ${headroom} mm below the safe height ${Z1.toolChange.safeZ}, or the raised moves run past the top of Z travel`);
  } else {
    console.log('  headroom  none needed: every move is inside the travel with the stock at the safe height');
  }

  // EVERY CLAUSE, AT THE PLACEMENT THE FILE IS WRITTEN FOR (#395 follow-ups 2 and 3). This report
  // used to be taken at the stub placement with `outside-envelope` carved out by its message prefix,
  // which excused X, Y and below-travel breaches the drop can never cure, and left the other checks
  // — depth, holder, fixture, rapid height — judging a placement the bench will not use. There is
  // nothing to exclude now: at the drop measured above, a finding that survives is a defect in the
  // file, whatever its code says.
  if (errors.length > 0) {
    throw new Error(`#208 D1 air file FAILED the app's verifier at its own placement, ${headroom} mm below the safe height (${errors.length} error) — do not hand it to the machine`);
  }

  // The air premise itself, which is what the file is FOR: it must remove nothing, and draw no
  // gouge.
  const session = createSimSession(tl);
  const sim = session.load(air, setupAt(headroom), airTool, Z1.id);
  const simProblems = simErrors(sim.diagnostics);
  const removed = sim.ok ? sim.stats.removedVolume : Number.NaN;
  const gouges = sim.ok ? sim.meshes.gouges.length : Number.NaN;
  console.log(`  sim       ok=${sim.ok}, ${simProblems.length} errors, removed ${fmt(removed)} mm³, ${gouges} gouges`);
  for (const d of simProblems) console.error(`     ERROR ${d.code}: ${d.message}`);
  session.dispose();
  // `sim.ok` IS NOT THE WHOLE VERDICT (#393's pattern, which this file repeated — #395 follow-up
  // 1). A sweep that reports `ok: true` can still carry an error diagnostic — the sweep driving the
  // cutter into the fixed jaw is the recorded case — and the old line took `ok` as the answer, so an
  // air file with a `tool-into-fixture` was printed and written. Nothing is carved out here either:
  // at the placement above, an error diagnostic is a reason not to write the file.
  if (!sim.ok || simProblems.length > 0) {
    const why = sim.ok
      ? simProblems.map((d) => `${d.code}: ${d.message}`).join('; ')
      : (simulationProblem(sim.diagnostics) ?? 'the sweep refused it');
    throw new Error(`#208 D1 air file: the sweep refused it — ${why}`);
  }
  if (removed !== 0 || gouges !== 0) {
    throw new Error(`#208 D1 air file is not air: it removes ${fmt(removed)} mm³ and draws ${gouges} gouge(s)`);
  }

  writeFileSync(join(outDir, '208-D1-three-strokes-air.nc'), air);

  // -------------------------------------------------------------------------------------------
  // Console receipt
  // -------------------------------------------------------------------------------------------

  console.log('\n#208 D1 air program — every Z word, as written');
  for (const line of air.split('\n').filter((l) => /Z/.test(l) && !l.trimStart().startsWith(';'))) console.log(`     ${line}`);
}
