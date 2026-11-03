# Review A — #924 / #947 / #925 / #928 on origin/main 829708cc (read-only, 2026-11-03)

Scope: the 16 commits named in the brief, read hunk by hunk; issue threads #924/#947/#925/#928/#948; the
specs they add, run from a `git archive origin/main` copy (casemaker-app + docs + samples) with
`~/projects/CaseMaker/casemaker-app/node_modules` symlinked (vitest 4.1.5 = lockfile). Nothing was checked
out, edited or run against k3/the machine. Line numbers are against origin/main unless a sha is given.

## Findings, by severity

### BLOCKER

**B1. The "independent design-side oracle" is built from the CAM's own opened region and the CAM's own
radius — it is not independent of the CAM.** (554b0f67, e39f4889)

- The "raw design" handed to the check is `designOf(e)` (e39f4889, `engraveGenerate.ts:2536`). `designOf`
  returns `byId.get(engrave.id)?.polygons` (`engraveGenerate.ts:2129-2148`), where `byId` is the
  measurement map (`:2122`), and `LabelEngravability.polygons` is documented and built as **"The opened
  region as plain polygons … what #172 pockets"** = `executeProfile(tl, engravableProfile(profile,
  itemRadius))` (`src/workers/sim/engraveGeometry.ts:91-92, 104-107`). `engravableProfile` is the
  morphological opening `offset(offset(G, −r), +r)` (`engravable.ts:7-10`). The check never sees the
  glyph `G`; it sees the CAM's prediction of what the cutter reaches.
- The per-item `r` is `vCarve.planeRadius` for a V item (`engraveGenerate.ts:2537`), which is
  `cone.tipRadius + belowPlane·cone.tanHalf` from `vCarvePlane` (`vCarveGeometry.ts:200-236`) — the CAM's
  own cone (`VCone` from `vProfile.ts`, the same object `grooveRadiusAt` reads). The commit message's
  description ("the cone's radius at THIS item's top surface — the widest it gets") is wrong:
  `planeRadius` is the half-width at the **colour plane**; the top-face radius is `planeRadius +
  surfaceOutset`. On a no-film blank (the hardwood stick, every Milestone-1 sample) `belowPlane = 0`, so
  `r = tipRadius`.
- Net effect: `reachable = erode(opening(G, r), r)` and `grown = dilate(opening(G, r), r + band)`, both
  through the same Clipper2 `CrossSection.offset` the CAM uses, with the CAM's `r`. Simulation.md §7
  (`Simulation.md:556-575`) asks for the opposite — "sample points of the raw glyph whose distance to its
  boundary is ≥ r — by point-in-polygon on the original outline, **not by offsetting**" — because "a
  wrong r shared by #171, #172 and #182, a glyph-outline bug, or a Clipper2 offset bug is invisible". All
  three remain invisible to `checkDesignReach`. Gate statement 5 ("computed from the raw design, not the
  CAM's offsets or cone") is not met; WP-4's acceptance ("#741's false pass would have been caught") is not
  demonstrated (B2).
- Failure scenario: `vCarvePlane` returns a `planeRadius` 30 % too large → the CAM's opening, the CAM's
  rings, the oracle prediction AND the design check's `reachable`/`grown` all move together → four green
  ticks, letters under-cut on the part.

**B2. For a V item the check reads one slice at the floor, where #741's defect does not live.**
(554b0f67 `designCheck.ts` `sliceAt(z + 0.001)` with `z = -item.depth`; e39f4889 `depth = clampToCone ?
floor + vLimit.limitMm : e.depth`)

- #741 was the V **flank** widening past the shank — excess width between the floor and the top face.
  `checkDesignReach` compares only `sliceAt(-depth + 0.001)`: just above the floor the groove is the tip
  trace, always inside `dilate(design, planeRadius + band)`. Nothing between floor and top is looked at,
  so a widened flank passes.
- The two "#741 class" tests do not model #741: `designCheck924.spec.ts:66-82` uses `r = 0.05` (tip
  radius) with a 0.1 mm-wide "design" — a configuration the live wiring never produces (live `r` is
  `planeRadius`, the design is the opening); `designCheckActivation924.spec.ts:91-123` dilates the
  **floor** slice uniformly by `r + 1 mm`. Any check catches a 1 mm uniform dilation.
- Failure scenario: the exact #741 engine bug re-introduced → `designCheck.ok = true` on the badge.

**B3. origin/main is red on two Playwright specs because of this stack; the fix-forward is not landed.**
(e39f4889 + 09a23cdd + 1fc73baa)

- #924 thread (manager, 10:15/10:20): `tests/e2e/engrave.spec.ts:180` (the built-in default job: three
  labels + a hole) reads "does not match the design" — `designCheck.ok = false`, MAKER label at z −1,
  `tooFar = 0.3905 mm²`, bbox `[49.9977, 29.5]–[50.5, 30.5]`: the ⌀1 hole at (50, 30) inside the label's
  `LOCAL_SLICE_PAD_MM = 1` clip box (09a23cdd `designCheck.ts:67,187-197`). `pcbTwoSided.spec.ts:19`
  times out (every isolation frame became a V design item; per-item offsets stall Generate — hotfix
  message 7f5a88af). Both were green on ac81676d.
- The clip (09a23cdd) is a heuristic: any removal from another feature within `r + band + 1 mm` of an
  item's grown bbox is charged to that item (drill discs, cut-out kerfs, a deeper neighbour). Its own
  justification ("text/shapes are laid out with real gaps") is the assumption the default job broke.
  `cand/924-hotfix` 7f5a88af (not on origin/main) subtracts other items' allowances and adds `allowOnly`
  drill/cut-out items — a third model of the same question in 12 hours.
- Failure scenario (today, origin/main): a user adds a hole next to a label → Cut card "did not pass" with
  under/over-cut 0/0 and no sentence naming why (M3).

### MAJOR

**M1. `SIMULATOR_VERSION` was not bumped for two verdict-moving changes landed hours after the rule was
written.** (a18add37 vs ba6f6fda, 554b0f67/1fc73baa)

- `simVersion.ts:15` is still `1`. Its header: "BUMP THIS, IN THE SAME COMMIT, for any change to
  `sweep.ts`, `columnEngine.ts`, `oracle.ts` … pass/fail". a18add37 landed 20:24; ba6f6fda (oracle.ts
  verdict loosened by the sliver open) 23:24 and 554b0f67/1fc73baa (design check folded into `ok`) 23:42 /
  next morning — same session, no bump. `git log a18add37..origin/main -- oracle.ts session.ts
  designCheck.ts` lists five commits; `simVersion.ts` has one.
- Failure scenario: a package frozen 11-02 21:00 (pre-sliver, pre-design-check) reads "current" on
  today's build; gate statement 10 is nominally met, practically not.

**M2. Gate statement 7 ("sliver width printed") is not met live: `combineOracles` drops
`sliverWidthMm`, `designCheck` and `goalCutInto`.** (a79aa8b4, b5bab13d, bd1c2b3f)

- The store sets `run.oracle = combineOracles(...)` (`engraveRunStore.ts:1011,1018`). `combineOracles`
  builds a fresh object carrying only `ok/band/levels/worst/areaFloor/frame/copper`
  (`engraveRunStore.ts:235-257`). Both readers — `SimPanel.tsx:310` and `EngravePanel.tsx:2612` — read
  `run.oracle?.sliverWidthMm`, so the field is always `undefined` live; the "Boundary slivers under
  0.01 mm are not counted" sentence never renders in the panel or the run sheet. The unit tests
  (`simPanel.spec.tsx:753`, `runSheet.spec.ts:2403`) set the field on the store by hand; the golden
  (b5bab13d `engraveGolden.spec.ts:178-185`) hands the **raw** work-frame report to the sheet, not the
  combined one. No e2e asserts the sentence (`git grep 'Boundary slivers' tests/e2e` → nothing). The same
  drop hides the design check's numbers (#924 thread 10:20: "the combined report drops the field").
- Failure scenario: the operator's run sheet says band 0.089 mm and nothing about the 0.01 mm the verdict
  also ignored; the maintainer's #947 instruction "state the rule and the resolution on the report" is
  met in the type and the fixture, not on the door.

**M3. The design check's verdict reaches the UI only as an unexplained cross.** (1fc73baa, 7882c37d)

- `designCheck.ok` folds into `report.ok` (554b0f67 `session.ts` `withDesignChecks`), `combineOracles`
  propagates `ok` but not the field (M2), `cutVerdict` reads `oracleOk` (7882c37d
  `EngraveCutSurface.tsx:405`). The failing run's sentence names `worst.underCut/overCut` (0/0 in the
  engrave.spec:180 case). 7882c37d's title says "the design check's severity decides the Cut verdict" but
  its hunk routes the **sweep's** diagnostics (`simErrors(runSimDiagnostics)`), not the design check; the
  design check has no severity term anywhere in the UI.

**M4. Gate statement 6 (volume agreement) is not a check — nothing in production calls it.** (554b0f67)

- `checkVolumeAgreement`, `flatCapsuleVolumeMm3`, `vGrooveVolumeMm3` have zero callers under `src/`
  (`git grep` → only `designCheck.ts` and the spec). The "#741 regression" tests
  (`designCheck924.spec.ts:152-170`) feed two hand-typed numbers from the issue (1431 vs 971) and assert
  47 % > 2 % — arithmetic on literals, not a pipeline result. The quadrature tests fairly check the closed
  forms, but the closed forms are never applied to a swept volume.
- Failure scenario: #741 recurs; no volume is measured; nothing fires.

**M5. The 3D half (goal cut-into) is not in-app on origin/main.** (554b0f67, 285d0c25)

- `checkGoalCutInto` is called only inside `withDesignChecks` when `goal !== undefined`
  (`session.ts:1186`); both live callers pass three arguments (`sim.worker.ts:310`,
  `planEvaluate.ts:678`); no `sweptTop` sampler exists on main. 285d0c25 says so. #948 (C's
  `948-goal-check`/`948-coverage`, not landed) builds the sampler; A's own review there records the open
  gaps: a one-column (0.1 mm) gouge is invisible to the "highest touching column" read; `ran:false` still
  shows four green ticks; the 95 % pass line folds into `ok` and will move any goal fixture. Until #948
  lands, #945/#946's pass criteria are read only by the demo page.

**M6. `ORACLE_SLIVER_WIDTH_MM = 0.01` has no margin and double-counts a tolerance already in the band.**
(ba6f6fda)

- Experiment (scratch copy, `oracle.ts:376` set to `1 × ARC_CHORD_TOLERANCE_MM` = 0.005, reverted): ⌀3.0
  and ⌀3.175 in `oracleSliver947.spec.ts` **fail**; at 0.01 they pass. The sliver's widest part is
  5–10 µm after the band step, and the constant is the smallest named-tolerance multiple that passes — the
  "derived, not tuned" claim reads post hoc. The band already contains `2 × ARC_CHORD_TOLERANCE_MM`
  (`Simulation.md:586-592`); the open adds the same 2× again under a different rationale. The maintainer
  asked for "sub-cell" (#947 routing comment); 0.01 is sub-band (0.016), but the derivation should name
  the ring-vs-opening construction error or admit the constant is empirical.
- What is absorbed: after `−band/+band`, any disagreement region whose width is < 0.01 mm everywhere
  (erode 0.005 → dilate 0.005), on both sides, every level, exact AND flat-column paths (`computeOracle`
  is one loop, `oracle.ts:820-822`; a79aa8b4's "absent on the rotary/column-dexel path" is true only of
  the indexed-rotary function at `:1007`). Effective boundary tolerance becomes `band + 0.01` for uniform
  thin error. A missed stroke (≥ 0.4 mm) survives; a uniform 0.025 mm under-size does not register.
  Physically acceptable, but it changes the oracle's contract from "area" to "width", and the sheet does
  not say so live (M2).

**M7. #928's `routeEngine` is a mirror of the live rule, not the live rule.** (feeef973)

- `sweepsOnColumn` (`session.ts:445`, via `isVShape`, `vProfile.ts:63`) and `denseFlatRoutesToColumn`
  (`:468`) still exist and are exported; `programSweep.ts:277` documents against them. `routeEngine`
  re-states the predicate by hand (`routeEngine.ts:51-64`); the header says "a semantic change to either
  one has to land here too". No test feeds one real `Tool`/`Timeline` through both and asserts agreement,
  so the thing WP-8 was written against — a routing change that moves silently — now has two places to be
  wrong in. Today they agree (by reading: engraving, chamfer, drill, thread, ball, bull → column;
  tapered-ball/unknown → exact).
- Spec hygiene: 15 rows, not 14; the row named "a sparse flat job with no rotary and no prior — the
  ordinary case" has `hasPriorRemoval: true`. The V badge → column and flat badge → exact rows are present
  by name (`routeEngine.spec.ts:14-30`).

**M8. The golden run sheets now freeze a sentence the test did not earn.** (b5bab13d)

- `record()` builds the sheet with `{ diagnostics: [], oracleBand, sliverWidthMm }` and no engine; the
  frozen sheets gained "Checked: the tool against the stock and the modelled fixture (Vise fixed jaw…)"
  (e.g. `fixtures/golden/badge-2026-10-24/run-sheet.md:+9`) for the V badge, which runs on the column
  engine that WP-3 says never reads the fixture. "Built the way the app builds them" is overstated; the
  golden asserts a fixture check no sweep in the spec performed.

### MINOR

**m1. Tautological pass test.** `designCheck924.spec.ts:32-45` passes `design.offset(-r)` — the same
`CrossSection.offset` the check computes — as the "simulated" slice, after a header promising "never the
design's own eroded shape reused as if it were independent". A flat cutter removes the opening, not the
erosion; the test exercises neither.

**m2. Band mismatch in the design check.** `withDesignChecks` calls `checkDesignReach(..., {})`
(554b0f67 `session.ts`), so the band is the one-level default `0.012` (`designCheck.ts:118`) instead of
the sweep's own `band` (0.089 on the column goldens). The activation specs passed only because the V
items' loose `r` hides it; the hotfix (7f5a88af) names this as a cause of the engrave.spec:180 red.

**m3. Acceptance line not met.** #924 activation scope (manager 07:40): "the badge, the laminate and j13
pass through the real path". `designCheckActivation924.spec.ts` runs badge and 450-laminate only; j13 is
first exercised on `cand/924-hotfix`.

**m4. a79aa8b4 landed red on the golden.** The #947 thread records main red on `engraveGolden.spec` for
~3 minutes after a79aa8b4 until 6a6546ea. The commit message makes no golden claim.

**m5. Documentation drift.** e39f4889's `planeRadius` comment is wrong (B1). a79aa8b4/bd1c2b3f say the
open never runs on the column path; it does. 09a23cdd's "verified against the #741 regression numbers,
unaffected" refers to the volume literals, which the clip cannot affect.

**m6. Performance.** 285d0c25 admits `planEvaluate.ts:678` computes the design check per candidate and
discards it; e39f4889 builds one item per V region including PCB isolation nets (the pcbTwoSided
timeout). No cap, no budget line in the report.

### SOLID

- **#925 severity (a18add37):** `air-moves-unchecked` is `error` at both sites (`sweep.ts:1016`,
  `columnEngine.ts:2114`); `sweep-stalled` already `error` (`columnEngine.ts:2060`, `sweep.ts:1387`).
  Upload/verdict read severity, not code (`engraveRunGate.ts:148-150,173`; `simGate.ts:28`), so both
  block. cnc-guide ch.8 rows updated in both copies. `airMoveChecks858.spec` asserts codes only, so it
  stayed green honestly.
- **#925 version in hash (a18add37, f97fadd5):** `packageHash(jobHash, programs, simVersion?)`
  (`package.ts:200-204`); `frozenSimVersion` reads the version back by trial (`:214-220`);
  `packageStaleness` stales unversioned and other-version packages with distinct sentences
  (`:262-269`); `validatePackage` does not call a bump "tampered" (`:327-331`).
  `packageSimVersionStaleness925.spec.ts` mocks `SIMULATOR_VERSION = 2` and proves a v1 package reads
  stale and not tampered — a real bump test. f97fadd5's caller audit is explicit and correct.
- **Golden re-pin 6a6546ea:** exactly four `"sliverWidthMm": 0.01` lines across three `oracle.json`;
  no `.nc.sha256`, `verifier.json` or `run-sheet.md` moved (`git show --stat`). Justified by the new
  field alone; the message carries the review note.
- **b5bab13d's .nc claim:** the three `run-sheet.md` diffs are pure insertions; the header lines with
  `sha256 b99a38c8 / d3ab1a68 / c7cc29b8` are unchanged context.
- **Ownership:** e39f4889 ("B's file") titled as such and authorised on #924 ("A makes the additive
  hunk since B was away"); 285d0c25 names planEvaluate/sim.worker as unowned with authorisation;
  a79aa8b4 left D's/C's call sites unwired and said so; C and D wired them (b5bab13d, bd1c2b3f).
  c9ff666f and 1fc73baa fixed the tests tsc -b misses and said which. 829708cc is a two-line lint fix.
  Cross-column edits were declared and minimal.
- **`oracleSliver947.spec.ts`** runs the real `engraveGenerate → session.oracle` pipeline on C's
  reproduced job (⌀1/2/3/3.175) and a shifted program; not a tautology.
- **7882c37d** separates sweep errors from document/verifier errors and pins both directions.

## Spec runs (scratch copy of origin/main, vitest 4.1.5, each < 3 min)

| run | specs | result |
|---|---|---|
| 1 | routeEngine, packageSimVersionStaleness925, engravePackage, simCoverage, designCheck924 | 5 files, **77/77 pass** |
| 2 | oracleSliver947, designCheckActivation924 | **8/8 pass** |
| 3 | engraveGolden, engraveRunStore, cutSurface, simPanel, jobFile | 143 pass, 1 fail — `single-thin` ENOENT: archive lacked `samples/` |
| 4 | runSheet, jobPackageDocument, cncGuide | 126 pass, 2 skipped, 1 fail — ENOENT `docs/bench/165-depth-ladder-row-A.job.json` (same cause) |
| 5 | engraveGolden + runSheet after adding `docs/` + `samples/` from origin/main | **114 pass, 2 skipped, 0 fail** |
| exp | oracleSliver947 with `ORACLE_SLIVER_WIDTH_MM = 1 × ARC_CHORD_TOLERANCE_MM` (scratch edit, reverted) | ⌀3.0 and ⌀3.175 **fail**; 3 pass |

Every spec these commits added or changed passes on origin/main. The two Playwright reds
(`engrave.spec.ts:180`, `pcbTwoSided.spec.ts:19`) are recorded by the manager on #924 and were not
re-run here (no browser in the scratch copy).

## Answers to the eight questions

1. **Independent?** No. The region is `designOf(e)` = the measurement's `engravableProfile` opening
   (CAM); `r` = `vCarve.planeRadius` (CAM cone) or the tool radius; built with `CrossSection.offset`,
   which Simulation.md §7 names as the thing not to use. One slice at the floor, blind to #741's flank.
   Tautology: `designCheck924.spec.ts:32-45`; the volume "regression" is arithmetic on issue literals.
2. **Sliver:** opened at 0.01 mm (erode/dilate 0.005) on both sides, every level, exact and flat-column
   paths, after the band. Does not pass a stroke-sized under-cut; hides uniform thin error up to
   band + 0.01. Width = 2 × chord tolerance; half that fails the same job (no margin), and the band
   already contains that term. Printed on the type and the fixtures; **not printed live** (M2).
   Maintainer: "absorb sub-cell slivers (state the rule and the resolution on the report)".
3. **Goal cut-into:** generator-side only; no caller passes `goal`; #948 (unlanded) supplies the sampler,
   with a stated one-column blind spot and `ran:false` → four green ticks still open.
4. **#925:** errors on both engines, yes; version in hash, yes; a bump stales a frozen package, yes
   (mocked v2 spec). But the version was not bumped for ba6f6fda or the design-check fold.
5. **#928:** named function + 15-row frozen table with V badge → column and flat badge → exact by name;
   but a mirror of `sweepsOnColumn`/`denseFlatRoutesToColumn`, which still exist, with no agreement test.
6. **6a6546ea:** justified; four added lines; hashes/verifier/sheets untouched. b5bab13d's sheet re-pin
   also left the `.nc` sha lines unchanged.
7. **Ownership/tiers:** cross-column edits declared and authorised. Missing tests: severity assertions
   for the two flips; a live-UI test for the sliver sentence; a `routeEngine` vs `sweepsOnColumn`
   agreement test. Contradicted acceptance lines: #924 "j13 passes" (not in the spec); WP-4 "#741's false
   pass would have been caught" (not shown for the live wiring); gate 7 (not live).
8. **Runs:** above.

## Recommended order

1. Treat 7f5a88af as a stop-gap. File the real issue: `designItems.design` must be the glyph profile
   (`engrave.profile` → `executeProfile`), not `LabelEngravability.polygons`; `r` from the tool
   (`cuttingRadiusForSweep`, tip diameter, half-angle), not `vCarvePlane`; point-in-polygon sampling per
   Simulation.md §7; for a V item check the top-face slice too.
2. Bump `SIMULATOR_VERSION` to 2 now, naming ba6f6fda and the design-check fold.
3. Make `combineOracles` carry `sliverWidthMm`, `designCheck` and `goalCutInto` (first failing
   program's) and add one e2e assertion on the sentence.
4. Wire `checkVolumeAgreement` to a swept volume or drop "gate 6" from the #924 claims.
5. Make `sweepsOnColumn`/`denseFlatRoutesToColumn` call `routeEngine` (or delete them) and add a
   real-Tool agreement test.
