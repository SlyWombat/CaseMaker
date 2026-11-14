/**
 * #1207 — THE GOAL HEIGHTFIELD'S CELL CAP, in one import-free module.
 *
 * The value the goal sampler, the rotary field and the primitive surface run on when a caller
 * states no cap — the labelled fallback of the shop's `goal.maxCells` (#1256). Callers at the realm
 * edge read the key and pass it as `maxCells`; the samplers cannot read it themselves, because the
 * gate's value-import closures stay CAM-free and defaults-free (#964). The goal CHECK's own, higher
 * cap (`GOAL_CHECK_MAX_CELLS`) is a gate rule and is not this key. Keeping the cap here, with no imports, leaves those closures clean.
 */
export const GOAL_MAX_CELLS = 4_000_000;
