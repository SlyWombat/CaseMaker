# Planner v3 — decide on fields, cut on exact geometry, prove once

**Status:** proposed, 2026-11-11. Author: the analyst session. For the maintainer's ruling.
**Supersedes, if accepted:** the search layers of `docs/design/cam-model-engine.md` (§4 sequence, §10.1 rest, §10.2 pick). The method of that note (feature recognition, drop-cutter on triangles, Z-level rough, scallop finish, pencil) stands.
**Reviewed code:** land18 at `28e04f756` (`casemaker-app/`). Nothing was run for this document; every number below is from the code's own comments, earlier measured runs, or arithmetic that is marked as such.

---

## 1. Summary

One Generate takes 5 to 90 minutes because the planner answers "which cutters, in which order" by building real toolpaths for each candidate answer, posting them to G-code, parsing the G-code back and simulating it. Commercial CAM does not answer that question at all: the user picks the cutters.

The proposal keeps the question, because it is the product's advantage, and changes how it is answered:

1. **Decide on fields.** Compute, once per setup, a small set of maps of the part: where each cutter diameter can go, and what each ball radius leaves behind. Every candidate is then priced from those maps in microseconds, with no toolpath and no simulation.
2. **Cut on exact geometry.** Build toolpaths once, for the chosen plan, with the existing exact drop-cutter. Posted points never come from a grid.
3. **Prove once.** Simulate and check the posted programs once, with one simulator that shares no code with the planner.

The same three steps serve every way the machine can hold and turn a part: one-sided jobs, flips with any number of sides, indexed and continuous 4th-axis work, and lathe-style turning. §4A states the general model (poses, charts, one stock, one clock) and shows each capability as an instance of it, so that putting a figure on the rotary is a new instance and not a new engine.

Expected result: Generate dominated by one plan and one proof. The target is under two minutes for the tray on dave-1 (§9); that is a target to be measured in the first slice, not a measurement.

Roughly 25–30 thousand lines of planner, pick and simulation code are replaced or deleted (§7). The job document, the IR, the posts, the verifier, the registration and run code, and the UI contract of Generate are kept.

---

## 2. What the review found

Five parallel reads of the engine, the pick, the simulation, the Generate pipeline and the earlier rulings. Two claims made in discussion before the review were wrong and are corrected here.

| Claim before the review | Verdict | Evidence |
|---|---|---|
| Path ordering is solved by search | **Wrong.** It is nearest-neighbour plus 2-opt, stay-down links where the disc is clear | `cam/model/ops/rough.ts:133-197, 270`; `plan.ts:6247-6284`; `linking.ts:412-436` |
| The drop-cutter kernel is naive | **Mostly wrong.** Triangle grid index, max-Z early exit, closed-form facet and vertex contact | `triangleBins.ts:127-147`; `dropcutter.ts:208-227, 392` |
| Edge contact is found numerically where a closed form exists | **Right.** Golden section on three edges per triangle for ball and cone | `dropcutter.ts:284-313` |
| Cutter choice is priced by running the real planner | **Right, and it is the dominant cost** | below |
| Checking shares one representation with planning | **Wrong in the bad direction.** There are three simulators, and the check is not independent of the planner | §2.3 |

### 2.1 Where the time goes

Per goal side, one Generate runs:

- **The smart pick** (`engrave/smartPick.ts:770`): up to 16 candidates measured coarsely, then up to 3 finalists, each a whole Generate plus a sweep per program plus the goal check (`workers/sim/planEvaluate.ts:629-644, 710-765`).
- **Two plans** (`cam/model/twoPlans.ts:97`): the owned plan, then the catalogue "ideal" plan. They share nothing but the mesh index.
- **Inside each plan, per setup:**
  - *The ball rank* (`plan.ts:1686`): one full curved plan and one goal stamp per reaching ball, 42–65 s each by the code's own figure (`scripts/lib/casemaker/rankPool.ts:4`).
  - *The sequence choice* (`sequence.ts:754-859, 1128-1144`): primaries × rest variants × prefixes × balls × chamfers × freeing cutter × order. Every unique step is planned for real, then posted, parsed and stamped (`plan.ts:1030-1046, 4055-4103`). One tray side produced 299 step plans and 834–1,202 s of chain time (`plan.ts:1018-1027`).

Nothing is reused between pick finalists, or between the owned and ideal plans.

- **Inside one plan,** the surface is queried point by point with no cache. The same point is asked again by the rough grid, the disc guard, the finish mask, the ride tests and the reach tests. Admitting one finish point costs about 18 surface queries (`clsurface.ts:91`; `plan.ts:5299-5323`).

### 2.2 Two selection layers

The smart pick and the model planner's own chain and ball choice both select cutters. Only a user-sourced tool sets a pin (`sequence.ts:1088-1089`), so the two may choose independently. The review did not trace whether a pick finalist constrains the planner; the design removes the question by having one selector.

### 2.3 Simulation and the check

- **Three simulators:** an exact solid sweep for flat end mills only, capped at 1,000 checkpoints (`workers/geometry/sweep.ts:102, 109`); a column height field (`columnEngine.ts`); and the "stamp" on the goal's grid that the verdict reads (`workers/sim/sweptPoint.ts`).
- **The stamp is brute force:** a sample every 0.05 mm, each writing every cell under the cutter (`sweptPoint.ts:32, 142-175`), about 74,000 cell visits per millimetre for a ⌀6 cutter (arithmetic). The column engine does a move in closed form (`columnEngine.ts:1226-1235`).
- **The check is not independent.** The planner's coverage rank and the gate's verdict call the same `exactSweptFieldTooled`, the same G-code parser and timeline, on goals from the same sampler (`plan.ts:1040`; `session.ts:1596`; `goalCheckField.ts:65`). The documents require the gate not to import `cam/model/**`; the dependency runs the other way and has the same effect.
- **Defects found, independent of this design:**
  - A goal that could not be checked returns `ok: true` (`engrave/designCheck.ts:1825-1827`).
  - The planner samples the goal under a 4 M-cell cap and the gate under 20 M, so above 4 M cells they work at different pitches (`engrave/goalHeightfield.ts:34`; `goalCheckField.ts:35`).
  - The stamp models a bull nose as a flat disc and every drill at 59° (`sweptPoint.ts:73-82`).
  - The planner's stamp returns null without a statement for anything but a rectangular blank (`plan.ts:1037-1039`).

