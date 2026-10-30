/**
 * #766 slice B — THE SEARCH: the cutter plans worth trying, and the one to choose.
 *
 * Rules pick by a proxy and each proxy has failed on a real job (#762 area, #760 kind, #765 the
 * tightest gap). This module does not judge a plan at all: it GENERATES the plausible plans and
 * hands each to slice A's evaluator (`evaluatePlan`), then chooses by the stated objective — the
 * most fidelity, then the fewest tool changes, then the shortest time, with owned cutters before
 * catalogue ones and the catalogue winner named so the operator can 'buy this'.
 *
 * THE CANDIDATES. Every plan is kind-valid and reach-filtered before it costs a simulation: the
 * #762 work classes decide which cutter shapes an item accepts, the material gate refuses a
 * cutter the job cannot run, and the reach filter refuses one whose flute cannot cover the cut it
 * owns. Around the kind plan (`planCutters`) the search tries what an operator would: a single
 * clearance flat, and that flat with each of the finest feasible rest cutters — the raised-text
 * pinches are the case that needs it (#765) — plus a sharp V as the rest for raised text, which
 * the simulation measures at its real edge loss.
 *
 * PURE, with the evaluator INJECTED: this module lives in `engine/`, which must not import the
 * worker realm slice A lives in. D binds `evaluatePlan` to it in the CLI, the Design panel and the
 * wizard, so every surface runs the same search (the issue's "same engine for every surface").
 *
 * BUDGET. Coarse-evaluate every pruned candidate, then full-evaluate the finalists
 * (`fullFinalists`, default 3); slice A caches both, so nothing is simulated twice.
 */

