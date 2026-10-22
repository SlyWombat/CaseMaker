// Temporary reproduction for #577 — is the sim+oracle result (worst under/over-cut) stable across
// repeated fresh sweeps of the SAME program? If it is, the ✓→× flip is a sequencing/stale-state
// issue; if it varies, the sweep feeding the oracle is non-deterministic.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { Z1 } from '@/engine/cnc/machine';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { postZ1 } from '@/engine/cnc/post/z1';
import type { OraclePredicted } from '@/engine/cnc/engrave/oracle';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import type { EngraveJob } from '@/types/engraveJob';

function dj(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  return job;
}

function postCtx(job: EngraveJob): Parameters<typeof postZ1>[1] {
  return {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test',
    toolKey: job.toolKey,
  };
}

describe('repro #577 — sim+oracle determinism', () => {
  it('sweeps the single-barrel job 20 times and reports oracle stability', () => {
    const raw = readFileSync(new URL('../../../docs/bench/single-barrel.job.json', import.meta.url), 'utf8');
    const parsed = parseEngraveJob(JSON.parse(raw));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const job = parsed.job;
    const tool = jobTool(job)!;
    const g = generate(tl, job);
    expect(g.nc).not.toBeNull();

    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const session = createSimSession(tl);
      const r = session.load(g.nc!, toSetup(job, Z1), tool, Z1.id);
      if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
      const report = session.oracle(g.predicted);
      results.push(`ok=${report.ok} under=${report.worst.underCut} over=${report.worst.overCut}`);
      session.dispose();
    }
    // eslint-disable-next-line no-console
    expect(new Set(results).size).toBe(1);
  });

  it('sweeps a coarse raster (known under-cut) 20 times and reports oracle stability', () => {
    // A hand-posted coarse raster — 1.26 mm passes on a 1.0 mm cutter leaves 0.26 mm spines, a
    // non-trivial under-cut (~36 mm²). If the sweep+oracle is deterministic, it is the SAME value
    // every run; if the flip is sim non-determinism, it would vary here.
    const job = dj();
    const tool = jobTool(job)!;
    const depth = 1;
    const predicted: OraclePredicted[] = [{ depth, polygons: [[[10, 5], [30, 5], [30, 15], [10, 15]]] }];
    const passes: number[] = [];
    for (let y = 5.5; y <= 15 - 0.5 + 1e-9; y += 1.26) passes.push(Number(y.toFixed(3)));
    const moves: CamMove[] = [];
    passes.forEach((y, k) => {
      const [xa, xb] = k % 2 === 0 ? [10.5, 29.5] : [29.5, 10.5];
      moves.push({ kind: 'rapid', x: xa, y, z: 1 });
      moves.push({ kind: 'feed', x: xa, y, z: -depth, f: 200 });
      moves.push({ kind: 'feed', x: xb, y, z: -depth, f: 400 });
    });
    const ir: ToolpathIR = {
      frame: 'flat',
      tool,
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      safeZ: 5,
      hopZ: 1,
      operations: [{ number: 1, name: '[T1]coarse raster', labelId: 'probe', depth, moves, estimatedSeconds: 5 }],
    };
    const posted = postZ1(ir, postCtx(job), Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));

    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const session = createSimSession(tl);
      const r = session.load(posted.text, toSetup(job, Z1), tool, Z1.id);
      if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
      const report = session.oracle(predicted);
      results.push(`ok=${report.ok} under=${report.worst.underCut} over=${report.worst.overCut}`);
      session.dispose();
    }
    // eslint-disable-next-line no-console
    expect(new Set(results).size).toBe(1);
  });
});
