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

import { describe, expect, it } from 'vitest';

import { setupRecordFor, verifyContextFrom } from '@/engine/cnc/setups/setupRecord';
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
