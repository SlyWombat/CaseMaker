/**
 * #961/#975 — THE OWNED-VERSUS-IDEAL TRADEOFF (#975, `docs/design/cam-model-engine.md` §4).
 *
 * The rule and its one materiality constant now live in `src` — the app's job card prints the line
 * and reads `PLAN_MATERIALITY` from there (#961's wiring) — so this module is a RE-EXPORT, kept so
 * the acceptance cards and the plan specs keep importing the tradeoff from where they always have.
 * There is exactly one definition, in `@/engine/cnc/cam/model/tradeoff`; do not add one here.
 *
 * The inputs are the two SCORED sides, structurally: the tests pass `ProgramScore`/
 * `SevenLineCard` and the app passes its own outcome shape, and both satisfy the src types without
 * either importing the other.
 */

export {
  PLAN_MATERIALITY,
  comparePlanOutcomes,
  idealWorsenings,
  type OutcomeWorsening,
  type PlanOutcomeScore,
  type PlanTradeoff,
  type PlanTradeoffSide,
  type PlanVerdictLine,
  type PlanVerdicts,
  type TradeoffBound,
  type TradeoffDifference,
} from '@/engine/cnc/cam/model/tradeoff';
