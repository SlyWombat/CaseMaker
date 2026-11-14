/**
 * #1246 stage 2, slice 1 — THE SETUP RECORD, RED FIRST.
 *
 * One record per setup states the twelve facts of `docs/design/planner-v3.md` §4A.8; the fields
 * this slice does not yet move are `null` and name the slice that will fill them. One builder
 * (`setupRecordFor`) derives what the verifier's side uses today; one function
 * (`verifyContextFrom`) turns a record plus the genuinely per-program fields into the
 * `VerifyContext` the nine inline builders used to assemble by hand.
 *
 * TEST 3 OF THE ANALYST'S LIST IS DELIBERATELY ABSENT: the verifier's `Setup` body is left
 * exactly as it is in this slice — building it from the setup's own stock was stopped because the
 * body's work origin and machine placement feed the runner's own `outside-envelope` verdict
 * (`verify.ts:602` → `timeline.ts:248/254`; `setup.ts:259-263, 285-291`). #1247 owns that fix and
 * its pin. The record's `verifierSetup` field is `null` here for the same reason.
 */

import { PROGRAM_CONTEXT } from './helpers/programContext';
import { describe, expect, it } from 'vitest';

import { evaluateOpenEdge } from '@/engine/cnc/cam/model/openEdges';
import { setupRecordFor, verifyContextFrom } from '@/engine/cnc/setups/setupRecord';
import { planModelCam, setupStockOf } from '@/engine/cnc/cam/model/plan';
import { GOAL_FIT_TOLERANCE_MM } from '@/engine/cnc/engrave/goalPlacement';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import type { VerifyReport } from '@/engine/cnc/verify';
import { boxTarget, jobFor, FLAT3, SHOP } from './helpers/twoSetupBox966';
import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import type { SetupSpec } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { buildThroughMask } from '@/engine/cnc/engrave/throughMask';
import { blankFootprint, jobFootprint, setupFootprint } from '@/engine/cnc/footprint';
import { Z1 } from '@/engine/cnc/machine';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { postKey } from '@/engine/cnc/post';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { stockDepthLimit, type VerifyContext } from '@/engine/cnc/verify';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

const TOOL: Tool = flatEndMill(3, { number: 1, id: 'flat-3', name: 'flat-3' });
const GRID: [number, number][] = [
  [0, 0],
  [100, 0],
  [0, 60],
  [100, 60],
  [50, 30],
  [-5, -5],
  [110, 70],
];

function boxJob(over: Partial<EngraveJob> = {}): EngraveJob {
  return { ...defaultEngraveJob(), ...over };
}

/** A tape-held rod: `rotaryMapOf` gives ⌀20 × 85 mm of stick-out. */
function rodJob(): EngraveJob {
  return boxJob({
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
  });
}

function mountFixture(): MountObstacles {
  return {
    obstacles: [{ id: 'clamp', kind: 'clamp', label: 'the clamp', fix: 'move it', min: [0, 0], max: [10, 10], topZ: 22 }],
    uncertainty: 0.1,
    fixture: { boxes: [], source: 'default', uncertainty: 0.1 },
  };
}

/**
 * Value equality for two verifier contexts: everything but the two function fields by value, and
 * those sampled at the grid (a function's identity is not a fact).
 */
function expectSameContext(actual: VerifyContext, expected: VerifyContext): void {
  const { depthLimit: aDepth, limitReasonAt: aReason, ...aRest } = actual;
  const { depthLimit: eDepth, limitReasonAt: eReason, ...eRest } = expected;
  expect(aRest).toEqual(eRest);
  for (const [x, y] of GRID) expect(aDepth(x, y), `depthLimit at (${x}, ${y})`).toBe(eDepth(x, y));
  if (eReason === undefined) {
    expect(aReason).toBeUndefined();
  } else {
    expect(aReason).toBeDefined();
    for (const [x, y] of GRID) expect(aReason!(x, y), `limitReasonAt at (${x}, ${y})`).toBe(eReason(x, y));
  }
}

