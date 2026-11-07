# The engine rebuild at 30 hours — review, and the issue/milestone tweaks (2026-11-05)

*Written against plan v2 (`2026-11-03-plan-v2.md`) after reading every commit on `main` and the
candidate branches since 2026-11-03, the design note (`docs/design/cam-model-engine.md`), the five
12-hour reports on #943, and all 306 comments (867 KB) on #943, #948, #955–#969. Nothing here
was run on the bench. Where a number comes from a thread it is the thread's own, with the issue
named; where it comes from the clone it was checked here. The sections to edit from are §5 (per-issue
tweaks) and §6 (milestones). §7 lists what only the maintainer can decide.*

---

## 0. Verdict in six lines

1. **The method is right and the engine exists.** `cam/model/` is 19 files, 6,628 lines, on
   `cand/engine-int` (126 commits ahead of `main`, zero of them merged). It plans the tray and the
   organizer the old engine refused, with the vendor's cutters, and the gate that judges it is
   independent and has Makera's program beside every card. That is what plan v2 asked for.
2. **The two acceptance parts do not pass.** Tray 4/7 lines, organizer 3/7 (#964, 04:28Z and
   04:56Z). Coverage crossed 95 % on both inside a day; cycle, air and rapids have not.
3. **Breadth ran ahead of depth.** The figures (#965), integration (#966, eighteen branches), the
   operator UI (#963, five rounds against a fixture plan), a 66-job breadth check, mesh repair for a
   mouse model and PNG reliefs all started in week 1. Plan v2 §8 put them in weeks 3–5, after the two
   parts pass. They cost sessions, reviews and merges without moving a single line on the two parts.
4. **Verdicts were made from tables and reversed by measurement, repeatedly.** Three manager rulings
   withdrawn, B's "real gouge" withdrawn in twelve minutes, E's chord claim withdrawn, the elephant's
   26 mm reading re-attributed three times, the datum settled over 21 hours in four modules. Each
   turn cost four to nine comments. Two pictures exist for the whole rebuild; the one plot that was
   drawn ended a circle in one comment.
5. **The yardstick moved.** The cycle line was judged against Makera's header (47.6 / 47.8 min) until
   04:07Z, then against our own estimator run over Makera's file (4,558 / 14,593 s). On the first
   basis the tray is 5.3× and the organizer 15×; on the second 1.32× and 2.34×. The plan's stop rule
   (3×) was breached on the first basis and never invoked. Only a clock settles which basis is true
   (§7, decision 1).
6. **Efficiency is the problem, not direction.** Seven sessions, 306 comments and ~90 branches in
   30 hours, peaking at 33 comments an hour; two sessions ran out of context; a token-reset pause.
   The fixes are process, not plan: one acceptance target, one integration branch, a picture before
   a verdict, rulings on the thread, and the stop rule applied as written.

---

## 1. Where it stands (checked in the clone and the threads)

| item | state |
|---|---|
| `main` | 4ba147e8. Carries the measurement side only: seven-line scorer, parity harness, #967 extraction, the goal check with wall/shadow/border exclusions (#948). **No `cam/model/` file is on main.** |
| candidate | `cand/engine-int` 2955e03b; `cand/engine-int-merge` 389ed57e (B's batching + F's catalogue door, "awaiting review/move"). 90 files, +16,069 lines vs main. |
| design note | `docs/design/cam-model-engine.md`, 773 lines, approved 11-04 01:52Z. Plan v2 gave it two days; it was written, reviewed, amended three times and approved in 2.5 hours. |
| branches touched since 11-03 | ~90 local and remote; `966-*` alone has eighteen. |
| sessions | A gpd-dave, B davebook-5, C d8, D c9, E 89, F f3, plus the manager. C and F restarted after their context ran out (#943 report 5). |
| pictures of the rebuild | two: `~/casemaker-manager/955-958-masks/ours/959-fb9fdaae/tray-cutinto-cells.png` (11-04 03:41) and `~/casemaker-manager/plots/e959-row97-corrected.png` (11-04 23:52). E's other maps are under `/tmp` on dave-1 and were never cited by anyone else. |

**The seven lines, latest (F on #964, 531060a2 with the catalogue, then 292665e9 with batching):**

| line | tray (ours / Makera) | organizer (ours / Makera) |
|---|---|---|
| coverage | 98.37 % / 99.52 % — **fail by 0.15 pt** (line is vendor − 1) | 98.61 % / 98.98 % — pass |
| cut-into (adjudicated) | 0.00 % — pass | 0.04 % (one spot, ball 0.107 mm below a 45° ramp) — **fail** |
| cycle, header basis | 4.2 h / 47.6 min = **5.3×** | 12.3 h / 47.8 min = **15×** |
| cycle, like-for-like basis (our estimator on both files + 91.4 s per bit change) | 6,347 s / 4,817 s = **1.32×** — pass | 35,089 s / 14,992 s = **2.34×** — fail |
| air | 9.48 % / 9.88 % — pass | 42.4 % / 9.74 % — **fail** |
| rapids per 1,000 feed lines | 53 / 6 — **fail** | 20 / 2 — **fail** |
| cutters | 3 / 4 — pass | 4 / 5 — pass |
| posts as filed | yes, **on tape** (plan says the vendor's holding: the vise) | yes, on tape |

**The figures (#965, one setup each, no vendor reference):** elephant 89.61 % coverage, cut-into
6.12 % with a **26 mm maximum** (a "pocket-2" op at z −26.1 under the figure; E's final reading
04:48Z: "a 22 mm cut-through"), 15.8 h; panther 73.17 %, 0.00 %, 12.9 h, and after the link change
19.9 h. The coverage line did not move across five shas.

**The reference page (#955):** twelve vendor cards plus two candidate cards, all seven lines, all
with Makera's NC beside ours, local HTML only. The old engine's cards read ring box 10.7 h vs 23 min
and tool holder 29.5 h vs 37 min with "yes — matches" on the posts line; nobody applied the stop rule
to them either.

---

## 2. Is the work correct? Findings, most serious first

**C1. The cycle yardstick changed mid-stream, and the two bases disagree by 1.6×.** Plan v2 §3 says
"the app's own estimate (#927) ≤ 2× the vendor's". Until 04:07Z the vendor's number was the NC
header (2,854 s). F then ran our estimator over Makera's own file and got 4,558 s, found Makera's
per-toolpath times "impossible against the same toolpath's NC", and re-based the line (#964, 04:28Z,
headed "ruling", a test-only branch). The tray went from fail to pass without an engine commit. Both
readings are defensible; neither is verified. The estimator's own acceptance (#927: predicted within
10 % of the clock) was parked with the bench. **Until a clock says which is right, a card must print
both bases, and a line that passes on one basis only is not a pass.** The cheapest decisive test is a
timed air run of Makera's tray NC on the Z1 with no stock (§7.1).

**C2. The acceptance harness ran with no feed catalogue for about 24 hours.** Every cutter was fed from
the compiled 1.6–3.2 mm hardwood row (F400, step-down 0.6) instead of Makera's ⌀6 rows (F1000, 1.0),
so every cycle number before 04:28Z was roughly 2.5× too slow on the flats (#964, 04:07Z). The
organizer's "15×", the manager's report-5 correction, and an evening of attribution all rested on a
harness configuration error. The catalogue door is now in (`964-catalogue-cycle`); it must be the
default of every acceptance run, and the card must print which row fed each cutter.

**C3. Stay-down linking turned air into cutting time without shortening the path.** On the panther the
ball program went from 922 to 372 rapids per 1,000 and 34.8 % to 7.7 % air, and the cycle estimate
rose from 44,547 s to 71,555 s (#965, 04:23Z). The elephant's two ball finishes did the same. Air
and rapids improved because the retracts became feed moves along the same legs. That is the metric
moving while the part gets worse. The organizer's ball finish still "lifts between rows" (8,536 s of
rapid for 69 m of cut; the vendor's ball never lifts) and the new 4b rough is 84 % air (#964,
04:07Z). No one has drawn a link path. §4's picture set includes it.

**C4. A 26 mm cut-through on the elephant was carried as a table cell for 75 minutes and attributed
three ways** (silhouette class → underside-modelling question → "a 22 mm cut-through, A's safety
route is right"; #965 03:32Z, 04:23Z, 04:48Z). A pocket op planned 45 Z-levels under a figure. In a
posted program that is a safety defect, not a coverage statistic; it should have its own bug issue,
blocking #965, with a Z-section picture attached (§5).

**C5. The organizer's ball sits 0.08–0.115 mm below the exact CL at three posted points** (E, #959
04:12Z, standing after the row-chord claim was withdrawn). B spent two rounds and five synthetic
fixtures on a hypothesis the plot then retracted, without the STEP or E's run data ("no local access
to the real STEP files or E's run output", #959 08:38Z; "neither of us has the STEP", 03:58Z). The
long-pole programmer is working blind. Give B the licensed inputs on davebook-5 (they are local files,
not committed) before another synthetic attempt.

**C6. Facing is the largest single cost on the tray and is not in the plan.** The facing op was added
at #959 07:03Z as "a safety requirement" and by 03:49Z costs 8,574 s of the tray's 18,467 s; it
covers 91 % of the pocket interiors before the pockets cut the same skin (#964, 04:07Z). The
exclusion was tried and reverted because it made both parts slower (three rounds, #959 07:03–08:09Z).
Makera does no facing: its T1 "3D Relief" is a surface-following pass with the ⌀6 flat over the gentle
surface (615 s), which is plan v2 §4 M2 step 3 exactly. The fix is to replace facing with that op, not
to tune the exclusion.

**C7. The "posts as filed" line is judged on tape, not the vise.** Plan v2 §3 line 7 and V2-7 say the
vendor's own holding; the old engine's refusal of the tray was in the vise ("finish into both jaws").
Every candidate card says "bare bed, tape-down". The line is not yet measured.

**C8. Budgets and flags came back.** A 120 s plan-time pin (`planBudget965`), a 2,000-cell relief cap,
and the old caps all still present (removal-prep: zero deletions). Six flags and switches
(`USE_MODEL_CAM_ENGINE`, `CASEMAKER_MODEL_CAM`, `VITE_MODEL_CAM`, `setModelCamEnabled`,
`window.__caseMaker`, `setupsOverride`) landed in two hours on 11-05. A flag is a fair landing
mechanism; it needs a removal date on #966, or it becomes the second engine the plan forbade.

**C9. The gate rule changed five times on `main` in 30 hours with no `SIMULATOR_VERSION` bump**
(#948: strict footprint edge, wall/shadow on every goal job, border ∪ wall seed, the exact stamp, the
raw read beside the judged one). Each change re-scored every card and the vendor's own tray moved from
99.52 % to 99.25 % to 99.52 %. The gate must now freeze for the rest of the milestone; a changing
ruler cannot judge a changing engine.

**C10. The approval record is unreliable in two places.** The manager approved the design note
asserting C's contract was "carried in §3.6/§5"; it was not, because every reader had used
`gh issue view --comments | tail -N`, which drops the middle of a long thread (#956, 02:05:55Z). The
interface was rewritten three times in 65 minutes as a result. And the first drop-cutter was accepted
"within one grid cell" on a ±1 mm comparator; at 0.001 mm, 20 of 21 cases failed and the
implementation was replaced (#957, 10:01Z). Both are tooling defects worth one fix each: a thread
reader that returns the whole thread, and a parity tolerance set before acceptance.

What is right and should not be touched: the gate's independence (import-graph spec, exact stamp,
E's page agreeing bit-for-bit with the app at 4ba147e8); the vendor-beside-ours discipline on every
card; the reference parity against OpenCamLib and PyCAM at 0.001 mm; the prior-art notes before
code on #958, #961, #962; the §8-format 12-hour reports with a vendor-delta table; "no bench" held.

---

## 3. Is the work efficient? The patterns, with their cost

| pattern | evidence | cost |
|---|---|---|
| **Breadth before depth** | #965 began 11-05 01:09Z, #966 seam 01:03Z, #963 five UI rounds from 11-04 17:15Z, breadth check over 66 jobs (59 not goal jobs), mouse manifold repair, PNG reliefs, spawn-path fix ported twice — all while the tray reads 4/7 | eighteen `966-*` branches, three rebases forced by one fix, D's and A's full day, no change to either acceptance part |
| **Verdict first, picture never** | "REAL GOUGE" (#959 08:55Z) withdrawn 09:07Z; manager's sliver ruling withdrawn (#958 03:53Z); report-4 lists "three of my rulings corrected by measurement"; elephant attribution ×3; E's chord claim withdrawn after the first plot (04:53Z) | 4–9 comments per circle; ten circles counted on #959 alone (§3 of its digest) |
| **Stage added, side-effect fixed later** | 4b rough split posted the tray as 30 programs / 29 bit changes (+2,651 s) → batching added; linking made links feed moves → cycle doubled; facing added → exclusion → reverted | three stages, each with a follow-up commit and a re-score |
| **Review lists that grow** | A 6+2 → B 7 → manager 5 → manager 8 (item 8 with 5 sub-items) → 4a/4b → 3-item queue → "a real gap" | #959: 86 comments, 204 KB, four signed manager comments |
| **Rulings off the record** | at least nine citations on #959 of manager instructions, formulas and "ruling accepted" that appear in no thread; B at 06:03Z "waiting on the manager's queue order" with no answer on-thread; 07:39Z question never answered, feature reverted | re-asking, and an audit that cannot see why a decision was made |
| **Manager implementing and pre-approving** | item 5 "taken over while C's session is out of context" (#959 03:16Z); note approved two minutes before A's review (#956 01:29Z / 01:31Z) | the one reviewer is also an author; a review that asserted absent content |
| **Harness defects consuming engine rounds** | no catalogue (C2); `runsOf` counting unbatched runs; page cache keyed on the 40-char sha so a provenance paragraph was wrong; a degenerate fixture triangle read as a 4 mm anomaly; the island fixture floating 1 mm; `tsc -b` checking nothing so a merge was held | each one a comment pair plus a re-run on a loaded machine (organizer plan 340 s per run) |
| **Programmer without inputs** | B has no STEP, no run output, no page; E runs everything on dave-1 and relays | five synthetic repro attempts that could not reproduce what E's data showed |
| **Speed claims by synthetic** | triangleBins "435×" → "116×" → 0.99× / 1.02× on the real parts | a merge and a re-score for no gain |

What the volume looks like from the outside: the maintainer paused the team once for a token reset and
once for the weekly reset; peak 33 comments in one hour (11-04 01:00Z); 24 comments an hour sustained
from 03:00Z to 05:00Z on 11-05. The plan's week-1 calendar had three programmers active (B, F, E) and
A on a design note. Seven ran.

---

## 4. "Render it": what the coaching should become

Two pictures in 30 hours is the problem the maintainer named. The sessions cannot publish Artifacts
("I cannot publish an Artifact from this session", #959 08:42Z), so pictures went to `/tmp` and were
never cited. The rule below makes the picture part of the record and part of the verdict.

**The standard set, produced by E's acceptance run for every scored sha, committed under
`docs/bench/2026-10-28-z1-real-jobs/renders/<part>/<sha>/`, and linked from the card and the issue
comment:**

1. **Plan view of each posted program** over the model outline, moves coloured by Z, rapids in red,
   vendor's program beside it at the same scale. This is the one that shows the ball lifting between
   rows (C3), the facing duplicating the pockets (C6), and 30 programs alternating cutters.
2. **A Z-section** (x or y line through any contested cell): stock, goal surface, exact CL, posted
   points. This is the picture that ended the organizer-chord circle; it would have shown the datum
   errors on the first pass and the elephant's 26 mm pocket on the first run.
3. **The leftover map and the cut-into map** (E already draws these) with the per-program attribution
   coloured, not listed.
4. **The simulated stock after all programs** — the app's own simulator view, screenshotted through
   the CDP harness, beside a render of the goal. The demo page already does this for the figures.
5. **For #958, the feature tree drawn**: faces coloured by class (floor, island, contour, rim,
   remainder) on the tray, organizer and elephant. The elephant's "pocket-2" would have been obvious.

**The rule:** no verdict on a cell, a class, a gouge, a datum or a "no gain" is posted without the
picture that shows it, and no manager ruling on geometry is given from a table alone. "Plot, with
every sweep from now on" (E, 04:53Z) is the right instinct; this makes it the gate's rule rather than
one session's habit.

---

## 5. Issue tweaks (apply as edits to the bodies; "add" lines go under Acceptance)

| issue | now | change |
|---|---|---|
| **#943** tracking | line 1b "the rebuilt engine passes the seven lines on the reference cards, then the figures" | Rewrite 1b as two gates: **1b-i** tray and organizer 7/7 **on the published cycle basis (§7.1), in the vise, with the render set**; **1b-ii** the figures on the whole-surface line against a stated reference (wild-spirit relief for the surfacing class). Move #945/#946 under 1b-ii. **Amended 2026-11-05 (#965 6670116631):** the only scorable vendor figure (the Wolf, a 5 mm V-wrinkle relief, 96.77 %) is not the 26 mm figures' class, so 1b-ii is not judgeable in M1; the figure line closes as *measured* (panther 91.06 %, elephant 89.81 %, cut-into 0, remainder = the ⌀1 ball's wall-foot fillet) and the figures go to **M3** as plan v2 §0.2 always placed 3D, with two M3 issues: a wall-foot rule (the V's own CL as a rest over the ⌀1's mask) and a tall-figure vendor reference. Add: "the 12-hour report prints both cycle bases until the clock rules." |
| **#955** reference cards | 12 cards + 2 candidate, local only | Add: each card carries the §4 render set; the posts-as-filed line reads the holding the vendor used; cards whose "ours" is the old engine are labelled "old engine" and get a "stop rule" cell (ring box 27×, tool holder 48× already breach it). Close the four follow-ups the body asks for or strike that acceptance line. |
| **#956** umbrella | approved; threads cite off-record rulings | Add a standing rule: every ruling, formula and queue order is posted on the issue it rules on, before the programmer acts. Add the two tooling fixes from C10 (whole-thread reader; parity tolerance before acceptance). Amend plan v2 §4 M3 and §7.4 in the file: Kiri:Moto is local reference only (maintainer, 11-04 02:05Z). Answer the open GPL/LGPL test-number question (§7.6). |
| **#957** CL surface | parity 21/21 at 0.001 mm; stub closed | Add acceptance: the organizer's three posted points (0.08–0.115 mm below the exact CL, #959 04:12Z) read 0 after the fix, shown in a Z-section. Precondition: B has the two licensed STEPs and E's run outputs on davebook-5. |
| **#958** recognition | 8/8 green on the real STEPs | Mark code-complete for STEP. Add: the feature tree rendered for tray, organizer and elephant (§4.5); the elephant's under-figure "pocket" either not recognised or refused by the air-shadow rule, with a picture. Mesh (non-STEP) parity on the figures stays open. |
| **#959** rough / rest / pockets / contour | 86 comments; items 4a, 7, skim linking queued | Re-scope the acceptance to the two parts' seven lines, nothing else. **Facing off by default (ruled, §7.3):** remove the facing stage from the default plan, keep it as an operator option, and give the gentle-slope skin to the flat surface-following pass (C6) rather than fixing the exclusion. No new stage until the current plan's §4.1 picture is reviewed. Close the datum item (done). Hand the 0.107 mm spot to #957. |
| **#960** finishing | `finish()` both kinds; flat/ball chosen by sequence slot, no slope rule; `rough()` a throwing stub | Add: the slope threshold stated and the kind chosen by the region's slope, not its slot (plan §4 M2 step 3). Ball step-over from a scallop height, not a constant — ours 0.30–0.41 mm against the vendor's 0.8 mm for the same ⌀6 ball is half the lever on the organizer. Drop the stub or name its owner. |
| **#961** sequence by cost | rank by completeness, then failures, then "price"; price never printed | Add: the card prints the priced candidate sequences for the tray; the chosen one is Makera's four cutters within the cost model; pricing is #927's estimate, stated. |
| **#962** linking | one prior-art comment; work merged elsewhere; real parts still lift between rows; links as feed moves doubled the panther's cycle | Report on this issue. Acceptance restated: rapids per 1,000 ≤ 2× vendor **and** the cycle does not rise when a retract becomes a link; the organizer's ball and the 4b rough do not lift between adjacent rows; the link path drawn (§4.1). |
| **#963** job model / UI | five rounds against a fixture plan; blocked on the seam | Hold. No further UI rounds until a real `planModelCam` plan reaches the seam. Remove the fixture-driven e2e from acceptance until then. |
| **#964** specs / harness | strong; yardstick re-based by a test-only "ruling" | Add: the catalogue door is the default of every acceptance run; the card prints both cycle bases and which feed row fed each cutter; the harness-defect list (C2, `runsOf`, cache key, fixture triangle) becomes a self-test. The cycle basis is the maintainer's decision, not F's (§7.1). |
| **#965** figures | started week 1; 22 mm cut-through; no vendor reference | Park until 1b-i. Keep the registration-offset fix. File the cut-through as its own blocking bug with a Z-section (C4). Name the reference for the figures' class (wild-spirit) before any further run. |
| **#966** integration | eighteen branches; flags; removal-prep empty; mouse, reliefs, breadth in scope | Collapse to one integration branch with one owner. **Ruled (§7.5): the old engine and all six flags are retired in the same removal; the package lands with no second engine and the seam calling the new one unconditionally.** Mouse manifold repair, PNG reliefs and the 66-job breadth check leave this issue (park as `parked-until-m2`); the breadth check returns after 1b-i. |
| **#968** SVG stroke band | fixed on a candidate; coasters card built on it | Land it; close when the coasters card is scored on `main`. |
| **#969** island fixture | fixed, pins regenerated | Land, close. |
| **#948** goal check | changed five times on main | Bump `SIMULATOR_VERSION`; then **freeze the rule** for the rest of M2. Keep the whole-surface union as the figures' line. |
| **new** bug | — | "cam/model: a pocket op cuts 22 mm under the elephant — air-shadow of the material above a level" (from #965 04:48Z), blocking #965, picture attached. |
| **new** question | — | "cycle basis: header, our estimator, or the clock" with the air-run proposal (§7.1); default until answered: print both, pass on neither alone. |
| **new** task | — | "renders: the standard picture set per scored sha" (§4), owner E, one day. |
| **new** task | — | "B's inputs: the licensed STEPs and E's run outputs on davebook-5" — half a day, unblocks #957 and #959. |

---

## 6. Milestones

GitHub holds one active milestone, "Milestone 1 — Clean samples from the app" (36 open, 12 closed),
which now mixes the parked bench half (#935–#942, #932–#934, #930, #931) with the rebuild
(#955–#969). Plan v2 §4 named M1/M2/M3 and §7.2 merged M2+M3. Make the structure match:

| milestone | holds | gate |
|---|---|---|
| **Milestone 2 — The rebuilt engine passes the references** (new) | #956–#969, #955, #948, #951, the three new items above | #943 line 1b-i, then 1b-ii |
| **Milestone 1 — Clean samples from the app** (existing, parked) | the bench sessions #935–#942, registration #932–#934, wizard/cut truth #930/#931, close-out #942, #943 itself | opens on the maintainer's go after M2 (plan v2 §7.1) |
| **Mesh to part** (existing) | #914, #916 — superseded by M2; close or move | — |
| labels | `parked-until-m2` for mouse/relief/breadth work; `old-engine` on #955 cards that score the shipped engine | — |

Calendar, re-cut from where the work actually is (one programmer per line, B the long pole):

| week | the two parts (B, C, E, F) | parked |
|---|---|---|
| this week | facing → flat surface-following; ball step-over by scallop; link rows (organizer ball, 4b rough); the 0.107 mm CL spot; catalogue default; the render set; vise holding on the cards | #963, #965, #966 breadth; UI |
| next | tray and organizer 7/7 on the published basis; the figures' reference named; #966 collapsed to one branch | — |
| after | #965 on the new engine; old engine removed; cards re-scored; the maintainer's go | bench S1 → S6 |

---

## 7. Decisions — all six ruled by the maintainer, 2026-11-05

1. **The cycle basis — decided:** the line is judged on **our estimator over both files** (#927 on
   Makera's NC and on ours, plus 91.4 s per bit change). Makera's header is printed beside it as a
   fact, never the reference. **Carried to the bench agenda:** when bench time comes, the first job is
   to find out why our estimator reads Makera's file at 76 min against its 47.6 min header — a timed
   air run of the vendor's tray NC, then #927's own acceptance (predicted within 10 % of the clock).
2. **The holding for "posts as filed" — decided: the vise**, as the plan says. The two parts are re-run
   in the vise with jaw clearance; the line passes only there. Tape cards keep their numbers and say
   "tape", never "as filed".
3. **Facing — decided (maintainer, 2026-11-05):** facing is rarely needed and is the operator's
   choice; the default is **no facing**. The rebuilt engine plans no facing stage unless the job asks
   for one; the gentle-slope skin goes to the flat surface-following pass Makera uses (C6).
4. **Park #965 and #966's breadth until the two parts pass** (plan v2 §8 as written) — in force.
5. **The old engine and the flags — decided: there is no second engine.** "Why are we keeping an old
   engine at all; it should be retired with the flags." The old heightfield engine (`surface3d.ts`,
   `rough3d.ts`, the caps and presses) and all six flags go in the same removal; the package lands
   with the seam calling `planModelCam` unconditionally. The figure and demo cards re-score on the new
   engine at whatever they read; nothing falls back. #966's acceptance is that removal commit, and
   it is no longer gated on 1b-i — it is the way the package lands.
6. **The licence question — decided: yes, numbers only.** Reference fixtures from OpenCamLib (LGPL)
   and PyCAM (GPL) are generated offline; the generator scripts and versions are committed, only
   numeric outputs enter the tree, no source is copied or linked. State it once in the design note §9
   and the fixtures' header. Kiri:Moto stays local reference only.

---

7. **Plan from all bits; show the inventory tradeoff — ruled 2026-11-05 (#975).** "Our software needs to
   be able to plan based on all bits available, but when constrained with a fixed inventory present to the
   user the tradeoffs (if any) and then implement with the tools available to the best of our ability.
   Potentially also showing the user what the outcome of the choice will be." The planner runs on the
   catalogue (ideal) and on the owned set (default); where the outcomes differ the card states the
   tradeoff in outcome terms and shows the simulated owned result beside the ideal; the ideal is a
   recommendation, never a gate; a refusal where an owned tool can do the job is our defect.
8. **Both acceptance rows, all seven lines — ruled 2026-11-05 (#991, #995).** A reference card's STEP
   row and its STL row are each judged on all seven lines against the same vendor basis; a row refused
   at the door is seven fails, never a skip; a line that passes on one row and fails on the other is a
   fail.

## 8. Process rules to add to the marching orders

1. One acceptance target per programmer at a time; the manager keeps the WIP list at one item each.
2. No verdict without the picture (§4); no ruling on geometry from a table.
3. Every ruling, formula and queue order is posted on the issue before anyone acts on it.
4. The manager reviews and does not implement; a session out of context is restarted, not replaced by
   the manager's hands.
5. The stop rule is applied as written: a reference card over 3× the vendor stops that package's new
   stages until the attribution and the picture say where the time goes.
6. The gate does not change during an engine milestone; a needed change bumps the version and
   re-scores every card in one commit.
7. One integration branch; a slice merges into it, never into a sibling.
8. Harness configuration is part of acceptance: the catalogue, the holding, the feed row per cutter and
   the picture set print on every card.
9. **Cost before the run (added 2026-11-05, after A's collision guard ran two hours at 100 % CPU on the
   elephant).** No new engine stage, guard or check runs on a real mesh until its reviewer has written
   its cost on the issue: the loop shape (what it iterates over, per level, per cell, per triangle),
   the index it uses (triangle bins or none), and the expected seconds derived from the synthetic
   timing. A run that exceeds 3× that number is stopped and filed, not waited out. The review that
   approves a hunk approves its cost; "it is still computing" is not a state a reviewed stage can be in.
10. **Ready before the branch (added 2026-11-05, after #970's two fixes and three card runs went to the
    wrong file).** An issue goes to a programmer only when it carries six items, written by the strongest
    model and read by the maintainer: (1) the **stamping fact** — which operation, move and line produces the
    symptom, with the dump numbers that prove it (`programs[].operations[].name` + the nearest move at the
    level is a two-minute read); (2) the **mechanism in geometry**, one checkable paragraph; (3) the
    **picture** that shows the mechanism, from the §4 set; (4) the **cost line** of §8.9, moved from "before
    the run" to "before the branch"; (5) the **change, named** — file, function, one sentence of what
    changes and what must not; (6) the **acceptance as numbers** — which cells go to zero, which card lines
    must not move, which spec pins it red-first. Items 1–4 are analysis and belong to the review session
    (case-maker-6b) or the manager on Fable; a programmer on Opus 5.5 then has nothing to decide, and a
    reviewer checks the hunk against item 5, not against a theory of its own. The label `ready` is set only
    by the manager and only when all six are present; the programmer queue takes `ready` issues only. An
    issue without them is a finding or a question and stays with the manager or goes to the review session.
    The template `.github/ISSUE_TEMPLATE/engine_work_item.yml` has the six fields.
