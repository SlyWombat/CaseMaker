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
import { cutterKeyOf } from '../../src/engine/cnc/cam/model/sequence';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { engraveJobDocumentSchema } from '@/store/engraveJobSchema';
import { planChoiceOf } from '@/types/engraveJob';
import { PLAN_MATERIALITY, comparePlanOutcomes, idealWorsenings } from '../tools/tradeoff';
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

  it('#1134 — a reused owned plan is posted as-is, and the ideal still runs beside it', async () => {
    const planInput = input([flat6, ball6, v90], [smallFlat]);
    const two = await planTwoOutcomes(planInput);
    expect(two.ideal).not.toBeNull();
    // The pick's measured owned plan handed through: the owned half is not planned again, the
    // ideal still runs, and the result is the same plan the first call produced.
    const reused = await planTwoOutcomes(planInput, {}, { reusedOwned: two.owned });
    expect(JSON.stringify(reused.owned)).toBe(JSON.stringify(two.owned));
    expect(reused.ideal).not.toBeNull();
    expect(JSON.stringify(reused.ideal)).toBe(JSON.stringify(two.ideal));
    // The pick's own evaluation shape: owned half only, planned exactly as the owned run does.
    const ownedOnly = await planTwoOutcomes(planInput, {}, { ownedOnly: true });
    expect(ownedOnly.ideal).toBeNull();
    const directOwned = await planModelCam({ ...planInput, cutters: { house: planInput.cutters.house, catalogue: [] } });
    expect(JSON.stringify(ownedOnly.owned)).toBe(JSON.stringify(directOwned));
  }, 120_000);

  it('#1134 — a reused plan’s programs carry the CUT’s own tool objects, not the pick’s', async () => {
    const planInput = input([flat6, ball6, v90], [smallFlat]);
    // The pick plans from its OWN input: the cutters equal this input's by identity key, but they
    // are different objects — the seam's post resolves a program's header key from object identity
    // (postModelPlan's registryKeyOf map), so a reused plan that kept the pick's objects could
    // post a different `;@CM|TOOL|key=` header than a re-plan would.
    const pickHouse = planInput.cutters.house.map((tool) => ({ ...tool }));
    const pickOwned = await planModelCam({ ...planInput, cutters: { house: pickHouse, catalogue: [] } }, { planKind: 'owned' });
    const reused = await planTwoOutcomes(planInput, {}, { reusedOwned: pickOwned });
    for (const setup of reused.owned.perSetup) {
      for (const program of setup.programs) {
        expect(planInput.cutters.house, `tool ${cutterKeyOf(program.tool)} must be the cut’s own object`).toContain(program.tool);
      }
    }
    // The swap changes no reported field: the reused plan is still the plan the pick measured.
    expect(JSON.stringify(reused.owned)).toBe(JSON.stringify(pickOwned));
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

  it('#961 — the app compares two measured outcomes with no scored card: the verdicts row is stated, never assumed', () => {
    const owned = SCORE();
    // Same numbers without a card: nothing material, and the verdicts row says why it is silent.
    const same = comparePlanOutcomes({ score: owned }, { score: SCORE() });
    expect(same.material).toBe(false);
    expect(same.differences.find((d) => d.bound === 'verdicts')!.reading).toContain('not scored');
    // A material geometry difference still fires from the outcomes alone.
    const deep = comparePlanOutcomes({ score: owned }, { score: SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.5 } }) });
    expect(deep.material).toBe(true);
    expect(deep.line).toContain('deepest cut');
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

// ── The superset rule, in its material form ─────────────────────────────────────────────────────
/**
 * The pre-ruling form of the superset assertion, kept ONLY here so the relaxed rule cannot go
 * vacuous: on a fixture where the ideal IS materially worse it must still fail.
 */
const strictSuperset = (owned: ProgramScore, ideal: ProgramScore): boolean =>
  ideal.coverage! >= owned.coverage! - 1e-9 &&
  ideal.cutInto.adjudicatedFraction! <= owned.cutInto.adjudicatedFraction! + 1e-12;

describe('#975 the superset rule — the ideal is never MATERIALLY worse', () => {
  it('passes the readings the real parts show, inside the bounds (tray −0.06 points, organizer +1.2e-6 points of share)', () => {
    const owned = SCORE({ coverage: 0.997236, cutInto: { ...SCORE().cutInto, adjudicatedFraction: 7.716e-7, maxMm: 3 } });
    const ideal = SCORE({ coverage: 0.996611, cutInto: { ...SCORE().cutInto, adjudicatedFraction: 1.929e-6, maxMm: 3 } });
    expect(idealWorsenings(owned, ideal).filter((w) => w.material)).toEqual([]);
    // and the strict form is exactly what failed on them — the restatement is a real relaxation,
    // not a test that had already passed.
    expect(strictSuperset(owned, ideal)).toBe(false);
  });

  it('still catches a coverage loss past 0.5 points — the strict fixture the ruling keeps', () => {
    const owned = SCORE({ coverage: 0.9972 });
    const ideal = SCORE({ coverage: 0.9972 - 0.0051 });
    const worse = idealWorsenings(owned, ideal).filter((w) => w.material);
    expect(worse).toHaveLength(1);
    expect(worse[0]).toMatchObject({ outcome: 'coverage', bound: 'coveragePoints' });
    expect(strictSuperset(owned, ideal)).toBe(false);
  });

  it('treats the bound itself as inside — 0.5 points of coverage is not material', () => {
    const owned = SCORE();
    const ideal = SCORE({ coverage: 0.99 - 0.005 });
    expect(idealWorsenings(owned, ideal).filter((w) => w.material)).toEqual([]);
    expect(PLAN_MATERIALITY.coveragePoints).toBe(0.5);
  });

  it('catches a cut-into share past 0.5 points and a deepest cut past 0.1 mm', () => {
    const owned = SCORE();
    const share = SCORE({ cutInto: { ...SCORE().cutInto, adjudicatedFraction: 0.006 } });
    expect(idealWorsenings(owned, share).filter((w) => w.material).map((w) => w.outcome)).toEqual(['cutIntoShare']);
    const deep = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.31 } });
    expect(idealWorsenings(owned, deep).filter((w) => w.material).map((w) => w.outcome)).toEqual(['deepestCut']);
  });

  it('never flags the ideal being better, and skips an outcome nobody judged', () => {
    const owned = SCORE();
    const better = SCORE({ coverage: 0.995, cutInto: { ...SCORE().cutInto, adjudicatedFraction: 0, maxMm: 0.1 } });
    expect(idealWorsenings(owned, better).every((w) => w.worseBy <= 0)).toBe(true);
    expect(idealWorsenings(owned, better).filter((w) => w.material)).toEqual([]);
    // A null share is not judged: the row is absent, never assumed clean.
    const unjudged = SCORE({ cutInto: { ...SCORE().cutInto, adjudicatedFraction: null } });
    expect(idealWorsenings(owned, unjudged).map((w) => w.outcome)).toEqual(['coverage', 'deepestCut']);
  });
});