describe('#1246 slice 1 — setupRecordFor', () => {
  it('1. a single-setup box job states the job blank, the heights, the setup footprint and jobDepthLimit', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const record = setupRecordFor(job, 0, { setup });

    expect(record.index).toBe(0);
    expect(record.stock).toEqual({ kind: 'box', length: 100, width: 60, thickness: 12 });
    expect(record.heights).toEqual({ stockTop: 0, stockBottom: -12 });
    expect(record.footprint).toEqual(setupFootprint(job, 0));

    const limit = jobDepthLimit(job);
    for (const [x, y] of GRID) expect(record.depthLimit(x, y), `depthLimit at (${x}, ${y})`).toBe(limit(x, y));
  });

  it('2. a job with side strips states their rectangles, equal to the shapes the #1235 footprint carries', () => {
    const job = boxJob({
      sacrificial: {
        under: null,
        sides: { left: { thickness: 6, height: 'flush' }, right: { thickness: 6, height: 'flush' }, front: null, back: null },
        source: 'saved',
      },
    });
    const record = setupRecordFor(job, 0, { setup: toSetup(job, Z1) });

    expect(record.sacrificial.underThicknessMm).toBeNull();
    // Pinned numbers, not a re-derivation: a 6 mm left strip on the 100 × 60 blank and its right
    // mirror — exactly the rectangles `jobFootprint` appends after the blank's own shape.
    expect(record.sacrificial.sides).toEqual([
      { kind: 'rect', x: -6, y: 0, length: 6, width: 60 },
      { kind: 'rect', x: 100, y: 0, length: 6, width: 60 },
    ]);
    expect(record.sacrificial.sides).toEqual(jobFootprint(job).slice(1));

    // With a board under it too, the under-board states its thickness and stays out of `sides`.
    const withBoard = boxJob({
      sacrificial: {
        under: { thickness: 12, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
        sides: job.sacrificial.sides,
        source: 'saved',
      },
    });
    const boardRecord = setupRecordFor(withBoard, 0, { setup: toSetup(withBoard, Z1) });
    expect(boardRecord.sacrificial.underThicknessMm).toBe(12);
    expect(boardRecord.sacrificial.sides).toEqual(record.sacrificial.sides);
  });

  it('4. a rod states its rod stock and the context rotary field', () => {
    const job = rodJob();
    const map = rotaryMapOf(job, null);
    expect(map).not.toBeNull();
    const setup = toSetup(job, Z1);
    const record = setupRecordFor(job, 0, { setup, depthLimit: jobDepthLimit(job), rotary: map! });

    expect(record.stock).toEqual({ kind: 'rod', diameter: 20, length: 85 });
    expect(record.heights).toEqual({ stockTop: 10, stockBottom: -10 });
    expect(record.rotary).toEqual({
      radius: map!.radius,
      stickout: map!.stickout,
      tailstock: map!.tailstock,
      limits: map!.limits,
    });
  });

  it('5. the facts this slice does not move are null, and the deferred body names #1247', () => {
    const job = boxJob();
    const record = setupRecordFor(job, 0, { setup: toSetup(job, Z1) });
    expect(record.frame).toBeNull(); // slice 2 — the planner's SetupFrame
    expect(record.openEdges).toBeNull(); // slice 2 — #1234
    expect(record.outline).toBeNull(); // slice 2 — the outline-is-stock / freeing contour fact
    expect(record.datum).toBeNull(); // slice 4 — the registration/probing session
    expect(record.priorCuts).toBeNull(); // slice 5 — the stock as it now stands (#1221's Stock)
    expect(record.verifierSetup).toBeNull(); // #1247 — the body built from `stock`
  });

  it('6. a job-less call MUST state the stock and the depth limit — the builder throws without either', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const limit = (): number => 0;
    const stock = { length: 100, width: 60, thickness: 12 };
    // Neither stated.
    expect(() => setupRecordFor(null, 0, { setup })).toThrow(/deps\.stock/);
    // A stated limit does not excuse the missing stock.
    expect(() => setupRecordFor(null, 0, { setup, depthLimit: limit })).toThrow(/deps\.stock/);
    // A stated stock does not excuse the missing limit.
    expect(() => setupRecordFor(null, 0, { setup, stock })).toThrow(/deps\.depthLimit/);
    // Both stated: the record is built, and its stock is the stated box (not derived).
    const record = setupRecordFor(null, 0, { setup, depthLimit: limit, stock });
    expect(record.stock).toEqual({ kind: 'box', ...stock });
    expect(record.sacrificial).toEqual({ underThicknessMm: null, sides: [] });
  });
});

