/**
 * #1121 — THE SAMPLE BENCH HARNESS. Run the staged Google Drive samples through the engine and
 * record each stage (import · plan · goal check) into one `results.json`, beside the receipts.
 *
 * NOT A SPEC — a bench tool, like `scripts/card-renders.mts`. The sample files stay OUT of the
 * repo (the Makerables pattern): this reads `CM_SAMPLES_GDRIVE` (default
 * `/mnt/house/casemaker/samples-gdrive`), which holds `manifest.json` and the folders by purpose.
 * A missing root is a named skip, never a failure.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tools/samples/run-gdrive-samples.mts \
 *     [--only id,id] [--out <dir>] [--location <location.json>] [--catalogue <catalogue.json>] \
 *     [--keep-jobs] [--timeout <seconds>]
 *
 * Output: `<out>/results.json` — `{ header, samples: { <id>: { import, plan, check } } }`, each
 * stage `{ status: 'pass' | 'fail' | 'n/a', note, receiptPath }`. Default `<out>` is
 * `<root>/runs/<main sha>`, the folder the review session loads into the Sample Bench.
 *
 * Per purpose, as #1121 states:
 *   - mesh samples (rotary, rotary-unreachable, relief-3axis, plate-2.5d, step-import,
 *     step-vs-stl, gears-outline, relief-plate-own, badge-own): a job the wizard would build —
 *     stock from `proposeStock` (mesh box + 5 mm each side, +1 mm under), `targetObject` = the
 *     file centred on the blank, tape hold (rotary*: a 44.5 mm rod in the rotary chuck, the mesh
 *     scaled to fit), then `casemaker cut … --json`;
 *   - outline samples (svg-coaster, svg-outline, svg-shapes-mm, dxf-units): `parseOutlineFile` →
 *     `toVectorShape` / `toLineTraces` on a 60 mm-coaster-class 12 mm plate, plus a cut-out of the
 *     first item;
 *   - units-3mf: import only — the unit the importer assumed and the resulting bbox;
 *   - broken-mesh: import only — the refusal, or the repair sentence with its count;
 *   - step-vs-stl: both files into identical jobs, the two plans' NC md5s compared;
 *   - prior-art: `gbox-canvas.nc` through the sim session on a 10 mm plate, and `gbox-t1.svg` as
 *     an outline sample.
 *
 * The harness only produces receipts and the results file; the review session writes the tracker.
 */
import '../../scripts/lib/casemaker/nodeTarget';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { defaultEngraveJob, newEngraveCutoutId, newEngraveShapeId, newEngraveTraceId } from '../../src/engine/cnc/engrave/defaults';
import { proposeStock } from '../../src/engine/cnc/stockProposal';
import { defaultSacrificialUnder, noneSacrificial } from '../../src/engine/cnc/sacrificial';
import { parseStl, type ParsedMesh } from '../../src/engine/import/stlParser';
import { parse3MF } from '../../src/engine/import/threeMfParser';
import { stepToStl } from '../../src/engine/import/stepMesh';
import { arrayBufferToBase64 } from '../../src/engine/import/base64';
import { sha256HexBytes } from '../../src/engine/import/sha256';
import { parseOutlineFile, toLineTraces, toVectorShape, type OutlineImport } from '../../src/engine/import/outlineImport';
import { parseGcode } from '../../src/engine/cnc/gcode/interpreter';
import { toSetup } from '../../src/engine/cnc/engrave/jobSetup';
import { resolveTool } from '../../src/engine/cnc/toolRegistry';
import { closeOpenSheet, UnclosableOpenMeshError } from '../../src/engine/cnc/engrave/closeSheet';
import { bootstrap } from '../../src/platform/headless/bootstrap';
import { Z1 } from '../../src/engine/cnc/machine';
import { boxProblem } from '../../src/engine/cnc/stockStart';
import { createSimSession } from '../../src/workers/sim/session';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const REPO = resolve(APP, '..');

const DEFAULT_ROOT = '/mnt/house/casemaker/samples-gdrive';
/** The rod the shop's rotary chuck takes (#1059/#1121): the 44.5 mm square's inscribed cylinder. */
const ROD_DIAMETER_MM = 44.5;
const ROD_LENGTH_MM = 100;
const ROD_STICKOUT_MM = 60;

type StageStatus = 'pass' | 'fail' | 'n/a' | 'exceeds-machine';
interface StageResult {
  status: StageStatus;
  note: string;
  receiptPath: string | null;
}
interface SampleResult {
  purpose: string;
  import: StageResult;
  plan: StageResult;
  check: StageResult;
}

interface ManifestSample {
  id: string;
  path: string;
  purpose: string;
  dims?: string;
  triangles?: number;
  health?: string;
  source?: string;
  owner?: string;
  licence?: string;
  note?: string;
  bytes?: number;
  sha256?: string;
}

interface Manifest {
  stagedAt?: string;
  root?: string;
  rule?: string;
  samples: ManifestSample[];
}