/**
 * #1092 (0f's ruling, 2026-11-09) — THE DEEPEST-CUT ROW IS GATED ON THE ADJUDICATED MAXIMUM.
 *
 * The organizer's ideal plan posts the deep rest moves the owned plan does not, and its RAW deepest
 * cut reads 3.0 → 10.0 mm — but that cell is one the goal check excludes by proof (a wall cell),
 * and the ADJUDICATED maximum is 0 on both sides. A superset gate that compared the raw maxima
 * failed the ideal for a reading artefact. The ruling: the row compares the adjudicated maxima; the
 * raw pair is still printed beside the judged pair, with the class the cell was excused as, and is
 * never gated.
 */
describe('#1092 (0f’s ruling) — the deepest row is judged on the adjudicated maximum', () => {
  it('an ideal whose raw maximum got deeper while its adjudicated maximum held is not material — the raw pair is printed as excused', () => {
    const owned = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 3, adjudicatedMaxMm: 0 } });
    const ideal = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 10, adjudicatedMaxMm: 0, rawMaxExclusion: 'wall' } });
    const rows = idealWorsenings(owned, ideal);
    const deep = rows.find((r) => r.outcome === 'deepestCut')!;
    expect(deep.material, JSON.stringify(deep)).toBe(false);
    expect(deep.owned).toBe(0);
    expect(deep.ideal).toBe(0);
    expect(deep.reading).toBe('ideal deepest adjudicated cut 0 → 0 mm (raw 3 → 10 mm at a wall cell, excused)');
    expect(rows.filter((w) => w.material)).toEqual([]);
  });

  it('still catches a real adjudicated worsening past the bound, and then prints no excuse', () => {
    const owned = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.2, adjudicatedMaxMm: 0.05 } });
    const ideal = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.5, adjudicatedMaxMm: 0.31 } });
    const worse = idealWorsenings(owned, ideal).filter((w) => w.material);
    expect(worse.map((w) => w.outcome)).toEqual(['deepestCut']);
    expect(worse[0]!.reading).toBe('ideal deepest adjudicated cut 0.05 → 0.31 mm');
  });

  it('names the excluded cell’s own class — a shadow cell is not called a wall cell', () => {
    const owned = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 3, adjudicatedMaxMm: 0 } });
    const ideal = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 10, adjudicatedMaxMm: 0, rawMaxExclusion: 'shadow' } });
    const deep = idealWorsenings(owned, ideal).find((r) => r.outcome === 'deepestCut')!;
    expect(deep.reading).toBe('ideal deepest adjudicated cut 0 → 0 mm (raw 3 → 10 mm at a wall-shadow cell, excused)');
  });

  it('falls back to the raw maximum when a side cannot adjudicate (a page-JSON card), stated as before', () => {
    const owned = SCORE();
    const deep = SCORE({ cutInto: { ...SCORE().cutInto, maxMm: 0.31 } });
    const row = idealWorsenings(owned, deep).find((w) => w.outcome === 'deepestCut')!;
    expect(row.material).toBe(true);
    expect(row.reading).toBe('deepest cut 0.11 mm');
  });
});

