# Can the simulation be the pre-cut gate? A read-only review (main 5bcc5a88, 2026-11-02)

Question asked: can the simulation today prove a job is CORRECT (the program cuts the designed part and
nothing else) and EFFICIENT (no wasted time) well enough to be the gate before a physical cut?

Short answer: for a simple 2.5D job it proves that **the posted file does what the CAM decided** — to a
derived tolerance, in the registered frame, with no rapid through material — and it does this well, with
the real badge job pinned as a regression test and one bench confirmation (2026-10-25: oracle 0/0, clean
first cut). It does **not** check the CAM's decision against the design independently, it does **not**
check the vise on any job the column engine sweeps (every V-bit, drill, ball, thread and dense-flat job),
and it has **no efficiency check at all** beyond printing a rapid-to-cut ratio. Details and evidence below;
every path is under `casemaker-app/` unless it starts with `docs/` or is a root document.

---

## 1. Correctness — what the gate checks today

The gate is one pipeline (`src/workers/sim/engraveGenerate.ts`): job findings → feeds → CAM → post →
**verifier on the posted text** → **sweep of the posted text** → **oracle** → `runErrorCodes` /
`saveBlocker` (`src/store/engraveRunGate.ts:146,445`). The design rule is Simulation.md §1.2: simulate
the `.nc`, never the IR.

### 1.1 Job-level findings (design geometry, before any program exists)

`src/engine/cnc/engrave/jobSetup.ts`. Relevant to the gate:
- `vise-jaw-collision` (`jobSetup.ts:3340-3370`): every enabled cut's **plan-view swept extent** (outline
  for a region, line + cutter radius for a trace, disc for a drill/thread) against the jaw faces from
  `viseEnvelope`, with the job's `jawClearance` as the margin. 2D, stated geometry, no uncertainty band.
  This is the ONLY vise check that applies to a V-bit job (see §1.3).
