# Review B — #921 golden, #922 one pipeline, #945/#946 goal CAM (origin/main 829708cc, 2026-11-03)

Read-only review. Every spec run below was on a `git archive origin/main` copy under
`scratchpad/review-B/wt/` with `~/projects/CaseMaker/casemaker-app/node_modules` symlinked; a second
copy of `bab37c2c` (emitter fix in, guard fix out) under `wt-pre/`. Nothing in the repo was touched.

## Findings, severity-ranked

### F1 — HIGH — 218b59e2: the overcut guard still misses an interior dip; no test pins its search
`casemaker-app/src/engine/cnc/cam/surface3d.ts:1761-1832` (planGoalOvercut → stampSegment).
Candidates are derived from the POINT-centre distance (`C = px²+py²−r²`, the two roots where
d_point = r, and the closed-form ball minimum about t0), but a candidate is *admitted* by the
SQUARE distance (`cellSquareDistance` ≤ r − skin, line 1787). pitch/2 = 0.05 mm > skin = 0.01 mm, so
the admissible span of a segment extends 0.04 mm beyond every point-centre root — 40 % of a 0.1 mm
column step. The comment at :1772 ("`skin` already absorbs the pitch/2 square correction") is false.

Reproduced with a scratch spec (`scratchpad/review-B/reviewGuard945.spec.ts`): a step goal (plateau
z = 0, floor z = −10, vertical wall), ⌀2 ball, `finishTipField` at 0.1 mm. Steepest tip pair on the
row: (11.00, −0.688) → (11.10, −10.000), slope 93. Both endpoints alone: `worstMm 0` (each is its
own drop-cutter tip). The single diagonal between them, brute-forced over t with the guard's OWN
model (square distance, `ballRise`, linear z): **worst gouge 3.545 mm at cell (10.00, 10.00)**.
`planGoalOvercut` on the same segment: **`{worstMm: 0, cells: 0}`** — on main 829708cc AND on
bab37c2c (pre-guard-fix). Every candidate collapses to t = 0 for this geometry (t0 raw = −10 →
clamp 0; the point roots are tLo = −20, tHi = 0; the closed-form interior root lands at exactly 0),
while the square-admissible interval is t ∈ [0, 0.4].

Failure scenario: any emitter that still posts a steep diagonal (the rest pass's own joins, a future
regression of `staircaseCorner`, rough3d) gouges a wall foot by millimetres and the plan is posted
with no `goal-overcut` finding — exactly the 2026-11-02 class, still open for a vertical wall.
Test gap: the only positive guard test is `tests/unit/surface3d.spec.ts:647-663` (a raster held at
−2 across the goal: endpoints below the goal, trivially caught). The new #945 cases
(`surface3d.spec.ts:698-721`, `goalCorpus873.spec.ts:280-331`) assert `worstMm 0` after the
staircase, so they cannot fail on a guard regression; 218b59e2's own message says the guard change
"changes nothing observable". Fix shape: also consider the roots of d_square(t) = r − skin (or
widen the point roots by (pitch/2 − skin)/|dxy|), and add a red-first unit case with a hand-built
steep segment whose endpoints are safe (the scratch spec above is one).

### F2 — HIGH — #922: "one shop builder" is not called by the app; the identity spec compares the CLI to a COPY of the app
`casemaker-app/src/engine/cnc/engrave/feeds.ts:132-163` (`engraveShopOpts`) is called only from
`scripts/lib/casemaker/engrave.ts:552`. The app's Generate still builds its own literal at
`src/store/engraveRunStore.ts:482-496` (plus `mount`, `bed`, `surface`); the identity spec builds a
third hand copy, `appShop()` at `tests/unit/pipelineIdentity.spec.ts:133-150`, and drives
`engraveGenerate` with it (:219-227) — not the store. So the spec proves "CLI == a transcription of
the store", not "CLI == the app": a field added to or changed in `engraveRunStore.ts` passes the
spec and diverges in production; `engraveShopOpts`'s doc comment names the SPEC as its reference.
Acknowledged on #922 as a follow-up ("the store calling engraveShopOpts (B, after #945's first
slice)"), but the issue was closed code-complete with this open. The j13 symptom is fixed (see Q2).

### F3 — MEDIUM — the cutter PICK is still two implementations on main; 3 of 5 sample jobs pick different cutters per door
`scripts/lib/casemaker/engrave.ts:1500` (three-argument `candidatePlans`), `:1539` and `:1690`
(CLI's own `evaluatePlan`/`smartPick` with `pickShop`, 9c2cd88f) vs the worker's `runSmartPick`
(`src/workers/sim/smartPickRun.ts:100`, used by `sim.worker.ts:255`). #922's thread (identity-samples
ce6c15c2) records 936 (flat-1.0 vs ⌀0.1 60° V), 940 (25 vs 42 mm o-flute), 941 (o-flute vs
flat-3.175x12) picking differently; the fix (1d534542, `pickForEngrave`) is on a branch that is not
on origin (`git branch -r` shows no identity-samples). 9c2cd88f's `finish: undefined` mirrors
`engravePreviewStore.previewInputs()` by hand — parity by duplication, and its message admits it is
not regression-testable with committed fixtures. Also acknowledged and parked: the CLI never builds
`mount`/`bed`, so `casemaker cut` runs no bracket-clamp/jaw obstacle check the app runs.

