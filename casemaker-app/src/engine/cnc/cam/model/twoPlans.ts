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
import { cutterKeyOf } from './sequence';
import { comparePlanOutcomes, type PlanTradeoff } from './tradeoff';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
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
 * #1134 — REBIND THE PICK'S TOOL OBJECTS TO THE CUT'S OWN. The seam's post resolves a program's
 * header key from the SHOP's own tool objects (`postModelPlan`'s `registryKeyOf` is a Map keyed by
 * object identity: the registry key when the very object is a shop entry's tool, else
 * `cutterKeyOf`). The pick's plan was planned from the pick's own input; its programs carry that
 * input's tool objects. Handed through unchanged, a house tool the pick's shop knew could post its
 * registry key where the cut's re-plan posts its raw identity — the same program under a different
 * `;@CM|TOOL|key=` header (measured on the Set B bottom through the pick: the 4 mm ball posted
 * `cat:…` from the reused plan and its tool id from the re-plan). Rebinding each program's tool to
 * the CUT input's house object restores the re-plan's own resolution, header included.
 */
function rebindToolsToHouse(plan: ModelPlanOutput, house: readonly Tool[]): ModelPlanOutput {
  const byIdentity = new Map<string, Tool>();
  for (const tool of house) byIdentity.set(cutterKeyOf(tool), tool);
  const rebind = (ir: ToolpathIR): ToolpathIR => {
    const twin = byIdentity.get(cutterKeyOf(ir.tool));
    return twin === undefined || twin === ir.tool ? ir : { ...ir, tool: twin };
  };
  return { ...plan, perSetup: plan.perSetup.map((setup) => ({ ...setup, programs: setup.programs.map(rebind) })) };
}

/** #1134 — the handoffs `planTwoOutcomes` accepts. */
export interface TwoPlanOptions {
  /**
   * THE PICK'S MEASURED OWNED PLAN (#1134). The smart pick fully evaluates its finalists with
   * `engraveGenerate`; the winning evaluation's plan IS the cut's owned plan, so the cut hands it
   * through here and the owned half is not planned a second time. The reused plan was computed
   * from the same input this call builds (the pick's own evaluation plans the owned half with the
   * catalogue CONFIGURED — see `EngraveGenerateOptions.ownedOnly` — so the statements match too).
   * `null`/absent: plan it here as before.
   */
  reusedOwned?: ModelPlanOutput | null;
  /**
   * THE OWNED HALF ONLY (#1134). The pick's full evaluation needs a real plan, but not the ideal
   * comparison; skipping the ideal keeps each finalist at one plan's cost while the catalogue stays
   * CONFIGURED in the input, so the plan a finalist stores is the plan the cut would have planned.
   */
  ownedOnly?: boolean;
}

/**
 * Run the cost-ranked plan twice — owned and ideal — and return both.
 *
 * The owned run gets `cutters.house` exactly as the caller supplied it (pinned keys included: the
 * operator's pin is honoured in the plan that will be cut). The ideal run gets the union of the
 * owned set and the catalogue, with the pin DROPPED: the ideal answers "what would the best
 * available bit do", not "what would the operator's pin do".
 */
export async function planTwoOutcomes(
  input: ModelPlanInput,
  opts: PlanModelCamOptions = {},
  two: TwoPlanOptions = {},
): Promise<TwoPlanOutput> {
  const reused = two.reusedOwned === undefined || two.reusedOwned === null
    ? null
    : rebindToolsToHouse(two.reusedOwned, input.cutters.house);
  const owned = reused ?? await planOwnedOnly(input, opts);
  // #1258 — a plan that asked has no programs; the ideal would ask the same question.
  if (owned.tabChoiceNeeded !== undefined) return { owned, ideal: null, defaultPlan: 'owned' };
  if (two.ownedOnly === true) return { owned, ideal: null, defaultPlan: 'owned' };
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
 *
 * #1028 — THE LADDER IS THE OWNED PLAN'S, AND ONLY WHEN NOTHING ELSE ANSWERS. A catalogue ball
 * the caller carries is the enriched reference's own answer (`enrichOwnedRestStatement`), so the
 * ladder would be a second, virtual answer beside it; the owned plan measures the rungs only
 * when the catalogue carries no ball at all.
 */
export async function planOwnedOnly(input: ModelPlanInput, opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  const catalogueHasBall = input.cutters.catalogue.some((tool) => tool.shape === 'ball');
  return planModelCam(
    {
      ...input,
      cutters: { house: input.cutters.house, catalogue: [], ...(input.cutters.pinned === undefined ? {} : { pinned: input.cutters.pinned }) },
      // #1027 (E's review) — the catalogue is emptied above so the owned plan cannot see it; the
      // rest statement still has to tell "none configured" from "configured, none measured".
      catalogueConfigured: input.catalogueConfigured ?? input.cutters.catalogue.length > 0,
    },
    // #1052 — the trace's plan:start row names which of the two runs it is (6b's round).
    // #1028 — and the ladder is the OWNED run's, only when the catalogue carries no ball for the
    // enriched reference to measure; the ideal is never re-planned with it (#1151's deferral).
    { ...opts, planKind: 'owned', restLadder: opts.restLadder === true && !catalogueHasBall },
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
    // #1052's plan kind, #1023's restatement rule and #1028's ladder: the ideal run has none of
    // the ladder — the owned plan is the only one that measures the virtual rungs.
    { ...opts, restStatement: false, planKind: 'ideal', restLadder: false },
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