- `vise-stock-not-proud`, `vise-grip-shallow` (warning), `vise-seat` (info), the cone bound (#741: a V cut
  deeper than the cone or stated flute is refused), `trace-self-overlap` / `vcarve-surface-merge`
  (warnings, judged from the supporting floor since #748), `item-outside-stock`, `tool-geometry-from-catalogue`.

### 1.2 The verifier — `src/engine/cnc/verify.ts:390 verifyProgram(text, ctx)`

Runs on the exact posted text, through the real parser and runner (`parseGcode`, `buildTimeline`). Codes
it raises (grep of the file): `parse-error`, `not-our-dialect`, `runner-error` (envelope, unknown
position), `cut-too-deep` (both endpoints and the midpoint, against an injected `DepthLimit`),
`cut-outside-stock` (judged on the **tool edge**), `spindle-off-cut`, `spindle-at-unknown-z`,
`feed-missing`, `feed-too-high`, `rapid-too-low` (below `ir.hopZ`), `multi-tool`, `rpm-too-high`,
`bad-preamble`, `bad-ending`, `tool-change`, `tlo-calibrate`, `toolpath-start`, `numbered-line`,
`stock-exceeds-module`, and the rotary set `rotary-y-off-axis`, `axis-crossing`, `wrap-into-clamp`,
`wrap-off-free-end`, `rotary-rapid-engaged`, `rapid-into-chuck`, `rapid-into-tailstock`, `clamp-unchecked`,
`feed-at-radius`.

The depth limit the generator hands it is `jobDepthLimit(job, boundaryMargin, throughMask, bedBoardMm)` or
the layer stack's `stack.limit` (`engraveGenerate.ts:6551, 8131`; verifier call at `:3247, :6557, :8227`).
**The vise is explicitly not checked by the verifier** (`verify.ts:12`: "The FIXTURE (the vise) is NOT
checked here — that needs solids").

`cncVerify.spec.ts` asserts no committed `docs/bench` program (26 files) is refused — the verifier is
pinned against real posted programs.

### 1.3 The sweep — two engines, and the one that misses the fixture

Routing (`src/workers/sim/session.ts:888`): a job goes to the **column (dexel) engine** when
`rotaryClass === 'wrapped'`, or `sweepsOnColumn(tool)` (`:441`: V-shape, drill, thread, ball, bull), or
`denseFlatRoutesToColumn` (`:464`: a flat end mill over `MAX_CHECKPOINTS`). Everything else — a flat end
mill at ≤ 1000 causal runs — goes to the **exact 2.5D sweeper** (`src/workers/geometry/sweep.ts`).

Exact sweeper checks (codes in `sweep.ts`): `rapid-through-stock` (time-ordered, against the stock as it
is at that step, gouge returned as a solid, never subtracted), `rapid-below-bed`,
`spindle-off-near-stock` / `-bed` (proximity from the shop's `sim.spindleOffProximityMm`, fallback 1.0;
`:860, :982`), `tool-into-fixture` on every cutting move (`:1496`), `rapid-into-fixture` /
`feed-into-fixture` on air moves (`:920-921`), `holder-into-fixture` (`:1456`), `holder-collision` /
`holder-unproven` (`holderGate`, `:1033`: depth vs `shoulderLength ?? fluteLength`),
`holder-vs-fixture-unproven`, `fixture-unchecked` (`:1589`), `ramp-over-removed` (info: a non-constant-Z
move is swept from its lowest Z), `air-moves-unchecked` (past `MAX_AIR_CHECKS = 4000`, `:78, :883, :1014`),
`dense-3d-refused` (`MAX_CHECKPOINTS = 1000`, `:91, :1175`), `sweep-stalled`, `tool-refused`.

Column engine checks (`src/workers/geometry/columnEngine.ts`): `rapid-through-stock` by a per-column walk
under every air move with the cutter's own floor profile (`:2078-2113`, no count cap since #858),
`air-moves-unchecked` when the stall window expires mid-phase (`:2109`), `holderGate` for the neck
(`:1999`), `ramp-over-removed` per qualifying move above half the smallest predicted level gap (`:1932`,
#629), `axis-clamped`, the rotary refusals, and the thread envelope notes.

**Finding (correctness gap).** `columnEngine.ts` never reads `setup.fixture` — the only `Setup` fields it
touches are `setup.part` (`:742, :1116, :1814-1817`), and its only imports from `sweep.ts` are
`MAX_GOUGES` and `holderGate` (`:50`). `session.ts:925-928` builds the fixture **meshes** on the column
path for drawing only, and still stamps `fixtureSource` on the result (`:971`), so
`simCoverage.ts:128` then prints "the modelled fixture (fixed jaw, moving jaw)" among the obstacles the
sweep was given. On the column path that sentence is not backed by a check. Consequence: for the badge
(a V-bit job) and every drill, ball, thread or dense-flat program, tool-into-jaw is caught only by the
plan-view rule in `jobSetup.ts:3340` (design geometry, not the program), and the collet nut vs the jaw is
not caught at all. The exact engine has all four fixture checks; the column engine has none.

### 1.4 The volumetric oracle — `src/engine/cnc/engrave/oracle.ts:621 computeOracle`

Exact definition:
- Levels: one per distinct predicted depth that carries geometry, plus a **shallow groove level** at
  0.1 × the shallowest trace depth (`ORACLE_SHALLOW_DEPTH_FRACTION`, `:317`) and the thread levels.
- Predicted region at level `z = zTop − depth`: the union of every item whose depth ≥ this level — a flat
  item's opened polygons; a V trace as a **groove** = its centreline dilated by
  `grooveRadiusAt(cone, z − zTip)`; a V-carved region's floor grown by `(depth − d)·tanHalf`, capped at
  the flank's radial run (`vRegion.maxGrow`, #741); a thread as the column-grid height field swept with the
  same tooth profile the simulator uses.
- Simulated region: the exact sweeper's `removal.slice(z + 0.001)` (`removalSliceAt`, `:336`) or the
  column grid's cells with `h <= zSlice` merged into runs (`gridSliceAt`, `:361`).
- `underCut = area(offset(predicted, −band) − simulated)`; `overCut = area(simulated − offset(predicted, +band))`
  (`:721-735`).
- Band, derived never hand-set: `levels × SWEEP_SIMPLIFY_EPS_MM (0.002) + 2 × ARC_CHORD_TOLERANCE_MM (0.005)`
  (`oracleBand`, `:320`); the column engine adds **half a cell diagonal** (`columnBandTerm`, `:429-435`).
  On the badge (0.1 mm grid) the band reads 0.085-0.089 mm.
- Pass: `worstUnder <= areaFloor && worstOver <= areaFloor`, `areaFloor = max(1e-3 mm², 4 × cellArea)`
  (`ORACLE_AREA_FLOOR_CELLS = 4`, `:295, :776`) — 0.0399 mm² on a 0.1 mm grid. So a 2 × 2 cell
  (0.2 × 0.2 mm) spot of uncut or over-cut material passes by construction.
- Per cutter class: flat end mill → exact sweeper, polygon prediction, band ≈ 0.016 mm; V trace → column,
  groove prediction, +0.071 mm; V region → column, floor + `vRegion` growth; drill/thread → column,
  analytic/thread prediction (`simCutterShapes.spec.ts:268-297` pins a hole the program did not drill);
  ball/bull → column, **no 2.5D prediction** (a goal program reports "No 2.5D check for a surface program —
  checked on the 0.1 mm dexel grid", `engraveRunGate.ts surfaceCheckSentence`); PCB → copper topology
  (`copper`), not area.
- Surface frame after registration (#623/#625/#628): the program is **un-lifted** (`unliftTimeline`) before
  either engine sweeps, so the verdict is the flat program's own; `OracleReport.frame = 'surface'` is
  stamped and printed. Pinned by `engraveOracleSurface.spec.ts:309` with the REAL bench badge job and the
  run-6 plane (0/0), and by the 302 mm² work-frame signature as the negative.

**Design intent vs the CAM's own prediction — which is it?** It is the CAM's own prediction, per check:

| Check | Compares the program with… | Independent of the CAM? |
|---|---|---|
| Verifier | machine limits, stock box, depth limit, dialect | yes (limits are external facts) |
| Sweep gouge / fixture / holder | the stock as cut so far, the fixture boxes, the tool record | yes |
| Oracle, flat region | `offset(offset(design, −planeRadius), tipRadius)` — "the CAM's own reach" (#584 fix, `engraveGenerate.ts` ~1792) | **no**: same Clipper2 offsets `pocketLoops` uses |
| Oracle, V trace | a groove along `tracePaths`' own passes with the same `grooveRadiusAt`/`surfaceAboveTip` cone the engine sweeps (`oracle.ts:100-125`) | **no**: same cone model both sides |
| Oracle, thread | the CAM's own feed moves swept with the same tooth (`OracleThread.moves`) | **no** |
| Oracle, goal/surface | nothing (0 predicted levels); `goalCoverage.ts` measures reach separately (#872/#873) | n/a |

Simulation.md §7 says this plainly ("'no over-cut' is close to an identity … the oracle's real content is
the under-cut direction plus serialisation") and asks for one independent check — sample points of the raw
glyph at distance ≥ r from its boundary by point-in-polygon and assert each lies inside the simulated
region. **That check is not implemented** (no `independent`/point-in-polygon code in `oracle.ts`,
`engraveGenerate.ts` or `session.ts`). The oracle is also order-blind (a union) and feed-blind by design;
the verifier carries the sequence rules.

### 1.5 Known false positives / negatives, with state

| Issue | What | Direction | State |
|---|---|---|---|
| #584 | badge under-cut 0.0815 mm²: prediction counted a Ø0.61 dot the ring arithmetic drops | false FAIL (prediction) | fixed 03e60786; bench 0/0 10-24 |
| #623 | lifted program vs flat prediction → 301 mm² under-cut | false FAIL (frame) | fixed c7920af7; bench-verified |
| #625 | lift tips a flat job over the density cap → column staircase 0.84 mm² | false FAIL | fixed 8e603e1f (density judged in the surface frame) |
| #628 | column engine swept ramped V at the deep end → 1.66/75.5 mm² | false FAIL | fixed 830054ae; regression pinned 69f85601 |
| #629 | any ramping feed swept at its deep end on the column engine (silent) | false PASS/FAIL risk | `ramp-over-removed` info now raised above ½ the level gap (bc6b678f); the removal itself is still deep-end for a plain V (`columnEngine.ts:1200 followsZ`); a dense FLAT job routed to column gets no threshold |
| #734 item 1 | j13 tool tray `rapid-through-stock`: sweep floor was the blank bottom, not thickness + breakthrough | false FAIL | fixed 5eb2eb2d |
| #738 | relief roughing retract combined X/Z through standing stock | TRUE positive (CAM bug) | fixed e1480beb |
| #741 | V cone not capped at the body: 5.1 mm pocket "simulated without complaint", 1431 vs 971 mm³ | **false PASS** | fixed d33bfb31; `vCarveConeSim.spec.ts` |
| #740 | missing tip read as 3.175 mm → V-carve refused | false FAIL | closed |
| #748 | merge warnings judged from the top face on a pocket floor (4-17× too wide) | false WARN | fixed 6fdbaf1b |
| #747 | frame file outside the envelope blocked a verified program | false FAIL | fixed |
| #750 | a tab read as a loose piece | false FAIL | fixed |
| #630/#631 | tilt/dome verdict flipping on noise at the band edge; Makera would cut it | false REFUSE (registration) | closed (dome writes the origin, G32 route) |
| #916 | compute caps that refuse or degrade a plan | false REFUSE / silent degrade | OPEN (see §4) |

Pattern worth naming: of the fourteen, eleven were the simulation refusing a good program and only one
(#741) was the simulation passing a bad one — and that one was found by an external sweep, not by the
app's own tests. The pipeline errs loud, which is the right side, but its one quiet miss was in exactly
the place the oracle cannot see (the shared cone model).

---

## 2. The V-bit discrepancy (20–60 % more removed than the independent sweep)

Source: `docs/bench/2026-10-28-z1-real-jobs/README.md` ("On V-bits the app removes 20–60 % more (#741)")
and #741's two measurements: j11 star female 1431 vs 971 mm³ (+47 %), j11 inlay 30° 5089 vs 3067 mm³
(+66 %). Both jobs are **deeper than the cutter's cone** (5.1 mm against a 1.59 mm 90° cone and a 4.99 mm
30° cone).

Where it came from: `columnCutterFor`'s V branch built the cutter as `{radius: tipRadius, tanHalf}` with no
`outerRadius`, so `cutterReach` (`columnEngine.ts:168-178`) kept widening the flank past the shank and
`surfaceAboveTip` never said "no cutter here". The independent sweep (`tools/render.py:34-49`) caps the cone
at `D/2` of the stated diameter (`K = inf` beyond). So the whole 20–60 % is the uncapped cone on
deeper-than-cone jobs; neither the tip (D1 = tipDiameter, both models use it) nor the shank is modelled
differently otherwise.

Is it understood and fixed? Yes: #741 landed d33bfb31 (2026-10-29 01:19), 34 minutes before the README's
re-run commit 207e8a11; the README sentence was written from the first run and not re-measured.
`vCarveConeSim.spec.ts` pins the cap ("stops the sweep's footprint at the body, however deep the tip
is"; "removes the body-capped stroke, not the unbounded flank") and passes. A V cut deeper than the cone
is now refused by name (`benchTypicalJobs.spec.ts:519`).

Does it affect the badge? No. The badge's 30° × 0.3 mm bit at 1 mm deep has a cone 5.37 mm tall
((1.5875 − 0.15)/tan 15°), so the cap never engaged; its 0/0 verdicts were and are the same numbers.

What it does show: the oracle could not have caught #741, because `OracleGroove` and `vRegion` use the
same `VCone`/`grooveRadiusAt` the engine sweeps with. A cone error moves both sides together. The only
independent V check in the repo is `render.py`, which is a bench tool, not a test — and its own v1 drew
balls at the shank, so "independent" needs its own gate. There is no analytic-volume test for a V groove
(`simCutterShapes.spec.ts` has them for drill, chamfer plunge and thread envelope; `cncSweep.spec.ts` has
the capsule closed form for a flat).

---

## 3. Time and efficiency

### 3.1 The cycle estimate — `src/engine/cnc/cam/ir.ts`

- `moveSeconds(distance, rate, accel)` (`:482`): trapezoid `d/v + v/a` or triangle `2√(d/a)`.
- `estimateCycleSeconds(moves, rapid, rotaryRadius?)` (`:546`): feeds timed **per run** (consecutive feeds
  at one `f`), a run ending at a corner past `JUNCTION_CORNER_DEG = 10` (`:500`, #657); rapids one
  trapezoid each at `rapidRate` (Z-only at `zMmPerMin`, else `xyMmPerMin`). Rotary adds the arc length.
- The rapid model is the machine profile's `rapidEstimate` (`machine.ts:695`: Z1 1200/600 mm/min,
  150 mm/s², "config read 2026-10-07 + stopwatch 2026-10-08 (#281)"); required, no default.
- Not modelled, by its own doc (`:505-515`): spindle spin-up, tool change (`M6` macro, probe), dwell,
  operator time, the inter-operation rapid (the first move of each op is unpriced), the controller's
  real `junction_deviation` (the 10° constant stands in for it; "a planning constant, not a measurement").
- One number feeds the panel, the run sheet and `;@MKR|TIME` (`post/z1.ts`, `plan/phases.ts:176`).

### 3.2 Predicted vs actual, every real run with a trace

| Run | Program | Predicted (`;@MKR\|TIME` as posted) | Actual | Ratio | Model at the time |
|---|---|---|---|---|---|
| 2026-10-17 pm | `single.nc` (2 mm O-flute rough, 2 pockets) | 94 s | 136 s | **1.45× low** | per-run trapezoid (#281, 10-12) |
| 2026-10-17 pm | `single-rest.nc` (0.6 corn rest, 42 626 lines) | 820 s | 856 s | 1.04× low | same |
| 2026-10-17 eve | `thin-v.nc` (30° V-carve, 35 560 motion lines — the "35 555-line" run) | **373 s** | **437 s** | **1.17× low** | same |
| 2026-10-25 | badge `single.nc` (13 442 moves, 0.5 V, catalogue F1000/F500) | 162-165 s | ~255 s | **1.55× low** | per-run |
| 2026-10-25 re-timed | same program | 249 s | 255 s | −2.4 % | junction model (#657, fe379317) |
| off-bench | j02 (CutRocket) | 120 s | source says 7-10 min | not like-for-like (#735 item 4) |

(The 10-17 headers are read from the maintainer's local `.scratch/badge-2026-10-17/*.nc`; the committed
`docs/bench/single-barrel.receipt.json` is a different, 445-line job — its current estimate 120.1 s has no
recorded run.) The junction model was tuned on the one badge run it then matches; the three 10-17 programs
have not been re-estimated with it, so the current model has **one in-sample point and no out-of-sample
check**. #208 D3 (a timed air run + a timed cutting run, portions separately) is still the closing
measurement and has not been done.

### 3.3 Efficiency measures that exist

- `rapidMm`, `cutMm`, `baselineRapidMm` per program (`engraveGenerate.ts:3020-3032`), printed in the run
  sheet as "spends N mm in rapid against M mm cutting (r : 1)" with the pre-#487 baseline
  (`runSheet.ts:2661-2675, 4409-4414`). The CAM orders regions by nearest-neighbour + 2-opt (`cam/tour.ts`,
  #487) and rotates entry points.
- `surface3d.ts:1070-1071` compares the estimated time of a raster rough against an adaptive rough to
  choose one (goal jobs only; `rough3d.compareCellBudget` skips the comparison above 1 M cells, #916 item 3).
- Smart tool selection by simulated outcome (#766, #760) picks a cutter that fits the design's gaps.

Measures that do **not** exist: air-cut time fraction, rapid-height waste (hops at `HOP_Z` are a fixed
1 mm), redundant removal (a pass re-cutting already-cut volume — the column engine's `written` count per
move would make this cheap), path length vs a lower bound, feed utilisation (fraction of a run at the
commanded feed, available from the same trapezoid), MRR vs the catalogue row, tool-change count or dwell.
No threshold or finding reads the rapid ratio. **A correct program that is 3× slower than it needs to be
passes the gate without comment**, except a goal's rough strategy.

---

## 4. Budgets and caps — what stops the sim early, and what the gate does then

| Cap | Where | On expiry | Gate effect |
|---|---|---|---|
| `sim.budgetMs` 60 s wall clock | retired 2026-11-01 (#895), `defaultsClient.ts:62 RETIRED_DEFAULTS` | — | gone; #871/#894 (dead "longer limit" press) closed with it |
| `sim.loadStallMs` (fallback 30 s, 5 s-10 min) | `defaultsClient.ts:365`; `simClient.ts:328-349` watchdog terminates the worker | `sweep-stalled` **error** (`sweep.ts:1385`, `columnEngine.ts:2060`) | **refuses**; "a fault, not a slow program" |
| same window, air phase | `columnEngine.ts:2090-2109`; `sweep.ts:684-723, 1009-1014` | `air-moves-unchecked` **warning** | **passes** with air moves below the stock top unchecked — not in `ACKNOWLEDGE_CODES`, so no tick |
| `MAX_AIR_CHECKS = 4000` | `sweep.ts:78, 883` (exact only) | `air-moves-unchecked` warning | same silent pass |
| `MAX_CHECKPOINTS = 1000` | `sweep.ts:91, 1175` | `dense-3d-refused` error, or re-route a flat job to the column engine (`session.ts:464`) | refuse or degrade-and-state ("simulated on a 0.1 mm grid") |
| `sim.stallMs` 180 s (Generate) | `defaultsClient.ts:366` | generate stopped | refuse |
| `MAX_GOUGES` 200, `DIAGNOSTIC_CAP` 25 | drawing / readability | `gouges-truncated` info | none |
| `DEFAULT_MAX_CELLS` 4 M | `surface3d.ts:75, 291, 434` | pitch coarsened and stated | degrade, stated |
| `GOAL_MEMORY_BUDGET_MB` 640/256, `GOAL_BYTES_PER_MOVE` 1100 | `surface3d.ts:163, 166` | `goal-program-too-big` | refuse by name (#902 OPEN: re-price, ~100 B/move measured) |
| `DEFAULT_MAX_FINISH_TIP_OPS` 300 M | `surface3d.ts:96` | refuse "too detailed to plan" | **still on main**; #916 removes it |
| `DEFAULT_PLAN_BUDGET_CELL_LEVELS` 500 k, `DEFAULT_COMPARE_CELL_BUDGET` 1 M | `surface3d.ts:968-969` | fall back to raster / skip the comparison | **silent degrade, still on main** |
| `DEFAULT_MAX_SCALLOP_CONTOURS` 4000, `DEFAULT_MAX_TEXTURE_STROKES` 4000 | `surface3d.ts:117`, `texture.ts:64` | truncate the pass / drop strokes (`texture-crowded`) | **degrades the CUT, still on main** |

#916 (OPEN, maintainer 2026-11-02: "no arbitrary time limits") audits exactly this table and keeps only
memory, stall and I/O guards; its removals live on branch `902-goal-budget`, not on main 5bcc5a88. #894
(CLOSED) was the dead "Open the control" press for the 60 s stop. The one gate-relevant degrade that #916
does not name as a problem is `air-moves-unchecked` being a warning: it is the only path by which a program
with an unchecked rapid below the stock top reaches Upload with every tick green.

---

## 5. Gate wiring — hard blocks, warnings, overrides, staleness

`src/store/engraveRunGate.ts` (the one statement; the store re-exports it; scripts use it too, #395):

- `runErrorCodes` (`:146`) = error-severity findings + verifier errors + `simErrors(simDiagnostics)`
  (`src/engine/cnc/simGate.ts`). `SimLoadResult.ok` is NOT the safety answer (simGate.ts header, #393).
- `saveBlocker` (`:445`), in order: rotary unmeasured → "Generate first" → **stale** (`staleSince`) →
  first error's own sentence → run still going → no `.nc` → `simStatus !== 'ready'` → oracle not run →
  **oracle not ok** (names the program, #844) → missing acknowledgement tick.
- `uploadBlocker` (`:509`) = save + "run elsewhere" (stated/GRBL machines) + one-file rule + the verifier
  report must exist. `releaseBlocker` (`:542`) = per-program verify-or-surface-check. `uploadGate.ts
  programUploadProblem` is the type-level last line (`VerifiedProgram` has no other constructor).
- `surfaceRepostBlocker` (`:575`): the frozen package's `surface {plane, z0}` must equal the registration's
  (both directions, #635).

Hard-blocking, no override: every error (verifier, sweep, findings), oracle fail, stale result, sim not
finished. #206: "There is no 'save anyway'". Warnings: only `ACKNOWLEDGE_CODES` (`:49`: `vise-default`,
`holder-vs-fixture-unproven`, `holder-unproven`, `released-onto-board`) require the operator's tick;
every other warning (`trace-self-overlap`, `vise-grip-shallow`, `air-moves-unchecked`, `ramp-over-removed`,
`thread-envelope`, `axis-clamped`…) is shown and does not block. The Cut step adds operator confirmations
(clearance, cutter fitted, "I am at the machine").

Staleness is a **comparison, not a timer** (`src/engine/cnc/engrave/package.ts:22, 191-228`): the package
hash covers the job hash, each program's bytes hash and frame hash, and the registration; `markStale`
(`engraveRunStore.ts:1135`) sets `staleSince` on any job or machine input change and only a new Generate
(which re-runs verify → sweep → oracle) clears it. So the sim verdict is tied to the package **indirectly**:
a package can only be frozen from a run that passed `saveBlocker`, and any input change forces a re-run.
What the hash does not cover is the **simulator's own version**: a package frozen before a simulator fix
stays "current" (the bytes and inputs match) with a verdict the fixed simulator might not give. Low risk
on a single machine; worth one line in the hash (`CAM_VERSION` is already in the post header).

---

## 6. Test evidence

Run here (Windows node via `cmd.exe`; vitest cannot run from WSL in this checkout — the rolldown Linux
binding is absent, as CLAUDE.md warns):

- Batch 1, 11 files / **108 passed**, 8.9 s: `engraveOracle` (default job every level in band; coarse raster
  under-cut ≈ 36 mm² caught; +0.5 mm X shift caught both sides; band derived not hand-set; trace, thread,
  M2 ramp), `engraveOracleSurface` (incl. `:309` the REAL bench badge job re-posted against the 0.817°
  plane reads 0/0), `engraveOracleGroove`, `vCarveConeSim` (#741 cap), `vCarveFloorReach` (#584),
  `timeEstimate735`, `camEstimate` (#281/#657 pins), `cncVerify` (no committed `docs/bench` program
  refused, 26 files; 10 000 moves in 34 ms), `simGate`, `engraveRunVerify`, `engraveOracleDeterminism`
  (sweeps the single-barrel job 20×, stable).
- Batch 2, 3 files / **36 passed, 4 skipped**, 4.6 s: `docsRoundTrip` (regenerates
  `docs/bench/single-barrel.receipt.json` through the CLI and compares), `programSweep` (#744 per-program
  seeding, rest-pair rapid in the channel clean / without the seed a gouge), `simCutterShapes` (analytic
  plunge volumes; a hole the program did not drill is caught); `columnFlatMeasure` skipped (vendor corpus
  not on disk).

Real posted programs pinned by tests: `docs/bench/single-barrel.nc` motion lines
(`engraveGenerate.spec.ts:1213`), its receipt (`docsRoundTrip.spec.ts:130`), the 2026-10-28 job fixtures
(`benchTypicalJobs.spec.ts`, not run here — heavy). **Not pinned**: the 450-laminate coupons
(`docs/bench/450-lam-v-*.json`, no test references them), the 10-17 `thin-v.nc` (local only), and any
predicted-vs-actual time.

---

## 7. Assessment

### (a) Sufficient today for a SIMPLE job (text V-carve or flat pocket, 76 × 38)?

As a check that **the file does what the CAM decided** — yes, and it is the strongest part of the product:
the verifier and sweep run on the posted bytes, the oracle is derived-tolerance and frame-aware, the real
badge job is a regression fixture, and the bench confirmed it (10-25: 0/0 → clean first cut). As a check
that **the program cuts the designed part and nothing else** — not yet, for three reasons in order of
weight: (1) nothing checks the CAM's intent against the design independently (the oracle shares the
offsets and the cone with the CAM; #741 is the proof it matters); (2) on a V-bit job the vise is checked
only in plan view from the design, never from the program (column engine has no fixture check, and the
coverage sentence says otherwise); (3) a stalled air phase downgrades to a warning. As a check of
**efficiency** — no, nothing is measured against anything.

### (b) Missing for correctness, in order

1. **An independent oracle side.** Simulation.md §7's point-in-polygon check on the raw design (every design
   point ≥ r from the outline must be inside the simulated region; every simulated point must be within r
   of the design), plus an analytic volume/area for a straight V groove, and a second height-field
   implementation (a TS port of `render.py` or an `evaluateOp`-free sampler) as a test oracle over the
   corpus. Off-bench.
2. **Fixture and holder on the column engine** (`tool-into-fixture`, `rapid/feed-into-fixture`,
   `holder-into-fixture`) — or route the fixture test through a shared function both engines call. Until
   then `simCoverage.ts:128` must not list the fixture as checked on a column program. Off-bench.
3. **`air-moves-unchecked` → error, or at least an `ACKNOWLEDGE_CODES` tick.** A gate that passes with
   unchecked rapids below the stock top is not a gate. Off-bench, one line plus its tests.
4. **Goal/surface programs have no oracle.** `goalCoverage` measures reach, not over-cut; a ball program
   that gouges the goal by 0.3 mm passes. A heightfield-vs-goal under/over comparison with the grid band is
   the obvious analogue. Off-bench.
5. **Ramping V moves** are still swept at the deep end (`columnEngine.ts:1200`); the info diagnostic
   (#629) names it but the removal is wrong where it fires. Split the move (as #629 proposed). Off-bench.
6. **The physical tool**: `shoulderLength` empty for every engraver/chamfer → `holder-unproven` is a tick,
   not a check; the stepped shank (cone to 2.78 mm then 3.175) is not modelled. Bench: measure the house
   bits once (calipers), then it is a catalogue edit.
7. **Hash the simulator version into the package** so a simulator fix stales a frozen verdict. Off-bench.

### (c) Missing for efficiency, in order

1. **Define the measures and print them per program**: air fraction (rapid seconds / cycle seconds), hop
   count and hop time, rapid : cut ratio (exists), feed utilisation (Σ time at commanded feed / feed time
   from the same trapezoids), redundant removal (per-move `written` cells vs cells under the footprint —
   a pass that writes < X % is cutting air), path length vs the tour's lower bound. All from data already
   in hand. Off-bench.
2. **Turn two of them into findings** with a shop-default threshold (the house rule: location.json, never a
   constant): air fraction above N % → warning naming the operation; a pass whose written fraction is below
   M % → warning "this pass mostly cuts air". Off-bench.
3. **Calibrate the time model** (#208 D3): one timed air run (rapids) and one timed cutting run (feeds)
   read from the `P:` trail, compared as portions; read `junction_deviation` with `config-get sd`. Then
   re-estimate the three 10-17 programs with the current model as out-of-sample checks. **Bench**, ~15 min.
4. Price what is unpriced: tool-change macro, `M491`, spindle spin-up, the inter-operation rapid. The
   firmware's own numbers are in the profile (#184); bench once to confirm.
5. Strategy comparison beyond goals: for a pocket, adaptive vs contour-parallel by estimated time (the
   adaptive engine exists, `cam/adaptive.ts`).

### (d) Bench vs off-bench

Off-bench (code + tests + CDP): b1, b2, b3, b4, b5, b7, c1, c2, c5. Bench (minutes, not a session): c3
(D3 air + cutting run; `config-get sd junction_deviation`), b6 (caliper the three V-bits' flute/shoulder),
c4 (one tool-change macro timed), and — the one physical measurement the oracle cannot replace — a V-groove
width/depth coupon measured with calipers or a loupe against `grooveRadiusAt` (#450's laminate row).

### (e) Proposed definition: "the simulation validates a job" when all of these hold

1. The verifier passes the **posted bytes** with zero errors, in the frame the package will run in
   (`frame = 'surface'` when a tilt was measured; `surfaceRepostBlocker` null).
2. Every program's sweep completed with **no unchecked air moves**: `air-moves-unchecked` absent (made an
   error), no `sweep-stalled`, no `rapid-through-stock`, no `spindle-off-near-*`.
3. **Fixture and holder were tested on this program's engine**: `tool-into-fixture`, `rapid/feed-into-fixture`
   and `holder-into-fixture` absent AND actually evaluated (the coverage sentence names the engine and the
   obstacles it tested; "cannot be proven" is an acknowledged tick, never a default pass).
4. The **oracle** passes at every level: worst under- and over-cut ≤ the resolution floor, with the band
   printed and the floor stated as a physical size ("a 0.2 × 0.2 mm spot could pass unseen").
5. An **independent design check** passes: sampled design points reachable by the cutter are inside the
   simulated region and no simulated point lies more than r (+ band) from the design — computed from the
   raw design, not from the CAM's offsets or cone.
6. **Removed volume agrees** with an analytic or second-implementation figure within the grid's own
   tolerance (flat: capsule closed form; V: groove closed form; ball/drill: `simCutterShapes`-style).
7. Every number the sim reports carries its **resolution and provenance** ("simulated on a 0.1 mm grid";
   tool geometry source; fixture source), and no cap coarsened, truncated or skipped a check without saying
   so in the same report (#916).
8. The **cycle estimate** is printed with its basis, and the air fraction, hop count and feed utilisation
   are printed per program; a program above the shop's air-fraction or below its feed-utilisation threshold
   carries a warning naming the operation.
9. After a run, the **actual time is recorded beside the estimate** on the run record, so the model's
   error is a number the next job can see (the record already has start/finish).
10. The frozen package is **current**: job, registration, program bytes and simulator version all match
    the hash; any change re-runs 1–8.

Items 1, 2 (minus the severity change), 4, 7 (mostly) and 10 (minus the version) hold today for 2.5D jobs
on the exact engine; 3 fails on the column engine; 5, 6, 8, 9 do not exist.