### 2.4 Structure

- `engraveGenerate.ts` (9,157 lines) is a dispatcher over at least nine paths: model engine, legacy 2.5D items, drill, thread mill, facing, rotary wrap, rotary relief, indexed faces, flip helpers. It has two parallel post/verify/hash loops (`:5814-5892`, `:8980-9097`).
- Sweep, oracle and run-sheet orchestration exists in the run store and again in the CLI (`store/engraveRunStore.ts:1133-1530`; `scripts/lib/casemaker/engrave.ts:1329-1477`).
- `plan.ts` (6,376 lines) mixes planning, simulation, statements and feeds, and imports the post, the parser, the emulator and the simulator (`plan.ts:123-128`).

### 2.5 What the planner chooses today, against the vendor

From the Z1 Demo Jobs page rebuilt on the published build `e741c9266` (2026-11-11). These cards read "Matches the design", because that verdict judges geometry only; the agreed cycle and cutter-count lines are not met.

| Reference part | Makera Studio | Case Maker | Card compute |
|---|---|---|---|
| Tool organizer | 5 cutters, 47.8 min header | 12 cutters, 6.7 h estimate | 48 min |
| Tool tray 70 mm (on tape) | 4 cutters, 47.6 min | 8 cutters, 1.7 h | 13.8 min |
| Accuracy sample | 4 cutters, 55.9 min | 9 cutters, 1.0 h | 72 s |
| Ring box body | 2 cutters, 23.4 min | 3 cutters, 0.5 h | 4.4 min |

**Sources.** The Makera columns are our measurement of Makera's published programs for these four parts, read from each program's header and tool list (the files themselves are never committed). The parts are Makerables project pages:
tool organizer, <https://www.makerables.com/project/makera-tool-organizer>; tool tray 70 mm, <https://www.makerables.com/project/modular-stackable-tool-trays> (CC BY-NC-SA 4.0); accuracy sample, <https://www.makerables.com/project/cnc-accuracy-test-sample>; ring box, <https://www.makerables.com/project/wooden-ring-box>. The Case Maker columns are ours, from the Demo Jobs page build named above.

The agreed lines are cycle ≤ 2× vendor and cutters ≤ vendor + 1. The organizer misses both by a wide margin. The mechanism is the objective's first key: simulated leftover outranks everything, so any cutter that removes a few more cells is added whatever it costs in time and bit changes. The selector in §4.3 keeps the objective's order but needs a tolerance on that first key (open decision 7).

### 2.6 Setups, flips and the rotary today (second review, land18 `bb935dcd3`)

**There are five planners, not one.** The model engine plans a mesh goal from the top and, on one path, the bottom. Four other paths never go through it: the legacy 2.5D items, rotary wrap (`rotary/wrap.ts`), rotation relief (`cam/rotaryRelief.ts`, its own radial field and its own rough and finish), and indexed faces (`cam/indexed.ts`). The panther on the stick and the panther on the rod are planned by different engines.

**Setups are described three ways.** The document's `JobSetup` (`types/engraveJob.ts:1909`), the setups engine's `Setup` with six axis faces (`setups/types.ts:83`), and the model planner's `SetupSpec` with an `up` vector (`cam/model/plan.ts:243`). The types allow any number of setups; the model planner accepts top and bottom only (`cam/model/setups.ts:40, 138, 171`).

**Two-sidedness is special-cased in at least nine places:** tabs when `setups.length > 1` (`plan.ts:1995`); the opposite surface is always `perSetup[0]` (`plan.ts:2030`); registration is always against setup 0 (`plan.ts:1354`); every saved side is read as top or bottom (`engraveGenerate.ts:6503`); locating holes read `sides[1]` only (`:6603`); the band conversion tests `up[2] === -1` (`:5333`); `SetupFlip` is one axis and one turn; `JobSetupPins` is exactly two; `flipTabBands` is one plane and two bands.

**Each side plans the whole goal** in its own frame, limited by a depth band. Nothing subtracts what another side already cut, except the last setup's freeing contour.

**The goal check is one side only.** A goal cut from more than one side is returned "unchecked" (`engrave/goalCheckInput.ts:61-86`). `unionWholeSurface` (`cam/model/wholeSurface.ts:91`) has no caller. The carried stock between setups is refused for 90° side setups (`setups/carry.ts:123-125`).

**On the rotary:**
- Rotation relief uses one cutter for rough and finish, a single-valued radius field (no undercuts), and full turns at constant X for roughing (`rotaryRelief.ts:336-408`). On the panther, 491,000 of 1,244,000 map cells are air.
- Most 2.5D operations are refused: through-cuts, cut-outs, chamfers, traces, drilled holes, threads, inlays, facing (`rotary/findings.ts:113-131`).
- Indexed faces are `job.faces`, not setups, and a goal on a rod takes no manual setups (`engraveGenerate.ts:7488-7506`).
- There is no turning operation. The A axis is modelled as unbounded, the post unwinds whole turns (`post/z1.ts:372-377`), and a continuous spiral exists only as a test fixture.
- Time is modelled twice: the verifier uses the surface-speed formula with the 60°/s cap (`verify.ts:762-767`); the cycle estimate uses arc length at the design radius with no cap (`cam/ir.ts:558-587`).
- The jaw keep-out, tailstock band, tailstock body and turn clearance are code constants (`rotary/wrap.ts:41-53`, `rotary/tailstock.ts:22-30`). The rod's axis and face angle are measured datums on the bed profile.

### 2.7 What Makera's own sources say (checked for each unknown)

Sources, each marked where it appears: **public**: the firmware source (MakeraInc/MakeraZ1Firmware, `main` as read 2026-10-05: `src/modules/robot/Robot.cpp` and `configZ1.default`), the sample programs `NefertitiRough.nc` and `NefertitiFinish.nc` (MakeraInc/CarveraController, `src/gcodes/Examples/`, GPL-3.0; MakeraInc/CarveraProfiles release `1.4.6_sample`, no licence stated; fetched by `scripts/fetch-reference-gcode.mjs`, pinned, never committed), and the Makera wiki and MakeraCAM user guide (URLs beside each fact). **Ours**: measurements we took of those files and on our machine. **Kept on the share, not public**: what was read from Studio's installed binary and library (`docs/reverse/makera-studio/README.md`).

