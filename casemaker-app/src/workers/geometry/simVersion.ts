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
// 3 — #948 judges goal cut-into on the page's own stamp; #924 judges the raw outline with the
//     cutter's own radius, at every level above the floor (one bump: no package between them).
// 4 — THE GOAL CHECK'S RULE, FROZEN FOR MILESTONE 2 (the maintainer's review §8.6, C9). The
//     rule as it lands (main's 4ba147e8 plus #964's fcad250d, one rule): the part's silhouette is
//     a design edge; the edge-break leg is inclusive; wall cells and the wall shadow are excluded
//     on every goal job; the raw reading prints beside the judged one; and the V GATE — the
//     stamp's stated tip (the 0.1 mm flat, never a sharp cone), the per-cell `who` map (lowest
//     reach wins, ties to the later stamp), and edge break excused only where the V bit is the
//     deepest cutter (a card passes the job's chamfer tool number; with no V there is no
//     allowance, stated). The rule's fingerprint is pinned in
//     `tests/unit/goalRuleFreeze948.spec.ts`: a later change to the rule fails there unless this
//     version is bumped and the cards are re-scored in the same commit.
export const SIMULATOR_VERSION = 4;