### F4 — MEDIUM — #945's acceptance is judged by the guard that was the blind spot, not by the independent oracle
`goalCorpus873.spec.ts:329-330` and `surface3d.spec.ts:719-720` assert "no `goal-overcut` finding"
/ `planGoalOvercut == 0`. The independent judges that found the defect (`tools/goal_check.py`,
#924's `checkGoalCutInto` on the column-engine field) are not in any test. Per "the oracle judges
the end state", the stick-scale figure case should be swept and measured (`createSimSession.load`
→ `checkGoalCutInto`), as the `#873 … generated, swept, and measured` block already does for other
cases. B's own #946 note reports "small nonzero cut-into readings even post-#945-fix" on that path
and set it aside as harness wiring — unresolved.

### F5 — MEDIUM — the pass line was reinterpreted (coverage = TOP-surface) by the manager, not put to the maintainer; the coverage diagnosis rests on proxy numbers and has already been withdrawn once
#945 thread 2026-11-03 ~08:30: "Pass line clarified: coverage ≥ 95 % is the top-surface coverage"
(cards: elephant 82.72 % top / 32 % whole; panther 82.56 % / 39 %). That is a milestone acceptance
decision; it was not filed as a question with a default to the maintainer (the maintainer's
own words in the review doc are "coverage ≥95 % with the remainder named"). B's diagnosis moved
three times in one day: (1) 94.5 % closable by step-over → candidate cfc1241a moved coverage
−0.01 %, not landed; (2) "beyond any top-side cutter → #914" → withdrawn (beyondReach read as
idealLeftover); (3) the rest pass's step-over (`engraveGenerate.ts:5419`) ignores
`finishStepOverForCusp()` — "~82 % of the 14.34 % gap". (3) has numbers, but all from figure.stl at
j29's placement; the real-mesh evidence is only the card, and no card yet confirms (3). The whole-
surface 32/39 % numbers mean the elephant and panther are 2/3 un-reproduced from one setup, which is
what the maintainer's "flat underside / tabs or quarter turns" clause is about.

