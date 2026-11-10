/**
 * #961/#975 — THE TWO PLANS (the maintainer's 2026-11-05 ruling, `docs/design/cam-model-engine.md`
 * §4): plan the IDEAL from every bit the app knows, and the OWNED plan from the location's set.
 *
 * The ruling, in the maintainer's words (#975): *"Our software needs to be able to plan based on
 * all bits available, but when constrained with a fixed inventory present to the user the
 * tradeoffs (if any) and then implement with the tools available to the best of our ability.
 * Potentially also showing the user what the outcome of the choice will be."*
 *
 * This module is the sequence half of it: `planModelCam` already chooses from ONE candidate set
 * (`input.cutters.house`); `planTwoOutcomes` runs it twice — the owned set, then every cutter the
 * caller knows (owned ∪ catalogue) — and returns both plans. The OWNED plan is the default and the
 * one the seven lines judge; the ideal is the reference a card may print beside it. Neither is a
 * gate, and nothing here refuses a job the owned set can plan (that rule is the plan's own).
 *
 * The tradeoff LINE is not computed here: it is judged on the two plans' SIMULATED outcomes (the
 * card's seven lines), so it belongs where those are measured — `./tradeoff.ts` carries the
 * materiality constant and the one-line comparison, and the job card that shows the line reads
 * them from there. (#961's wiring: the seam calls this module and carries the ideal beside the
 * owned plan as `planIdeal`.)
 */

import { enrichOwnedRestStatement, planModelCam, type PlanModelCamOptions, type ModelPlanInput, type ModelPlanOutput, type PlanOutcome } from './plan';
import { comparePlanOutcomes, type PlanTradeoff } from './tradeoff';
import type { Tool } from '@/engine/cnc/tool';

export type PlanKind = 'owned' | 'ideal';

/** A cutter's identity for de-duplication: the key the catalogue and the job both speak. */
function toolKey(tool: Tool): string {
  return `${tool.id ?? ''}|${tool.number ?? ''}|${tool.name}|${tool.tipDiameter ?? ''}|${tool.shape}`;
}

export interface TwoPlanOutput {
  /** The plan from the location's own set — the default, and what the seven lines judge. */
  owned: ModelPlanOutput;
  /**
   * The plan from every bit the caller knows (owned ∪ catalogue). NULL when the catalogue adds no
   * cutter the owned set did not already carry: the two runs would be the same plan, and the
   * comparison would print a tradeoff against itself.
   */
  ideal: ModelPlanOutput | null;
  /** The ruling's default: the owned plan, always. Stated here so no caller re-decides it. */
  defaultPlan: 'owned';
}

/**
 * Run the cost-ranked plan twice — owned and ideal — and return both.
 *
 * The owned run gets `cutters.house` exactly as the caller supplied it (pinned keys included: the
 * operator's pin is honoured in the plan that will be cut). The ideal run gets the union of the
 * owned set and the catalogue, with the pin DROPPED: the ideal answers "what would the best
 * available bit do", not "what would the operator's pin do".
 */
export async function planTwoOutcomes(input: ModelPlanInput, opts: PlanModelCamOptions = {}): Promise<TwoPlanOutput> {
  const owned = await planOwnedOnly(input, opts);
  const ideal = await planIdealOnly(input, opts);
  if (ideal === null) return { owned, ideal: null, defaultPlan: 'owned' };
  return { owned: enrichOwnedRestStatement(owned, ideal, input), ideal, defaultPlan: 'owned' };
}

/**
 * #1151 (#1134(c)'s ruling) — THE OWNED PLAN ALONE. `planTwoOutcomes`' own first half, extracted
 * so a caller that will carry the ideal LATER — the app's Generate, the house service's child work —
 * can stop at the plan that cuts. The input, the emptied catalogue, the `catalogueConfigured`
 * reading and the pin are the ones `planTwoOutcomes` uses, so the plan that posts cannot differ
 * between the two doors. The caller owes the ideal half (`planIdealOnly`) afterwards.
 */
export async function planOwnedOnly(input: ModelPlanInput, opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  return planModelCam(
    {
      ...input,
      cutters: { house: input.cutters.house, catalogue: [], ...(input.cutters.pinned === undefined ? {} : { pinned: input.cutters.pinned }) },
      // #1027 (E's review) — the catalogue is emptied above so the owned plan cannot see it; the
      // rest statement still has to tell "none configured" from "configured, none measured".
      catalogueConfigured: input.catalogueConfigured ?? input.cutters.catalogue.length > 0,
    },
    // #1052 — the trace's plan:start row names which of the two runs it is (6b's round).
    { ...opts, planKind: 'owned' },
  );
}

/**
 * #1049 — THE IDEAL PLAN ALONE, for a caller that already holds the owned outcome: the press
 * ("Every bit the app knows") re-plans only this half instead of both. `planTwoOutcomes` calls it
 * too, so the ideal the press returns and the ideal Generate measured are one computation of one
 * input — the same union set and `restStatement: false` — never two spellings of it.
 *
 * NULL when the catalogue adds no cutter the owned set did not already carry: the two runs would
 * be the same plan, and the comparison would print a tradeoff against itself.
 */
export async function planIdealOnly(
  input: ModelPlanInput,
  opts: PlanModelCamOptions = {},
): Promise<ModelPlanOutput | null> {
  const seen = new Set(input.cutters.house.map(toolKey));
  const extra = input.cutters.catalogue.filter((tool) => !seen.has(toolKey(tool)));
  if (extra.length === 0) return null;
  // #986 (the maintainer's ruling) — NO CYCLE CAP. The ideal is ranked on outcome alone; a longer
  // plan is stated as its cost on the card, never used to hide a better surface.
  //
  // #1023 — THE IDEAL'S OWN LEFTOVER STATEMENT IS SUPPRESSED: the owned plan is the one that
  // posts, and it is the owned plan's single statement that names the ideal's measured ball.
  return planModelCam(
    { ...input, cutters: { house: [...input.cutters.house, ...extra], catalogue: [] } },
    { ...opts, restStatement: false, planKind: 'ideal' },
  );
}

/**
 * #1049 — THE PRESS'S ONE PLAN: the ideal half plus its tradeoff line against an owned outcome the
 * caller already holds. `planTwoOutcomes` uses the same `planIdealOnly`, so the numbers this
 * returns are the ones Generate's own comparison printed for the same inputs.
 */
export async function planIdealAgainst(
  input: ModelPlanInput,
  ownedOutcome: PlanOutcome,
  opts: PlanModelCamOptions = {},
): Promise<{ tradeoff: PlanTradeoff | null; ideal: PlanOutcome | null }> {
  const idealPlan = await planIdealOnly(input, opts);
  const ideal = idealPlan?.outcome ?? null;
  return {
    tradeoff: ideal === null ? null : comparePlanOutcomes({ score: ownedOutcome }, { score: ideal }),
    ideal,
  };
}
