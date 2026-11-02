// #902 — MEASURE FIRST (Node). Drives one goal end to end — embed the mesh, `engraveGenerate`
// (the same call `engraveRunStore` makes), then a `createSimSession` sweep of the posted file —
// and samples `process.memoryUsage()` at each phase. Nothing in `bench-files.ts`, `sweep-timing.ts`
// or `gen-goal-fixtures.mts` drives a goal end to end, so this is a new entry point rather than a
// change to any of them.
//
// Usage (from `casemaker-app/`):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/goal-memory-bench.mts \
//     [--mesh <path>] [--cell 0.1] [--length 150] [--width 75] [--thickness 51] [--tool-dia 3]
//
// Run under an explicit cap to make the cap visible in the report, e.g.:
//   node --max-old-space-size=2048 --experimental-strip-types ... (tsx sets its own loader; see
//   README note below) — or simplest, read the active cap this process already has
//   (`v8.getHeapStatistics().heap_size_limit`), printed in the report either way.
//
// One JSON line per phase to stdout, plus a human table at the end. `--mesh` defaults to the
// panther used in the #889/#896 crash profiling (local-only, excluded via .git/info/exclude;
// never commit it).

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';

import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { Z1 } from '@/engine/cnc/machine';
import { toSetup, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { sha256Hex } from '@/engine/import/meshStock';
import { simErrors, simulationProblem } from '@/engine/cnc/simGate';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { EngraveProgress } from '@/workers/sim/engraveGenerate';
import { bootstrap } from '@/platform/headless/bootstrap';

interface Args {
  mesh: string;
  cellMm: number;
  length: number;
  width: number;
  thickness: number;
  toolDiaMm: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    mesh: 'samples/3d/nude_pantherv2-final.stl',
    cellMm: 0.1,
    length: 150,
    width: 75,
    thickness: 51,
    toolDiaMm: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (flag === '--mesh') args.mesh = value;
    else if (flag === '--cell') args.cellMm = Number(value);
    else if (flag === '--length') args.length = Number(value);
    else if (flag === '--width') args.width = Number(value);
    else if (flag === '--thickness') args.thickness = Number(value);
    else if (flag === '--tool-dia') args.toolDiaMm = Number(value);
    else continue;
    i++;
  }
  return args;
}

interface Sample {
  phase: string;
  tMs: number;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

const samples: Sample[] = [];
const started = performance.now();

function sample(phase: string): Sample {
  const m = process.memoryUsage();
  const row: Sample = {
    phase,
    tMs: Math.round(performance.now() - started),
    rssMb: m.rss / (1024 * 1024),
    heapUsedMb: m.heapUsed / (1024 * 1024),
    externalMb: m.external / (1024 * 1024),
    arrayBuffersMb: (m.arrayBuffers ?? 0) / (1024 * 1024),
  };
  samples.push(row);
  console.log(JSON.stringify(row));
  return row;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const heapLimitMb = v8.getHeapStatistics().heap_size_limit / (1024 * 1024);
  console.log(`# goal-memory-bench: mesh=${args.mesh} cell=${args.cellMm}mm stock=${args.length}x${args.width}x${args.thickness}mm tool-dia=${args.toolDiaMm}mm`);
  console.log(`# node --max-old-space-size effective heap_size_limit: ${heapLimitMb.toFixed(0)} MB`);

  sample('start');
  const { manifold: tl } = await bootstrap();
  sample('bootstrap');

  // ── Phase: mesh load — read the STL bytes, hash and embed them into the target object. ───────
  const bytes = readFileSync(args.mesh);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const sha256 = await sha256Hex(buf);
  const target: EngraveTargetObject = {
    id: 'g-bench',
    name: args.mesh.split('/').pop() ?? args.mesh,
    format: 'stl',
    sha256,
    data: Buffer.from(buf).toString('base64'),
    size: { x: args.length, y: args.width, z: args.thickness },
    position: { x: args.length / 2, y: args.width / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    surface: { gridPitchMm: args.cellMm },
  };
  sample('mesh-load');

  const job: EngraveJob = {
    ...defaultEngraveJob(),
    name: '#902 goal memory bench',
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: args.length, width: args.width, thickness: args.thickness, material: 'hardwood' },
    targetObject: target,
  };
  const tool = flatEndMill(args.toolDiaMm, { id: 'bench-flat', name: `flat ${args.toolDiaMm}mm` });

  // ── Phase: generate — `engraveGenerate`'s own stage events double as the parse/CAM/post split. ─
  const stageSeen = new Set<string>();
  const onProgress = (p: EngraveProgress): void => {
    if (stageSeen.has(p.stage)) return;
    stageSeen.add(p.stage);
    sample(`generate:${p.stage}`);
  };
  const generated = await engraveGenerate(tl, job, tool, [], null, undefined, {}, onProgress);
  sample('generate-done');
  if (!generated.ok || generated.nc === null) {
    console.error(JSON.stringify({ stage: generated.stage, errors: generated.errors, findings: generated.findings }, null, 2));
    throw new Error(`goal did not generate (stopped at ${generated.stage})`);
  }
  console.log(`# generate ok: ${generated.cam?.cuttingMoves} cutting moves, ${generated.nc.length} bytes posted, ${generated.nc.split('\n').length} lines`);

  // ── Phase: sweep — the simulation that checks the posted file. ─────────────────────────────────
  const session = createSimSession(tl);
  const simLoad = session.load(generated.nc, toSetup(job, Z1), tool, 'Z1');
  sample('sweep-done');
  if (!simLoad.ok) {
    console.error(JSON.stringify(simLoad.diagnostics, null, 2));
    throw new Error('simulation refused');
  }
  const simProblem = simulationProblem(simLoad.diagnostics);
  console.log(`# sweep ok: ${simLoad.count} checkpoints, ${simErrors(simLoad.diagnostics).length} errors${simProblem !== null ? ` (${simProblem})` : ''}`);
  session.dispose();
  sample('dispose');

  console.log('\n# phase                  t(ms)   rss(MB)  heapUsed(MB)  external(MB)  arrayBuffers(MB)');
  for (const s of samples) {
    console.log(
      `${s.phase.padEnd(24)}${String(s.tMs).padStart(7)}${s.rssMb.toFixed(1).padStart(10)}${s.heapUsedMb.toFixed(1).padStart(14)}${s.externalMb.toFixed(1).padStart(14)}${s.arrayBuffersMb.toFixed(1).padStart(18)}`,
    );
  }
  const peakRss = Math.max(...samples.map((s) => s.rssMb));
  console.log(`\n# peak rss: ${peakRss.toFixed(1)} MB, heap_size_limit: ${heapLimitMb.toFixed(0)} MB`);
}

await main();
