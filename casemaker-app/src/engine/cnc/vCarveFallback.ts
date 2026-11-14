/**
 * The V-carve step-over's labelled fallback — a LEAF module (it imports nothing).
 *
 * It lives here, not in `vCarveGeometry.ts`, because `feeds.ts` reads it at module load for the V
 * rows of its static table, and `vCarveGeometry` imports `defaultsClient`, whose graph reaches back
 * to `feeds.ts`. Entered from `feeds.ts` first (the order a spec that imports only the indexed CAM
 * gets) that cycle read the constant before it was initialised. `vCarveGeometry` re-exports it, so
 * every other importer is unchanged.
 */

/** The V-carve step-over at its recommendation: the static feed table's labelled fallback (the
 *  registry owns the value; `vcarve.stepoverRatio`'s recommendation equals this). */
export const V_CARVE_STEPOVER_FALLBACK = 0.6;