**How Makera cuts a figure on the rod.**
- Its own programs (`NefertitiRough.nc`, `NefertitiFinish.nc`, published as above; the figures here are **our measurement** of them) are **helices**. Roughing: one full turn of A per 1.39 mm of X at constant Z, layer by layer (Z 22, 19, 16 … 8). Finishing: a slower helix, 0.1175 mm of X per turn, with Z following the model as A sweeps (89,198 moves change Z and A together). A runs to −153,720° and is unwound at the end with `G92.4 A0 S0`. Y is 0 throughout. Feeds are 1,125–1,500 (`/Rotary.md` §1.1).
- **The finish passes below the rotary axis:** 3,847 moves at Z ≤ 0, down to Z −5. A "radius from the axis" field cannot describe that (`/Rotary.md` §1.1 item 6).
- Studio's 4-axis generator is a separate core with its own roughing and finishing method (heightmap roughing around the axis, finishing by slices across it). The detail was read from Studio's installed binary and is kept on the share, not public.
- Makera's operation list and rotary dialog (Direction Horizontal or Vertical, Use Tailstock, ramping, fixed angle) are in the MakeraCAM user guide (<https://wiki.makera.com/en/software/MakeraCAM_userguide>). The class-name read of Studio itself is kept on the share, not public. The guide lists no turning operation and no wrap of 2D vectors; both would be ours.
- Makera's guide cuts roughing and finishing as two jobs and vacuums between them, with no dust collection and no auto-levelling on the rotary (wiki, Carvera 4th-axis relief, <https://wiki.makera.com/en/carvera/manual/4th-axis-relief>).

**The controller.**
- Feed on a rotary move is a surface speed over a perimeter of 2π·r + 30 mm per turn, then capped by the A axis's maximum rate. This is read from the public firmware source (`Robot.cpp`, MakeraInc/MakeraZ1Firmware), not guessed.
- A is unbounded; `G92.4 A<v> S<n>` drops whole turns.

