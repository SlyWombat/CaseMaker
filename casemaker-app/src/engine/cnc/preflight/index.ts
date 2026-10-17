/**
 * The preflight gate (#419 §2.2): the row shape, and the collector that fills it from the owners
 * that already compute every check.
 *
 * See `collect.ts` for the one rule this directory enforces — preflight adds no rule of its own — for
 * the two worker-bound owners (the reach table arrives as data, the geometry findings on the
 * Generate's result), and for the scope `collect()` answers: ONE setup and tool, which the hub loops
 * over `(setupIndex, tool)` and aggregates.
 */

export { collect } from './collect';
export type { PreflightInput } from './collect';
export type { PreflightCause, PreflightOwner, PreflightRow, PreflightSeverity } from './types';
