/**
 * #673 — the inlay pair's one labelled default.
 *
 * It lives in its own leaf module (rather than in `inlay.ts`) so `partPlan.ts` can read it
 * without importing the derivation: since #742 `inlay.ts` imports `partPlan.ts`'s label outline,
 * and a shared constant between the two would be an import cycle. `inlay.ts` re-exports it, so
 * every existing importer keeps its path.
 */

/** The glue gap a new inlay half runs with when the operator states none, mm — labelled, not measured. */
export const DEFAULT_INLAY_GLUE_GAP_MM = 0.2;
