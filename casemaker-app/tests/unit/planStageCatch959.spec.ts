/**
 * #959 review item 5 — A FAILED STEP DOES NOT SINK THE PLAN.
 *
 * The review found that a throwing region or stage (plan.ts's curved pipeline had no catch at all;
 * the pocket chain caught per region but only into prose notes) either crashed `planModelCam`
 * outright or vanished from what the plan states. The manager's ruling: catch per region and per
 * stage, state each failure in the plan's `unplanned` list in `sequence.ts`'s own
 * `SequenceStepFailure` shape (kind, cutter, regions, reason), and keep planning the rest. Only a
 * PRIMARY failure disqualifies a candidate (`priceSequence`'s step-0 rule); in the curved pipeline a
 * failed ROUGH is that region's primary: nothing after it is planned on stock it never cleared.
 *
 * The failures are injected by wrapping the real ops (`vi.mock`), on the `sloped` random part
 * (seed 1): two pockets on two flats, one curved region (rough → finish → pencil), the contour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput, type SetupPlan } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

type Inject = { op: 'pocket' | 'rough' | 'finish'; when: (opts: { cutter: Tool; node?: { id: string }; regionRef?: { id: string } }) => boolean };
const injected = vi.hoisted(() => ({ current: null as Inject | null }));

function wrap<F extends (opts: never) => unknown>(op: Inject['op'], real: F): F {
  return ((opts: Parameters<F>[0]) => {
    const inj = injected.current;
    if (inj !== null && inj.op === op && inj.when(opts as never)) throw new Error(`injected ${op} failure`);
    return real(opts);
  }) as F;
}

vi.mock('@/engine/cnc/cam/model/ops/pocket', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/engine/cnc/cam/model/ops/pocket')>();
  return { ...real, pocket: wrap('pocket', real.pocket) };
});
vi.mock('@/engine/cnc/cam/model/ops/rough', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/engine/cnc/cam/model/ops/rough')>();
  return { ...real, rough: wrap('rough', real.rough) };
});
vi.mock('@/engine/cnc/cam/model/ops/finish', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/engine/cnc/cam/model/ops/finish')>();
  return { ...real, finish: wrap('finish', real.finish) };
});

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };

async function planSloped(): Promise<SetupPlan> {
  const part = buildRandomPart(1, 'sloped', tl);
  const input: ModelPlanInput = {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [FLAT6, FLAT3175, BALL2], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
  const out = await planModelCam(input);
  expect(out.perSetup.length).toBe(1);
  return out.perSetup[0]!;
}

const opsOf = (plan: SetupPlan): string[] => plan.ops.map((o) => `${o.kind}:${o.region.id}`);

describe('#959 item 5 — a failed region or stage is stated in `unplanned`, the rest still plans', () => {
  afterEach(() => {
    injected.current = null;
  });

  it('the baseline plan (nothing injected) states nothing unplanned', async () => {
    const plan = await planSloped();
    expect(opsOf(plan)).toEqual(expect.arrayContaining(['pocket:pocket-0', 'pocket:pocket-1', 'rough:curved-0', 'finish:curved-0', 'pencil:curved-0', 'contour:contour']));
    expect(plan.unplanned).toEqual([]);
  }, 120_000);

  it('a throwing curved FINISH: the plan returns, every other program is there, and unplanned names it', async () => {
    injected.current = { op: 'finish', when: (o) => o.regionRef?.id === 'curved-0' };
    const plan = await planSloped();
    const ops = opsOf(plan);
    expect(ops).toEqual(expect.arrayContaining(['pocket:pocket-0', 'pocket:pocket-1', 'rough:curved-0', 'pencil:curved-0', 'contour:contour']));
    expect(ops).not.toContain('finish:curved-0');
    expect(plan.programs.length).toBeGreaterThan(0);
    expect(plan.unplanned).toEqual([
      { kind: 'finish', cutterKey: 'ball-2', regionIds: ['curved-0'], reason: 'injected finish failure' },
    ]);
  }, 120_000);

  it('a throwing curved ROUGH is that region\'s primary: its later stages are not planned on uncleared stock, the pockets and contour still are', async () => {
    injected.current = { op: 'rough', when: (o) => o.regionRef?.id === 'curved-0' };
    const plan = await planSloped();
    const ops = opsOf(plan);
    expect(ops).toEqual(expect.arrayContaining(['pocket:pocket-0', 'pocket:pocket-1', 'contour:contour']));
    expect(ops.filter((o) => o.endsWith(':curved-0'))).toEqual([]);
    expect(plan.unplanned[0]).toEqual({ kind: 'rough', cutterKey: 'flat-6', regionIds: ['curved-0'], reason: 'injected rough failure' });
    expect(plan.unplanned.slice(1).map((f) => f.kind)).toEqual(['finish', 'pencil']);
    for (const f of plan.unplanned.slice(1)) expect(f.reason).toMatch(/rough .*failed/);
  }, 120_000);

  it('a throwing POCKET region: the plan returns, the other pocket and the curved stages post, unplanned names the region with its own message', async () => {
    injected.current = { op: 'pocket', when: (o) => o.node?.id === 'pocket-1' };
    const plan = await planSloped();
    const ops = opsOf(plan);
    expect(ops).toEqual(expect.arrayContaining(['pocket:pocket-0', 'rough:curved-0', 'finish:curved-0', 'contour:contour']));
    expect(ops).not.toContain('pocket:pocket-1');
    const failure = plan.unplanned.find((f) => f.regionIds.includes('pocket-1'));
    expect(failure, `unplanned: ${JSON.stringify(plan.unplanned)}`).toBeDefined();
    // The sequence's own step vocabulary: pocket-1 is the chain's REST step on the smaller flat.
    expect(failure).toEqual({ kind: 'rest', cutterKey: 'flat-3.175', regionIds: ['pocket-1'], reason: 'injected pocket failure' });
    // The chain that left it out ranks first, so it is also unreachable — with the real reason,
    // not a cutter-size sentence the house's ⌀3.175 would contradict.
    expect(plan.unreachable).toContain('pocket-1: not cut — planning failed (injected pocket failure)');
  }, 120_000);

  it('a PRIMARY failure still disqualifies the candidate: every flat-6 pocket throws, no candidate survives, the plan refuses', async () => {
    // Every candidate this part offers roughs its pockets on flat-6 first (step 0): with that step
    // failing, `priceSequence` drops each one, and the refusal is the sequence's own sentence —
    // a plan whose primary failed is not posted with the failure stated, it is not a plan.
    injected.current = { op: 'pocket', when: (o) => o.cutter.id === 'flat-6' };
    await expect(planSloped()).rejects.toThrow(/every candidate had a step the ops could not post/);
  }, 120_000);
});
