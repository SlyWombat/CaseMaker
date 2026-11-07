/**
 * #1052 — THE MEMORY TRACE. Flag-gated, measure-only: with no sink every memTrace call is one null
 * check, and the plan and the posted program must be byte-identical. With a sink the rows bracket
 * the phases in CLI order (goal field, plan start, the measured search's candidates, each op, the
 * plan's end, each program's sweep) and carry both `process.memoryUsage()` and the wasm heap figure.
 *
 * The acceptance line on the issue: trace-off bytes identical; the 4096 run's last rows name the
 * phase, op and memory kind. This spec pins the first half on the plate; the second is eb's run.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';

import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { setMemTraceSink } from '@/engine/cnc/memTrace';

type P = [number, number, number];
type Tri2 = [[number, number], [number, number], [number, number]];

function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

/** The #1023/#1028 plate: 20 × 10 × 5 with a 6 mm-wide V notch. */
function notchedPlate(): string {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [20, 0];
  const C: [number, number] = [20, 5];
  const D: [number, number] = [13, 5];
  const E: [number, number] = [10, 0.5];
  const F: [number, number] = [7, 5];
  const G: [number, number] = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: Tri2[] = [[C, D, E], [B, C, E], [A, B, E], [G, A, E], [E, F, G]];
  const cap = (y: number): readonly (readonly [P, P, P])[] =>
    capTris.map(([a, b, c]) => (y === 0
      ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
      : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]])) as readonly (readonly [P, P, P])[];
  const sideTris: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

const BALL6: Tool = { ...flatEndMill(6), name: '6 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 6, cornerRadius: 3, fluteLength: 40 };
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 0.4,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-1046', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
    sha256: 'q'.repeat(64), data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 }, rotation: 0,
    size: { x: 20, y: 10, z: 5 },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

async function plateInput(): Promise<ModelPlanInput> {
  const target = goalTarget();
  const job = goalJob(target);
  return await buildModelPlanInputForGoal(job, target, BALL6, { tools: [], feeds: SHOP_FEEDS });
}


describe('#1052 the memory trace is flag-gated and changes nothing', () => {
  it('trace off: the plan JSON and the posted NC are byte-identical, and no row exists', async () => {
    const input = await plateInput();
    const plan = await planModelCam(input);
    const target = goalTarget();
    const job = goalJob(target);
    const run = async () => {
      const out = await generateGoalProgram(job, target, BALL6, null, { shop: { tools: [], feeds: SHOP_FEEDS } });
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      return out;
    };
    // no sink: nothing collected, nothing written
    setMemTraceSink(null);
    const off = await run();
    const planJsonOff = JSON.stringify(plan);
    const ncHashOff = createHash('sha256').update(off.nc!, 'utf8').digest('hex');

    const rows: string[] = [];
    setMemTraceSink((line) => rows.push(line));
    try {
      const on = await run();
      // THE SAME BYTES with the trace running: the rows are observations, never inputs.
      expect(createHash('sha256').update(on.nc!, 'utf8').digest('hex')).toBe(ncHashOff);
      const planOn = await planModelCam(await plateInput());
      expect(JSON.stringify(planOn)).toBe(planJsonOff);
      // And the rows bracket the phases, each with both memory kinds.
      const stages = rows.map((r) => JSON.parse(r) as { stage: string; wasmBytes: number; heapUsed: number; wasmSource: string });
      expect(stages.length).toBeGreaterThan(4);
      // The input build's goal sample is the first traced step on this path (`pipeline:start` is
      // the CLI body's own row, one layer above `generateGoalProgram`).
      expect(stages[0]!.stage).toBe('goal-field');
      for (const need of ['goal-field', 'plan:start', 'op', 'plan:end']) {
        expect(stages.some((r) => r.stage === need), `missing stage ${need}`).toBe(true);
      }
      for (const r of stages) {
        expect(typeof r.heapUsed).toBe('number');
        expect(typeof r.wasmBytes).toBe('number');
        expect(['HEAP8', 'arrayBuffers']).toContain(r.wasmSource);
      }
    } finally {
      setMemTraceSink(null);
    }
  }, 300_000);
});

// ── The CLI path: the flag parses, rows are appended, and the NC is the same file ─────────────
describe('#1052 casemaker cut --mem-trace', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const APP = join(HERE, '..', '..');
  const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
  const CUTTER = 'user:6f7a8b9c0d';
  const NOW = new Date('2026-10-28T12:00:00.000Z');

  function oneLabelJob(): EngraveJob {
    const base = defaultEngraveJob();
    const label = { ...base.labels[0]!, text: 'AE', size: 24, position: { x: 50, y: 32 }, depth: 0.5 };
    return { ...base, name: 'trace job', toolKey: CUTTER, labels: [label] };
  }

  it('writes the rows bracketing the phases and posts the same NC as a run without the flag', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'casemaker-mem-trace-'));
    const jobPath = join(scratch, 'job.json');
    writeFileSync(jobPath, JSON.stringify(oneLabelJob(), null, 2) + '\n');
    const silent = { json: true, now: NOW } as const;

    const plainOut = join(scratch, 'plain');
    const codePlain = await engraveJobMain([jobPath, '--out', plainOut, '--location', LOCATION], silent);
    expect(codePlain).toBe(0);
    const tracedOut = join(scratch, 'traced');
    const tracePath = join(scratch, 'mem.jsonl');
    const codeTraced = await engraveJobMain([jobPath, '--out', tracedOut, '--location', LOCATION, '--mem-trace', tracePath], silent);
    expect(codeTraced).toBe(0);

    // The rows: the pipeline's start and each program's sweep, each carrying both memory kinds.
    const rows = readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { stage: string; heapUsed: number; wasmBytes: number; wasmSource: string });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.stage).toBe('pipeline:start');
    expect(rows.some((r) => r.stage === 'sweep:start')).toBe(true);
    for (const r of rows) {
      expect(typeof r.heapUsed).toBe('number');
      expect(typeof r.wasmBytes).toBe('number');
      expect(['HEAP8', 'arrayBuffers']).toContain(r.wasmSource);
    }

    // The posted program is the same file: the trace is an observation, not an input.
    const plainNc = readFileSync(join(plainOut, oneLabelJob().name.replace(/\s+/g, '-').toLowerCase() + '.nc'), 'utf8');
    const tracedNc = readFileSync(join(tracedOut, oneLabelJob().name.replace(/\s+/g, '-').toLowerCase() + '.nc'), 'utf8');
    expect(tracedNc).toBe(plainNc);
  }, 300_000);
});
