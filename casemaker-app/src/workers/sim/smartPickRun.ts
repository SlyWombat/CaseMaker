/**
 * #766 D — THE MEASURED PICK, RUN IN THE BACKGROUND AND CANCELLABLE.
 *
 * The Design panel draws at once with the #211 rule's answer and asks the sim worker for the
 * measured one behind it. This module is the worker-side run: it binds the engine's `smartPick`
 * to a caller-supplied evaluator (slice A's `evaluatePlan` in the worker, a fake in a test) and
 * makes the search INTERRUPTIBLE.
 *
 * WHY IT IS ASYNC AND YIELDS. The search shares the sim worker with the preview, and one full
 * plan evaluation is a synchronous 1.4–3.2 s of real generator. Without yielding, an edit made
 * mid-search would leave the panel's own preview queued behind the whole run. Between plan
 * evaluations the run awaits `yieldTo`, which lets the worker's message queue drain — the next
 * preview request is served, `latestGen` moves, and the run notices `isStale()` on its next step
 * and stops (returning null). Cancellation is therefore COOPERATIVE at plan granularity: a plan
 * already being evaluated finishes, and nothing after it runs.
 *
 * WHAT IS KEPT WHEN IT STOPS. Slice A memoises every completed verdict and every cutter measure,
 * so a cancelled run loses only the plan it was mid-way through; the next run for the edited job
 * reuses whatever the edit did not invalidate (see `measureFingerprint`).
 *
 * HEADLESS: no Comlink, no worker globals — plain Node can run it, and `sim.worker.ts` is a thin
 * shell over it, exactly as it is over `engravePreview.ts`.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { smartPickKey } from '@/engine/cnc/engrave/measuredPick';
import {
  candidatePlans,
  smartPick,
  type CandidatePlan,
  type Evaluate,
  type SmartPick,
  type SmartPickOptions,
  type SmartPickRefusal,
} from '@/engine/cnc/engrave/smartPick';
import { explainSmartPick, type SmartPickWords } from '@/engine/cnc/engrave/smartPickWords';
import type { EngraveShopOpts } from './engraveGenerate';
import { evaluatePlan, type EvalContext, type PlanEvaluation } from './planEvaluate';

/**
 * #922 — THE PICK'S INPUTS, BUILT ONCE. The app's worker (`sim.worker.ts`'s `engraveSmartPick`) and
 * `casemaker cut` (`engrave.ts`'s `chooseCutters`) both search through the builders below, so the
 * conditions map, the shop's feed table, the five-argument candidate list and the plan-evaluator
 * context cannot drift between the two doors. A three-argument `candidatePlans` call silently drops
 * the conditions and feed-table filters; there is no such call on either side now.
 */
export interface EngravePickInputs {
  tl: EvalContext['tl'];
  job: EngraveJob;
  tools: readonly ToolLibraryEntry[];
  catalogue: readonly FeedCatalogueRow[];
  conditions: ReadonlyMap<string, ConditionSummary> | null;
  shop: EngraveShopOpts;
  /** The caller's own table, when it is not the shop's `feeds` (the worker sends it explicitly). */
  table?: readonly FeedsEntry[] | null;
}

/** The one plan-evaluator context: the search, the candidate filter and the evaluator share it. */
export function pickContext(inputs: EngravePickInputs): EvalContext {
  return {
    tl: inputs.tl,
    tools: inputs.tools,
    catalogue: inputs.catalogue,
    shop: inputs.shop,
    calibration: null,
    conditions: inputs.conditions,
    table: inputs.table ?? inputs.shop.feeds ?? null,
  };
}

/** `candidatePlans` with the context's own filters — never the three-argument form. */
export function pickCandidates(inputs: EngravePickInputs): CandidatePlan[] {
  const ctx = pickContext(inputs);
  return candidatePlans(inputs.job, inputs.tools, inputs.catalogue, ctx.conditions, ctx.table);
}

/** One plan, evaluated against the context the search itself uses. */
export function evaluatePickPlan(
  inputs: EngravePickInputs,
  plan: CandidatePlan,
  level: 'coarse' | 'full',
): PlanEvaluation | Promise<PlanEvaluation> {
  return evaluatePlan(inputs.job, plan, pickContext(inputs), { level });
}

/**
 * The engine's search for this job, with the context's conditions/table and the shop's own
 * `toolChangeSeconds` (the app's picker and the CLI read it from the same location setting).
 * `evaluate` is for the worker's cancellation guard; the CLI passes nothing.
 */
export function pickForEngrave(
  inputs: EngravePickInputs,
  opts: SmartPickOptions = {},
  evaluate?: Evaluate,
): Promise<SmartPick | SmartPickRefusal> {
  const ctx = pickContext(inputs);
  return smartPick(
    inputs.job,
    inputs.tools,
    inputs.catalogue,
    evaluate ?? ((plan, level) => evaluatePlan(inputs.job, plan, ctx, { level })),
    {
      ...(inputs.shop.toolChangeSeconds === undefined || inputs.shop.toolChangeSeconds === null
        ? {}
        : { toolChangeSeconds: inputs.shop.toolChangeSeconds }),
      ...opts,
    },
    ctx.conditions,
    ctx.table,
  );
}

