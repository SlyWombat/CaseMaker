/**
 * #961/#975 — THE TWO PLANS AND THE TRADEOFF LINE, the maintainer's 2026-11-05 ruling.
 *
 * `planTwoOutcomes` runs the cost-ranked plan twice — the owned set, then every bit the caller
 * knows — and returns both; the owned plan is the default. `comparePlanOutcomes` prints ONE line,
 * in outcome terms, only when the two plans' outcomes differ materially (the manager's proposed
 * bounds, one constant in `tests/tools/tradeoff.ts`). The job records the operator's choice, and
 * an absent choice reads as the owned plan.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import { planTwoOutcomes } from '../../src/engine/cnc/cam/model/twoPlans';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { engraveJobDocumentSchema } from '@/store/engraveJobSchema';
import { planChoiceOf } from '@/types/engraveJob';
import { PLAN_MATERIALITY, comparePlanOutcomes } from '../tools/tradeoff';
import { scoreSevenLines, type ProgramScore } from '../tools/sevenLines';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball6: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const v90: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });
const smallFlat: Tool = flatEndMill(1, { number: 9, id: 'flat-1', name: 'flat-1' });
const flat3175: Tool = flatEndMill(3.175, { number: 4, id: 'flat-3.175', name: 'flat-3.175' });

/** The `sloped` random part (seed 1) — the same working synthetic mesh the #959 plan specs use. */
function input(owned: Tool[], catalogue: Tool[]): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: owned, catalogue },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

describe('#961/#975 the two plans', () => {
  it('runs the sequence twice — owned and ideal — and the owned plan is the default', async () => {
    const owned = [flat6, ball6, v90];
    const planInput = input(owned, [smallFlat]);
    const two = await planTwoOutcomes(planInput);
    expect(two.defaultPlan).toBe('owned');
    expect(two.owned.perSetup.length).toBeGreaterThan(0);
    expect(two.ideal).not.toBeNull();
    // The ideal run is exactly `planModelCam` over the union set — same entry, same options.
    const directIdeal = await planModelCam({ ...planInput, cutters: { house: [...owned, smallFlat], catalogue: [] } });
    expect(JSON.stringify(two.ideal)).toBe(JSON.stringify(directIdeal));
    // And the owned run is `planModelCam` over the owned set alone — the catalogue never leaks in.
    const directOwned = await planModelCam({ ...planInput, cutters: { house: owned, catalogue: [] } });
    expect(JSON.stringify(two.owned)).toBe(JSON.stringify(directOwned));
  }, 120_000);

  it('never refuses where an owned tool can do the job — even when the catalogue carries a better bit', async () => {
    // The owned set plans the sloped part's pockets (the baseline planStageCatch959 pins that);
    // the catalogue offers a ⌀1 flat that corners better. The OWNED plan must still plan the
    // pockets with no refusal — the ruling's point 2 — and the ideal is the reference beside it.
    const planInput = input([flat6, flat3175, ball6], [smallFlat]);
    const two = await planTwoOutcomes(planInput);
    const ownedUnplanned = two.owned.perSetup.flatMap((setup) => setup.unplanned);
    expect(ownedUnplanned, JSON.stringify(ownedUnplanned)).toEqual([]);
    expect(two.owned.perSetup[0]!.ops.some((op) => op.kind === 'pocket')).toBe(true);
    expect(two.ideal).not.toBeNull();
  }, 120_000);

  it('keeps every owned candidate in the ideal’s set — adding a bit never replaces a rest choice', async () => {
    // The superset rule in candidate terms: the ideal's search must still consider the sequence
    // the owned plan chose. Before the one-candidate-per-rest change, the coverage rests were a
    // single tail and a smaller catalogue bit could push the owned rest out (the tray's ⌀3.175,
    // #975 review); this is the fast pin of that property.
    const planInput = input([flat6, flat3175, ball6], [smallFlat]);
    const two = await planTwoOutcomes(planInput);
    const sig = (steps: readonly { kind: string; cutterKey?: string; cutter?: { key: string } }[]): string =>
      steps.map((step) => `${step.kind}:${step.cutterKey ?? step.cutter?.key ?? '?'}`).join('+');
    const ownedSig = sig(two.owned.perSetup[0]!.choice.steps);
    const idealSigs = new Set(two.ideal!.perSetup[0]!.choice.considered.map((c) => sig(c.steps)));
    expect(idealSigs.has(ownedSig), `owned ${ownedSig}; ideal considered ${[...idealSigs].join(' | ')}`).toBe(true);
  }, 120_000);

  it('states no ideal when the catalogue adds no cutter the owned set did not carry', async () => {
    const planInput = input([flat6, ball6, v90], [smallFlat, { ...smallFlat }]);
    // A catalogue entry identical to an owned one (same key) is not an extra cutter.
    const two = await planTwoOutcomes({ ...planInput, cutters: { house: [flat6, ball6, v90, smallFlat], catalogue: [smallFlat] } });
    expect(two.ideal).toBeNull();
  }, 120_000);

  it('does not let the ideal run see the operator’s pin', async () => {
    const planInput: ModelPlanInput = {
      ...input([flat6, ball6, v90], [smallFlat]),
      cutters: { house: [flat6, ball6, v90], catalogue: [smallFlat], pinned: { rough: 'flat-6' } },
    };
    const two = await planTwoOutcomes(planInput);
    // The owned plan honours the pin; the ideal run is built without one (its own call).
    expect(two.ideal).not.toBeNull();
    const directIdeal = await planModelCam({ ...planInput, cutters: { house: [flat6, ball6, v90, smallFlat], catalogue: [] } });
    expect(JSON.stringify(two.ideal)).toBe(JSON.stringify(directIdeal));
  }, 120_000);
});

