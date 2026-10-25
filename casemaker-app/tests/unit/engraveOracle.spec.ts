// The volumetric oracle (#206, /Simulation.md §7): does the simulated removal match the CAM's
// prediction, level by level? Real Manifold, real sweep, plain Node.
//
// The two failure-mode tests are the point of the file: a step-over past the radius must leave an
// UNCUT spine the oracle reports, and a deliberately shifted program must be caught on both
// sides. If either ever passes, the oracle has stopped looking.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOpts, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
import {
  ORACLE_AREA_FLOOR,
  computeOracle,
  oracleBand,
  type OraclePredicted,
  type OracleReport,
} from '@/engine/cnc/engrave/oracle';
import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM } from '@/engine/compiler/arcResolution';
import { SWEEP_TOLERANCES } from '@/workers/geometry/sweep';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ShopDefaults } from '@/platform/defaultsClient';
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
    // #332: the job's own key, exactly as `engraveGenerate` passes it.
    toolKey: job.toolKey,
  };
}

function load(job: EngraveJob, nc: string, tool: Tool, opts?: SimLoadOpts): SimSession {
  const session = createSimSession(tl);
  const r = session.load(nc, toSetup(job, Z1), tool, Z1.id, opts);
  if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
  return session;
}

const under = (p: OracleReport) => p.worst.underCut;
const over = (p: OracleReport) => p.worst.overCut;

