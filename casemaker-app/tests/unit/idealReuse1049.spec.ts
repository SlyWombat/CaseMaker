/**
 * #1049 — THE PRESS PLANS ONE PLAN, NOT TWO.
 *
 * Generate plans both outcomes itself and carries `planTradeoff` on its result; the store reads
 * that line straight away. The press ("Every bit the app knows") is the only caller that re-plans,
 * and it plans the IDEAL half alone against the owned outcome the run holds (`planIdealAgainst`).
 * These cases pin the helper to `planTwoOutcomes` itself: one `planModelCam` call instead of two,
 * the same ideal plan, and the same tradeoff numbers — with the call count taken on a mocked
 * module so "one, not two" is measured, not read.
 */
import { describe, expect, it, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';

vi.mock('@/engine/cnc/cam/model/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/plan')>();
  return { ...actual, planModelCam: vi.fn(actual.planModelCam) };
});

import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { planIdealAgainst, planIdealOnly, planTwoOutcomes } from '@/engine/cnc/cam/model/twoPlans';
import { comparePlanOutcomes } from '@/engine/cnc/cam/model/tradeoff';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball6: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const smallFlat: Tool = flatEndMill(1, { number: 9, id: 'flat-1', name: 'flat-1' });

/**
 * The `sloped` random part (seed 1) — the same synthetic mesh the #959/#961 plan specs use —
 * plus a goal cell field, because a plan's OUTCOME (what the tradeoff compares) is measured only
 * when the caller supplies one. The field's numbers are a crude grid over the stock; the pin is
 * that both spellings of the ideal comparison land on the same tradeoff.
 */
function input(owned: Tool[], catalogue: Tool[], withGoal = true): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  const nx = Math.ceil(part.stock.length);
  const ny = Math.ceil(part.stock.width);
  const z = new Float32Array(nx * ny).fill(part.mesh.bbox.max[2]);
  const covered = new Uint8Array(nx * ny).fill(1);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: owned, catalogue },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    ...(withGoal ? { goal: { nx, ny, x0: 0, y0: 0, pitch: 1, z, covered } } : {}),
  };
}

const calls = (): number => vi.mocked(planModelCam).mock.calls.length;

describe('#1049 the ideal half alone', () => {
  it('plans one model plan where planTwoOutcomes plans two, and the ideal is the same plan', async () => {
    const planInput = input([flat6, ball6], [smallFlat]);
    vi.mocked(planModelCam).mockClear();
    const two = await planTwoOutcomes(planInput);
    expect(calls()).toBe(2);
    expect(two.ideal).not.toBeNull();

    vi.mocked(planModelCam).mockClear();
    const ideal = await planIdealOnly(planInput);
    expect(calls(), 'the press re-plans the ideal half only').toBe(1);
    // No change to the ideal's bytes: the two spellings are one computation of one input.
    expect(JSON.stringify(ideal)).toBe(JSON.stringify(two.ideal));
  }, 120_000);

  it('returns the tradeoff Generate would have printed, against the owned outcome it holds', async () => {
    const planInput = input([flat6, ball6], [smallFlat]);
    const two = await planTwoOutcomes(planInput);
    expect(two.owned.outcome).toBeDefined();
    expect(two.ideal?.outcome).toBeDefined();
    const fromGenerate = comparePlanOutcomes({ score: two.owned.outcome! }, { score: two.ideal!.outcome! });

    vi.mocked(planModelCam).mockClear();
    const pressed = await planIdealAgainst(planInput, two.owned.outcome!);
    expect(calls()).toBe(1);
    expect(pressed.tradeoff, 'the comparison is real, not null against null').not.toBeNull();
    expect(JSON.stringify(pressed.tradeoff)).toBe(JSON.stringify(fromGenerate));
    expect(JSON.stringify(pressed.ideal)).toBe(JSON.stringify(two.ideal!.outcome));
  }, 120_000);

  it('plans nothing when the catalogue adds no cutter the owned set did not carry', async () => {
    const planInput = input([flat6, ball6], []);
    vi.mocked(planModelCam).mockClear();
    expect(await planIdealOnly(planInput)).toBeNull();
    expect(calls()).toBe(0);
    // A catalogue entry that duplicates an owned cutter by identity is no addition either.
    const two = await planTwoOutcomes(input([flat6, ball6], [flat6]));
    expect(two.ideal).toBeNull();
  }, 120_000);
});