describe('#1246 slice 1 — verifyContextFrom equals the inline builders', () => {
  it('A. the frame/facing path: job footprint, verbatim limit, mount grown by clearance and top lift', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const mount = mountFixture();
    const limit = jobDepthLimit(job);
    const deps = { setup, mount, clearanceMm: 1.5, topLiftMm: 0.4, footprint: jobFootprint(job), depthLimit: limit };
    const perProgram = { setup, machine: Z1, tool: TOOL, minRapidZ: 3, dialect: postKey(Z1) };

    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, deps), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: limit,
      minRapidZ: 3,
      footprint: jobFootprint(job),
      mountObstacles: { obstacles: mount.obstacles, uncertainty: mount.uncertainty, clearance: 1.5, topLift: 0.4 },
    });
  });

  it('B. the postModelPlan/restoredRun path: the through kerf widens the limit, per-setup thickness', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const cutouts = [{ path: [[[0, 0], [20, 0], [20, 10], [0, 10]]] as [number, number][][], spans: [], toolRadius: 1.5, tabHeight: 1 }];
    const mask = buildThroughMask({ thickness: 12, breakthrough: job.breakthrough, cutouts });
    const limit = jobDepthLimit(job, undefined, mask ?? undefined, undefined, 12);
    const allowances = new Map([[1, 0.5]]);
    const deps = { setup, throughKerf: cutouts }; // no depthLimit: the builder composes fact 6
    const perProgram = { setup, machine: Z1, tool: TOOL, minRapidZ: 4, dialect: postKey(Z1), outsideAllowancesMm: allowances };

    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, deps), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: limit,
      minRapidZ: 4,
      footprint: setupFootprint(job, 0),
      outsideAllowancesMm: allowances,
    });
  });

  it('C. the rotary face path: rotary frame stated, no flat footprint, no mount', () => {
    const job = rodJob();
    const map = rotaryMapOf(job, null)!;
    const setup = toSetup(job, Z1);
    const limit = jobDepthLimit(job);
    const deps = { setup, depthLimit: limit, footprint: null, rotary: map };
    const perProgram = { setup, machine: Z1, tool: TOOL, minRapidZ: 5, dialect: postKey(Z1) };

    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, deps), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: limit,
      minRapidZ: 5,
      rotary: { radius: map.radius, stickout: map.stickout, tailstock: map.tailstock, limits: map.limits },
    });
  });

  it('D. the generateOne flat path: item program, its allowances and the limit sentence', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const mount = mountFixture();
    const limit = jobDepthLimit(job, undefined, undefined, null);
    const allowances = new Map([[2, 0.2]]);
    const reason = (x: number, y: number): string => `a void at ${x}, ${y}`;
    const deps = { setup, mount, clearanceMm: 0.5, topLiftMm: 1, depthLimit: limit, footprint: jobFootprint(job) };
    const perProgram = {
      setup,
      machine: Z1,
      tool: TOOL,
      minRapidZ: 2,
      dialect: postKey(Z1),
      outsideAllowancesMm: allowances,
      itemProgram: true,
      limitReasonAt: reason,
    };

    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, deps), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: limit,
      minRapidZ: 2,
      footprint: jobFootprint(job),
      outsideAllowancesMm: allowances,
      itemProgram: true,
      limitReasonAt: reason,
      mountObstacles: { obstacles: mount.obstacles, uncertainty: mount.uncertainty, clearance: 0.5, topLift: 1 },
    });
  });

  it('E. the clean-walk/dry-run path (an infinite limit) and the restart path (stockDepthLimit, a blank footprint)', () => {
    const job = boxJob();
    const setup = toSetup(job, Z1);
    const perProgram = { setup, machine: Z1, tool: TOOL, minRapidZ: 7, dialect: postKey(Z1) };

    const infinite = (): number => Number.POSITIVE_INFINITY;
    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, { setup, depthLimit: infinite, footprint: jobFootprint(job) }), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: infinite,
      minRapidZ: 7,
      footprint: jobFootprint(job),
    });

    const restartLimit = stockDepthLimit(job.stock, 0);
    expectSameContext(verifyContextFrom(setupRecordFor(job, 0, { setup, depthLimit: restartLimit, footprint: [blankFootprint(job.stock)] }), perProgram), {
      setup,
      machine: Z1,
      tool: TOOL,
      dialect: postKey(Z1),
      depthLimit: restartLimit,
      minRapidZ: 7,
      footprint: [blankFootprint(job.stock)],
    });
  });
});