function parseArgs(argv: readonly string[]): {
  root: string;
  only: Set<string> | null;
  out: string;
  location: string | null;
  catalogue: string | null;
  keepJobs: boolean;
  coarse: boolean;
  timeoutMs: number;
} {
  let root = process.env.CM_SAMPLES_GDRIVE ?? DEFAULT_ROOT;
  let only: Set<string> | null = null;
  let out: string | null = null;
  let location: string | null = process.env.CM_SAMPLES_LOCATION ?? null;
  let catalogue: string | null = process.env.CM_SAMPLES_CATALOGUE ?? null;
  let keepJobs = false;
  let coarse = false;
  let timeoutMs = 30 * 60 * 1000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--only') only = new Set((argv[++i] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    else if (a === '--out') out = argv[++i] ?? null;
    else if (a === '--location') location = argv[++i] ?? null;
    else if (a === '--catalogue') catalogue = argv[++i] ?? null;
    else if (a === '--keep-jobs') keepJobs = true;
    else if (a === '--coarse') coarse = true;
    else if (a === '--timeout') timeoutMs = Math.max(1, Number(argv[++i] ?? '0')) * 1000;
    else if (a === '--root') root = argv[++i] ?? root;
    else {
      console.error(`run-gdrive-samples: unknown argument "${a}"`);
      process.exitCode = 2;
    }
  }
  const sha = mainSha();
  return {
    root,
    only,
    out: out ?? join(root, 'runs', sha),
    location,
    catalogue,
    keepJobs,
    coarse,
    timeoutMs,
  };
}

/** The main commit this run is keyed by: the checkout's HEAD, short. */
function mainSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileReceipt(path: string): string {
  return path;
}

/* ---------------------------------------------------------------------------------------------
 * Targets: the file bytes → the job's `targetObject`, headless (no browser File, no meshStock's
 * browser chain — the hash is `sha256HexBytes`, the bytes `arrayBufferToBase64`).
 * ------------------------------------------------------------------------------------------- */

interface ReadTarget {
  ok: true;
  target: EngraveTargetObject;
  mesh: ParsedMesh;
  storedBytes: Uint8Array;
  note: string | null;
}
interface ReadTargetFail {
  ok: false;
  error: string;
}

function formatOfFile(name: string): 'stl' | '3mf' | 'step' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step';
  return null;
}

function scaleMesh(mesh: ParsedMesh, scale: number): ParsedMesh {
  if (scale === 1) return mesh;
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! * scale;
  const bbox = {
    min: mesh.bbox.min.map((v) => v * scale) as [number, number, number],
    max: mesh.bbox.max.map((v) => v * scale) as [number, number, number],
  };
  return { ...mesh, positions, bbox };
}

/** A binary STL of a mesh (the writer stepMesh keeps private; the samples' scale needs one). */
function binaryStl(mesh: ParsedMesh): Uint8Array {
  const tris = Math.floor(mesh.indices.length / 3);
  const out = new Uint8Array(84 + tris * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, tris, true);
  let at = 84;
  for (let t = 0; t < tris; t++) {
    const a = mesh.indices[t * 3]! * 3;
    const b = mesh.indices[t * 3 + 1]! * 3;
    const c = mesh.indices[t * 3 + 2]! * 3;
    const ax = mesh.positions[a]!, ay = mesh.positions[a + 1]!, az = mesh.positions[a + 2]!;
    const bx = mesh.positions[b]!, by = mesh.positions[b + 1]!, bz = mesh.positions[b + 2]!;
    const cx = mesh.positions[c]!, cy = mesh.positions[c + 1]!, cz = mesh.positions[c + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(at, v, true);
      at += 4;
    }
    view.setUint16(at, 0, true);
    at += 2;
  }
  return out;
}