describe('#1062 the tradeoff line states a predicted bevel when the two plans differ', () => {
  /** A minimal scored side; `predictedCutIntoMm` is the plan's own V-floor prediction. */
  const bevelSide = (bevel: number | null) => ({
    score: { coverage: 0.99, cutInto: { adjudicatedFraction: 0, maxMm: 0 }, cycleSeconds: 600, predictedCutIntoMm: bevel },
  });

  it('a V floor on one side and square lips on the other is a material row, labelled a prediction', () => {
    const cmp = comparePlanOutcomes(bevelSide(0.6), bevelSide(null));
    const row = cmp.differences.find((d) => d.reading.startsWith('lips:'));
    expect(row, 'no bevel row').toBeDefined();
    expect(row!.reading).toBe('lips: bevelled 0.60 mm (V floor) · square (prediction)');
    expect(row!.material).toBe(true);
    expect(cmp.line).toContain('lips: bevelled 0.60 mm (V floor) · square');
  });

  it('the same bevel on both sides prints no row', () => {
    const cmp = comparePlanOutcomes(bevelSide(0.6), bevelSide(0.6));
    expect(cmp.differences.some((d) => d.reading.startsWith('lips:'))).toBe(false);
    expect(cmp.material).toBe(false);
  });

  it('a difference under the 0.1 mm geometry bound prints no row', () => {
    const cmp = comparePlanOutcomes(bevelSide(0.6), bevelSide(0.52));
    expect(cmp.differences.some((d) => d.reading.startsWith('lips:'))).toBe(false);
  });
});
