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
// 5 — #970/v5 (the maintainer's ruling, 2026-11-05): THE WALL-SHADOW CELL IS EXCUSED ONLY WHEN
//     THE STAMP PROVES IT IS A DISC ARTEFACT. A cell within the shadow radius of a design wall
//     used to be excluded blanket-style; now it is excused only if (a) the V cut it and its cut is
//     no deeper than the edge-break leg, or (b) the deepest cutter's own CL point stays at least
//     the shadow radius from the wall (the cell sits at the disc's rim, not under the tool).
//     Everything else — a cutter's CL driven INTO the wall's base, as the tray's V was at
//     (19.800, 12.050, -4.692), 3.49 mm into the land — is ADJUDICATED. The stamp now carries
//     the per-cell CL point (`StampedTop.clX/clY`) and the check reads it via `clAt`. The rule's
//     fingerprint is re-pinned in `tests/unit/goalRuleFreeze948.spec.ts`; the cards are re-scored
//     in the same commit.
// v6 (#996) — THE STRADDLING-CELL EXCUSE, ON PROOF. A cut-into cell whose centre sits on a
// vertical step reads the step's high side while the cutter correctly stops at the step; it is now
// excused when the step over the cell (centre + four corners) is at least as tall as the read
// intrusion and the swept floor is no more than 0.005 mm below the design's low side over the cell
// — nothing cut that the design keeps. Excused cells are counted and their tallest step printed
// (`straddlingNotScoredCells` / `straddlingMaxStepMm`), never silent. A one-cell gouge on flat
// ground (step 0) can never qualify. The rule's fingerprint gains the two constants in
// `tests/unit/goalRuleFreeze948.spec.ts`; the cards are re-scored in the same commit.
//
// v7 (#1064) — THE EDGE-BREAK BAND SEEDS ONLY FROM THE EDGES THE JOB NAMED. The job's edge-break
// statement gains `edges: 'silhouette' | 'all'` (absent = silhouette, the part's own outline);
// `all` is the pre-v7 reading (every design wall, interior pocket lips included). A stated rim
// chamfer no longer excuses a V floor pocket's lip at an interior wall unless the job said `all`.
// The canonical fingerprint keeps its numbers under an explicit `all`; the new default is pinned
// beside it. The cards carrying this rule's numbers are re-scored in the same commit.
export const SIMULATOR_VERSION = 7;