describe('#1246 slice 2 — the two stock resolvers agree before they become one', () => {
  const spec = (stock?: { length: number; width: number; thickness: number }, up: [number, number, number] = [0, 0, 1], top = 0, bottom = -12): SetupSpec => ({
    frame: { up, stockTop: top, stockBottom: bottom },
    underside: 'flatOnStockBottom',
    ...(stock === undefined ? {} : { stock }),
  });

  function compare(name: string, job: EngraveJob, specs: SetupSpec[]): void {
    const input = { stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness } };
    specs.forEach((s, i) => {
      const planner = setupStockOf(input, s);
      const verifier = stockForSetup(job, i);
      expect(verifier, `${name} setup ${i}: the two resolvers disagree`).toEqual(planner);
    });
  }

  it('a box job, a two-setup job with no stated stock, the #1082 fixture and a rod all agree', () => {
    // 1. A box job, no setups.
    const box = boxJob();
    compare('box', box, [spec()]);

    // 2. Two setups, neither states a stock.
    const twoPlain = boxJob({
      setups: [
        { id: 'a', orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' }, mount: { kind: 'tape' }, itemIds: [], tools: [] },
        { id: 'b', orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' }, mount: { kind: 'tape' }, itemIds: [], tools: [] },
      ] as never,
    });
    compare('two-plain', twoPlain, [spec(), spec(undefined, [0, 0, -1], 12, 0)]);

    // 3. The #1082 fixture: setup 1 states 106 × 136 × 25.
    const stated = { length: 106, width: 136, thickness: 25 };
    const flip = boxJob({
      stock: { ...box.stock, length: 120, width: 160, thickness: 28 },
      setups: [
        { id: 'top', orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' }, mount: { kind: 'tape' }, itemIds: [], tools: [] },
        { id: 'flip', orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' }, mount: { kind: 'tape' }, itemIds: [], tools: [], stock: { ...stated, provenance: 'stated' } },
      ] as never,
    });
    compare('1082', flip, [spec(undefined, [0, 0, 1], 0, -28), spec(stated, [0, 0, -1], 28, 0)]);

    // 4. A rod job (its single setup states no box).
    const rod = rodJob();
    compare('rod', rod, [spec()]);
  });
});

describe('#1246 slice 2 — ModelPlanInput no longer drops the stock kind', () => {
  it('a box job states box; a rod states rod and its diameter', async () => {
    const job = jobFor(boxTarget('goal-kind', 40, 30, 20), 40, 30, 20);
    const boxInput = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT3, SHOP);
    expect(boxInput.stock.kind).toBe('box');
    expect(boxInput.stock.diameter).toBeUndefined();

    const rod = {
      ...job,
      stock: { ...job.stock, length: 60, width: 20, thickness: 20, shape: 'cylinder' as const, diameter: 20 },
      workholding: {
        kind: 'rotary-chuck' as const,
        rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner' as const, tailstock: false, source: 'test' },
      },
    };
    const rodInput = await buildModelPlanInputForGoal(rod as never, rod.targetObject!, FLAT3, SHOP);
    expect(rodInput.stock.kind).toBe('rod');
    expect(rodInput.stock.diameter).toBe(20);
  });
});

describe('#1246 slice 2 — the record carries the planner’s own frame', () => {
  it('the record states the frame it is given, and the stub’s Z-up is pinned beside it', async () => {
    const job = jobFor(boxTarget('goal-frame', 40, 30, 20), 40, 30, 20);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT3, SHOP);
    // #1254 — the records DO NOT ride ModelPlanInput: a record's `depthLimit` is the verifier's
    // function, and the input is structured-cloned into the rank pool. The record is built in the
    // seam; its frame is the spec's own object, which the planner reads.
    const frame = setupRecordFor(job, 0, { setup: toSetup(job, Z1), frame: input.setups[0]!.frame }).frame!;
    expect(frame).toBe(input.setups[0]!.frame);
    expect(frame.up).toEqual([0, 0, 1]);
    expect(frame.stockTop).toBe(0);
    // The verifier's stub is Z-up in the SETUP's own frame by construction — nothing forces it to
    // equal a FLIPPED record frame, which is exactly A's observation this assertion pins.
    expect(toSetup(job, Z1).placement.rotationZ).toBe(0);
    const bottom = setupRecordFor(job, 0, {
      setup: toSetup(job, Z1),
      frame: { up: [0, 0, -1], stockTop: 20, stockBottom: 0 },
    });
    expect(bottom.frame!.up).toEqual([0, 0, -1]);
    expect(toSetup(job, Z1).placement.rotationZ).toBe(0);
  });
});

describe('#1246 slice 2 pair (a) — the facing file judges the setup’s footprint', () => {
  it('it is the job footprint on a plain job and the setup’s own box when setup 0 states one', () => {
    const plain = boxJob();
    expect(setupFootprint(plain, 0)).toEqual(jobFootprint(plain));

    const stated = boxJob({
      setups: [
        {
          id: 'setup-0',
          orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
          mount: { kind: 'tape' },
          itemIds: [],
          tools: [],
          stock: { length: 80, width: 50, thickness: 10, provenance: 'stated' },
        },
      ] as never,
    });
    expect(setupFootprint(stated, 0)).toEqual([{ kind: 'rect', x: 0, y: 0, length: 80, width: 50 }]);
    expect(setupFootprint(stated, 0)).not.toEqual(jobFootprint(stated));
  });
});

describe('#1246 slice 2 pair (c) — a restored run without a stored plan says so', () => {
  const SENTENCE = "This restored run has no stored plan; it was checked against the job's limits, not the setup's own.";
  const program = (): EngraveProgram =>
    ({
      setupIndex: 1,
      setupId: 'setup-1',
      toolKey: 'flat-1.0',
      nc: ['G90 G21', 'G0 Z5', 'G0 X0 Y0', 'M5', 'M02'].join('\n'),
      verify: null as unknown as VerifyReport,
      frameNc: null,
      frameVerify: null,
      programHash: 'h-1246c',
      ...PROGRAM_CONTEXT,
      cam: null,
    }) as unknown as EngraveProgram;
  const generatedWith = (p: EngraveProgram): EngraveGenerated =>
    ({
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      threadMachining: null,
      cam: null,
      nc: p.nc,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      predicted: [],
      programs: [p],
      errors: [],
    }) as unknown as EngraveGenerated;

  it('the sentence rides the sheet statements only when the plan is missing', () => {
    const job = boxJob();
    job.toolKey = 'flat-1.0';
    const one = program();
    const recheck = (generated: EngraveGenerated) =>
      recheckStoredPrograms({ job, generated, machine: Z1, mount: null, setup: toSetup(job, Z1), defaults: null });

    const withoutPlan = recheck(generatedWith(one));
    expect((withoutPlan.generated.planStatements ?? []).map((s) => s.text)).toContain(SENTENCE);

    const withPlan = { ...generatedWith(one), plan: { perSetup: [{ ops: [], programs: [] }] } } as unknown as EngraveGenerated;
    const withStoredPlan = recheck(withPlan);
    expect((withStoredPlan.generated.planStatements ?? []).map((s) => s.text)).not.toContain(SENTENCE);
  });
});

describe('#1246 slice 2 step 4 — the open-edge raw facts ride the record', () => {
  it('the rule evaluated from a record equals the hand-computed predicate', () => {
    const facts = {
      boxes: [{ minX: -10, maxX: 0, minY: 0, maxY: 10, topZ: 20 }],
      uncertaintyMm: 0.1,
      clearanceMm: 0.5,
      stockLengthMm: 100,
      stockWidthMm: 60,
    };
    const job = boxJob();
    const record = setupRecordFor(job, 0, { setup: toSetup(job, Z1), openEdges: facts });
    expect(record.openEdges).toEqual(facts);
    // Band 1.6; the box overlaps the left strip; its top+fit (20.1) is above 10 − 1 − 0.5 → closed.
    expect(evaluateOpenEdge(record.openEdges!, 'left', 10, 1)).toBe(false);
    // …and below 30 − 1 − 0.5 → open.
    expect(evaluateOpenEdge(record.openEdges!, 'left', 30, 1)).toBe(true);
    // The box is nowhere near the right strip.
    expect(evaluateOpenEdge(record.openEdges!, 'right', 10, 1)).toBe(true);

    const none = { boxes: [], uncertaintyMm: 0, clearanceMm: 0, stockLengthMm: 100, stockWidthMm: 60 };
    for (const side of ['left', 'right', 'front', 'back'] as const) expect(evaluateOpenEdge(none, side, -10, 3)).toBe(true);
  });

  it('the model input’s plain edge facts are exactly its own fixture’s — and a record built from them evaluates the same', async () => {
    const job = jobFor(boxTarget('goal-open', 40, 30, 20), 40, 30, 20);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT3, SHOP);
    const facts = input.openEdges!;
    expect(facts).not.toBeNull();
    expect(facts.stockLengthMm).toBe(job.stock.length);
    expect(facts.stockWidthMm).toBe(job.stock.width);
    expect(facts.clearanceMm).toBe(job.jawClearance);
    // The facts are exactly the input's own fixture envelope, box for box.
    const envelope = input.fixture.envelope;
    expect(facts.boxes).toEqual(
      (envelope?.boxes ?? []).map((b) => ({ minX: b.min[0], maxX: b.max[0], minY: b.min[1], maxY: b.max[1], topZ: b.max[2] })),
    );
    expect(facts.uncertaintyMm).toBe(envelope?.uncertainty ?? 0);
  });
});