async function readTargetFile(path: string, opts: { scaleTo?: number } = {}): Promise<ReadTarget | ReadTargetFail> {
  const name = basename(path);
  const format = formatOfFile(name);
  if (format === null) return { ok: false, error: `${name} is not an STL, 3MF or STEP file.` };
  const raw = readFileSync(path);
  let mesh: ParsedMesh;
  let stored: Uint8Array = new Uint8Array(raw);
  let note: string | null = null;
  try {
    if (format === 'step') {
      const converted = await stepToStl(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'recognition');
      mesh = converted.mesh;
      stored = new Uint8Array(converted.stl);
    } else if (format === '3mf') {
      mesh = parse3MF(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    } else {
      mesh = parseStl(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    }
  } catch (error) {
    return { ok: false, error: `${name} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (mesh.triangleCount === 0 || mesh.indices.length === 0) return { ok: false, error: `${name} holds no triangles.` };
  const size = {
    x: mesh.bbox.max[0] - mesh.bbox.min[0],
    y: mesh.bbox.max[1] - mesh.bbox.min[1],
    z: mesh.bbox.max[2] - mesh.bbox.min[2],
  };
  let scale = 1;
  if (opts.scaleTo !== undefined) {
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > opts.scaleTo) scale = opts.scaleTo / maxDim;
  }
  if (scale !== 1) {
    mesh = scaleMesh(mesh, scale);
    stored = binaryStl(mesh);
    note = `scaled ×${Number(scale.toFixed(4))} to fit ${opts.scaleTo} mm`;
  }
  const sha = createHash('sha256').update(Buffer.from(stored)).digest('hex');
  const finalSize = {
    x: mesh.bbox.max[0] - mesh.bbox.min[0],
    y: mesh.bbox.max[1] - mesh.bbox.min[1],
    z: mesh.bbox.max[2] - mesh.bbox.min[2],
  };
  return {
    ok: true,
    mesh,
    storedBytes: stored,
    note,
    target: {
      id: `goal-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`,
      name,
      format: format === 'step' ? 'stl' : format,
      sha256: sha,
      data: arrayBufferToBase64(stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) as ArrayBuffer),
      size: { x: Number(finalSize.x.toFixed(3)), y: Number(finalSize.y.toFixed(3)), z: Number(finalSize.z.toFixed(3)) },
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    },
  };
}

/* ---------------------------------------------------------------------------------------------
 * Jobs.
 * ------------------------------------------------------------------------------------------- */

function meshJob(sample: ManifestSample, read: Extract<ReadTarget, { ok: true }>, rotary: boolean, coarse: boolean): EngraveJob {
  const job = defaultEngraveJob();
  job.id = `job-${sample.id}`;
  job.name = sample.id;
  job.labels = [];
  job.shapes = [];
  job.targetObject = read.target;
  const size = read.target.size;
  if (rotary) {
    job.stock = {
      ...job.stock,
      length: ROD_LENGTH_MM,
      width: ROD_DIAMETER_MM,
      thickness: ROD_DIAMETER_MM,
      diameter: ROD_DIAMETER_MM,
      shape: 'cylinder',
      material: 'hardwood',
    };
    job.workholding = {
      kind: 'rotary-chuck',
      rotary: { stickout: ROD_STICKOUT_MM, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'sample-bench' },
    };
    read.target.position = { x: ROD_STICKOUT_MM / 2, y: 0, z: 0 };
    // The rotary dispatch reads the goal's own surface settings; the e2e's coarse template keeps
    // the sweep in minutes while still showing the form (the preview keeps its own pitch).
    read.target.surface = { gridPitchMm: 1, roughStepOverMm: 3, roughStepDownMm: 2, finishStepOverMm: 2.5, stockToLeaveMm: 0.3 };
  } else {
    const proposal = proposeStock({ kind: 'mesh', size });
    if (proposal === null) throw new Error('the mesh proposed no blank');
    job.stock = { ...job.stock, length: proposal.length, width: proposal.width, thickness: proposal.thickness, material: proposal.material };
    job.workholding = {
      kind: 'tape',
      tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'default' },
    };
    read.target.position = { x: proposal.length / 2, y: proposal.width / 2, z: 0 };
  }
  if (coarse) {
    // A PROOF-ONLY switch: the goal's own sampling at the bench's default pitch plans a real part
    // for tens of minutes on one core. `--coarse` states the same coarse surface the rotary
    // template uses, so the plumbing can be proven without waiting on a full-resolution plan.
    read.target.surface = { gridPitchMm: 0.5, roughStepOverMm: 3, roughStepDownMm: 2, finishStepOverMm: 2.5, stockToLeaveMm: 0.3 };
  }
  return job;
}

function outlineJob(sample: ManifestSample, outline: OutlineImport): EngraveJob {
  const job = defaultEngraveJob();
  job.id = `job-${sample.id}`;
  job.name = sample.id;
  job.labels = [];
  job.shapes = [];
  // The blank follows the wizard's proposal: the drawing's own size plus 5 mm each side, on a
  // 12 mm plate (the coaster class). A fixed 60 mm blank would put a 70 mm drawing off the piece.
  const margin = 5;
  const length = Number((outline.width + 2 * margin).toFixed(1));
  const width = Number((outline.height + 2 * margin).toFixed(1));
  job.stock = { ...job.stock, length, width, thickness: 12, material: 'hardwood' };
  job.workholding = {
    kind: 'tape',
    tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'default' },
  };
  // A cut-out through a 12 mm plate needs the board under the part (the wizard's own toggle); the
  // planner refuses the through cut without one, by name.
  job.sacrificial = { ...noneSacrificial(), under: defaultSacrificialUnder() };
  const position = { x: length / 2, y: width / 2 };
  let firstId: string | null = null;
  if (outline.contours.length > 0) {
    const shape = toVectorShape(outline, { id: newEngraveShapeId(), position, depth: 1.5, name: outline.sourceName });
    job.vectors = [shape];
    firstId = shape.id;
  }
  const lines = toLineTraces(outline, { idFor: () => newEngraveTraceId(), position, depth: 0.8, name: outline.sourceName });
  if (lines.length > 0) {
    job.traces = lines;
    firstId ??= lines[0]!.id;
  }
  if (firstId !== null) {
    job.cutouts = [
      { kind: 'cutout', id: newEngraveCutoutId(), enabled: true, of: firstId, side: 'outside', inset: 0, tabs: { count: 0, width: 8, height: 2 } },
    ];
  }
  return job;
}

/* ---------------------------------------------------------------------------------------------
 * Running one job through the CLI, and reading its receipt.
 * ------------------------------------------------------------------------------------------- */

interface CutRun {
  rc: number;
  receipt: Record<string, unknown> | null;
  stderr: string;
  receiptPath: string;
  outDir: string;
}

function runCut(jobPath: string, outDir: string, opts: { location: string | null; catalogue: string | null; timeoutMs: number }): CutRun {
  ensureDir(outDir);
  // scripts/casemaker.ts through tsx, the way the bin starts it — but WITHOUT the bin's own
  // spawnSync layer: a timeout must reach the process that is actually planning, or a hung sample
  // leaves an orphaned CLI behind (observed: one kept grinding an hour after its harness died).
  const tsxEntry = import.meta.resolve('tsx');
  const args = ['--import', tsxEntry, join(APP, 'scripts', 'casemaker.ts'), 'cut', jobPath, '--out', outDir, '--json'];
  if (opts.location !== null) args.push('--location', opts.location);
  if (opts.catalogue !== null) args.push('--catalogue', opts.catalogue);
  let rc = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: APP,
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(APP, 'tsconfig.scripts.json') },
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    rc = e.status ?? 1;
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? e.message ?? '';
  }
  writeFileSync(join(outDir, 'run.log'), stderr);
  let receipt: Record<string, unknown> | null = null;
  try {
    receipt = stdout.trim().length === 0 ? null : (JSON.parse(stdout) as Record<string, unknown>);
  } catch {
    receipt = null;
  }
  const receiptPath = join(outDir, 'receipt.json');
  if (receipt !== null) writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { rc, receipt, stderr, receiptPath, outDir };
}

/** The receipt's posted programs (`details.programs`), or an empty list. */
function programsOf(receipt: Record<string, unknown> | null): Record<string, unknown>[] {
  const details = receipt?.['details'];
  if (details === undefined || details === null || typeof details !== 'object') return [];
  const programs = (details as Record<string, unknown>)['programs'];
  return Array.isArray(programs) ? (programs as Record<string, unknown>[]) : [];
}

function diagnosticCodes(receipt: Record<string, unknown> | null): string[] {
  const codes = new Set<string>();
  const add = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>)['code'] === 'string') {
        codes.add((row as Record<string, unknown>)['code'] as string);
      }
    }
  };
  add(receipt?.['diagnostics']);
  add(receipt?.['refusals']);
  return [...codes];
}

/* ---------------------------------------------------------------------------------------------
 * The per-purpose runners.
 * ------------------------------------------------------------------------------------------- */

const MESH_PURPOSES = new Set([
  'rotary',
  'rotary-unreachable',
  'relief-3axis',
  'plate-2.5d',
  'step-import',
  'gears-outline',
  'relief-plate-own',
  'badge-own',
]);
const OUTLINE_PURPOSES = new Set(['svg-coaster', 'svg-outline', 'svg-shapes-mm', 'dxf-units']);

function stage(status: StageStatus, note: string, receiptPath: string | null): StageResult {
  return { status, note, receiptPath };
}

function checkStageOf(receipt: Record<string, unknown> | null): StageResult {
  const programs = programsOf(receipt);
  const goals = programs
    .map((p) => p['goal'])
    .filter((g): g is Record<string, unknown> => g !== null && g !== undefined && typeof g === 'object');
  if (goals.length === 0) {
    return stage('n/a', 'no program carried a goal check', null);
  }
  const parts: string[] = [];
  let ok = true;
  for (const goal of goals) {
    const ran = goal['ran'] === true;
    const adjudicated = typeof goal['adjudicatedMaxMm'] === 'number' ? (goal['adjudicatedMaxMm'] as number) : null;
    const leftover = Array.isArray(goal['leftoverFractions']) ? (goal['leftoverFractions'] as number[]) : [];
    const passCoverage = typeof goal['passCoverage'] === 'number' ? (goal['passCoverage'] as number) : null;
    const coverage = leftover.length === 0 ? null : 1 - (leftover[0] as number);
    const passLineOk = coverage === null || passCoverage === null ? null : coverage + 1e-9 >= passCoverage;
    if (!ran || (adjudicated !== null && adjudicated > 0) || passLineOk === false) ok = false;
    parts.push(
      ran
        ? `adjudicated cut-into ${adjudicated === null ? '?' : adjudicated.toFixed(4)} mm, coverage ${
            coverage === null ? '?' : `${(coverage * 100).toFixed(2)} %`
          } vs ${passCoverage === null ? '?' : `${(passCoverage * 100).toFixed(2)} %`}, leftover bands ${leftover.map((v) => `${(v * 100).toFixed(2)} %`).join('/')}`
        : `not compared: ${String(goal['reason'] ?? 'no reason stated')}`,
    );
  }
  const codes = diagnosticCodes(receipt);
  return stage(ok ? 'pass' : 'fail', `${parts.join('; ')}${codes.length === 0 ? '' : ` [${codes.join(', ')}]`}`, null);
}

function planStageOf(run: CutRun): StageResult {
  const programs = programsOf(run.receipt);
  const codes = diagnosticCodes(run.receipt);
  const ok = run.receipt?.['ok'] === true && programs.length > 0;
  const stageWord = typeof run.receipt?.['stage'] === 'string' ? (run.receipt['stage'] as string) : null;
  return stage(
    ok ? 'pass' : 'fail',
    `${programs.length} program(s)${stageWord === null ? '' : `, stage ${stageWord}`}, rc ${run.rc}${
      codes.length === 0 ? '' : `; ${codes.join(', ')}`
    }`,
    run.receiptPath,
  );
}

/**
 * #1161 — A BLANK BIGGER THAN THE MACHINE AT 1:1 IS ITS OWN VERDICT, not a refusal and not a
 * failure: a laser-kit drawing (burnathome, crown) or a phone stand (gbox-t1) is drawn for a
 * bigger bed, and scaling it to fit would change the design. The manager's ruling, 2026-11-10:
 * no scale-to-fit by default — state the dimension and the travel, and count these apart, the
 * same grouping C's #1121 table gives the over-travel stocks. Nothing is run: the CLI's own
 * preflight would refuse the blank before a plan exists.
 */
function exceedsMachine(job: EngraveJob): StageResult | null {
  const problem = boxProblem(job.stock, Z1);
  if (problem === null) return null;
  return stage('exceeds-machine', `${problem}; not scaled to fit (scaling would change the design)`, null);
}

async function runMeshLike(
  sample: ManifestSample,
  ctx: { root: string; out: string; location: string | null; catalogue: string | null; timeoutMs: number; coarse: boolean },
  rotary: boolean,
): Promise<SampleResult> {
  const path = join(ctx.root, sample.path);
  if (!existsSync(path)) return skipped(sample, `file absent: ${sample.path}`);
  const read = await readTargetFile(path, rotary ? { scaleTo: ROD_DIAMETER_MM - 4.5 } : {});
  if (!read.ok) {
    return {
      purpose: sample.purpose,
      import: stage('fail', read.error, null),
      plan: stage('n/a', 'not planned: the import refused', null),
      check: stage('n/a', 'not checked: nothing was planned', null),
    };
  }
  const jobDir = ensureDir(join(ctx.out, sample.id));
  const job = meshJob(sample, read, rotary, ctx.coarse);
  const jobPath = join(jobDir, 'job.json');
  writeFileSync(jobPath, `${JSON.stringify(job, null, 1)}\n`);
  const importNote = `${read.target.format.toUpperCase()}: ${read.mesh.triangleCount} triangles, ${read.target.size.x} × ${read.target.size.y} × ${read.target.size.z} mm${
    sample.health === undefined ? '' : `, ${sample.health}`
  }${read.note === null ? '' : ` (${read.note})`}`;
  const tooBig = exceedsMachine(job);
  const importStage = stage('pass', importNote, fileReceipt(jobPath));
  if (tooBig !== null) {
    return { purpose: sample.purpose, import: importStage, plan: tooBig, check: stage('n/a', 'not checked: the blank at 1:1 exceeds the machine', null) };
  }
  const run = runCut(jobPath, join(jobDir, 'run'), { location: ctx.location, catalogue: ctx.catalogue, timeoutMs: ctx.timeoutMs });
  return {
    purpose: sample.purpose,
    import: importStage,
    plan: planStageOf(run),
    check: checkStageOf(run.receipt),
  };
}

async function runOutlineLike(
  sample: ManifestSample,
  ctx: { root: string; out: string; location: string | null; catalogue: string | null; timeoutMs: number },
): Promise<SampleResult> {
  const path = join(ctx.root, sample.path);
  if (!existsSync(path)) return skipped(sample, `file absent: ${sample.path}`);
  const text = readFileSync(path, 'utf8');
  const parsed = parseOutlineFile(text, basename(path));
  if (!parsed.ok) {
    return {
      purpose: sample.purpose,
      import: stage('fail', parsed.error, null),
      plan: stage('n/a', 'not planned: the import refused', null),
      check: stage('n/a', 'not checked: nothing was planned', null),
    };
  }
  const outline = parsed.outline;
  const importNote = `${outline.format.toUpperCase()}: ${outline.contours.length} contour(s), ${outline.paths?.length ?? 0} path(s), ${outline.width} × ${outline.height} mm${
    outline.notes.length === 0 ? '' : `; ${outline.notes.join('; ')}`
  }`;
  const jobDir = ensureDir(join(ctx.out, sample.id));
  const job = outlineJob(sample, outline);
  const jobPath = join(jobDir, 'job.json');
  writeFileSync(jobPath, `${JSON.stringify(job, null, 1)}\n`);
  const tooBig = exceedsMachine(job);
  const importStage = stage('pass', importNote, fileReceipt(jobPath));
  if (tooBig !== null) {
    return { purpose: sample.purpose, import: importStage, plan: tooBig, check: stage('n/a', 'not checked: the blank at 1:1 exceeds the machine', null) };
  }
  const run = runCut(jobPath, join(jobDir, 'run'), { location: ctx.location, catalogue: ctx.catalogue, timeoutMs: ctx.timeoutMs });
  return {
    purpose: sample.purpose,
    import: importStage,
    plan: planStageOf(run),
    check: checkStageOf(run.receipt),
  };
}

async function runImportOnly(sample: ManifestSample, ctx: { root: string; out: string }): Promise<SampleResult> {
  const path = join(ctx.root, sample.path);
  if (!existsSync(path)) return skipped(sample, `file absent: ${sample.path}`);
  const reportPath = join(ensureDir(join(ctx.out, sample.id)), 'import.json');
  const tail = extname(sample.path).toLowerCase();
  if (tail === '.3mf') {
    // units-3mf: the unit the model DECLARES and the factor #1130 applied, then the bbox those
    // numbers produced — the row states both (`mm (default)` when the model states none).
    try {
      const raw = readFileSync(path);
      const mesh = parse3MF(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const statedUnit = mesh.unit.stated ?? 'mm (default)';
      const size = {
        x: Number((mesh.bbox.max[0] - mesh.bbox.min[0]).toFixed(3)),
        y: Number((mesh.bbox.max[1] - mesh.bbox.min[1]).toFixed(3)),
        z: Number((mesh.bbox.max[2] - mesh.bbox.min[2]).toFixed(3)),
      };
      writeFileSync(
        reportPath,
        `${JSON.stringify({ unit: statedUnit, mmPerUnit: mesh.unit.mmPerUnit, size, triangles: mesh.triangleCount }, null, 2)}\n`,
      );
      return {
        purpose: sample.purpose,
        import: stage('pass', `3MF unit ${statedUnit} (${mesh.unit.mmPerUnit} mm per unit): ${size.x} × ${size.y} × ${size.z} mm, ${mesh.triangleCount} triangles`, fileReceipt(reportPath)),
        plan: stage('n/a', 'units-3mf is an import-only sample', null),
        check: stage('n/a', 'units-3mf is an import-only sample', null),
      };
    } catch (error) {
      return {
        purpose: sample.purpose,
        import: stage('fail', `${basename(path)} could not be parsed: ${error instanceof Error ? error.message : String(error)}`, null),
        plan: stage('n/a', 'not planned: the import refused', null),
        check: stage('n/a', 'not checked: nothing was planned', null),
      };
    }
  }
  // broken-mesh: the closure read. Manifold closes the one-sheet case with a skirt; anything else
  // is refused BY NAME with the count that decided it — never a plan.
  const boot = await bootstrap({});
  let mesh: ParsedMesh;
  try {
    const raw = readFileSync(path);
    mesh = parseStl(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  } catch (error) {
    return {
      purpose: sample.purpose,
      import: stage('fail', `could not be parsed: ${error instanceof Error ? error.message : String(error)}`, null),
      plan: stage('n/a', 'not planned: the import refused', null),
      check: stage('n/a', 'not checked: nothing was planned', null),
    };
  }
  try {
    const closed = closeOpenSheet(boot.manifold, mesh, { skirtTo: 'lowestBoundary' });
    writeFileSync(
      reportPath,
      `${JSON.stringify({ closedBy: closed.closedBy, note: closed.note, triangles: mesh.triangleCount, manifestHealth: sample.health ?? null }, null, 2)}\n`,
    );
    return {
      purpose: sample.purpose,
      import: stage(
        'pass',
        `${basename(path)}: ${closed.note}${sample.health === undefined ? '' : ` (manifest: ${sample.health})`}`,
        fileReceipt(reportPath),
      ),
      plan: stage('n/a', 'a broken-mesh sample is an import-only refusal/repair read', null),
      check: stage('n/a', 'a broken-mesh sample is an import-only refusal/repair read', null),
    };
  } catch (error) {
    const named = error instanceof UnclosableOpenMeshError ? error.message : error instanceof Error ? error.message : String(error);
    writeFileSync(reportPath, `${JSON.stringify({ refused: named, triangles: mesh.triangleCount }, null, 2)}\n`);
    return {
      purpose: sample.purpose,
      import: stage('fail', named, fileReceipt(reportPath)),
      plan: stage('n/a', 'not planned: the import refused', null),
      check: stage('n/a', 'not checked: nothing was planned', null),
    };
  }
}

async function runStepPair(sample: ManifestSample, ctx: { root: string; out: string; location: string | null; catalogue: string | null; timeoutMs: number; coarse: boolean }): Promise<SampleResult> {
  const path = join(ctx.root, sample.path);
  if (!existsSync(path)) return skipped(sample, `file absent: ${sample.path}`);
  const read = await readTargetFile(path);
  if (!read.ok) {
    return {
      purpose: sample.purpose,
      import: stage('fail', read.error, null),
      plan: stage('n/a', 'not planned: the import refused', null),
      check: stage('n/a', 'not checked: nothing was planned', null),
    };
  }
  const jobDir = ensureDir(join(ctx.out, sample.id));
  const job = meshJob(sample, read, false, ctx.coarse);
  const jobPath = join(jobDir, 'job.json');
  writeFileSync(jobPath, `${JSON.stringify(job, null, 1)}\n`);
  const tooBig = exceedsMachine(job);
  const importStage = stage('pass', `${read.target.format.toUpperCase()} read: ${read.mesh.triangleCount} triangles, ${read.target.size.x} × ${read.target.size.y} × ${read.target.size.z} mm`, fileReceipt(jobPath));
  if (tooBig !== null) {
    return {
      purpose: sample.purpose,
      import: importStage,
      plan: tooBig,
      check: stage('n/a', 'not checked: the blank at 1:1 exceeds the machine; step-vs-stl parity needs both plans'),
    };
  }
  const run = runCut(jobPath, join(jobDir, 'run'), { location: ctx.location, catalogue: ctx.catalogue, timeoutMs: ctx.timeoutMs });
  return {
    purpose: sample.purpose,
    import: importStage,
    plan: planStageOf(run),
    check: stage('n/a', 'step-vs-stl parity is compared by the pair row (both files in identical jobs, NC md5s)', null),
  };
}

async function runPriorArt(sample: ManifestSample, ctx: { root: string; out: string; location: string | null; catalogue: string | null; timeoutMs: number; coarse: boolean }): Promise<SampleResult> {
  const path = join(ctx.root, sample.path);
  if (!existsSync(path)) return skipped(sample, `file absent: ${sample.path}`);
  if (sample.path.toLowerCase().endsWith('.svg')) return runOutlineLike(sample, ctx);
  // gbox-canvas.nc: a foreign program through the sim session on a 10 mm plate — the import is the
  // parse, the check is the sweep's own numbers. The plate and the cutter are STATED here (a
  // foreign NC carries no Case Maker job); the sample row says so.
  const text = readFileSync(path, 'utf8');
  const reportPath = join(ensureDir(join(ctx.out, sample.id)), 'sim.json');
  let parsed: ReturnType<typeof parseGcode>;
  try {
    parsed = parseGcode(text);
  } catch (error) {
    return {
      purpose: sample.purpose,
      import: stage('fail', `not a program this build can read: ${error instanceof Error ? error.message : String(error)}`, null),
      plan: stage('n/a', 'prior art is not our plan', null),
      check: stage('n/a', 'nothing to sweep', null),
    };
  }
  const job = defaultEngraveJob();
  job.name = sample.id;
  job.labels = [];
  job.shapes = [];
  job.stock = { ...job.stock, length: 100, width: 60, thickness: 10, material: 'hardwood' };
  job.workholding = { kind: 'tape', tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'default' } };
  // The gbox sample states a 6 mm bit; the built-in 6 mm flat is the bench's stand-in when the
  // registry has no 6 mm entry. The note names the cutter used.
  const cutterKey = resolveTool('flat-6.0') !== null ? 'flat-6.0' : 'flat-1.0';
  job.toolKey = cutterKey;
  const tool = resolveTool(cutterKey);
  if (tool === null) {
    return {
      purpose: sample.purpose,
      import: stage('pass', `NC parsed: ${text.split('\n').length} lines`, null),
      plan: stage('n/a', 'prior art — not our plan', null),
      check: stage('fail', `no cutter resolves for ${cutterKey}`, null),
    };
  }
  const boot = await bootstrap({});
  const session = createSimSession(boot.manifold);
  let simNote: string;
  let simOk = false;
  try {
    const loaded = session.load(text, toSetup(job, Z1), tool, Z1.id);
    const codes = loaded.ok ? (loaded as { diagnostics?: { code?: string }[] }).diagnostics ?? [] : [];
    const stats = loaded.ok ? (loaded as { stats?: { removedVolume?: number; errors?: number } }).stats : undefined;
    if (loaded.ok) {
      simOk = true;
      simNote = `simulated: ${loaded.count} checkpoints, ${stats?.removedVolume ?? '?'} mm³ removed, ${codes.filter((c) => c.code !== undefined).length} diagnostic row(s)${
        codes.length === 0 ? '' : ` (${[...new Set(codes.map((c) => c.code))].join(', ')})`
      }; cutter ${cutterKey}`;
    } else {
      simNote = `the simulation refused the file: ${(loaded as { reason?: string }).reason ?? 'no reason stated'}`;
    }
    writeFileSync(reportPath, `${JSON.stringify({ lines: text.split('\n').length, header: parsed.header, sim: loaded.ok ? { count: loaded.count, stats } : { refused: true } }, null, 2)}\n`);
  } finally {
    session.dispose();
  }
  return {
    purpose: sample.purpose,
    import: stage('pass', `NC parsed: ${text.split('\n').length} lines${parsed.header === null ? '' : ', with a Makera header'}`, fileReceipt(reportPath)),
    plan: stage('n/a', 'prior art — not our plan', null),
    check: stage(simOk ? 'pass' : 'fail', simNote, fileReceipt(reportPath)),
  };
}

function skipped(sample: ManifestSample, why: string): SampleResult {
  return {
    purpose: sample.purpose,
    import: stage('n/a', why, null),
    plan: stage('n/a', why, null),
    check: stage('n/a', why, null),
  };
}

async function runSample(sample: ManifestSample, ctx: { root: string; out: string; location: string | null; catalogue: string | null; timeoutMs: number; coarse: boolean }): Promise<SampleResult> {
  if (MESH_PURPOSES.has(sample.purpose)) {
    return runMeshLike(sample, ctx, sample.purpose === 'rotary' || sample.purpose === 'rotary-unreachable');
  }
  if (sample.purpose === 'step-vs-stl') return runStepPair(sample, ctx);
  if (OUTLINE_PURPOSES.has(sample.purpose)) return runOutlineLike(sample, ctx);
  if (sample.purpose === 'units-3mf' || sample.purpose === 'broken-mesh') return runImportOnly(sample, ctx);
  if (sample.purpose === 'prior-art') return runPriorArt(sample, ctx);
  return skipped(sample, `unknown purpose "${sample.purpose}"`);
}

/* ---------------------------------------------------------------------------------------------
 * Main.
 * ------------------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The SVG importer's only ambient dependency is the browser's DOMParser; the bench tool provides
  // one from jsdom (a devDependency) before any outline is parsed. A DXF needs none of this.
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: Record<string, unknown> } };
  const dom = new JSDOM('');
  const g = globalThis as unknown as Record<string, unknown>;
  g.DOMParser = dom.window.DOMParser;
  g.Element = dom.window.Element;
  g.document = dom.window.document;
  const manifestPath = join(args.root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log(
      `run-gdrive-samples: skipped — no manifest at ${manifestPath}. Stage the downloads at ${DEFAULT_ROOT} or set CM_SAMPLES_GDRIVE.`,
    );
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const selected = manifest.samples.filter((s) => args.only === null || args.only.has(s.id));
  if (selected.length === 0) {
    console.log('run-gdrive-samples: nothing selected (--only matched no manifest row).');
    return;
  }
  // The kernel is needed for STEP conversion and the broken-mesh closure read; the jobs themselves
  // run in the CLI's own process.
  await bootstrap({ location: args.location ?? undefined, catalogue: args.catalogue ?? undefined });
  ensureDir(args.out);
  const samples: Record<string, SampleResult> = {};
  const started = Date.now();
  for (const sample of selected) {
    const at = Date.now();
    try {
      samples[sample.id] = await runSample(sample, args);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      samples[sample.id] = {
        purpose: sample.purpose,
        import: stage('fail', `harness error: ${why}`, null),
        plan: stage('n/a', 'not reached', null),
        check: stage('n/a', 'not reached', null),
      };
    }
    const r = samples[sample.id]!;
    console.log(
      `${sample.id}: import ${r.import.status} / plan ${r.plan.status} / check ${r.check.status} (${((Date.now() - at) / 1000).toFixed(0)} s)`,
    );
  }
  const results = {
    header: {
      issue: 1121,
      mainSha: mainSha(),
      stagedAt: manifest.stagedAt ?? null,
      runAt: new Date().toISOString(),
      selected: selected.map((s) => s.id),
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      note: 'The Sample Bench harness (#1121): import · plan · goal check per staged sample. The review session writes the tracker from these receipts.',
    },
    samples,
  };
  const resultsPath = join(args.out, 'results.json');
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const all = Object.values(samples);
  const over = all.filter((s) => s.plan.status === 'exceeds-machine').length;
  const pass = all.filter(
    (s) => s.plan.status !== 'exceeds-machine' && s.import.status !== 'fail' && s.plan.status !== 'fail' && s.check.status !== 'fail',
  ).length;
  console.log(
    `run-gdrive-samples: ${all.length} sample(s), ${pass} without a fail${
      over === 0 ? '' : `, ${over} exceeding the machine at 1:1 (not scaled)`
    }; results ${resultsPath}`,
  );
  if (args.keepJobs !== true) {
    // The job documents are receipts in their own right (they embed the mesh), so they are kept;
    // --keep-jobs is accepted for symmetry with benches that clean them. Nothing is deleted here.
  }
}

await main();