/** One cutter of the measured plan, as the panel writes it back into the job. */
export interface EngravePickCutter {
  key: string;
  items: string[];
  source: 'owned' | 'catalogue';
}

/**
 * The panel's measured answer. Plain data (it crosses Comlink by structured clone): the plan to
 * write, its explanation, and the key of the job content it was measured for.
 */
export interface EngravePickSummary {
  /** `smartPickKey` of the job and context this answers — equal keys mean the same answer. */
  jobKey: string;
  cutters: EngravePickCutter[];
  /**
   * #869 — the flat the chosen plan roughs a goal with, when the plan splits the goal's program
   * into a flat rough and the ball finish. Absent on every one-cutter plan.
   */
  goalRoughKey?: string;
  words: SmartPickWords;
  /** The chosen plan's worst-item fidelity, 0…1. */
  worstFidelity: number;
  toolChanges: number;
  /** The run's cutting seconds, or null when the full evaluation could not estimate one. */
  seconds: number | null;
  /** How many candidate plans the search scored (the debug line's "over N plans"). */
  considered: number;
}

/** Everything the search needs, as the caller holds it. */
export interface SmartPickRequest {
  job: EngraveJob;
  tools: readonly ToolLibraryEntry[];
  catalogue: readonly FeedCatalogueRow[];
  conditions?: ReadonlyMap<string, ConditionSummary> | null;
  shop: EngraveShopOpts;
  table?: readonly FeedsEntry[] | null;
  /** #785 — the search's progress: the level being measured and the candidate about to be tried. */
  onProgress?: (p: { level: 'coarse' | 'full'; done: number; total: number }) => void;
}

/**
 * Slice A's evaluator, as the worker binds it (one job, one context). #881 — a full evaluation may
 * be asynchronous (it runs the real generator, whose roughing levels a pool can plan), so the
 * evaluator may answer with a promise; `smartPick` already awaits either form.
 */
export type PickEvaluator = (plan: CandidatePlan, level: 'coarse' | 'full') => PlanEvaluation | Promise<PlanEvaluation>;

/** Thrown out of the evaluator when the run has been superseded; caught here, never escapes. */
class SupersededError extends Error {
  constructor() {
    super('the measured search was superseded by a newer edit');
    this.name = 'SupersededError';
  }
}

/** Let the worker's message queue run (an edit's preview request, a newer search's cancel). */
const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run the search. Returns null when it is CANCELLED (by an edit or a newer request — the caller
 * owns the newer answer) or when the job offers no candidate plan at all (nothing to measure).
 * Throws only for a genuine failure inside the evaluator.
 */
export async function runSmartPick(
  request: SmartPickRequest & { tl: EvalContext['tl'] },
  isStale: () => boolean,
  yieldTo: () => Promise<void> = yieldToMessages,
  /** The worker passes nothing; a test may replace the plan evaluator. */
  evaluate?: PickEvaluator,
): Promise<EngravePickSummary | null> {
  const { job, tools, catalogue, shop } = request;
  // The one builder (#922): the same context the CLI's door uses, with the worker's own table.
  const inputs: EngravePickInputs = {
    tl: request.tl,
    job,
    tools,
    catalogue,
    conditions: request.conditions ?? null,
    shop,
    table: request.table ?? null,
  };
  if (pickCandidates(inputs).length === 0) return null;
  const jobKey = smartPickKey(job, { tools, catalogue, conditions: request.conditions, shop });
  const guarded: Evaluate = async (plan, level) => {
    await yieldTo();
    if (isStale()) throw new SupersededError();
    return evaluate === undefined ? evaluatePickPlan(inputs, plan, level) : evaluate(plan, level);
  };
  let pick;
  try {
    pick = await pickForEngrave(inputs, { onProgress: request.onProgress }, guarded);
  } catch (e) {
    if (e instanceof SupersededError) return null;
    throw e;
  }
  // #910 — a stated refusal: no plan to summarise (the pre-check above normally answers first).
  if (pick.refused === true) return null;
  const chosen = pick.chosen;
  return {
    jobKey,
    cutters: chosen.plan.cutters.map((cutter) => ({
      key: cutter.key,
      items: [...cutter.items],
      source: chosen.plan.source[cutter.key] ?? 'owned',
    })),
    ...(chosen.plan.goalRoughKey === undefined ? {} : { goalRoughKey: chosen.plan.goalRoughKey }),
    words: explainSmartPick(pick, tools),
    worstFidelity: chosen.worstFidelity,
    toolChanges: chosen.evaluation.toolChanges,
    seconds: chosen.evaluation.seconds,
    considered: pick.considered.length,
  };
}
