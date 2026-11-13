/**
 * #1207 — THE GOAL HEIGHTFIELD'S LABELLED FALLBACK, in one import-free module.
 *
 * `goal.maxCells`'s recommendation, and the value the goal sampler, the rotary field and the
 * primitive surface run on when a caller states no cap. It equals the registry key (the limits
 * gate asserts it). Keeping it here, with no imports, lets those modules state the cap WITHOUT
 * importing `platform/defaultsClient` — whose own imports reach CAM — into the gate's value-import
 * closures (#964: goalCheckField, designCheck and goalHeightfield must carry no CAM).
 */
export const GOAL_MAX_CELLS_FALLBACK = 4_000_000;
