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
const BADGE = { length: 76.2, width: 38.1, thickness: 3.81 } as const;
// Two rows of six 5 mm squares, 2 mm gaps, 40 mm span, centred in X. X centres: the 40 mm row
// spans 18.1..58.1 on the 76.2 mm length (pocket is 45 mm wide, ~2.5 mm margin each end).
const X_CENTRES = [20.6, 27.6, 34.6, 41.6, 48.6, 55.6] as const;
const DEPTHS = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6] as const;
// Row A over the 45 × 13 magnet pocket, on its centre line; Row B 12 mm further back (+Y), in the
// 12.55 mm clear band above the pocket (clears the pocket edge by ~3 mm).
const ROW_A_Y = 19.05;
const ROW_B_Y = 31.05;

function ladderShape(row: 'A' | 'B', i: number): EngraveRectShape {
  const depth = DEPTHS[i] as number;
  return {
    // Deterministic ids so the committed .nc is reproducible run to run.
    id: `shp-${row.toLowerCase()}-${fmt(depth)}`,
    kind: 'rect',
    // The item NAME flows into every operation name on the run sheet, so it carries the one fact
    // the job document cannot model: Row A (over the magnet pocket) vs Row B (the clear band).
    name: row === 'A' ? `A over pocket ${depth.toFixed(1)}` : `B clear ${depth.toFixed(1)}`,
    position: { x: X_CENTRES[i] as number, y: row === 'A' ? ROW_A_Y : ROW_B_Y },
    rotation: 0,
    depth,
    enabled: true,
    width: 5,
    height: 5,
    cornerRadius: 0,
  };
}

function ladderJob(): EngraveJob {
  return {
    schemaVersion: 2,
    name: '165 depth ladder',
    // Printed PLA blank (100 % infill), not wood — #165 is the two-colour badge experiment.
    stock: { length: BADGE.length, width: BADGE.width, thickness: BADGE.thickness, material: 'pla' },
    labels: [],
    shapes: [...DEPTHS.map((_, i) => ladderShape('A', i)), ...DEPTHS.map((_, i) => ladderShape('B', i))],
    // Vise: the blank is only 3.81 mm thick, so the shipped DEFAULT_VISE (stockProud 4) reads as
    // "nothing left in the jaws" (`vise-stock-proud-exceeds-thickness`, an ERROR) and stops the
    // pipeline. stockProud 3.0 clears the deepest cut (1.6 + 1 mm) while staying under the
    // thickness; it is UNMEASURED still (`source: 'default'`) — #208 A3/A5 replace it. The thin
    // blank necessarily also raises `vise-grip-shallow`, which the run sheet carries as a warning.
    workholding: { kind: 'vise', vise: { ...DEFAULT_VISE, stockProud: 3.0 } },
    toolKey: 'flat-1.0',
    minFloor: 1.0,
    edgeMargin: 1.0,
    sacrificial: noneSacrificial(),
    breakthrough: DEFAULT_BREAKTHROUGH,
    customFonts: [],
  };
}

const job = ladderJob();
const generated = engraveGenerate(tl, job, jobTool(job));
if (!generated.ok || generated.nc === null) {
  console.error(JSON.stringify({ stage: generated.stage, errors: generated.errors, findings: generated.findings }, null, 2));
  throw new Error(`#165 ladder did not generate (stopped at ${generated.stage})`);
}

// #206's "simulated" gate: run the saved text through the session and require zero errors.
const tool = jobTool(job);
if (tool === null) throw new Error('flat-1.0 is not in the tool library');
const session = createSimSession(tl);
const simLoad = session.load(generated.nc, toSetup(job, Z1), tool, 'Z1');
if (!simLoad.ok) {
  console.error(JSON.stringify(simLoad.diagnostics, null, 2));
  throw new Error('#165 ladder simulation refused');
}
const simErrors = simLoad.diagnostics.filter((d) => d.severity === 'error');
session.dispose();

const sheet = buildRunSheet(job, generated, { diagnostics: simLoad.diagnostics });
if (sheet.header.fileName !== '165-depth-ladder.nc') {
  throw new Error(`run sheet file name drifted: ${sheet.header.fileName}`);
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

writeFileSync(join(outDir, '165-depth-ladder.nc'), generated.nc);
writeFileSync(join(outDir, '165-depth-ladder.job.json'), JSON.stringify(job, null, 2) + '\n');
writeFileSync(join(outDir, '165-depth-ladder-run-sheet.md'), renderRunSheetMarkdown(sheet));

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

console.log('#165 depth ladder');
console.log(`  file       165-depth-ladder.nc  (${generated.nc.length} bytes, ${generated.nc.split('\n').length} lines)`);
console.log(`  stage      ${generated.stage}, ok=${generated.ok}`);
console.log(`  cam        ${generated.cam?.operations} ops, ${generated.cam?.cuttingMoves} cutting moves, ${generated.cam?.passes} passes, ~${generated.cam?.estimatedSeconds}s`);
console.log(`  findings   ${generated.findings.filter((f) => f.severity === 'error').length} error, ${generated.findings.filter((f) => f.severity === 'warning').length} warning`);
for (const f of generated.findings.filter((f) => f.severity === 'warning')) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  verify     ${generated.verify?.findings.filter((f) => f.severity === 'error').length ?? '?'} error, ${generated.verify?.findings.filter((f) => f.severity === 'warning').length ?? '?'} warning`);
for (const f of generated.verify?.findings.filter((f) => f.severity === 'warning') ?? []) console.log(`     warn  ${f.code}: ${f.message}`);
console.log(`  sim        ok=${simLoad.ok}, count=${simLoad.count}, removed=${fmt(simLoad.stats.removedVolume)} mm³, ${simErrors.length} errors, ${simLoad.diagnostics.length - simErrors.length} warnings`);
for (const d of simLoad.diagnostics.filter((x) => x.severity !== 'error')) console.log(`     warn  ${d.code}: ${d.message}`);
console.log(`  sheet      ${sheet.header.fileName}  hash=${sheet.header.fileHash}  time=${sheet.header.estimatedTime}`);

console.log('#208 D1 air program');
console.log(`  file       208-D1-three-strokes-air.nc  (${air.length} bytes, ${air.split('\n').length} lines)`);
for (const line of air.split('\n').filter((l) => /Z/.test(l) && !l.trimStart().startsWith(';'))) console.log(`     ${line}`);