describe('#1246 slice 2 step 5 — the planner states the outline on its result', () => {
  it('a goal that fills the blank states isStock true; a smaller goal states its margins', async () => {
    const equal = jobFor(boxTarget('goal-outline-eq', 40, 30, 20), 40, 30, 20);
    const equalInput = await buildModelPlanInputForGoal(equal, equal.targetObject!, FLAT3, SHOP);
    const equalOut = await planModelCam(equalInput);
    expect(equalOut.perSetup.every((p) => p.outline !== null)).toBe(true);
    expect(equalOut.perSetup[0]!.outline).toEqual({ isStock: true, marginsMm: [0, 0, 0, 0] });

    const smaller = jobFor(boxTarget('goal-outline-sm', 30, 20, 10), 40, 30, 12);
    const smallerInput = await buildModelPlanInputForGoal(smaller, smaller.targetObject!, FLAT3, SHOP);
    const smallerOut = await planModelCam(smallerInput);
    const outline = smallerOut.perSetup[0]!.outline!;
    expect(outline.isStock).toBe(false);
    // A relief's skirt can extend past the blank (a negative margin); what makes the outline NOT
    // the stock's is at least one side with more stock beyond it than the fit tolerance.
    expect(outline.marginsMm.some((m) => m > GOAL_FIT_TOLERANCE_MM)).toBe(true);
  });
});