### F6 — LOW/MEDIUM — the golden's byte pin includes the `;@MKR|TIME` estimate, so time-model work forces regeneration of the "frozen bytes"
`tests/unit/engraveGolden.spec.ts:219-220` hashes the whole text. c64e1236 (#927) moved all three
.nc hashes with "the only line that differs is TIME" (byte counts 129956/110997/207926 unchanged
— consistent, not independently re-generated here). Golden fixtures were touched 5 times in ~9 h
(562141d2 17:04 create; 72430bd0 17:30 run sheets, #926; c64e1236 18:01 .nc + sheets, #927;
6a6546ea 23:25 oracle.json +`sliverWidthMm`, #947; b5bab13d 01:56 run sheets' band block, #947).
Only c64e1236 moved .nc bytes; every regeneration carries a review note naming what moved and
why; stat lines agree with the notes. Suggest pinning the program with the TIME record stripped
plus TIME as its own number so the byte pin means CAM/post only.

### F7 — LOW — ac81676d: timeouts 2.5–3.3× with no measurement; messages cite SHAs that do not exist on main
`flipMouldShell.acceptance.spec.ts:317` 120 → 300 s; `goalReach.spec.ts:345,405` 120 → 400 s,
justified only as "costs real wall time" (the guard now tries ≥5 candidates per cell). No before/
after seconds are given. The two re-pins are explained and plausible (goalRoughSplit869 hash
aa35ab5a → da7e66c7 "staircase on a slope>1 pair"; stepAccuracy873 sharedUnique 9735 → 9407,
identicalZ 1075 → 747 with moves/maxDz/overBar unchanged). ac81676d, 9c2cd88f, 1b80e0c2, f83084ad
reference c4ef03e7/22b5c374/49b1ff2e/f67b3d9b — pre-rebase SHAs not resolvable on main.

### F8 — LOW — the staircase's vertical leg is a full-depth plunge at `feeds.feed`
`surface3d.ts:2300-2312` + :2365-2366, :2793-2796, :3105-3107: the "straight down" leg (up to ~11 mm
in the j29 segment) is emitted with `feeds.feed`, not `feeds.plungeFeed`. The old diagonal was
also near-vertical at feed, so not a regression, but the fix makes it an exact plunge.

### F9 — LOW — ownership declarations
B edited E's `scripts/lib/casemaker/engrave.ts` (ef34d10e, 9c2cd88f; marching orders line 50 gives
`scripts/**` to E, line 30 gives B "the CLI's engine seam" — ambiguous) without an "E's file" note
(contrast e39f4889 "(#924, B's file)"). B unskipped F's spec (4be2584d, granted). C regenerated F's
goldens (72430bd0, c64e1236) "per the manager's instruction", with notes. f83084ad/dbca7171 edit
E's job files with fixture-correction notes. No commit message quotes a T1/T1-lite line; hand-over
lines live on the issues (#922: "6 failed | 688 passed … identical to vanilla main's 7 pre-existing";
#945: "full vitest is flaky on this box, not clean — noted rather than claimed clean"). Tests: the
#922 stack added no unit test of its own for `engraveShopOpts`/`installLocationFeedsTable`/the
null-install (c1327600) — the acceptance is F's spec; 218b59e2 added none (F1).

### F10 — INFO — #949 and #950
#949 (11-03 14:31, bug): an oversized goal clipped to the stock runs its ⌀1 finish along the stock
edge under the jaws; found by #923's new column-engine fixture check — the clipping is pre-existing
CAM behaviour newly DETECTED, not a regression of this wave. Its comment adds a pre-existing UI gap:
`generated.errors` from a CAM-stage refusal never reaches the panel's run-error line ("Not
generated."). #950 (11-03 18:51): `withOwnDesignItems` (`engraveGenerate.ts:7284-7286` on main) hands
every design item to program 0 — new code from this wave's #924 stack (e39f4889/1fc73baa); latent
(no failing case on main), a wave-introduced defect class, T2 scope.

## Answers to the seven questions

**Q1 #921.** Pinned per case under `tests/unit/fixtures/golden/<case>/`: `program.nc.sha256` (sha256 +
byte count of the posted text), `verifier.json` (`EngraveGenerated.verify`), `oracle.json` (work
frame; surface frame against the 10-24 run-6 plane for the badge only, `surface: null` otherwise),
`run-sheet.md` (`buildRunSheet` + `renderRunSheetMarkdown` at a pinned clock 2026-11-02T12:00Z,
now built with the work oracle's band/sliver — b5bab13d). Regeneration only via
`CASEMAKER_UPDATE_GOLDEN=1` (spec :70, :194-200); no CLI `--update`. Regenerations and .nc movement:
see F6 — five touches, one .nc move (c64e1236, TIME-only, deliberate and named), all with notes.
Golden freezes the code's defaults (no location), so k3's measured laminate row is not covered —
stated in the spec header and on the issue.

**Q2 #922.** Yes — `pipelineIdentity.spec.ts:233` compares `worker.nc !== cli.nc` as full strings for
badge, j16, j13 (CLI via `engraveJobMain` and its receipt; worker via `engraveGenerate`). j13 is
green: 3/3 passed, 11.8 s. Root cause: options construction, not CAM — the CLI's shop literal
carried only tools/drill/rest so `finish.stockToLeaveMm` (and feeds/defaults/…) fell to fallbacks;
the committed fixtures reproduce the finish split (52194 vs 56071 lines); the bench's 10000/F1000
vs 12000/F500 needs k3's PLA rows (not committed) and is the same class plus the headless bootstrap
never installing the location's `feeds` table (832dc5ac). The shared functions are
`engraveFeedsFor`, `installLocationFeedsTable`, `shopFeedsTable`, `engraveShopOpts`
(`src/engine/cnc/engrave/feeds.ts`). Both doors call `engraveFeedsFor` (14 worker sites + 3 CLI
sites). Only the CLI calls `engraveShopOpts` (F2). Remaining second paths: F2, F3, mount/bed.

**Q3 #945.** Guard: NO for a vertical wall (F1, reproduced). bab37c2c: `staircaseCorner` emits a
corner at the higher Z when |Δz| > lateral, in raster/scallop/pencil; evidence (issue thread):
figure.stl at j29 — goal_check.py 8 cells/1.288 mm and checkGoalCutInto ~5 cells/1.131 mm → 0/0
after; the real cards: elephant 1.3 %/6.657 mm → 0, panther 1.01 %/12.795 mm → 0; time +0.01 %,
cutting moves +8.3 %. ac81676d: re-pins explained (F7); timeouts +150–233 % with no numbers (F7).

**Q4.** See F5. Diagnosis (3) is numeric but proxy-only and unconfirmed by a card; the top-vs-whole
question was decided by the manager, not filed to the maintainer with a default.

**Q5.** See F10.

**Q6.** See F9.

**Q7 runs** (scratch copy of origin/main): `engraveGolden.spec.ts` 3 passed, 5.1 s;
`pipelineIdentity.spec.ts` 3 passed, 11.8 s; `surface3d.spec.ts -t "909|945"` 2 passed;
scratch `reviewGuard945.spec.ts` FAILS on main and on bab37c2c (guard 0 vs 3.545 mm brute force).
Logs: `scratchpad/review-B/run-*.log`.