**The origin.**
- "The 4th-axis zero point is preset in the software at the center of the right edge of the spindle" (Z1 4th-axis quick start, <https://wiki.makera.com/en/Z1/Accessories/4Axis>). Y is fixed; X is stated relative to the right edge of the headstock; the Z probe position is fixed (Carvera relief guide, <https://wiki.makera.com/en/carvera/manual/4th-axis-relief>).
- The firmware holds the preset as `coordinate.rotation_offset_x/y/z`; our machine's config reads −7.5 / 69.0 / 17.0 (our reading, bench day 1, 2026-10, `docs/bench/2026-10-bench-day-1.md`) (`docs/design/rotary-flow.md:223`).
- Work Z is the distance above the rotary axis; Makera's clearance rule is half the stock diameter plus 3 mm. (MakeraCAM user guide, <https://wiki.makera.com/en/software/MakeraCAM_userguide>).

**The chuck.** The jaw setup follows the stock size by our chosen setting, not measured: under 20 mm standard jaws; 20–35 mm reverse jaws, inner teeth; over 35 mm reverse jaws, outer teeth. The wiki says only that reverse jaws are fitted by default for larger work (<https://wiki.makera.com/en/Z1/Accessories/4Axis>). The cutter recommendation reads the chuck diameter.

**The 3D probe.** The freely downloadable Makera software asks the operator for a "Probe Diameter"; the wiki (<https://wiki.makera.com/en/Makera-Accessories/Makera-3D-Probe>) says the probe is factory-calibrated and publishes no ball size. So the diameter is an operator-stated value in Makera's own software, which is what #1200's fields rule.

### 2.8 What is sound

Feature recognition (`cam/model/features/*`), the drop-cutter and its index, the row sampler, linking, the IR (`cam/ir.ts`), both posts, `verify.ts`, the G-code interpreter and timeline, the column engine's core, and the goal check's verdict rule are self-contained and are kept.

---

## 3. Why the earlier height-field engine was rejected, and why this is not that

The 2026-11-03 plan and the 2026-11-05 review rejected a planner that sampled the goal to a 0.1 mm height field and planned moves on it. This design uses grids again, so each reason is answered.

| Reason it was rejected | This design |
|---|---|
| Posted Z came from interpolating grid samples; a ball read about (pitch/2)·tan θ high on a slope | No posted coordinate comes from a grid. Fields decide; exact drop-cutter on triangles places every point |
| A gridded leftover mask dropped cells on steep flanks (`plan.ts:5272-5279`) | Fields carry a lower and an upper bound per cell (§4.2). A cell the bounds cannot classify is resolved exactly, never dropped |
| A cell cap silently coarsened the pitch; budgets refused the tray | The decision pitch is a registry value with a stated error bound, coarse by intent. No cap changes it silently, and no budget refuses a job |
| Every model was treated as a surfacing problem | Feature recognition stays first. Pockets, contours and rims are decided on exact polygons, not on a field |
| 23 h, 7,889 rapids | Toolpath generation and linking are the current engine's, unchanged |

---

## 4. The design

### 4.1 One pipeline

```
job ─▶ features ─▶ fields ─▶ select ─▶ toolpaths ─▶ IR ─▶ post ─▶ verify ─▶ simulate + goal check
        (kept)     (new)      (new)     (kept,        (kept)  (kept)  (kept)   (one engine, once)
                                         simplified)
```

Every job kind enters the same pipeline. An engrave, a pocket, a drill and a mesh goal differ in the features they produce, not in the path they take.

### 4.2 Fields

Computed once per setup and shared by the owned and the ideal selection.

**Reach of flat cutters (2.5D features): exact polygons, no grid.**
For each pocket or region at each floor level, and for each distinct flat diameter d in the shop and the catalogue, the area a cutter of that diameter can clear is the morphological opening of the region by a disc: inset by d/2, then outset by d/2. Clipper already does both. Openings are nested (a smaller cutter reaches everything a larger one does), so the family is stored as increments: what diameter dᵢ adds over the next larger. With about 40 distinct diameters this is about 80 polygon offsets per level per region.

**Leftover of ball and cone cutters (3D surface): a bounded field.**
The goal is sampled to a grid in which each cell stores the lowest and highest Z of the surface over that cell, not one sample. The cutter-location surface of a tool is the surface dilated by the tool's shape (a max-plus convolution), computed on both bounds. This gives, per cell and per tool, a guaranteed interval for where the tool tip can sit, and so a guaranteed interval for what that tool leaves behind.
- A cell whose interval is entirely above or below a threshold is classified.
- A cell whose interval straddles it is **ambiguous** and is resolved by exact drop-cutter. Ambiguous cells lie along steep flanks and feature edges, which is where the withdrawn gridded mask failed.
- A min/max pyramid of the field lets most cells be classified from a coarse level without evaluating the full kernel.

**Depth.** Each feature carries its depth; each cutter its stated flute length. Reach is a hard constraint, as today (`sequence.ts:479-511`).

**Decision pitch.** A registry value, `plan.decisionPitchMm`, recommendation 0.25 mm. It affects only selection estimates and the count of ambiguous cells, never a posted coordinate.

### 4.3 Selection

**One selector.** It replaces the smart pick's full finalists, the ball rank, the virtual ladder and the sequence pricing loop.

**The objective is unchanged** and stays lexicographic (`sequence.ts:1035-1047`): leftover first, then failures, priced seconds, bit changes, catalogue steps, fallback-feed steps, flute sum, signature. The pick's fidelity measures for engraving (text, pinches, counters) are already coarse geometric measures (`planEvaluate.ts:585`) and become the leftover term for those features.

**Pricing a candidate from the fields:**
- *Leftover* of a chain = the area or volume outside the union of what its cutters reach. Read from the stored increments.
- *Time* of a step = path length ÷ feed, with path length = area ÷ step-over per level for clearing, perimeter for contours, and area ÷ scallop step-over for finishing, on the feed row that cutter really runs. Plus the priced bit changes (#1114).
- *Rest* of cutter j after cutter i is the increment between their openings. This is the quantity the current code obtains by posting, parsing and stamping the prefix.

This costs microseconds per candidate against a minute or more today.

**The search.**
- Where reach is not limited by flute length, openings are nested and the chain is a shortest path through cutters sorted by diameter, with tuple weights compared lexicographically. Because a bit change is priced from the preceding program (`sequence.ts:941`), the state is (previous, current) cutter: about 4.6 million transitions for a 166-cutter catalogue, which is milliseconds.
- Where flute length limits reach, nesting breaks. The selector then searches cutter subsets directly, after the exact dominance prune #1192 already defined. At microseconds per candidate this is affordable where it was not before.
- The ball, the chamfer cone and the freeing cutter are further stages with their own candidates; the freeing cut may return to an earlier cutter, as today (`sequence.ts:798-808`).
- Flip jobs: per setup, with the sibling-merge rule applied across setups as today.

**Owned and ideal** are two runs of the selector over the same fields. The tradeoff line is available at once; nothing is deferred.

**Confirming the model.** The selector returns its best K chains (`plan.proposalTopK`; the key is defined on #1192's branch and is registered with the slice that lets the selector decide). The real planner runs on the first. If its priced seconds differ from the estimate by more than `plan.estimateTolerancePct` (new registry entry, recommendation to be set from the slice-3 measurement), the next chain is planned too and the better real result wins. The receipt states the estimate, the real figure and how many chains were planned.

### 4.4 Toolpaths

The current ops, with three changes:

1. **Rest regions come from the fields** (§4.3), not from stamped prefix programs. `plan.ts` stops importing the post, the parser, the emulator and the simulator.
2. **Masks come from the bounded fields.** The finish and rest masks classify cells from the intervals and call exact drop-cutter only for ambiguous cells, in place of 18 exact queries for every cell.
3. **Closed-form edge contact** for ball and cone cutters; the golden-section search stays only for the bull nose.

Ordering and linking are unchanged. The air-fraction and rapids acceptance lines (§8) decide whether more is needed; a level-tree ordering for Z-level roughing is noted in §11 and is not part of this design.

### 4.5 Proof

- **One simulator:** the column engine, for every cutter shape. The exact solid sweep and the stamp are retired.
- **Run once,** on the posted programs, after Generate. Never inside selection or planning.
- **Independent:** the simulator and goal check import nothing from the planner or the fields module, and sample the goal with their own code. A source-gate test enforces both directions.
- **The verdict rule is unchanged** (coverage, bands, adjudicated cut-into, the five excuses). Moving the verdict from the stamp to the column engine is a change of method, so `SIMULATOR_VERSION` becomes 9 with a re-score and re-pin in the same commit, per the standing rule.
- **Unchecked is not ok.** A goal that could not be checked is a failure that names why.
- **One grid cap** for any goal sampling, a registry value.

### 4.6 Generate

- One orchestrator used by the app, the CLI and the house runs service: features → fields → select → plan → post → verify, then the proof.
- One post/verify/hash loop.
- A real cancel signal passed all the way down (an `AbortSignal` exists but is not passed today, `engraveGenerate.ts:7522-7532`).
- Progress reports the true stages: fields, selecting, planning (per program), posting, checking.

---

## 4A. The general model — every capability is an instance of it

**Ruling this section answers (maintainer, 2026-11-11):** the design covers the full capability set from the start; limits and unknown dimensions are run-time data. The engine is not redesigned again to put the panther on the 4th axis.

Sections 4.1–4.6 describe the pipeline for one fixed setup seen from above. That is one instance. The engine is built on four general things, and every job kind is a choice of values for them.

### 4A.1 Pose

A **pose** is where the part sits relative to the machine: a rotation and a translation, with the hold that keeps it there. Any rotation, not only six faces.

- A job has a list of poses. One pose is today's single-sided job.
- A pose may be **fixed** (the operator placed it) or **driven** (the A axis placed it). A driven pose is a one-parameter family: the same hold, turned by an angle.
- Going from one fixed pose to another is an operator action (a flip, a re-seat) with a price in seconds and a registration method. Going between driven poses is a machine move with a time.

### 4A.2 Chart

A **chart** is how a pose sees the part: two coordinates across and one along the tool axis.

| Chart | Across | Along the tool | Used by |
|---|---|---|---|
| **Planar** | x, y | z | Any fixed or indexed pose: the tool comes straight down |
| **Cylindrical** | x along the rod, angle θ | signed height along the tool, measured from the rotary axis | Continuous rotary: the tool points at the axis while the rod turns |
| **Profile** | x along the rod | the same height | Turning: the cylindrical chart with θ collapsed to its outermost value |

The cylindrical chart's height is **signed**, not a radius. Makera's own finishing program takes the tip 5 mm below the rotary axis where the part's section is thin and off-centre (§2.7). At each angle the chart is the centre line of the planar chart for that angle, so a height below zero is ordinary. Today's relief planner uses a radius and refuses everything within 2 mm of the axis; that refusal goes away.

Everything in §4.2 is defined on a chart, not on "the top view":
- **Surface bounds:** per cell, the goal's height along the tool axis as a guaranteed interval.
- **Tip bounds:** the surface dilated by the cutter. In the planar chart the cutter's footprint is the same everywhere. In the cylindrical chart a surface point at angle offset Δθ and radius r′ sits r′·sin Δθ to the side of the tool and r′·cos Δθ along it, so the same formula is evaluated with those two numbers. One function, the chart supplies the geometry.
- **Flat reach:** polygons in the chart's own across-plane. On the cylindrical chart that is the unrolled map, with the across-rod scale the existing wrap code already computes.
- **Cell size:** a chart states the real size of a cell (on the cylindrical chart, arc length = r·dθ), so areas, volumes and times are in millimetres on every chart.

### 4A.3 One stock, cut from every pose

The remaining material is one object for the whole job. It is stored as **one height field per chart that has cut it**, plus the blank: a point is still material when it is inside the blank and below every chart's field at that point. A cut in any pose only ever lowers that pose's own field, so the representation is exact for what a 3- or 4-axis machine can do, for any number of poses and any mix of planar and cylindrical charts.

From it, for any pose about to be planned, the planner reads the surface that pose starts from (the blank, less everything earlier poses removed). This replaces the depth band as the way sides share the work: a side no longer plans the whole goal and stops at a plane; it plans what is left that it can reach.

The proof (§4.5) keeps its own copy of the same idea, built from the posted programs, and judges the **whole goal surface** after all poses: each piece of the goal's surface is checked in a chart that sees it.

### 4A.4 Which pose cuts what

For each candidate pose the fields give the part of the goal's surface it can finish: visible in its chart, within the cutters' reach, and outside the hold's keep-outs. Choosing poses is then one more selection, on the same objective as §4.3 and decided the same way, from the fields:

1. **Coverage first.** Add poses while they add reachable surface above the tolerance (`plan.leftoverEquivalencePct`).
2. **Then time.** A fixed pose costs its operator action and its registration; a driven pose costs its A move; continuous rotation costs nothing extra.
3. Each piece of surface is assigned to the cheapest pose that reaches it; a piece two poses reach is cut once.

Candidate poses come from the hold: a vise offers the six faces; a bracket or tape offers top and bottom; the chuck offers every angle (indexed) and continuous turning. A job may fix its poses (the operator's stated flip) and the planner honours them.

This generalises today's `goalFlipPlan`, which scores six faces by visible area and offers one flip.

### 4A.5 One clock

Time comes from one function that takes a move and the pose's **kinematics**: which axes move, each axis's rate and acceleration limits, and what the controller's feed word means for that combination. The selector's estimate, the IR's cycle estimate and the verifier's warning all call it. For the rotary that means the 60°/s cap and the surface-speed formula are applied once, everywhere, and a slow A axis shows up in the estimate before it shows up at the machine.

### 4A.6 Limits are records

Every limit the planner uses is read from a record with its provenance, at run time: axis travel, rates and the stock envelope from the machine profile; the chuck's jaw keep-out, the tailstock's body and band, the bracket's arms, the vise's jaws and the clamps from the accessory and hold records; the rod's axis, the jaw face and the face angle from the bed profile's datums. A value that is a default or unmeasured is used as recorded and stated on the sheet. Whether the machine may run an unmeasured setup is the run gate's decision (#1202), not the planner's: the planner always produces a plan.

The constants this moves to records: `ROTARY_JAW_KEEP_OUT_MM`, `ROTARY_TAILSTOCK_BAND_MM`, the tailstock body (`rotary/tailstock.ts:22-30`), the turn clearance (`rotary/wrap.ts:53`), the envelope fallback (`wrap.ts:56-57`).

### 4A.7 The capabilities, as instances

| Capability | Poses | Chart | Operations | What is new against today |
|---|---|---|---|---|
| One-sided job | 1 fixed | planar | all | nothing |
| Two-sided flip | 2 fixed, a half turn apart | planar each | all | sides share one stock; whole-surface check; cutters and bit changes priced across both |
| Any-sided job (side faces in the vise) | up to 6 fixed | planar each | all | the model planner accepts any face, not only top and bottom |
| Indexed 4th axis | N driven angles on the chuck | planar each | all 2.5D and 3D operations at each angle | pockets, drills, chamfers, threads and contours become available on the rod; no operator action between faces |
| Wrap | continuous | cylindrical | engrave, pocket, trace on the unrolled map | goes through the same selector and proof |
| Rotation relief (the panther on the rod) | continuous | cylindrical | rough, rest, finish, pencil with the selector's cutter chain | more than one cutter; rough by spiral; what the radial pass cannot reach is assigned to indexed poses by §4A.4 |
| Turning (lathe operation) | continuous | profile | rough to a profile, finish a profile, grooves, part-off | new operation; also the roughing stage of every rotary relief (remove everything outside the goal's envelope of revolution first) |

Two consequences worth stating plainly:
- **Undercuts on the rod.** A radius field is single-valued, so a continuous pass alone leaves undercuts. The model handles them by adding indexed poses for the surface the radial pass cannot see, chosen by coverage and time like any other pose. That is the combination a figure on the rod needs.
- **Turning is not a separate engine.** It is the profile chart: one curve, radius against length. Flat reach along that curve is one-dimensional, the path is a spiral (A continuous, X advancing a step-over per turn), and time comes from the one clock.

### 4A.8 What changes in the data model

- One setup record. The document's `JobSetup`, the setups engine's `Setup` and the planner's `SetupSpec` become one description of a pose, with a kind (`fixed` or `driven`), its rotation, its hold and its registration.
- Indexed faces (`job.faces`) become driven poses. A goal on a rod may have poses.
- The nine two-sided special cases in §2.6 are replaced by rules over the pose list: tabs and release belong to the last pose that holds the part by them; registration is carried from the pose before; locating features are planned for each fixed-to-fixed transition.
- `SetupFlip` (one axis, one turn) and `JobSetupPins` (exactly two) become properties of a transition between two poses.
- The depth band stays as an operator's statement ("do not cut below here from this side"), no longer the mechanism that divides the work.

### 4A.9 What is not known

After checking Makera's sources (§2.7), most of what the first draft listed here is answered:

- **A continuous spiral on this controller:** answered. It is how Makera's own rough and finish programs move, at F 1,125–1,500, and the feed arithmetic is read from the firmware.
- **The origin:** answered in kind. It is the firmware's preset at the centre of the headstock's right edge, with this machine's `rotation_offset` values on record. What the bench still owes is the sign of +A and the measured offset from that preset to the jaw tips for each jaw setup.
- **Near the axis:** answered by design. The chart's height is signed, so passing the axis is ordinary (§4A.2).

Still to be measured, as inputs with provenance:

- Whether the 60°/s A cap binds on small radii at the vendor's feeds, and by how much the estimate must slow.
- The tailstock body's real dimensions and the jaw tips' reach for the three jaw setups.
- The cost of reading one pose's start surface out of several charts on a large job. It is a field computation of the same order as the tip bounds; it is measured when it is built.
- The 3D probe's ball diameter: operator-stated, as in Makera's own wizard.

## 5. Standing rulings this design keeps

Facing off by default. Ideal as a recommendation, never a gate; owned plan is the default; no refusal where an owned tool can do the job. Catalogue feed rows, with the row named. No budgets: a refusal on memory or time is a method defect. One program per tool. Fixtures are machine-fixed and never reflected in a flip. Rotary chuck keep-out and tailstock band. V-carve as a floor-correct pocket. Verdicts never excuse silence: a dropped region, cutter or run is stated. Every chosen number is a registry entry with a recommendation (#1207). Every tie names its key.

New registry entries introduced here: `plan.decisionPitchMm`, `plan.estimateTolerancePct`, `goal.maxCells`.

---

## 6. The contract that does not change

- **The job document.**
- **The IR** (`cam/ir.ts`): one tool and one file per IR; operations with name, depth, pass kind and moves.
- **The posts** and the posted bytes: the `;@MKR` and `;@CM` records and `TOOLPATH_START` markers that the simulator, restart, cut map and header matching read.
- **`EngraveGenerated`** as the UI, the freeze, the receipt and the run sheet consume it: `programs[]` with `setupIndex`, `setupId`, `toolKey`, `nc`, `programHash`, `verify` and the per-program fact blocks; `plan`, `planIdeal`, `planTradeoff`, `planStatements`, `runCycle`.
- **The package hash:** job fingerprint + program hashes + simulator version.

Three leaks into planner internals need a stated field in place of a reach into the plan:
- `engrave/restoredRun.ts` (#1126, resolved): reads no plan IR. Each program carries `verifyContext` (`minRapidZ`, `outsideAllowancesMm`, `throughKerf`, `depthLimit` as its stored composition, `topLiftMm`, `itemProgram`; the frame trace has its own), stored by the path that posted it from the facts its first verification used; the plan reaches the page only as a `PlanSummary` (`engine/cnc/engrave/planSummary.ts`), and `restoredRun` asks it only whether each program's setup has an entry.
- The CLI reads `plan.ladderRows` and `perSetup[].clGrid` (`scripts/lib/casemaker/engrave.ts:1286, 1893`).
- `src/testing/windowApi.ts` reads `plan.perSetup`.

---

## 7. Keep, replace, delete

| Area | Action | Notes |
|---|---|---|
| `cam/model/features/*` | Keep | |
| `dropcutter.ts`, `triangleBins.ts`, `rowDropper.ts`, `linking.ts`, `footprintIndex.ts` | Keep | Closed-form ball and cone edge added |
| `cam/model/ops/*` (rough, finish, rest, pencil, pocket, contour, chamfer) | Keep, simplify | Masks and rest regions from fields; `rough.ts`/`rest.ts` duplication merged |
| `cam/model/plan.ts` (6,376) | Replace | Becomes a thin planner over ops; stamping, ball rank, ladder, statements and feeds move out or go |
| `cam/model/sequence.ts` (1,400) | Replace | By the selector; constraints and tie keys carried over |
| `cam/model/twoPlans.ts` | Replace | Two selector runs |
| `engrave/smartPick.ts`, `workers/sim/planEvaluate.ts`, `smartPickRun.ts`, rank and pick pools | Delete | One selector |
| `workers/geometry/sweep.ts` (2,152), `workers/sim/sweptPoint.ts`, stamp caches | Delete | One simulator |
| `workers/geometry/columnEngine.ts` core | Keep | Becomes the verdict's engine |
| `engrave/designCheck.ts` verdict rule, `verify.ts`, `gcode/*`, `emulator/*` | Keep | |
| `workers/sim/session.ts` (1,846) | Replace | Routing between engines disappears |
| `workers/sim/engraveGenerate.ts` (9,157) | Replace | One orchestrator |
| `engrave/oracle.ts` | Review | It compares the simulation with the CAM's own prediction; the code calls this "the CAM grading its own homework". Keep only if it finds something the goal check cannot |
| Legacy 2.5D `cam/*` (pocket, profile, trace, chamfer, drill, thread, facing) | Keep as primitives | They become ops of the one pipeline; the model engine already uses them this way |
| `rotary/wrap.ts` (455) | Keep its geometry | The unrolling and the footprint scale become the cylindrical chart's across-plane (§4A.2) |
| `cam/rotaryRelief.ts` (415), `rotary/radialField.ts` | Replace | Rotation relief becomes the pipeline on the cylindrical chart (slice 7b); the radial sampling is kept as that chart's surface sampler |
| `cam/indexed.ts` (283), `rotary/faceOps.ts`, `job.faces` | Replace | Indexed faces become driven poses with ordinary ops (slice 7a) |
| `cam/model/setups.ts`, `setups/*`, `engrave/goalFlipPlan.ts`, `goalFlipSetups.ts` | Replace | One pose record and pose selection (§4A.4, §4A.8); the reflection and Z0 carry rules are kept |
| `cam/model/wholeSurface.ts` | Use | The whole-surface union has no caller today; the proof needs it |
| `cam/chamfer3d.ts`, `cam/moveWire.ts` | Delete | No importers outside tests |
| Registration, run, post, UI | Untouched | |

---

## 8. Acceptance

**Unchanged outcome lines** (plan v2 §3), on the vendor reference parts, in the vendor's holding: coverage ≥ vendor − 1 pt and ≥ 95 %; cut-into 0 beyond the edge-break allowance; cycle ≤ 2× vendor; air fraction ≤ vendor + 10 pt; rapids per 1,000 feed lines ≤ 2× vendor; cutters ≤ vendor + 1; posts as filed.

**New lines for this design:**
- **Equal or better choice.** On Set B, the pot lid, the organizer and the 33 samples, the selector's chosen plan is equal to or better than today's by the same lexicographic objective, judged on the real plan and the real check. Each difference is listed with its key.
- **Count.** One Generate runs the real planner at most K times per setup and the simulator once per posted program. The receipt states both counts.
- **Estimate error.** The selector's time estimate against the real priced seconds, per job, reported; the tolerance is set from this.
- **Bounds property.** For random meshes and tools, the exact drop-cutter value lies inside the field's interval at every sampled point; no ambiguous cell is ever classified without the exact query.
- **Independence.** A source-gate test: the simulator and goal check import nothing from the planner, the selector or the fields; the planner imports nothing from the post, parser, emulator or simulator.
- **Determinism.** The same job and shop produce byte-identical programs across runs and worker counts.

---

## 9. Cost, stated before anything is built (review rule §8.9)

These are arithmetic estimates and must be replaced by measurements in slice 0 and slice 2.

| Stage | Iterates over | Estimate for the tray (160 × 126 mm) |
|---|---|---|
| Flat reach | regions × levels × ~40 diameters × 2 polygon offsets | Thousands of Clipper offsets; seconds |
| Ball/cone fields | cells × kernel samples, pruned by the pyramid; 0.25 mm → 320,000 cells; a ⌀6 ball kernel ≈ 450 samples | ≈ 1.4 × 10⁸ operations per tool before pruning; well under a second each |
| Selection | ≤ 4.6 M transitions, or pruned subsets | Milliseconds to seconds |
| One real plan | as today, less the mask and stamp work | Today's single owned pass is about 220 s on the pot lid; the mask change should cut it, by how much is not known |
| Proof | posted moves on the column engine | Seconds per program |

**Target:** tray Generate under 2 minutes on dave-1, owned and ideal both stated. If slice 0 shows the single real plan alone exceeds that, the mask work in §4.4 is the next lever, and the target is restated with numbers.

---

## 10. Slices

Each slice lands alone, is measured before the next starts, and leaves the app working.

0. **Measure.** Instrument today's Generate on the tray, the lid and the organizer: counts of real plans, step plans and simulations; wall time by phase. This is the baseline every later slice is judged against. No behaviour change.
1. **Defects that stand regardless:** unchecked-is-ok; the 4 M / 20 M cap mismatch; closed-form ball and cone edge contact (parity fixtures prove the same Z).
2. **Fields module.** Flat reach by polygon opening; bounded goal field, dilation and pyramid; the bounds property tests. Used by nothing yet. Its cost line is measured here.
3. **Selector, in shadow.** It runs beside today's pick and sequence choice and logs its choice, its estimate, and the real figures. The "equal or better" and "estimate error" tables come from this. No behaviour change.
4. **Selector takes over.** The smart pick's finalists, the ball rank, the ladder and the sequence pricing loop are removed. Rest regions and masks read the fields. `plan.ts` loses its simulation imports.
5. **One simulator.** Verdict on the column engine; `SIMULATOR_VERSION` 9; re-score and re-pin; the solid sweep and the stamp are deleted.
6. **One orchestrator.** `engraveGenerate.ts` and the store/CLI duplicates collapse; cancel signal; honest progress stages.
7. **Legacy item paths join the pipeline** as features and ops.

The general model of §4A is built in this order. Each line is a slice of its own, in the same style, and none needs the engine redesigned:

| Slice | What it adds | Depends on |
|---|---|---|
| 2b | Charts: the fields module takes a chart; cylindrical and profile tip bounds; cell sizes in mm | 2 |
| 2c | One stock from many charts: the start surface of a pose | 2b |
| 3b | One clock: a single time function with per-pose kinematics, used by the estimate, the IR and the verifier | 3 |
| 4 | The selector decides, **over the pose list** (§4A.4), not one side at a time | 2c, 3, 3b |
| 4b | One setup record; the two-sided special cases become rules over poses | 4 |
| 5 | One simulator, whole-surface check across poses | 4 |
| 7a | 2.5D items and indexed faces as poses and ops | 4b |
| 7b | Rotation relief through the pipeline (the panther on the rod), with indexed poses for undercuts | 2b, 4, 7a |
| 7c | Turning: the profile chart, spiral roughing and finishing, grooves and part-off | 2b, 3b |
| 7d | Rotary limits from records (§4A.6) | 7a |

### The sequence (analyst's choice; maintainer, 2026-11-11: "you choose what to sequence for success. There will be no bench time until the software is done.")

The first shadow run (#1216) set the order. It showed that coverage can be decided from the fields, that the time estimate is not yet good enough to decide alone, that the leftover tolerance is worth 1.8 h on the tray by itself, and that the first pocket step's own time, not the choice between chains, is what keeps us above the vendor.

Five tracks. Within a track the issues run in order; the tracks run side by side on different lines.

| Track | Purpose | Issues, in order |
|---|---|---|
| **A. Time now** | Take the hours out of today's plans with small, separate changes | A1 leftover tolerance in the chain rank (#1217) · A2 the same tolerance in the finishing-ball rank · A3 whatever the pocket-step comparison with Makera's program finds (feed row, step-down, step-over, the first cutter) |
| **B. Foundations** | The general model's parts, as new code nothing calls yet | B1 charts (2b) · B2 one stock from many charts (2c) · B3 one clock (3b) · B4 rotary limits as records (7d) |
| **C. The selector** | Replace candidate pricing by real planning | C1 estimate v2: contour priced, rest steps corrected, time from the one clock · C2 shadow v2 on every reference part, with the agreement table · C3 the selector decides, over the pose list (4) · C4 one setup record (4b) |
| **D. The proof** | One simulator, whole surface | D1 verdict on the column engine, `SIMULATOR_VERSION` 9 (5) · D2 whole-surface check across poses |
| **E. Capabilities** | Each as an instance of §4A | E1 2.5D items and indexed faces as poses (7a) · E2 rotation relief through the pipeline (7b) · E3 turning (7c) |

Gates between them:
- C3 does not start until C2's table shows the selector's pick equal to or better than the real planner's on the reference set.
- D1 follows C3, so the gate moves once, on plans that have stopped changing.
- E2 needs B1, B3 and C3. E3 needs B1 and B3 only, so turning can land before rotation relief.
- The baseline comparison (#1212) is re-run after A, after C3, and at the end.

Slices 0–3 as posted (#1213–#1216) are unchanged by §4A: the fields module's planar functions become the planar chart's, and the shadow selector prices one pose. Slice 4 is where the pose list matters, and it is not written until 2c and 3b exist.

Slices 0–3 change no decision. Slice 1 may move a posted feed word or a last digit, as its issue states. Slice 4 changes picks and therefore programs, so Set B and the cycle pins are re-pinned with reasons. Slice 5 changes the frozen gate and needs the maintainer's explicit yes.

---

## 11a. Rulings (maintainer, 2026-11-11)

Asked one by one; these replace the open list below.

1. **Direction: go.** Slices 0–3 start. Slice 4 onward waits for the shadow results and a further ruling.
2. **The gate moves to the column engine: yes, now.** `SIMULATOR_VERSION` 9 with the re-score and re-pin in one commit. The agreement table between the column engine and the stamp is reported with that commit, not as a precondition.
3. **The seven lines judge the full-catalogue plan.** The owned-shop plan is printed beside it as the tradeoff.
4. **Facing is off unless the job asks,** for every material. `cnc-job-workflow.md` §8.6 is corrected to match.
5. **Cycle basis: our estimator. Already settled on the bench.** Our air run on 2026-11-05 of Makera's published tray program (§2.5 source) took 4,576 s on the controller's clock; our estimator read 4,542.5 s (+0.7 %); the program's own header figure, 2,854.5 s, is 1.6× short (our reading of the header). The header is printed as a fact only. The earlier documents that call this test "still owed" are stale, and so was this document's first draft.
6. **The oracle is retired now.** Until #924's independent design check covers them, chamfers and cut-outs are checked by the verifier only; the receipt says so for those items.
7. **Leftover tolerance: yes, 0.5 points of coverage.** Registry entry `plan.leftoverEquivalencePct`. Chains within it are equal on leftover, and time and bit changes decide. The receipt states when it decided a pick.
   **Amended by the analyst, 2026-11-11, on evidence (#1219, #1224):** the tolerance never forgives *tall* leftover. On the tray it let the pick drop a rest pass that had been removing 1,530 cells standing 5.77 mm (0.11 points by count, a fin by height). With the tolerance on, fewer cells standing more than `plan.leftoverTallMm` (1.0 mm) always ranks first, and the 0.5 points apply only between chains with the same tall count. Reported to the maintainer as a refinement of his ruling.

## 11. Open decisions as first put (superseded by 11a)

1. **Go or no-go** on the direction, and whether slices 0–3 (no behaviour change) may start before the rest is ruled.
2. **The gate moves engines** in slice 5 (`SIMULATOR_VERSION` 9). Accept, or keep the stamp as the verdict and use the column engine only where it is used today.
3. **Which cutter set the seven lines judge** on reference cards: the vendor's set (engine note §7) or the owned plan (§4, #975). The documents disagree.
4. **Facing default.** `cnc-job-workflow.md` §8.6 says rough or unknown stock turns it on; the 2026-11-05 ruling says off. This design follows the ruling.
5. **Cycle basis.** Our estimator reads Makera's published tray file at 76 min against its 47.6 min header (our reading), and the bench test of which is right is still owed. The estimate-error line in §8 depends on it.
6. **The oracle** (`engrave/oracle.ts`): keep or retire.
7. **A tolerance on leftover.** Today any gain in leftover outranks time and cutter count, which is how the organizer reaches 12 cutters and 6.7 h (§2.5). Proposal: two chains whose leftover differs by less than a registry value (`plan.leftoverEquivalencePct`, recommendation 0.5 points of coverage, the same threshold already proposed for the tradeoff line) are equal on that key, and time and bit changes decide. This changes picks and needs your ruling.

---

## 12. Risks and what is not known

- **Nothing here is measured.** Slice 0 exists to fix that before any code is replaced.
- **The estimate may rank wrongly** where linking, acceleration or feed limits dominate (many tiny regions, deep narrow slots). The top-K confirmation is the guard; slice 3 measures how often it fires.
- **Flute-limited reach** breaks the nested structure. The subset search covers it, but its size on the 166-cutter catalogue is not yet known.
- **The bounded field's ambiguous share** on organic meshes (the panther, the elephant) is not known. If most cells are ambiguous the field saves little there, and those jobs keep today's cost for masks.
- **The column engine as verdict** has only been a diagnostic so far. Its agreement with the stamp on the reference set has to be shown before slice 5.
- **Rotary and setups are now reviewed** (§2.6) and designed (§4A). Still not reviewed: the PCB isolation path, assumed to enter as 2.5D features in slice 7a.
- **The rotary's unknowns are bench facts,** listed in §4A.9. They are inputs with provenance; none changes the design.
- **Not in this design:** tree-ordered Z-level roughing (cutting each basin to depth before leaving it). The review found ordering is not the bottleneck; it becomes worth doing only if the air-fraction or rapids lines fail.
