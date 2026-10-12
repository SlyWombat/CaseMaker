// Bench-trip file generator (#230, slot 4): produce, through the app's OWN pipeline, the files
// the first bench session needs — and record nothing. #165 is an experiment; its numbers do not
// exist yet, so this writes INPUTS (.nc, run sheet, the job document), never results.
//
//   * #165 depth ladder — a real engrave job (two rows of six 5 × 5 mm squares at
//     0.6 / 0.8 / 1.0 / 1.2 / 1.4 / 1.6 mm on the 76.2 × 38.1 × 3.81 mm badge blank) run through
//     #206's `engraveGenerate` (findings → feeds → cam → post → verify), simulated through #182's
//     `createSimSession`, and rendered from #207's `buildRunSheet`.
//   * #208 D1's air program — `tests/e2e/fixtures/three-strokes.nc` (#199) with every motion Z
//     raised 25 mm, so nothing touches.
//
// Outputs land in `docs/bench/`. Run:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/bench-files.ts
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
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import {
  buildRunSheet,
  runSheetDiagramSvg,
  type RunSheet,
  type RunSheetStep,
} from '@/engine/cnc/engrave/runSheet';
import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';

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
  shoulderLength: 12,
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
    // Printed PLA blank (100 % infill), not wood — #165 is the two-colour badge experiment.
    stock: { length: BADGE.length, width: BADGE.width, thickness: BADGE.thickness, material: 'pla' },
    labels: [],
    // One file per row: the bench plan probes Z0 at each row's centre (decided 2026-10-12).
    shapes: DEPTHS.map((_, i) => ladderShape(row, i)),
    // Vise: the blank is only 3.81 mm thick, so the shipped DEFAULT_VISE (stockProud 4) reads as
    // "nothing left in the jaws" (`vise-stock-proud-exceeds-thickness`, an ERROR) and stops the
    // pipeline. stockProud 3.0 clears the deepest cut (1.6 + 1 mm) while staying under the
    // thickness; it is UNMEASURED still (`source: 'default'`) — #208 A3/A5 replace it. The thin
    // blank necessarily also raises `vise-grip-shallow`, which the run sheet carries as a warning.
    workholding: { kind: 'vise', vise: { ...DEFAULT_VISE, stockProud: STOCK_PROUD } },
    toolKey: 'flat-1.0',
    tool: { ...O_FLUTE_2_12 },
    minFloor: 1.0,
    edgeMargin: 1.0,
    sacrificial: noneSacrificial(),
    breakthrough: DEFAULT_BREAKTHROUGH,
    customFonts: [],
  };
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

function renderRunSheetMarkdown(s: RunSheet): string {
  const out: string[] = [];
  out.push(`# Run sheet — ${s.header.jobName}`);
  out.push('');
  out.push(
    `Generated ${s.header.generatedOn} · file \`${s.header.fileName}\` · ` +
      `sha256 \`${s.header.fileHash}\` · estimated cutting time ${s.header.estimatedTime} ` +
      `(${s.header.estimatedTimeNote})`,
  );
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
      '`RunSheetView` renders the same structure. This is the sheet for #165’s depth ladder on the ' +
      'printed badge blank — its blanks are filled at the machine and the results go to #165 / ' +
      '`docs/bench/2026-10-bench-day-1.md` (E). No result is recorded here.*',
  );
  out.push('');
  out.push(
    '*Row A (“A over pocket”) is centred on the 45 × 13 mm magnet pocket — the unsupported-' +
      'membrane test. Row B (“B clear”) is 12 mm behind it in the clear band. The job document has ' +
      'no field for the pocket, so the row names and the operator, not the diagram, carry that ' +
      'distinction (logged on #206’s dogfood issue).*',
  );
  return out.join('\n') + '\n';
}

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
const simErrors = simLoad.diagnostics.filter((d) => d.severity === 'error');
session.dispose();

const sheet = buildRunSheet(job, generated, { diagnostics: simLoad.diagnostics });
const base = `165-depth-ladder-row-${row}`;
if (sheet.header.fileName !== `${base}.nc`) {
  throw new Error(`run sheet file name drifted: ${sheet.header.fileName}`);
}
if (simErrors.length > 0) throw new Error(`row ${row}: ${simErrors.length} simulation error(s)`);
console.log(`#165 depth ladder, row ${row}`);
console.log(`  file       ${base}.nc  (${generated.nc.length} bytes, ${generated.nc.split('\n').length} lines)`);
console.log(`  stage      ${generated.stage}, ok=${generated.ok}`);
console.log(`  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ${generated.cam?.passes} passes, ~${generated.cam?.estimatedSeconds}s`);
console.log(`  findings   ${generated.findings.filter((f) => f.severity === 'error').length} error, ${generated.findings.filter((f) => f.severity === 'warning').length} warning`);
for (const f of generated.findings.filter((f) => f.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  verify     ${generated.verify?.findings.filter((f) => f.severity === 'error').length ?? '?'} error, ${generated.verify?.findings.filter((f) => f.severity === 'warning').length ?? '?'} warning`);
for (const f of generated.verify?.findings.filter((f) => f.severity === 'warning') ?? []) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  sim        ok=${simLoad.ok}, count=${simLoad.count}, removed=${fmt(simLoad.stats.removedVolume)} mm³, ${simErrors.length} errors, ${simLoad.diagnostics.length - simErrors.length} warnings`);
for (const d of simLoad.diagnostics.filter((x) => x.severity !== 'error')) console.log(`     warn  ${d.code}: ${d.message}`);
console.log(`  sheet      ${sheet.header.fileName}  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);

writeFileSync(join(outDir, `${base}.nc`), generated.nc);
writeFileSync(join(outDir, `${base}.job.json`), JSON.stringify(job, null, 2) + '\n');
writeFileSync(join(outDir, `${base}-run-sheet.md`), renderRunSheetMarkdown(sheet));
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
 */
function raiseMotionZ(text: string, dz: number): string {
  return text
    .split('\n')
    .map((line) => (line.trimStart().startsWith(';') ? line : line.replace(/Z(-?\d+(?:\.\d+)?)/g, (_m, n: string) => `Z${fmt(Number(n) + dz)}`)))
    .join('\n');
}

const air = raiseMotionZ(fixture, AIR_RISE);
writeFileSync(join(outDir, '208-D1-three-strokes-air.nc'), air);

// ---------------------------------------------------------------------------------------------
// Console receipt
// ---------------------------------------------------------------------------------------------

console.log('#208 D1 air program');
console.log(`  file       208-D1-three-strokes-air.nc  (${air.length} bytes, ${air.split('\n').length} lines)`);
for (const line of air.split('\n').filter((l) => /Z/.test(l) && !l.trimStart().startsWith(';'))) console.log(`     ${line}`);
