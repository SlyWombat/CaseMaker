/**
 * #925 — a frozen package's own key must go stale when the simulator itself changes, not only when
 * the job does: a package frozen under a bug in any part of the gate's verdict reads "current"
 * forever once the bug is fixed, because the bytes and inputs it was frozen from never moved.
 *
 * BUMP THIS, IN THE SAME COMMIT, for any change to `sweep.ts`, `columnEngine.ts`, `oracle.ts` or
 * `verify.ts` that can alter a verdict — a new check, a changed tolerance or band, a fixed false
 * pass/fail, a changed severity. Do NOT bump it for a change that cannot move a verdict (comments,
 * refactors, perf, a rename).
 *
 * `src/engine/cnc/engrave/package.ts` folds this into `packageHash` and `packageStaleness`; a
 * package that cannot show a version at all (frozen before this existed) is stale too, by the
 * same statement — see that file's header comment on `packageStaleness`.
 */
// 1 — #925 introduced the version.
// 2 — #947 opens boundary slivers before counting; #924 folds the design check into `ok`.
export const SIMULATOR_VERSION = 2;
