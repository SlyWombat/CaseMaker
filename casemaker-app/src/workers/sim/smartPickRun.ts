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
import { candidatePlans, smartPick, type CandidatePlan, type Evaluate } from '@/engine/cnc/engrave/smartPick';
import { explainSmartPick, type SmartPickWords } from '@/engine/cnc/engrave/smartPickWords';
import type { EngraveShopOpts } from './engraveGenerate';
import type { PlanEvaluation } from './planEvaluate';

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

/** Slice A's evaluator, as the worker binds it (one job, one context). */
export type PickEvaluator = (plan: CandidatePlan, level: 'coarse' | 'full') => PlanEvaluation;

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
  request: SmartPickRequest,
  evaluate: PickEvaluator,
  isStale: () => boolean,
  yieldTo: () => Promise<void> = yieldToMessages,
): Promise<EngravePickSummary | null> {
  const { job, tools, catalogue, conditions, shop } = request;
  const table = request.table ?? shop.feeds ?? null;
  if (candidatePlans(job, tools, catalogue, conditions, table).length === 0) return null;
  const jobKey = smartPickKey(job, { tools, catalogue, conditions, shop });
  const guarded: Evaluate = async (plan, level) => {
    await yieldTo();
    if (isStale()) throw new SupersededError();
    return evaluate(plan, level);
  };
  let pick;
  try {
    pick = await smartPick(job, tools, catalogue, guarded, { onProgress: request.onProgress }, conditions, table);
  } catch (e) {
    if (e instanceof SupersededError) return null;
    throw e;
  }
  const chosen = pick.chosen;
  return {
    jobKey,
    cutters: chosen.plan.cutters.map((cutter) => ({
      key: cutter.key,
      items: [...cutter.items],
      source: chosen.plan.source[cutter.key] ?? 'owned',
    })),
    words: explainSmartPick(pick, tools),
    worstFidelity: chosen.worstFidelity,
    toolChanges: chosen.evaluation.toolChanges,
    seconds: chosen.evaluation.seconds,
    considered: pick.considered.length,
  };
}
