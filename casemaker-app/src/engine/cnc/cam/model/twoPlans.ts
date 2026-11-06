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

import { enrichOwnedRestStatement, planModelCam, type PlanModelCamOptions, type ModelPlanInput, type ModelPlanOutput } from './plan';
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
  const owned = await planModelCam(
    {
      ...input,
      cutters: { house: input.cutters.house, catalogue: [], ...(input.cutters.pinned === undefined ? {} : { pinned: input.cutters.pinned }) },
    },
    opts,
  );
  const seen = new Set(input.cutters.house.map(toolKey));
  const extra = input.cutters.catalogue.filter((tool) => !seen.has(toolKey(tool)));
  if (extra.length === 0) return { owned, ideal: null, defaultPlan: 'owned' };
  // #986 (the maintainer's ruling) — NO CYCLE CAP. The ideal is ranked on outcome alone; a longer
  // plan is stated as its cost on the card, never used to hide a better surface.
  //
  // #1023 — THE IDEAL'S OWN LEFTOVER STATEMENT IS SUPPRESSED: the owned plan is the one that
  // posts, and it is the owned plan's single statement that names the ideal's measured ball.
  const ideal = await planModelCam(
    { ...input, cutters: { house: [...input.cutters.house, ...extra], catalogue: [] } },
    { ...opts, restStatement: false },
  );
  return { owned: enrichOwnedRestStatement(owned, ideal, input), ideal, defaultPlan: 'owned' };
}
