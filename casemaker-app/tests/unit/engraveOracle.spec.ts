// The volumetric oracle (#206, /Simulation.md §7): does the simulated removal match the CAM's
// prediction, level by level? Real Manifold, real sweep, plain Node.
//
// The two failure-mode tests are the point of the file: a step-over past the radius must leave an
// UNCUT spine the oracle reports, and a deliberately shifted program must be caught on both
// sides. If either ever passes, the oracle has stopped looking.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  ORACLE_AREA_FLOOR,
  oracleBand,
  type OraclePredicted,
  type OracleReport,
} from '@/engine/cnc/engrave/oracle';
import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM } from '@/engine/compiler/arcResolution';
import { SWEEP_TOLERANCES } from '@/workers/geometry/sweep';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { Tool } from '@/engine/cnc/tool';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import type { EngraveJob } from '@/types/engraveJob';

/** The post context `engraveGenerate` builds, so a hand-posted program carries the same header. */
function postCtx(job: EngraveJob): PostContext {
  return {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test',
  };
}

function load(job: EngraveJob, nc: string, tool: Tool): SimSession {
  const session = createSimSession(tl);
  const r = session.load(nc, toSetup(job, Z1), tool, Z1.id);
  if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
  return session;
}

const under = (p: OracleReport) => p.worst.underCut;
const over = (p: OracleReport) => p.worst.overCut;

describe('engraveOracle (#206 §3)', () => {
  it('passes the default job, every level inside the band', () => {
    const job = defaultEngraveJob();
    const g = engraveGenerate(tl, job);
    expect(g.nc).not.toBeNull();
    const tool = jobTool(job)!;
    const session = load(job, g.nc!, tool);
    try {
      const report = session.oracle(g.predicted);
      expect(report.levels).toHaveLength(3); // depths 0.5, 1.0, 2.0
      expect(report.ok).toBe(true);
      for (const level of report.levels) {
        expect(level.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
        expect(level.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      }
      expect(under(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(over(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });

  // The issue prescribes "run the CAM core with step-over = 0.63 × diameter, bypassing feedsFor's
  // cap". That construction is no longer reachable: `pocketLoops` itself throws when step-over
  // exceeds the tool radius (#191's rule is a defence in the CAM core, not just in feedsFor), so
  // the CAM can never EMIT a spine. What a too-wide step-over would leave behind is modelled here
  // by hand instead — the same coarse raster, posted through the real post-processor — so the
  // oracle's under-cut direction is still proven to look at real content.
  it('catches an under-cut: a coarse raster leaves an uncut spine', () => {
    const job = defaultEngraveJob();
    const tool = jobTool(job)!;
    const depth = 1;

    // A 20 × 10 pocket promised at x∈[10,30], y∈[5,15], cut by horizontal passes 1.26 mm apart on
    // a 1.0 mm cutter: 0.26 mm of uncut stock between every pair of passes.
    const predicted: OraclePredicted[] = [
      { depth, polygons: [[[10, 5], [30, 5], [30, 15], [10, 15]]] },
    ];
    const passes: number[] = [];
    for (let y = 5.5; y <= 15 - 0.5 + 1e-9; y += 1.26) passes.push(Number(y.toFixed(3)));
    const moves: CamMove[] = [];
    passes.forEach((y, k) => {
      const [xa, xb] = k % 2 === 0 ? [10.5, 29.5] : [29.5, 10.5];
      moves.push({ kind: 'rapid', x: xa, y, z: 1 });
      moves.push({ kind: 'feed', x: xa, y, z: -depth, f: 200 });
      moves.push({ kind: 'feed', x: xb, y, z: -depth, f: 400 });
    });
    expect(passes.length).toBeGreaterThan(1);

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

    const session = load(job, posted.text, tool);
    try {
      const report = session.oracle(predicted);
      expect(report.ok).toBe(false);
      expect(under(report)).toBeGreaterThan(0.1); // the seven 0.26 mm spines are ~36 mm²
    } finally {
      session.dispose();
    }
  });

  it('catches an over-cut: shifting every X by +0.5 mm', () => {
    const job = defaultEngraveJob();
    const g = engraveGenerate(tl, job);
    expect(g.nc).not.toBeNull();
    // Only the emitted X words: every header field is lowercase (`x=`), so this cannot touch the
    // header. A move that omits X keeps the modal value, so the whole path shifts together.
    const shifted = g.nc!.replace(/X(-?\d+(?:\.\d+)?)/g, (_m, n: string) => `X${(Number(n) + 0.5).toFixed(3)}`);
    expect(shifted).not.toBe(g.nc);

    const session = load(job, shifted, jobTool(job)!);
    try {
      const report = session.oracle(g.predicted);
      expect(report.ok).toBe(false);
      expect(over(report)).toBeGreaterThan(0);
      expect(under(report)).toBeGreaterThan(0);
    } finally {
      session.dispose();
    }
  });

  it('derives the band from the named tolerances, never a hand-set number', () => {
    const levelsFor1000 = SWEEP_TOLERANCES.simplifyLevels(1000);
    expect(levelsFor1000).toBe(3);
    expect(oracleBand(1000)).toBeCloseTo(levelsFor1000 * SWEEP_SIMPLIFY_EPS_MM + 2 * ARC_CHORD_TOLERANCE_MM, 12);
    expect(oracleBand(1000)).toBeCloseTo(0.016, 12); // the value /Simulation.md §7 works out
  });
});
