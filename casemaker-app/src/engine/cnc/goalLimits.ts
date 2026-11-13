/**
 * #1207 — THE GOAL HEIGHTFIELD'S CELL CAP, in one import-free module.
 *
 * The value the goal sampler, the rotary field and the primitive surface run on when a caller
 * states no cap. `goal.maxCells` was WITHDRAWN from this landing: wiring it needs the shop's value
 * threaded through four sampling callers and the goal-check request, more than one parameter each
 * (the analyst's 2026-11-13 ruling), so follow-up #1256 — wire `goal.maxCells` from the
 * realm edge — owns it. Keeping the cap here, with no imports, leaves the gate's value-import closures CAM-free
 * (#964).
 */
export const GOAL_MAX_CELLS = 4_000_000;