describe('engraveOracle (#206 §3)', () => {
  it('passes the default job, every level inside the band', () => {
    const job = dj();
    const g = generate(tl, job);
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
    const job = dj();
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
      // #584 — the report locates the worst disagreement: the level Z and the region's bbox.
      expect(report.worst.underAt).toBeDefined();
      expect(report.worst.underAt!.z).toBe(-depth);
      expect(report.worst.underAt!.bbox.min[0]).toBeGreaterThanOrEqual(10);
      expect(report.worst.underAt!.bbox.max[0]).toBeLessThanOrEqual(30);
      expect(report.worst.underAt!.bbox.min[1]).toBeGreaterThanOrEqual(5);
      expect(report.worst.underAt!.bbox.max[1]).toBeLessThanOrEqual(15);
      // …and the level it came from carries the same bbox, so `levels[*]` names the failing level.
      const worstLevel = report.levels.find((l) => l.underCut === report.worst.underCut);
      expect(worstLevel).toBeDefined();
      expect(worstLevel!.underBbox).toEqual(report.worst.underAt!.bbox);
      // #580 — the floor is never below the sliver floor. The exact sweeper has no grid, so it is
      // the constant; the column engine (a V-bit trace) raises it to the cell area × 4.
      expect(report.areaFloor).toBeDefined();
      expect(report.areaFloor!).toBe(ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });

  it('catches an over-cut: shifting every X by +0.5 mm', () => {
    const job = dj();
    const g = generate(tl, job);
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

  // #287 — a single-line trace (#219) used to contribute no move to the program at all. Now that
  // it does, the prediction has to carry its swept region too: the oracle judges the simulation at
  // each PREDICTED depth, so a trace missing from `predicted` leaves its groove unlooked-at (and,
  // where a shallower item sets the level, unaccounted for). The second half of this test is the
  // proof the entry is load-bearing — the same program, judged against the prediction WITHOUT the
  // trace, is refused with the whole groove reported as over-cut.
  it('passes a single-line trace, and would refuse it if the trace were not predicted (#287)', () => {
    // The trace is the DEEPEST item in the job, so its floor is a level of its own — the level the
    // control below removes.
    const base = dj();
    const job: EngraveJob = {
      ...base,
      labels: [{ ...base.labels[0]!, depth: 0.5 }],
      shapes: [],
      traces: [
        {
          kind: 'line',
          id: 'tr',
          position: { x: 30, y: 10 },
          rotation: 0,
          points: [
            [0, 0],
            [30, 0],
          ],
          closed: false,
          depth: 1.5,
          enabled: true,
        },
      ],
    };
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(g.nc).toContain('Trace line (2 points) 1.5mm');

    const tool = jobTool(job)!;
    const session = load(job, g.nc!, tool);
    try {
      const report = session.oracle(g.predicted);
      // Two levels, ascending: the label's 0.5 mm floor and the trace's 1.5 mm one.
      expect(report.levels.map((l) => l.z)).toEqual([-0.5, -1.5]);
      // The groove really was cut — a 30 mm capsule on a 1.0 mm cutter is ~30.8 mm².
      expect(report.levels[1]!.simulatedArea).toBeGreaterThan(30);
      expect(report.ok).toBe(true);
      expect(over(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(under(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

      // The control: drop the trace from the prediction and the SAME program is refused, with the
      // whole groove reported as over-cut at the label's level. This is the mismatch #287 feared.
      const blind = session.oracle(g.predicted.filter((p) => Math.abs(p.depth - 1.5) > 1e-9));
      expect(blind.ok).toBe(false);
      expect(over(blind)).toBeGreaterThan(30);
    } finally {
      session.dispose();
    }
  });

  // #445 — a thread is judged on the SAME column/cone profile the simulator swept, not against an
  // annulus guessed at. The prediction is the CAM plan's own feed segments swept with
  // `threadCutter`/`surfaceAboveTip` on this run's grid, so the two sides are two readings of one
  // model; the levels include the threaded depth and a shallow flank level, where a cylinder (or a
  // wrong pitch) would disagree across the annulus.
  it('passes a milled thread on the profile the simulator swept (#445)', () => {
    const MILL: Tool = flatEndMill(4, {
      name: '4 mm thread mill',
      typeText: 'Thread Mill',
      shape: 'thread',
      tipDiameter: 4,
      diameter: 4,
      fluteLength: 20,
    });
    const defaults = {
      'thread.radialStepoverMm': { value: 0.2, source: 'seeded' },
      'thread.entryRampMm': { value: 0.5, source: 'seeded' },
      'thread.bottomClearancePitches': { value: 1, source: 'seeded' },
      'thread.pilotTipClearanceMm': { value: 0.5, source: 'seeded' },
      'thread.feed': { value: 300, source: 'seeded' },
      'thread.plungeFeed': { value: 100, source: 'seeded' },
      'thread.spindleRpm': { value: 10000, source: 'seeded' },
      'thread.chordToleranceMm': { value: 0.01, source: 'seeded' },
    } as unknown as ShopDefaults;
    const base = dj();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      traces: [],
      drills: [],
      tool: MILL,
      threads: [
        {
          kind: 'thread',
          id: 'thr-a',
          position: { x: 50, y: 30 },
          enabled: true,
          size: 'M5',
          standard: 'metric',
          classFit: '6H',
          depth: 5,
          through: false,
        },
      ],
    };
    const g = generate(tl, job, null, [], undefined, { defaults });
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(g.threads).toHaveLength(1);
    // The simulator needs the thread's dimensions; a foreign file may not have them, but this
    // program does, and the run's own store passes exactly this list to `load`.
    const session = load(job, g.nc!, MILL, { threads: g.threads!.flatMap((t) => t.simThreads) });
    try {
      const report = session.oracle(g.predicted);
      // The tip depth (thread depth + run-out), the threaded depth, the shallow flank level and
      // half a pitch above the tip — the level a wrong pitch moves first.
      expect(report.levels.map((l) => Number(l.z.toFixed(6)))).toEqual([-0.5, -5, -5.4, -5.8]);
      for (const level of report.levels) {
        expect(level.predictedArea).toBeGreaterThan(0);
        expect(level.simulatedArea).toBeGreaterThan(0);
      }
      expect(report.ok).toBe(true);
      expect(under(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(over(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

      // The control: loaded WITHOUT the thread's dimensions the simulator falls back to the old
      // cutting-diameter cylinder, which cuts deeper across the annulus than the profile predicts.
      // The oracle must see that difference rather than sharing the fallback's mistake.
      const cylindrical = load(job, g.nc!, MILL);
      try {
        const blind = cylindrical.oracle(g.predicted);
        expect(blind.ok).toBe(false);
        expect(over(blind)).toBeGreaterThan(ORACLE_AREA_FLOOR);
      } finally {
        cylindrical.dispose();
      }
      // And a wrong PITCH is caught: bend the predicted helix by 20% of its climb and the
      // simulated floor (the program's own pitch) is no longer the floor the prediction says.
      const wrongPitch = g.predicted.map((p) =>
        p.thread === undefined
          ? p
          : {
              ...p,
              thread: {
                ...p.thread,
                moves: p.thread.moves.map((m) => ({
                  ...m,
                  z: m.z - (m.z + p.thread!.tipDepthMm) * 0.2,
                })),
              },
            },
      );
      const bent = session.oracle(wrongPitch);
      expect(bent.ok).toBe(false);
      expect(under(bent) + over(bent)).toBeGreaterThan(ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });

  // #445 review — the entry ramp may be LONGER than the pitch (the 0.5 mm seed against M2's
  // 0.4 mm). Its upper segments then sit above the first revolution's top, and the simulator sweeps
  // them; a prediction that kept only the first revolution would leave those columns untouched and
  // report an over-cut on a correct program. This is the permanent regression for that filter.
  it('passes an M2 thread whose entry ramp is longer than its pitch (#445)', () => {
    const MILL: Tool = flatEndMill(1.2, {
      name: '1.2 mm thread mill',
      typeText: 'Thread Mill',
      shape: 'thread',
      tipDiameter: 1.2,
      diameter: 1.2,
      fluteLength: 20,
    });
    const defaults = {
      'thread.radialStepoverMm': { value: 0.2, source: 'seeded' },
      'thread.entryRampMm': { value: 0.5, source: 'seeded' },
      'thread.bottomClearancePitches': { value: 1, source: 'seeded' },
      'thread.pilotTipClearanceMm': { value: 0.5, source: 'seeded' },
      'thread.feed': { value: 300, source: 'seeded' },
      'thread.plungeFeed': { value: 100, source: 'seeded' },
      'thread.spindleRpm': { value: 10000, source: 'seeded' },
      'thread.chordToleranceMm': { value: 0.01, source: 'seeded' },
    } as unknown as ShopDefaults;
    const base = dj();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      traces: [],
      drills: [],
      tool: MILL,
      threads: [
        {
          kind: 'thread',
          id: 'thr-m2',
          position: { x: 50, y: 30 },
          enabled: true,
          size: 'M2',
          standard: 'metric',
          classFit: '6H',
          depth: 3,
          through: false,
        },
      ],
    };
    const g = generate(tl, job, null, [], undefined, { defaults });
    expect(g.ok).toBe(true);
    expect(g.threads).toHaveLength(1);
    const plan = g.threads![0]!;
    // The premise: M2's pitch is 0.4 and the ramp 0.5, so the ramp really does climb above the
    // top of the first revolution (one pitch up from the tip). Without the premise the test would
    // not exercise the regression.
    expect(plan.pitch).toBeCloseTo(0.4, 9);
    const firstTurnTop = -plan.tipDepth + plan.pitch;
    expect(plan.moves.some((m) => m.z > firstTurnTop + 1e-9 && m.z < -1e-9)).toBe(true);
    const session = load(job, g.nc!, MILL, { threads: g.threads!.flatMap((t) => t.simThreads) });
    try {
      const report = session.oracle(g.predicted);
      expect(report.ok).toBe(true);
      expect(under(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(over(report)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });
});

// #642 — `computeOracle`'s promise ("every CrossSection is deleted exactly once, on both the success
// and the throw path") had no try/finally behind it and no throw-path test: a wasm failure in
// `offset` left the level's sections allocated with nothing to free them. This drives the throw and
// asks each section the library made whether it was deleted — `isDeleted` is embind's own answer.
describe('#642 computeOracle frees every section it built when a level throws', () => {
  it('deletes the predicted section when the first offset throws after it was built', () => {
    type Cs = { offset: (...args: unknown[]) => unknown; isDeleted: () => boolean };
    // Embind gives each instance its own prototype object (probed: the class prototype is not the
    // instance's), so the throwing `offset` is an OWN property on the one section `ofPolygons`
    // returns — exactly the section a real wasm failure in `offset` would strand.
    const CS = tl.CrossSection as unknown as { ofPolygons: (...args: unknown[]) => Cs };
    const realOf = CS.ofPolygons;
    const made: Cs[] = [];
    CS.ofPolygons = (...args: unknown[]) => {
      const cs = realOf.apply(CS, args);
      made.push(cs);
      cs.offset = () => {
        throw new Error('wasm: a section could not be built (test)');
      };
      return cs;
    };
    try {
      const predicted: OraclePredicted[] = [
        { depth: 1, polygons: [[[0, 0], [10, 0], [10, 10], [0, 10]]] },
      ];
      expect(() => computeOracle(tl, () => null, predicted, 0.05)).toThrow('a section could not be built');
      // The one section the level had built before the throw is freed by the finally…
      expect(made).toHaveLength(1);
      expect(made[0]!.isDeleted()).toBe(true);
    } finally {
      CS.ofPolygons = realOf;
    }
  });
});