import type { EvaluatedItem, PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { CandidatePlan, PinchFact } from '@/workers/sim/planEvaluate';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { statedCuttingSize as stated } from '@/engine/cnc/tool';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import { kindedWork, materialRefusal, planCutters, reachOf, type PlannedCutter } from './cutterPlan';

export type { CandidatePlan, PinchFact } from '@/workers/sim/planEvaluate';

/**
 * The evaluator, bound by the caller to slice A (workers/sim/planEvaluate).
 *
 * MAY BE ASYNC (#766 D). The Design panel runs this search in the sim worker BETWEEN edits, and a
 * synchronous search would block the preview that shares that worker for its whole run. An async
 * evaluator lets the worker yield to its message queue between plans — so a newer edit's preview
 * request is served, and can cancel the search — while the CLI and the unit tests pass a plain
 * synchronous one.
 */
export type Evaluate = (plan: CandidatePlan, level: 'coarse' | 'full') => PlanEvaluation | Promise<PlanEvaluation>;

/** The evaluator as the loops below consume it: always a promise, whichever form the caller bound. */
type AwaitableEvaluate = (plan: CandidatePlan, level: 'coarse' | 'full') => Promise<PlanEvaluation>;

/** Where a plan's cutters come from. `inv:` keys are the shop's own; catalogue entries are bought. */
export function sourceOf(entry: ToolLibraryEntry): 'owned' | 'catalogue' {
  return entry.key.startsWith('cat:') ? 'catalogue' : 'owned';
}

/** One plan with the numbers the objective ranks. */
export interface ScoredPlan {
  plan: CandidatePlan;
  evaluation: PlanEvaluation;
  /** The WORST item fidelity in the plan, 0…1 — the objective's first key. */
  worstFidelity: number;
  /** The mean item fidelity, 0…1 — the tie-break inside one plan. */
  meanFidelity: number;
  /**
   * #765 — the field still standing in the raised labels' JOINED pinches, mm² (0 when there is no
   * raised text). A raised item's readability is this number, not its area fidelity: a plan that
   * scores 97 % on area and still leaves three pinches bridged reads worse than one that spends a
   * little more time and leaves slighter touches.
   */
  raisedStandingMm2: number;
  /** The number of pinches left joined across the raised labels. */
  raisedJoined: number;
  /** True when every cutter in the plan is an owned one. */
  owned: boolean;
  /** The item the worst fidelity belongs to, for the sentence. */
  worstItem: EvaluatedItem | null;
}

export interface SmartPickOptions {
  /** Plans evaluated at all (default 16). */
  maxCandidates?: number;
  /**
   * How many cutter-shape groups (the best single-cutter plan, the best flat-rest pair, the best
   * V-rest pair…) are promoted to `full` as fallbacks BESIDE the whole top-fidelity tier, which is
   * always fully evaluated. Default 3.
   */
  fullFinalists?: number;
  /**
   * How much a catalogue plan must beat the best owned plan's worst fidelity by before it is
   * CHOSEN over it (default 0.02). At or under the margin the owned plan wins and the catalogue
   * plan is named as 'buy this' instead.
   */
  buyThisMargin?: number;
}

/** The search's answer: the plan to run, what was close, and what to buy. */
export interface SmartPick {
  /**
   * The QUICK RULE's plan (#211/#760/#762 — `planCutters`' kind plan), which is the first candidate
   * the search scores. The panel's provisional answer is a view of this plan, so this is what its
   * measured answer is compared against when the two differ (slice C's difference sentence) — and
   * what slice C's fallback sentence says is used when it is the only plan that posts. Null when
   * the rule assigns no cutter at all.
   */
  rule: ScoredPlan | null;
  /** The plan to run — a POSTING plan (slice A's `full.ok`), the best of those by the objective. */
  chosen: ScoredPlan;
  /** `chosen` when it posts; null when no plan the search tried posts (the CLI then stops, saying why). */
  runnable: ScoredPlan | null;
  /**
   * The best plan by measured fidelity, POSTING OR NOT — the one C's sentence quotes. Different
   * from `chosen` when the best-measured plan does not post yet (a V rest before its engine
   * lands); the note says why.
   */
  bestMeasured: ScoredPlan;
  /** The best POSTING plan that is not the chosen one, for the 'what the alternative would lose'. */
  runnerUp: ScoredPlan | null;
  /** The best CATALOGUE POSTING plan that would beat the owned choice — the 'buy this' line. */
  buyThis: ScoredPlan | null;
  /** Every plan the search looked at, in the order it scored them (coarse verdicts unless finalists). */
  considered: readonly ScoredPlan[];
  notes: string[];
}

const byDiameter = (a: ToolLibraryEntry, b: ToolLibraryEntry): number =>
  (stated(a.tool) ?? 0) - (stated(b.tool) ?? 0);

/** The canonical identity of a plan, for dedupe and for the evaluator's cache. */
export function planKey(plan: CandidatePlan): string {
  return plan.cutters.map((c) => `${c.key}[${[...c.items].sort().join(',')}]`).join('|');
}

/**
 * The QUICK RULE's plan: what `planCutters` (#211/#760/#762) assigns, with its rest pair, before
 * any simulation. `candidatePlans` tries it first and `smartPick` keeps its verdict as `rule` — the
 * plan the panel's provisional answer stands for, and what the measured answer is compared with.
 */
export function rulePlanOf(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
): CandidatePlan | null {
  const base = planCutters(job, null, tools, catalogue, conditions ?? undefined, table ?? undefined);
  if (base.cutters.length === 0) return null;
  return planFrom(base.cutters, tools);
}

/** A plan from `planCutters`' output, with each cutter's source recorded. */
function planFrom(cutters: readonly PlannedCutter[], tools: readonly ToolLibraryEntry[]): CandidatePlan {
  const source: Record<string, 'owned' | 'catalogue'> = {};
  for (const c of cutters) {
    const entry = tools.find((t) => t.key === c.key);
    source[c.key] = entry === undefined ? 'owned' : sourceOf(entry);
  }
  return { cutters: cutters.map((c) => ({ key: c.key, items: [...c.items] })), source };
}

/**
 * The candidate plans, pruned and deduped, in a deterministic order (the kind plan first, then
 * the flat variants by clearance diameter and finer rest).
 */
export function candidatePlans(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
): CandidatePlan[] {
  const out: CandidatePlan[] = [];
  const seen = new Set<string>();
  const add = (plan: CandidatePlan): void => {
    const key = planKey(plan);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(plan);
  };

  // The kind plan: one cutter per kind, and — when the reach table is absent — no rest pair. It is
  // the rule-based answer; the search treats it as one candidate among the measured ones.
  const base = planCutters(job, null, tools, catalogue, conditions ?? undefined, table ?? undefined);
  const basePlan = planFrom(base.cutters, tools);
  if (basePlan.cutters.length > 0) add(basePlan);

  const work = kindedWork(job);

  // #766 fix — A GOAL'S BALL IS CHOSEN BY THE FINISH BUDGET, AND THE BUDGET MAY NOT BE SAMPLABLE
  // HERE. `planCutters` refuses a ball whose finish tip field would exceed the cap (#540) — but
  // only when it can sample the goal heightfield; a job whose goal mesh is attached later (the
  // CLI's store, the panel's worker) samples as null and the rule then names the LARGEST ball,
  // which the generator refuses at `cam` ("3D finishing would need … over the … budget", j06
  // wolf). Try the balls from largest down: each over-budget one is refused cheaply and the
  // largest that FITS posts, so a goal job can always generate.
  const ballWork = work.filter((w) => w.kind === 'ball');
  if (ballWork.length > 0) {
    const ids = ballWork.map((w) => w.id);
    const balls = tools
      .filter((t) => t.tool.shape === 'ball' || t.tool.shape === 'bull')
      .filter((t) => (stated(t.tool) ?? 0) > 0 && materialRefusal(job, t, catalogue, conditions, table ?? undefined, { ownedVouches: true }) === null)
      .sort((a, b) => byDiameter(b, a))
      .slice(0, 6);
    for (const ball of balls) add({ cutters: [{ key: ball.key, items: ids }], source: { [ball.key]: sourceOf(ball) } });
  }

  const flatWork = work.filter((w) => w.kind === 'flat');
  if (flatWork.length === 0) return out;

  // The flat kind's own numbers, the same rules `planCutters` applies: the deepest cut, the
  // smallest bore, and a through cut-out's depth.
  const through = job.stock.thickness + job.breakthrough;
  const deepest = flatWork.reduce((m, w) => Math.max(m, w.reachMm), 0);
  const bores = (job.drills ?? []).filter((d) => d.enabled && d.mode === 'bore');
  const smallestBore = bores.reduce<number | null>((m, d) => {
    const h = d.diameter !== undefined && d.diameter > 0 ? d.diameter : null;
    return h === null ? m : m === null ? h : Math.min(m, h);
  }, null);
  const hasCutout = (job.cutouts ?? []).some((c) => c.enabled);
  const flatItems = flatWork.map((w) => w.id);

  const gate = (entry: ToolLibraryEntry): boolean =>
    materialRefusal(job, entry, catalogue, conditions, table ?? undefined, { ownedVouches: true }) === null;
  const reaches = (entry: ToolLibraryEntry, need: number): boolean => {
    const reach = reachOf(entry);
    return reach === null || need <= reach + 1e-9;
  };
  /** A flat that may take ALL the flat work: reach, smallest bore, through cut-outs. */
  const feasibleFlat = (entry: ToolLibraryEntry): boolean => {
    const d = stated(entry.tool) ?? 0;
    return (
      d > 0 &&
      gate(entry) &&
      reaches(entry, deepest) &&
      (smallestBore === null || d < smallestBore - 1e-9) &&
      (!hasCutout || reaches(entry, through))
    );
  };
  /** A rest cutter re-cuts the earlier cutter's leftovers: reach only, no bore/through ownership. */
  const feasibleRest = (entry: ToolLibraryEntry): boolean => gate(entry) && reaches(entry, deepest);

  const flats = tools.filter((t) => t.tool.shape === 'flat' && (stated(t.tool) ?? 0) > 0 && feasibleFlat(t)).sort(byDiameter);
  const rests = tools.filter((t) => t.tool.shape === 'flat' && (stated(t.tool) ?? 0) > 0 && feasibleRest(t)).sort(byDiameter);
  // The raised-text pinches want the FINEST TIP first (a 0.1 mm 30° cone opens a 0.28 mm gap with
  // 0.018 mm a side); the flank angle only orders tips of the same width.
  const cones = tools
    .filter((t) => vCone(t.tool) !== null && vFluteLength(t.tool) !== null)
    .filter((t) => gate(t))
    .sort((a, b) => byDiameter(a, b) || (vCone(a.tool)!.halfAngleDeg - vCone(b.tool)!.halfAngleDeg));

  // The non-flat cutters the kind plan chose keep their work in every flat variant: an item left
  // unassigned is a refusal, not a variant.
  const others = base.cutters.filter((c) => {
    const entry = tools.find((t) => t.key === c.key);
    return entry !== undefined && entry.tool.shape !== 'flat';
  });
  const withOthers = (flatCutters: { key: string; items: readonly string[] }[]): CandidatePlan => {
    const all = [...flatCutters, ...others.map((c) => ({ key: c.key, items: [...c.items] }))];
    const source: Record<string, 'owned' | 'catalogue'> = {};
    for (const c of all) {
      const entry = tools.find((t) => t.key === c.key);
      source[c.key] = entry === undefined ? 'owned' : sourceOf(entry);
    }
    return { cutters: all, source };
  };

  // The interesting clearances: the largest, the middle and the two finest a shop would reach for.
  const interesting = (list: readonly ToolLibraryEntry[], n: number): ToolLibraryEntry[] => {
    if (list.length <= n) return [...list];
    const picks = new Set<ToolLibraryEntry>();
    picks.add(list[0]!);
    picks.add(list[Math.floor(list.length / 2)]!);
    picks.add(list[list.length - 2]!);
    picks.add(list[list.length - 1]!);
    return [...picks].slice(0, Math.max(2, n)).sort(byDiameter);
  };
  // Clearance first: the LARGEST interesting flats clear fastest; the rests stay finest-first.
  const clearances = interesting(flats, 4).reverse();
  const restChoices = interesting(rests, 3);
  for (const clearance of clearances) {
    add(withOthers([{ key: clearance.key, items: flatItems }]));
  }
  // Rough + rest pairs: the rest owns no items — it is measured against the earlier program.
  for (const clearance of clearances.slice(0, 3)) {
    for (const rest of restChoices) {
      if ((stated(rest.tool) ?? 0) >= (stated(clearance.tool) ?? 0) - 1e-9) continue;
      add(withOthers([{ key: clearance.key, items: flatItems }, { key: rest.key, items: [] }]));
    }
  }
  // Raised text: a sharp V as the rest (the 0.1 mm 30° cuts its pinches to within a few hundredths
  // of a millimetre — #765), and the raised measurement decides by simulation whether that holds.
  const raisedIds = new Set(
    (job.combined ?? [])
      .filter((c) => c.enabled && c.kind === 'cutaway' && c.islands.some((id) => job.labels.some((l) => l.id === id && l.construction === true)))
      .map((c) => c.id),
  );
  if (raisedIds.size > 0) {
    for (const clearance of clearances.slice(0, 2)) {
      for (const cone of cones.slice(0, 3)) {
        add(withOthers([{ key: clearance.key, items: flatItems }, { key: cone.key, items: [] }]));
      }
    }
  }
  // #766 fix — A V CARVES TEXT TOO. On a job whose flat work is ALL text, a small flat can lose
  // whole characters (an ERROR, so no flat plan posts at all) while a V's flank keeps them: j14's
  // dog tag read cleanly with #762's 60° engraver, and the search could not propose it because its
  // only cones were raised-text rests. The evaluator measures whether the V holds; the ranking
  // still prefers a flat that cuts the text faster, so this only wins where it is the only thing
  // that cuts at all. Cones with an unstated reach are tried: the generator says when one is too
  // shallow, and refusing them here is what hid #762's answer.
  const labelIds = new Set(job.labels.filter((l) => l.enabled && l.construction !== true).map((l) => l.id));
  const allText = flatWork.length > 0 && flatWork.every((w) => labelIds.has(w.id));
  if (allText) {
    const textCones = tools
      .filter((t) => vCone(t.tool) !== null)
      .filter((t) => gate(t))
      .sort(byDiameter)
      .slice(0, 2);
    for (const cone of textCones) add(withOthers([{ key: cone.key, items: flatItems }]));
  }
  return out;
}

/** The worst and mean fidelity over the plan's items (all enabled items, so an uncut one counts). */
function fidelityOf(evaluation: PlanEvaluation): { worst: number; mean: number; worstItem: EvaluatedItem | null } {
  if (evaluation.items.length === 0) return { worst: 0, mean: 0, worstItem: null };
  let worst = 1;
  let sum = 0;
  let worstItem: EvaluatedItem | null = null;
  for (const item of evaluation.items) {
    const f = Math.max(0, Math.min(1, item.fidelity));
    sum += f;
    if (f < worst) {
      worst = f;
      worstItem = item;
    }
  }
  return { worst, mean: sum / evaluation.items.length, worstItem };
}

function toScored(plan: CandidatePlan, evaluation: PlanEvaluation): ScoredPlan {
  const { worst, mean, worstItem } = fidelityOf(evaluation);
  let raisedStandingMm2 = 0;
  let raisedJoined = 0;
  for (const item of evaluation.items) {
    for (const pinch of item.pinches) {
      if (!pinch.separated) {
        raisedStandingMm2 += pinch.areaMm2;
        raisedJoined += 1;
      }
    }
  }
  return {
    plan,
    evaluation,
    worstFidelity: worst,
    meanFidelity: mean,
    raisedStandingMm2: Math.round(raisedStandingMm2 * 1e6) / 1e6,
    raisedJoined,
    owned: plan.cutters.every((c) => plan.source[c.key] !== 'catalogue'),
    worstItem,
  };
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * #766 — WHAT A TOOL CHANGE COSTS, in run time. The issue's objective is fidelity, then the fewest
 * tool changes, then the shortest time; taken literally that chooses a 4.6-hour one-cutter run over
 * a 3-minute two-cutter one to save a single change (j02, measured). A change is not free — the
 * M6 plus the cutter's M491 is machine time — so it is counted at this stated allowance, and the
 * last two keys become one cost. The number is a LABELLED FALLBACK until a bench coupon measures
 * the real changeover; it is deliberately conservative so a real time difference decides.
 */
export const TOOL_CHANGE_SECONDS = 120;

/**
 * The objective: the most fidelity (worst item first, then mean), then the cost of the run —
 * its cutting seconds plus a stated allowance per tool change — then the plan key for
 * determinism. `ownedFirst` is applied by the caller: an owned plan within the margin outranks a
 * catalogue one.
 */
function byObjective(a: ScoredPlan, b: ScoredPlan): number {
  // #765 — A RAISED LABEL'S FIDELITY IS WHAT STANDS IN ITS PINCHES. Ranked first, so a plan that
  // leaves the letters' gaps bridged cannot win on a high field-area percentage.
  if (round6(a.raisedStandingMm2) !== round6(b.raisedStandingMm2)) return a.raisedStandingMm2 - b.raisedStandingMm2;
  if (a.raisedJoined !== b.raisedJoined) return a.raisedJoined - b.raisedJoined;
  const wa = round6(a.worstFidelity);
  const wb = round6(b.worstFidelity);
  if (wa !== wb) return wb - wa;
  const ma = round6(a.meanFidelity);
  const mb = round6(b.meanFidelity);
  if (ma !== mb) return mb - ma;
  const cost = (s: ScoredPlan): number =>
    (s.evaluation.seconds ?? Number.POSITIVE_INFINITY) + s.evaluation.toolChanges * TOOL_CHANGE_SECONDS;
  const ca = round6(cost(a));
  const cb = round6(cost(b));
  if (ca !== cb) return ca - cb;
  return planKey(a.plan) < planKey(b.plan) ? -1 : planKey(a.plan) > planKey(b.plan) ? 1 : 0;
}

/**
 * Run the search. `evaluate` is slice A's `evaluatePlan` bound to a context; every call is the
 * same job and plan shape the evaluator caches, so finalists are cheap the second time.
 */
export async function smartPick(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  evaluate: Evaluate,
  opts: SmartPickOptions = {},
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
): Promise<SmartPick> {
  const evaluateAsync: AwaitableEvaluate = async (plan, level) => evaluate(plan, level);
  const maxCandidates = opts.maxCandidates ?? 16;
  const fullFinalists = Math.max(1, opts.fullFinalists ?? 3);
  const margin = opts.buyThisMargin ?? 0.02;
  const notes: string[] = [];
  const rulePlan = rulePlanOf(job, tools, catalogue, conditions, table);
  const plans = candidatePlans(job, tools, catalogue, conditions, table).slice(0, maxCandidates);
  if (plans.length === 0) {
    throw new Error('the search found no candidate cutter plan for this job');
  }
  // COARSE FIRST — measure-only: every candidate is scored cheaply, and the top few are promoted
  // to a FULL evaluation, which is the level that says whether a plan actually posts.
  const verdicts = new Map<string, ScoredPlan>();
  for (const plan of plans) verdicts.set(planKey(plan), toScored(plan, await evaluateAsync(plan, 'coarse')));
  // COARSE ok IS NOT POSTING: it says the plan is structurally evaluable. Only a full verdict's
  // `ok` is the generator's fact (slice A's seam), so the posting pool is drawn from this set.
  const fullDone = new Set<string>();
  const full = async (plan: CandidatePlan): Promise<ScoredPlan> => {
    const scoredFull = toScored(plan, await evaluateAsync(plan, 'full'));
    verdicts.set(planKey(plan), scoredFull);
    fullDone.add(planKey(plan));
    return scoredFull;
  };
  const ordered = (): ScoredPlan[] => [...verdicts.values()].sort(byObjective);
  // FINALISTS. A coarse verdict has no time (slice A measures only), so the cost cannot tell a
  // single-cutter plan from a two-cutter one yet — and that difference is the whole question
  // (j02's 4½-hour single corn against a 3-minute pair). So every plan whose coarse fidelity ties
  // the best is fully evaluated (that is where the real time and the posting fact come from),
  // plus the best plan of each cutter-shape group as a fallback when the top tier does not post.
  const bestWorst = Math.max(...ordered().map((s) => s.worstFidelity));
  const fullList = ordered().filter((s) => s.worstFidelity >= bestWorst - 1e-9).slice(0, maxCandidates);
  const lastShape = (plan: CandidatePlan): string => {
    const last = plan.cutters[plan.cutters.length - 1];
    const entry = last === undefined ? undefined : tools.find((t) => t.key === last.key);
    return `${plan.cutters.length}:${entry?.tool.shape ?? '?'}`;
  };
  const byShape = new Map<string, ScoredPlan>();
  for (const s of ordered()) if (!byShape.has(lastShape(s.plan))) byShape.set(lastShape(s.plan), s);
  const shapeFallbacks = [...byShape.keys()]
    .sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]))
    .slice(0, fullFinalists)
    .map((k) => byShape.get(k)!);
  for (const s of shapeFallbacks) if (!fullDone.has(planKey(s.plan))) fullList.push(s);
  for (const finalist of fullList) if (!fullDone.has(planKey(finalist.plan))) await full(finalist.plan);

  // POSTING FIRST. A plan slice A's generator refuses is not a candidate to hand over, however
  // well its geometry measures; promote further plans until at least one posts.
  const postsSoFar = (): boolean => [...verdicts.entries()].some(([k, s]) => fullDone.has(k) && s.evaluation.ok);
  if (!postsSoFar()) {
    for (const candidate of ordered()) {
      const key = planKey(candidate.plan);
      if (!fullDone.has(key)) await full(candidate.plan);
      if (verdicts.get(key)!.evaluation.ok) break;
    }
  }
  const all = ordered();
  const postings = all.filter((s) => fullDone.has(planKey(s.plan)) && s.evaluation.ok);
  const bestMeasured = all[0]!;
  const bestOwnedPosting = postings.filter((s) => s.owned)[0] ?? null;
  const bestCataloguePosting = postings.filter((s) => !s.owned)[0] ?? null;
  const catalogueWins =
    bestCataloguePosting !== null &&
    (bestOwnedPosting === null ||
      round6(bestCataloguePosting.worstFidelity) > round6(bestOwnedPosting.worstFidelity) + margin - 1e-9);
  const chosen = (catalogueWins ? bestCataloguePosting : bestOwnedPosting) ?? bestMeasured;
  const runnable = postings.length > 0 ? chosen : null;
  if (runnable === null) {
    const why = bestMeasured.evaluation.refusal ?? 'the generator refuses every candidate';
    notes.push(`No plan the search tried posts: ${why}`);
  } else if (!sameCutters(chosen.plan, bestMeasured.plan)) {
    notes.push(
      `The best-measured plan (${planKey(bestMeasured.plan)}) does not post: ${bestMeasured.evaluation.refusal ?? 'the generator refuses it'} — the best plan that does post is run instead.`,
    );
  }
  const runnerUp = postings.find((s) => !sameCutters(s.plan, chosen.plan)) ?? null;
  const buyThis = catalogueWins ? bestCataloguePosting : null;
  if (buyThis !== null) {
    notes.push(
      `A catalogue cutter would measure better than your own: ${planKey(buyThis.plan)} (worst item fidelity ${round6(buyThis.worstFidelity)} against ${round6(bestOwnedPosting?.worstFidelity ?? 0)}).`,
    );
  }
  const rule = rulePlan === null ? null : (verdicts.get(planKey(rulePlan)) ?? null);
  return { rule, chosen, runnable, bestMeasured, runnerUp, buyThis, considered: all, notes };
}

function sameCutters(a: CandidatePlan, b: CandidatePlan): boolean {
  return planKey(a) === planKey(b);
}

/** The pinches a plan leaves joined, across every item — C's sentence source. */
export function joinedPinches(evaluation: PlanEvaluation): { item: EvaluatedItem; pinch: PinchFact }[] {
  const out: { item: EvaluatedItem; pinch: PinchFact }[] = [];
  for (const item of evaluation.items) {
    for (const pinch of item.pinches) {
      if (!pinch.separated) out.push({ item, pinch });
    }
  }
  return out;
}