// ── The tradeoff line ───────────────────────────────────────────────────────────────────────────
const SCORE = (over: Partial<ProgramScore> = {}): ProgramScore => ({
  label: 'plan',
  coverage: 0.99,
  cutInto: {
    adjudicatedFraction: 0,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    shadowNotScoredFraction: 0,
    rawFraction: 0.001,
    maxMm: 0.2,
  },
  cycleSeconds: 600,
  airFraction: 0.1,
  rapidsPer1000FeedLines: 5,
  // Line 5 (the #943 rapid-time rule) is neutral here — ours equals the vendor's, so these
  // fixtures keep testing only the tradeoff line, not line 5's own verdict.
  rapidSeconds: 100,
  rapidMoves: 50,
  cutters: 3,
  cuttersOwned: true,
  postsAsFiled: { ok: true, holding: 'vise', pitchMm: 0.1 },
  ...over,
}) as ProgramScore;

const VENDOR_SCORE = (over: Partial<ProgramScore> = {}): ProgramScore => ({ ...SCORE(), label: 'vendor', coverage: 0.995, cuttersOwned: null, postsAsFiled: null, cycleSeconds: 720, ...over }) as ProgramScore;
const card = (ours: ProgramScore, vendor: ProgramScore | null = VENDOR_SCORE()) => ({ score: ours, card: scoreSevenLines({ card: 't', ours, vendor }) });

describe('#975 the tradeoff line — one line, outcome terms, only when material', () => {
  it('prints nothing when the two plans pass and fail the same lines within the bounds', () => {
    const owned = card(SCORE());
    const ideal = card(SCORE({ coverage: 0.992, cycleSeconds: 630, cutInto: { ...SCORE().cutInto, maxMm: 0.25 } }));
    const cmp = comparePlanOutcomes(owned, ideal);
    expect(cmp.material).toBe(false);
    expect(cmp.line).toBeNull();
  });

  it('prints one line past the geometry bound — the depth, in mm, never a tool name', () => {
    const owned = card(SCORE());
    const ideal = card(SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.9 } }));
    const cmp = comparePlanOutcomes(owned, ideal);
    expect(cmp.material).toBe(true);
    expect(cmp.line).toContain('deepest cut');
    expect(cmp.line).not.toMatch(/flat|ball|chamfer|V bit/i);
    expect(PLAN_MATERIALITY.geometryMm).toBe(0.1);
  });

  it('prints one line past the coverage bound and past the cycle bound', () => {
    expect(comparePlanOutcomes(card(SCORE()), card(SCORE({ coverage: 0.984 }))).line).toContain('coverage');
    expect(comparePlanOutcomes(card(SCORE()), card(SCORE({ cycleSeconds: 670 }))).line).toContain('cycle');
  });

  it('is material when the seven-line verdicts differ, whatever the numbers say', () => {
    const owned = card(SCORE());
    const ideal = card(SCORE({ coverage: 0.8 })); // fails the coverage line
    const cmp = comparePlanOutcomes(owned, ideal);
    expect(cmp.material).toBe(true);
    expect(cmp.differences.find((d) => d.bound === 'verdicts')!.material).toBe(true);
  });
});

// ── The job records the choice ─────────────────────────────────────────────────────────────────
describe('#975 the operator’s plan choice on the job', () => {
  const doc = () => JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;

  it('round-trips through the Zod document schema', () => {
    const j = { ...doc(), planChoice: 'ideal' };
    const parsed = engraveJobDocumentSchema.parse(j) as { planChoice?: string };
    expect(parsed.planChoice).toBe('ideal');
    expect(planChoiceOf(parsed as never)).toBe('ideal');
  });

  it('reads an absent choice as the owned plan — the ruling’s default, never rewritten into the file', () => {
    const parsed = engraveJobDocumentSchema.parse(doc()) as { planChoice?: string };
    expect(parsed.planChoice).toBeUndefined();
    expect(planChoiceOf(parsed as never)).toBe('owned');
  });

  it('refuses a value that is neither plan', () => {
    const bad = { ...doc(), planChoice: 'vcarve' };
    expect(engraveJobDocumentSchema.safeParse(bad).success).toBe(false);
  });
});
