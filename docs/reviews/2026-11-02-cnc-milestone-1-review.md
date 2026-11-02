# CNC review and the Milestone 1 plan — 2026-11-02

*A full review of the CNC work as of `main` 5bcc5a88, written for the maintainer. Requested because
"agents have been working on this project for many days with little progress … the goal of a clean
sample being cut is causing a lot of extra testing and back and forth". Review only: nothing in the
app was changed. Seven independent reads were made (bench record, engine, simulation gate, registration
and bridge, sample corpus, process, UI walk); their full reports are in `2026-11-02-cnc-review/`, and
every number below is cited there with a file, line or issue. This document is the evaluation and the
plan; its §4 is written so each work package can be filed as an issue as it stands.*

**The maintainer's standing rule, taken as a milestone condition:** before any further cutting, the
simulation must be able to validate a job's **correctness** (the program cuts the designed part and
nothing else) and **efficiency** (no wasted time). §2.3 says how far from that the simulation is; §4
puts that work before the first bench cut.

---

## 0. Summary

**Verdict.** The product can cut, but not from its defaults. Everything a text badge needs exists, is typed, is green on 591
pipeline tests, and has produced one real part from the app's own registration → re-post → upload →
run (2026-10-25). What it has not produced is a *clean, measured* sample, and the fortnight since
has not moved toward one:

| Fact | Number | Source |
|---|---|---|
| Commits 2026-10-19 → 11-02 | 827 (155 on 10-31, 140 on 11-01) | `06-process-churn.md` §1 |
| Commits on the clean-cut path | 23 % overall; **12.6 % since 10-26** | §1 |
| Physical cuts in four weeks | 9; **none since 10-25**; 1 driven by the app | `01-bench-history.md` §1–2 |
| Caliper readings of any cut floor vs its commanded depth | **0**; the 10-25 part has since been discarded, so the first number comes from the next cut | §3 (#569 open since 10-21) |
| Measured feeds rows in the product | **1** (laminate V, F1000; on k3 only, not committed) | `05-samples-corpus.md` §4 |
| Issues closed in the window | 379; **74 % within 24 h**; 240 closing comments cite a test gate, **3** cite the machine | `06-…` §3 |
| Closed issues that need a machine check | 72; 11 of them on the #767 checklist | §5 |
| Hottest files | `EngravePanel.tsx` 144 commits / 5,585 LOC; `engraveGenerate.ts` 134 / 8,380; `jobSetup.ts` 104 / 4,105 | `02-engine-review.md` §5 |
| Unit specs on machine-touching code | `registration/execute.ts` 3, `machineBridge.ts` 3, `machineRun.ts` 7 | §1 |
| Cycle-time estimate vs the clock | 1.17× to 1.55× low on every real run | `03-simulation-gate.md` §3.2 |
| Efficiency checks in the gate | none | §3.3 |
| First-job wizard with every default | **does not generate** (a 1.5 mm plate sized from the text, facing pass into the moving jaw, +27 errors); the pocket variant stalled | `07-ui-walk.md` §3 |

**Why.** Breadth replaced depth. After the 10-25 cut, ten parallel streams (first-job UI, rotary,
mesh-to-part, operations matrix, Makera parity, GRBL machines, Release 1.0, headless, 3D printing,
planning for 1.1/2.0) rewrote the same four files the badge runs through, each stream closing its
issues on a green suite and deferring "the one machine check" to a list nobody owns. The bench, the
only true gate, was used three times in that period, all for probe wiring and switch surveys.

**The plan in one paragraph.** Define Milestone 1 as five measured sample parts cut from the app
(§1). Stop everything off the path (§4.1). First make the simulation able to say "this program is
correct and not wasteful" by the ten-statement gate in §2.3 (§4.3 Phase 1, off-bench, about a
week of two implementers). Harden the five bridge seams that have bitten every bench session (Phase
2, one air session). Then cut the proven badge job from the app with a human at the GUI and take
the calipers on it at once, since the 10-25 part was discarded unmeasured (Phase 3). Then four more samples, each as a feeds coupon first and a measured part
second (Phase 4). Every closure on the path needs a dated bench record; everything else waits.

---

## 1. What Milestone 1 is

No milestone in the tracker is named "1". CNC-1 ("Simulate any .nc") is closed; CNC-2 ("First
chips"), CNC-2.2 ("Measured, not assumed") and CNC-9 ("Registration") are open with their bench
items; two scoreboard milestones (Parity, Release 1.0) were created and filled in four days. This
document therefore **defines** Milestone 1 from the maintainer's words ("a clean sample being cut";
"the simulation validates efficiency and correctness before more cutting"; "stop optimizing, get to
a correct cut", #902) and proposes it as the one acceptance issue the tracker lacks.

**Milestone 1 — Clean samples from the app.** Done when:

1. **The simulation validates a job** by the ten statements in §2.3(e) before any cut, and the gate
   refuses a job that fails them. Items 3, 5, 6, 8 and 9 of that list do not exist today.
   **1b. The Z1 Demo Jobs page is the gate** (maintainer, 2026-11-02; §2.9): cleaned to cards the
   simulation can visually validate against an objective reference, rebuilt from the pinned sha every
   wave, and **the elephant and the panther read "Matches the design" on it before any bench work** —
   the air session included.
2. **Five hardwood sample parts** (§4.4; 36 × 36 × 100 mm sticks) are cut on the Z1 by an operator **at the GUI** (not an agent over
   CDP, not `z1.mjs`), each from a job the app generated, validated, registered, uploaded and ran;
   the parts are measured against **written acceptance numbers** (§4.4; the repo has none today)
   and photographed beside a scale, with the transcript saved.
3. **The badge is repeated twice after unclamping and re-seating** with the origin spread recorded
   (#570), so "clean" is shown to be repeatable, not lucky.
4. **Every feeds row the five samples used is `measured`**, flipped by a cut coupon and the readback
   script, not seeded or carried (#284).
5. **Predicted cycle time is within 10 % of the clock** on the five runs, and air fraction and feed
   utilisation are printed on every run sheet (§2.3).
6. The **#767 checklist is ticked or each unticked line is reopened** as its own issue; no closed
   issue on the path carries an unobserved machine claim.

**Material (maintainer, 2026-11-02):** hardwood. The shop has 36 × 36 × 100 mm hardwood sticks for
testing; printed plastic (PLA/PETG) needs its own cutting technique and is 1.1 (#913), and laminate goes
with it. §2.6 below was written before that ruling and reads the hardwood default as a mismatch; the
ruling stands and the five samples in §4.4 are hardwood.

Out of Milestone 1 by this definition (parked, not cancelled): rotary (#238 unmeasured since
10-05), mesh-to-part beyond the current flat goal, PCB and disc, GRBL/Carvera/USB, aluminium,
printed plastic and laminate (#913, 1.1), thread mill, inlay, 3D relief, the operations matrix, parity
rows, the welcome page, 1.1/2.0.

---

## 2. Where things stand

### 2.1 The bench record (`01-bench-history.md`)

Nine cuts: the 10-12 depth ladder (clean, −0.1…−0.2 mm, accepted "for V1"); the 10-15 V-grooves
(clean, never measured); 10-16 badge rough pass clean then the 0.6 mm corn bit broke in PETG; 10-17
rough + V rest (second colour patchy) and the **laminate V-carve, 437 s, clean first try** — the
accepted CNC-3 acceptance (#176); 10-18 four laminate feed coupons, all clean, the only measured
row; **10-25 the PLA badge from the app** (run 9 of nine registration runs across 10-23/24/25).

The 10-25 run is the furthest the app has gone: datum-path registration → tilt 0.75° → origin
written → re-post against the tilt → oracle 0/0 (the first time) → md5-verified upload → Run →
P 0→100 in about 4:15. It is not a clean end-to-end: the operator was an agent over CDP; the
machine sat **11 minutes in the firmware `Tool` state** until a hand `M490.2` (#655, fixed after the
cut, unverified); the run watch lost the run so `$H` was sent by hand; "Single Barrel" is legible
but "br" is unreadable (as the gate warned: 13 % of its area lost to a 0.5 mm V), interiors
mottled, a chip at the clamp edge; and **the caliper reading that is #569's pass criterion was
never taken**. The installed desktop (Tauri) app has never completed a registration.

Each of the eight earlier app attempts stopped on a different seam, each fixed the same day: planner
refusal of a low blank (#517), stale package (#580), the 800 ms `M491` reader (#563), a stale G54,
the oracle floor, seek window and 60 s park (#585/#588), extent order (#591), `blank-bowed` with no
origin (#608), X/Y margin with no "use found position" (#620), reading above the band (#619), the
oracle in the wrong frame (#623), the column-engine oracle (#628), a DOME verdict 0.008 mm over the
band (#631). The fixes are on `main`; only the 10-25 run has exercised any of them.

Recurring losses, every session: the Z1 failing to join the LAN (plug cycle is the only cure,
#304/#499); the harness's 3 s reply window timing out on `$H` and every long move (once queuing a
`G38.3` behind a moving rapid → `H:3` alarm); `ALARM: unexpected probe trigger` on a `G0` retract
after a sideways 3D-probe touch, which also cuts the probe's supply (#790, unfixed in the registration
scans); the wrong probe connector and a loose probe body jamming the head (10-30/31); the CRLF copy
of `ha-api.sh` every session; six k3 builds in one evening each dropping the browser session; and
multi-hour waits between registration and the cutter swap.

**Record discrepancy:** #580/#584 cite a "2026-10-19 badge cut"; no trace, photo or card file
supports it. It conflates the 10-17 cuts.

### 2.2 The engine (`02-engine-review.md`)

The CNC side is ~160k of 243k source lines: `engine/cnc` 80k (engrave 32.8k, cam 11.3k,
registration 4.6k), sim and geometry workers 19.9k, platform 38.9k (23.7k generated schema), Rust
21k. The simple badge path — document → `engraveRegions` → `validateJob` → `generateOneProgram` →
`generateEngrave` → `postZ1` → `verifyProgram` → `session.load` → `computeOracle` → five gate
functions → registration → upload → run — exists, is green (591/591 on the 18 pipeline specs,
`tsc -b` clean) and cut once.

Its risk is not missing function but **shared function**: every stage is one 10–16-parameter
function through which rotary, thread mill, adaptive metal, 3D goal, GRBL, multi-setup, facing and
bed-mount work also flow. `generateOneProgram` is 1,046 lines with 16 parameters; `validateJob` is
1,820 lines with 158 finding codes; `buildRunSheet` 1,137 lines; the flat job's surface frame is
chosen by a rotary null-check (`engraveGenerate.ts:8002`); *loading a job file* now consults the
machine registry (#773/#845). The document schema stayed at v3 while 63 commits added 142 optional
Zod fields in lock-step across three artefacts. A V-bit badge and a flat badge are simulated by
**different engines** (column vs exact), chosen at `session.ts:888` by a tool-shape × density ×
rotary × seed rule with no table test. The machine-touching layer has the least coverage: the two
machine-safety blockers of the last review (#632, #643) were both in `registration/execute.ts`,
which three specs import.

### 2.3 The simulation as the pre-cut gate (`03-simulation-gate.md`)

**What it proves today:** that the posted file does what the CAM decided. The verifier and sweep run
on the exact `.nc` bytes; the oracle uses a derived tolerance per level; the surface frame is handled
by un-lifting (#625/#628, fixed 830054ae, pinned by `engraveOracleSurface.spec.ts:309` with the real
10-24 badge job, bench-confirmed by run 9). This is the strongest part of the product and the biggest
lead over Makera Studio.

**What it does not prove:**

- **Design correctness.** Every oracle prediction is the CAM's own: the flat floor is the CAM's
  offset-of-offset, the V groove uses the same cone the engine sweeps. Simulation.md §7's independent
  point-in-polygon check against the raw design is not implemented. Of 14 known mis-verdicts, 11 were
  false refusals (fixed); the one **false pass** (#741, V-bit flank widening past the shank, 20–60 %
  excess volume) was found only by an external sweep, exactly where the oracle is blind.
- **Fixture collision on the column engine.** The verifier states it does not check the vise
  (`verify.ts:12`); the exact sweeper does; **the column engine never reads `setup.fixture`**, yet
  `simCoverage.ts:128` prints the fixture as an obstacle it tested. Every V-bit, drill, ball, thread
  and dense-flat program relies on the 2D plan-view rule `vise-jaw-collision` alone.
- **Unchecked air.** A stall in the air phase downgrades to the warning `air-moves-unchecked`
  (`columnEngine.ts:2109`, `sweep.ts:1014`) — unchecked rapids below stock can reach Upload green.
- **Efficiency: nothing.** The run sheet prints a rapid:cut ratio with no threshold. No air-time
  fraction, hop count, feed utilisation, redundant-removal, path-length bound, MRR, or tool-change
  cost. A correct program three times slower than it needs to be passes without comment.
- **Time.** Predicted vs clock: 94 vs 136 s, 373 vs 437 s, 162 vs 255 s (1.17–1.55× low). The
  junction model (#657) was tuned on the one 10-25 run it then matches; #208 D3 (a timed air run and
  a timed cutting run) has never been done. Not modelled: tool change, `M491`, spin-up, dwell, the
  inter-operation rapid, the real `junction_deviation`.
- **Caps.** The 60 s budget is gone (#895) but finish-tip, cell-level and compare-cell caps remain on
  `main` (`surface3d.ts`, `texture.ts`); #916 removes them on a branch. The simulator's version is not
  in the package hash, so a simulator fix does not stale a frozen verdict.

**(e) Proposed definition — "the simulation validates a job" when all ten hold** (today 1, 2, 4, 7,
10 hold on the exact engine; 3 fails on the column engine; 5, 6, 8, 9 do not exist):

1. The verifier passes the posted bytes with zero errors in the frame the package will run in.
2. Every program's sweep completed with no unchecked air moves (`air-moves-unchecked` becomes an error).
3. Fixture and holder were tested **on this program's engine**, and the coverage sentence names the
   engine and the obstacles tested; "cannot be proven" is an acknowledged tick, never a default pass.
4. The oracle passes at every level, with the band printed and the floor stated as a physical size.
5. An **independent design check** passes: sampled design points reachable by the cutter are inside
   the simulated region, and no simulated point lies more than r (+ band) from the design, computed
   from the raw design, not the CAM's offsets or cone.
6. Removed volume agrees with an analytic or second-implementation figure within the grid's tolerance.
7. Every reported number carries its resolution and provenance, and no cap coarsened or skipped a
   check without saying so in the same report.
8. The cycle estimate is printed with its basis; air fraction, hop count and feed utilisation are
   printed per program; a program outside the shop's thresholds carries a warning naming the operation.
9. After a run, the actual time is recorded beside the estimate on the run record.
10. The frozen package is current: job, registration, program bytes **and simulator version** match.

### 2.4 Registration and the machine bridge (`04-registration-bridge.md`)

The vise + wired-probe + datum path **converged on 10-25**: `?` Idle → `$H G54 G92.1` → `M831` →
`M119` → `M491` → two-stage jaw tap → surface search → left and front bracket-and-bisect scans →
five extents → plane fit → write origin → cutter `M491` → `G10 L2` → re-post. Repeatability is
excellent (same clamping 0.000–0.004 mm; ≤0.015 mm per point across runs). Over the 10-17 hand
procedure it adds what a clean cut needs (X/Y from the blank as clamped, which was 6–7 mm off on
both days; capped `G38.3` instead of alarm-prone `G38.2`; `M119`) and two things the badge's own
geometry forced (the mount tap as a floor, pulled in five issues of bed-profile plumbing; the
plane-fit re-post, needed only because a 0.8° tilt in a vise was accepted instead of re-seated).

Since 10-25 the module has grown **sideways**: ~60 commits adding the 3D probe as an instrument,
corner and centre-find, disc rims, drilled-hole references, PCB flips, the rotary chord tap, the
bracket tap — none run through the app on the machine, and the sideways path carries the known
retract alarm (#790). The default badge job passes 8 planner forks and ~9 executor forks and leaves
~18 roads untaken. The Cut step has ~20 distinguishable states.

Bridge gaps, in the order they should be proven: (1) `G38.5` release before any `G0` after a touched
reading, at five sites in `execute.ts`; (2) the executor's `?` polls inherit the 60 s console window,
so a silent link stalls a run for up to 30 minutes, and `$H` must answer `ok` inside 60 s on a cold
start; (3) **there is no mid-motion stop for a registration run** — Stop only answers a prompt;
(4) `HALT_WORDS[3]` says "did not trigger" where the bench saw "unexpected probe trigger"; (5) the
#767 ticks; (6) the G54 pre-flight (`workOffset()` exists, nothing calls it; the stale-G54 miss it
guards against happened on 10-21).

### 2.5 The first-job UI, as built today (`07-ui-walk.md`)

Driven headless on `main` 5bcc5a88 with a faked location (vise on pins, wasteboard under), no machine;
three walks (engrave with every default; a pocket; engrave on a waste board); key captures in
`docs/bench/img/2026-11-02-ui-walk/`.

**The shape is as designed.** One card on the door, one modal "Step n of 4" in the #897 order,
Design panel with Job / Cutter / Hold and a sentence-bearing Generate, three Cut lines, the job's
program in Simulate. Of the 45 findings of the 10-26 audit about 33 are fixed, 7 partly, 1 remains;
no issue numbers, codes-as-defaults or dev words on any capture; no page errors.

**The defaults do not produce a cuttable job.** All three Generates failed to reach four ticks:

- Engrave with every default: the wizard sizes a **1.5 mm hardwood plate** from the text; Holding
  disables the ledge ("it would sit 1.6 mm below the jaw tops"), selects nothing, yet "Create the job"
  is enabled and the job lands on the ledge. Generate: "the simulation did not pass — the facing pass
  (flat-1.0): checkpoint 0: the cutter drives 0.477 mm² into the fixture 'Vise moving jaw (right)'
  (vise-moving-jaw) (+27 more errors)". Codes in operator text, no fix sentence, no link.
- On a waste board: still "blank on the ledge, 0.3999999999999999 mm proud" and the same jaw
  collision (a 0.5 mm facing pass on a 0.4 mm-proud blank).
- Pocket: toolpath and check ticked after 183 s, then "The generator stopped reporting for 180 s"
  (observed once under load, not diagnosed).

**Cut mode contradicts Design.** With no machine it stops correctly at step 2, but step 1 says
"Program checked · matches the design" for a program never simulated, and "The check found nothing
blocking" under a jaw collision. The Cut switch tooltip is a developer sentence ("Ask every preflight
owner about this job…"); Register's second line refers to a machine card and a "Measure…" button not
on screen. "Change the machine…" and the bed/tape/bracket/rotary holdings are absent from Holding, so
the design's §3.8 is unreachable. Twenty defects are listed in the report with their captures.

The point for the milestone: the first-job redesign closed (#679, 10-26) and was repaired for two
days, and its default path still cannot generate. The acceptance e2e spec (#692) proves the flow's
shape, not that the default job is cuttable.

### 2.6 Samples, materials and "clean" (`05-samples-corpus.md`)

**The repo never defines "clean" physically.** It has #569's words ("centred, not skewed; lower
colour revealed evenly; no film; no cut-through; clean finish"), #176's ("legible, no melt, first
try"), the run sheet's three questions (legible yes/no; clean/fuzzy/burnt; what went wrong) and
coupon verdicts (ok/poor/broke). No dimensional tolerance for any pocket, hole or outline; no depth
number; no legibility threshold; nothing on tabs, chamfers, burrs or edges. The simulated verdicts
("matches the photo") are a reviewer's eye on a rendered sweep.

**Material reality** *(superseded on the material point by the maintainer's ruling in §1: hardwood is
the milestone material and 36 × 36 × 100 sticks are on hand; what follows about plastic feeds is still
true and is why plastic is 1.1)*. The default job became a 100 × 60 × 12 **hardwood** plate on 11-02
(#879); the hardwood rows are seeded "conservative guesses for a 150 W spindle", no hardwood has been
cut on this Z1, and the default stock is a plate sized from the text rather than the stick on the shelf. PLA flat rows are *seeded* 12000/F500/F200;
PETG/plastic V rows are *observed* once (10-17); the single *measured* row (laminate V, F1000) lives
only in k3's `location.json`. #913 (filed under 1.1) says printed plastic wants F1500–2500 at ½ D
with ramps, pecks and the fan — three to five times the seeds, which by its own physics are the
rubbing regime. The 284 feed coupon built to settle this has **never been cut** (`cutOn: null`).
Every CAM fix from the 10-28/29 demo runs (#736, #739, #746–#751, #760, #765, #766) is closed
"simulated only" and none is on #767; #736 part 2 (does the vise's lift satisfy the through-cut
clearance) lost its issue when part 1 closed. The cutter pick can still name a corn bit on plastic,
the cutter class that broke on 10-16.

**Inputs.** The badge 3MFs/STLs, the 165/284/450 bench jobs, and j01–j05, j10–j19, j22, j24, j25 and
the `fx-*` fixtures rebuild from committed files; j06/j20/j21/j23 need downloads under NC-ND or
unstated licences. Milestone 1 uses committed inputs only.

**CLI check (this review):** six jobs — the laminate V-carve, the badge `single-thin.3mf`, j03 vise
text, j16 chamfer, j16 tabbed cut-out, j05 PLA sign — all generate today against a local location
fixture in 2.8–3.9 s with 0 sim errors. Two observations to check before the bench: the two "tape"
j16 run sheets say "Mount the vise" and model the jaws; the chamfer's 0.1 mm-tip feeds came from an
unnamed seeded row.

### 2.7 Two pipelines that have drifted apart

A peer session reported today (its report is on a drive this session cannot read, so this is
*reported, not verified*): for `j13-tool-tray` against the identical k3 catalogue and location, the
in-app Generate and `casemaker cut` produce **different programs** — UI 10000 rpm / F1000 / 300
plunge, 483 depth passes, 2 h 49 m estimate; CLI 12000 / F500 / 200, 720 passes all ≤0.5 mm,
8 h 26 m — same cutter, same job file. For `j01-topclamp-alu` the UI correctly refuses (two clamps
overlap) while the CLI refuses two stages earlier at feeds. The 10-28/29 corpus verdicts, the
off-bench exercises and the planned MCP front door all run through the CLI path; the bench runs
through the UI path. Until one job yields one program on both, every simulated verdict is a verdict
on a program the operator may never run.

### 2.8 Process (`06-process-churn.md`)

Themes of the 827 commits: clean-cut path proper 23 %; adjacent holdings 4 %; first-job UI 13 %
(fix:feat 57:30 — the redesign shipped on 10-26 as "DONE … accepted" and was repaired for two days,
#726 25 fixes, #724 11); rotary 11 %; mesh-to-part 15 %; operations/parity/cutter pick/PCB/refusal
audit 20 %; GRBL 2 %; release/docs/welcome 6 %; headless 2 %; 3D printing and infra 5 % (despite the
standing CNC-only rule). The path is front-loaded: 120 of its 192 commits landed by 10-25.

Churn chains with numbers: #743 PCB, 32 commits in 3 days from a design "not yet approved", 14 on one
slice in one day (10 fixes); #786 refusal audit, a one-line remark → 27 commits in 48 h → three
regression issues; #723, two unrelated features under one issue, seven "R-4 review" fixes in a day;
#766, three cutter-rule sets in one night then four regressions, one commit landed twice; the cut
flow built three times in nine days (#573 → #689 removes it → #796); the wizard three passes in six
days; the panther: a budget, a re-priced budget, a parked re-pricing, a pool resized five times and
an issue to remove budgets, in 72 h. The 10-25 code review's one process rule ("read every hunk
before the gate") was abandoned within 48 h by the manager's own record; its replacement ("slow the
queue, don't thin the review") was followed by 155- and 140-commit days; the calipers it said must
precede the next cut were never taken.

### 2.9 The demo page as the gate

The *Z1 Demo Jobs* page (https://claude.ai/artifact/EZ2yRActt2oECe57cYGhGc, built by
`docs/bench/2026-10-28-z1-real-jobs/tools/`) has served as the team's gate: 25 maker jobs plus the mouse
shell, the elephant and the panther, each with a before / after (an independent height-field sweep of the
posted program) / intended frame and a verdict. Its verdicts are a reviewer's eye against the maker's photo
("Matches the photo / Partly / No photo to compare / Proxy"), several inputs are NC-ND downloads or need a
login, and the 3D cards exposed the gap §2.3 names: the rough cut into the goal while "the app's own check
passes, because it compares the simulation with the app's plan, not with the goal" (#909, since clamped).
On the 2026-11-02 page the **elephant and the panther are both "Refused as filed · stand-in shown"**: the
stand-ins reach 32 % of the surface from the top, propose six and five setups, and cut the part free on
side 2 (#911, since fixed). #898 part 2 (tabbed freeing cut), #914 (reach-aware quarter turns) and #916
(caps) are open. The maintainer's ruling: the page keeps only cards that can be visually validated from
the simulation, and the elephant and panther must pass on it before any bench work (#944–#946).

---

## 3. Root causes

1. **Nobody owns the end-to-end cut.** #567/#569/#570 have been open since 10-21; the measurement that
   would have closed #569 took five minutes with no machine, was "owed" for eight days, and the part
   was discarded before anyone took it. The one session
   that drives the bench also gates, lands, publishes, reviews, triages and writes design docs.
2. **"Closed" means merged, not observed.** 74 % of issues close within 24 h on a green suite; machine
   checks move to #767 (11 of 72). The tracker is a commit log with extra steps.
3. **Breadth was the objective.** Five worktree slots "refilled as each lands" plus "questions become
   issues, keep moving" guarantee that work is generated to fill capacity: five of six issues are
   session-authored; two milestones were invented and completed in four days while the cut waited.
4. **One shared code path for everything.** Ten streams × four files = regressions, conflict markers
   on `main` (a60fe772), a commit landed twice, and a badge path that moves under the bench between
   sessions (six k3 builds in one evening on 10-24).
5. **Fix storms instead of design-first slices, and review after landing.** Feat → 5+ fixes within a
   day (#599, #737, #740, #747, #881, #743 P-8); retroactive reviews (#727/#728/#729) found ~30
   defects including a verified blocker in code that had passed the gate.
6. **The simulation is trusted beyond what it proves, and the UI overstates it.** Cut step 1 reports "matches the design" for a program never simulated (§2.5). It confirms the CAM against itself, skips the
   fixture on the engine every V job uses, and measures no efficiency, yet "simulated, 0 errors" is
   the accepted evidence for closing CAM issues.
7. **The bench is scarce and unscheduled.** Every session starts with network and probe-wiring
   losses; no runbook, recorder or cadence; the three post-cut sessions produced surveys, not parts.

---

## 4. The plan

### 4.1 Rules for the milestone (process)

- **One acceptance issue is the milestone** (§1). Every commit on `main` names which of its six lines
  it moves. Anything that does not is held on a branch until the milestone closes.
- **WIP limit: six programmer sessions, one per file-ownership column** (four on dave-1, one each on
  gpd-dave and davebook-5; the marching orders §1.1 give each its files). No refilling across columns: a session that finishes
  early takes the next package in its own column. Cross-cutting sweeps (wording, spelling, docs lint, guide
  rows for parked features) are banned until Phase 3 is done.
- **"Closed" = outcome observed.** Anything that changes what the machine does, or what the gate
  says about a program, closes only with a dated bench record (transcript + photo or caliper reading)
  linked from the issue; otherwise it stays open labelled `code-complete`. #767 becomes the bench
  runbook, each line owned by a dated slot; a closure without a tick is reopened.
- **Bench cadence.** One slot every two days, ≤90 min, a written runbook of at most five items in
  priority order, and a recorder whose only job is to write results onto the issues before power-off.
  No bench time on setup changes (vise off, rotary, bracket, PCB) until the five samples are cut.
- **Fix-storm brake.** Three `fix` commits on one issue in 24 h stops it; the next commit is a one-page
  design note (order of material removal; the non-happy document; what the machine would do) and a
  failing test, reviewed before more code.
- **Sizing before umbrellas.** A maintainer remark gets a sizing comment (slices, files, risk, path
  relevance) and a one-word go before the first commit. No issue over ten commits without a re-size.
- **Review before landing or the queue stops.** No retroactive reviews.
- **Pin the bench build.** k3 runs one sha for a bench session; it moves only when the golden badge
  artefact (WP-1) and the pipeline specs are green on the candidate, and never during a session.
- **Report weekly:** bench-observed closures, % of commits on the path (target >60 %), #767 ticks,
  fix:feat on the path. Not commit counts, not milestone burndown.

### 4.2 Freeze list (park the issues, do not close them)

Rotary (all: #223, #238, #240, #545, #626, #729, #810); mesh-to-part **except what the elephant and
panther need** — #898, #914 and #916 are on the path (#945/#946); parked: #892, #902, #915 (the rotary
panther is a separate test), #917; PCB/disc (#823); GRBL/Carvera/USB; operations matrix
(#663, #676 — both say "already done": close or park); parity rows; welcome/docs/spelling; 3D-printing
(#131, #147, #151, #155, #156, #160, #161, #262, #322, #376, #903–#906); 1.1/2.0 (#907, #913's
*implementation* — its numbers are used by WP-13); camera (#189); V-carve guilloché (#609); batch
(#251); bed mounts beyond tape (#707 bracket half, #444).

### 4.3 Work packages, in order

Each row is written to become one issue. "Bench" marks the ones that need the machine; everything
else is off-bench. Sizes are in implementer-days and are estimates.

#### Phase 0 — Stop and settle (1 day, no code on the path)

| WP | Deliverable | Acceptance | Size | Merges / closes |
|---|---|---|---|---|
| **WP-0a** File the Milestone 1 acceptance issue (§1 verbatim) and a `docs/bench/milestone-1-clean-samples.md` with the five samples and their acceptance numbers (§4.4) | Issue exists; every open path issue links to it; numbers agreed by the maintainer or adjusted on the issue | 0.5 | supersedes #567/#569/#570 as the tracking spine (they stay open as the records) |
| **WP-0b** Apply the freeze list: label parked issues `parked-until-m1`, move them out of open milestones, stand down all but two worktrees | Open list shows only path work | 0.5 | #663/#676 closed or parked; #729 closed as its last comment asks |
| **WP-0c** ~~Calipers on the 10-25 badge~~ — **not possible: the part was discarded** (maintainer, 2026-11-02). Record that on #569 and #631. The reading moves to WP-14: calipers on the fresh badge immediately after the run, which closes #569's depth criterion, decides #631 bow-vs-dome and gives the Z-chain number #176/#209 asked for | #569/#631 carry the note; WP-14's acceptance includes the reading | 0.1 | #569, #631 |
| **WP-0d** Pin the bench build: publish one k3 sha with #655/#656 in; record it in #767 | k3 = the sha; moves only by rule | 0.2 | — |
| **WP-0e** Reconcile the record: #580/#584's "10-19 cut" corrected to the 10-17 cuts; #767 ticks already observed (#615, #627, #647, #289, #772 list) ticked with their trace lines | Checklist shows true state | 0.3 | #767 |

#### Phase 1 — The simulation validates a job, and the default job passes it (off-bench, ~8–10 implementer-days across two slots)

| WP | Deliverable | Acceptance | Size | Source |
|---|---|---|---|---|
| **WP-1** **Golden badge artefact** (Session F, tests column). Extend `engraveOracleSurface.spec.ts:309` into a frozen-artefact test: the committed 10-24 badge job → `.nc` text hash + verifier report + oracle numbers + run-sheet text, byte-compared; same for the laminate 450 job and `single-thin` | Any commit that changes the badge's bytes fails locally; the test names what changed | 1 | `02-engine-review.md` §8.1 |
| **WP-2** **One pipeline for UI and CLI.** A test (Session F) that `casemaker cut` and the worker's `engraveGenerate` yield byte-identical programs for the same job + location (badge, j13, j16); fix the feeds/step-down resolution that differs; the CLI's `feeds` refusal and the UI's `feedsFor` share one function | Identical hashes on the three jobs; the peer's j13 case reproduced then green | 2 | §2.7; peer report |
| **WP-3** **Fixture and holder on the column engine.** Route `tool-into-fixture`, `rapid/feed-into-fixture`, `holder-into-fixture` through one function both engines call; until then `simCoverage` must not list the fixture on a column program | A V-bit program that swings into the jaw is refused; coverage sentence truthful; spec with the vise fixture | 2 | `03-simulation-gate.md` §1.3, gate item 3 |
| **WP-4** **Independent design oracle.** Simulation.md §7's point-in-polygon check from the raw design (reachable design points inside the simulated region; no simulated point > r + band from the design) plus an analytic V-groove volume and a flat capsule closed form as second-implementation checks over the committed corpus | #741's false pass would have been caught; the badge, laminate and j16 pass; a deliberately widened cone fails | 2 | gate items 5, 6 |
| **WP-5** **`air-moves-unchecked` → error**; `sweep-stalled` never downgrades; simulator version in the package hash | A stalled air phase blocks Upload; a simulator fix stales a frozen package | 0.5 | gate items 2, 10 |
| **WP-6** **Efficiency measures and two thresholds.** Per program: air-time fraction, hop count/time, feed utilisation (from the same trapezoids), redundant removal (written cells per pass), path length vs tour bound; printed in panel and run sheet; two shop-default thresholds (`location.json`, never a constant) → warnings naming the operation | The 10-28 corpus prints the numbers; a program with >N % air or a pass writing <M % warns; thresholds documented with their recommendation | 2 | gate item 8; memory: thresholds are settings + per-job recommendation |
| **WP-7** **Time model honesty.** Price tool change / `M491` / spin-up / inter-op rapid from the profile; record actual time beside the estimate on the run record; re-estimate the three 10-17 programs as out-of-sample checks | Run record shows predicted/actual; 10-17 programs within the model's stated error | 1 | gate item 9; §2.3 time |
| **WP-8** **Routing table test.** `session.ts:888` as a named function with a frozen table (tool shape × rotary class × density × seed → engine) | A thread/GRBL/rest change cannot move a V badge off the column engine silently | 0.5 | `02-…` §8.4 |
| **WP-9** **Extract the flat-item program.** `generateFlatItemProgram` for vise + flat/V + no rotary/thread/adaptive/neck/facing, behind the predicates that already exist; same split for `validateJob` and `buildRunSheet`; declare schema v3 closed, new fields in a v4 branch | Golden (WP-1) unchanged; the badge no longer passes through rotary/thread/adaptive branches; breadth fields cannot strip a bench field | 2 | `02-…` §8.2–8.3 |
| **WP-9a** **The default job generates.** The wizard's default stock/hold must be one the gate accepts: no facing on a blank thinner than the pass, a hold that is actually selected, the house's material not hardwood (or hardwood only when the house has a hardwood blank); a 0.4 mm-proud blank never faces. e2e: defaults → four ticks | Engrave "Zoomba" with every default and the pocket variant both reach four ticks on the faked vise location; no code in the sentence; a disabled Create never lands a job | 1.5 | `07-ui-walk.md` §3, §7 defects 1–5, 10, 19 |
| **WP-21 (#944)** **The demo page is the gate.** Card rule: an objective reference drawn beside the swept result (design overlay + design-check numbers; goal mesh + deviation map + coverage; or a reference program), computed verdicts ("Matches the design / Deviates / Refused"), reproducible inputs only, no proxies, the five hardwood sample cards, one-command rebuild on a given sha at every T3 | Every card carries an objective reference and a computed verdict; the page states the pinned sha; the elephant and panther cards show pass/fail against #945/#946 | 2 | §2.9; Session E |
| **WP-22 (#945)** **The elephant passes:** posts as filed with the app's cutters; flat on the stock bottom (#898); zero cut-into (≤0.1 mm); coverage ≥95 % with the remainder named; the figure reads; time sane; **the figure scaled in the app to fit the 36 × 36 × 100 stick is the gate card** (maintainer: full size can be scaled down) | Card reads "Matches the design"; the committed figure corpus (#873) pins it | 2–3 | Session B code, E page, A #924 3D half |
| **WP-23 (#946)** **The panther passes:** laid flat as stored (orientation fix); held by tabs with the freeing cut stated (#898 part 2) or quarter-turned within reach (#914); locating holes with an owned drill; turn-over steps; zero cut-into; coverage ≥95 %; scaled in the app to fit the stick (about 63 × 36 × 27 laid flat) | Card reads "Matches the design"; corpus pins it | 3–4 | B, E, A |
| **WP-9b** **Cut mode tells the truth.** Step 1 reads the sim result it claims ("matches the design" only after a passed oracle; "did not pass" shown where the collision is); the developer tooltip and the off-screen "Measure…" reference go; the finding sentence carries the fix and a link | Cut step 1 and Design agree on every capture of the three walks; spec pins the three states | 1 | §4, §7 defects 6–8, 11–12 |

Exit of Phase 1: the ten statements in §2.3(e) hold on the flagship hardwood job, j16 and the committed
figure corpus; the Simulate panel and run sheet print them; the wizard's default job and the pocket
variant generate to four ticks on the faked vise location; **and the demo page, rebuilt on the wave sha,
shows the elephant and the panther as "Matches the design". No bench session, the air session included,
before this exit.**

#### Phase 2 — Bridge and registration hardening (off-bench 2 days + one air session, no cutting)

| WP | Deliverable | Acceptance | Size | Source |
|---|---|---|---|---|
| **WP-10** `G38.5` release before any `G0`/`G53 G0` after a touched reading at all five sites in `execute.ts`; refuse a zero-travel `G38.5`; `HALT_WORDS[3]` wording from `Kernel.h` | Air registration with each probe: no `unexpected probe trigger` | 1 | `04-…` §7c.1, #790 |
| **WP-11** Executor `?` polls on the status window (3 s + 2 s), not 60 s; `$H` wait proven on a cold start; **a mid-motion Stop for a registration run** (what `abort` does to an in-flight `G38.3`, then wire it); the G54 pre-flight called | A silent link stops the run in seconds; Stop mid-touch leaves the machine in a known state | 2 | §7c.2–3, 6; #304/#499 |
| **WP-12** **Hide the untested branches.** Remove the UI entry and planner acceptance for: the 3D probe as a registration instrument, bracket/tape mounts, disc/reference registration, PCB flip, the typed-seat path, the G32 recommendation text, the facing re-touch. Keep the code. Add "re-seat the blank (press down on the low side) or follow the tilt" **before** the automatic re-post | The default badge job traverses one procedure (vise, wired V2, datum path); hidden branches have no UI path; e2e spec pins it | 1.5 | §7b |
| **WP-13 (bench, air)** **Air session S1 (~60 min):** the #767 ticks that cost nothing (#586, #588, #615, #659, #562, #772 `rm`); WP-10/11 on the machine; **#208 D3** timed air run + timed cutting run for WP-7; `config-get sd junction_deviation`; probe fitted → `M119`/`diagnose` read | Ticks on #767 with trace lines; D3 numbers in the profile | 1 slot | `01-…` §3–5 |

#### Phase 3 — Sample 1: the flagship text job on the hardwood stick (one bench session, 90 min)

| WP | Deliverable | Acceptance | Source |
|---|---|---|---|
| **WP-14 (bench, #936)** The app's default flagship text job ("CASE / MAKER / first chips") on the house's 36 × 36 × 100 hardwood stick in the vise, cut **from the GUI by a human** on the pinned build with Phases 1–2 in; a 10-minute groove coupon on the stick's end first (hardwood has never been cut on this Z1); the frame air-run; vacuum on; the datum path, re-seat before any re-post; calipers on the part before it leaves the vise area | All labels legible at arm's length; floors flat, no fuzz, no tear-out, no burn; depth centre vs ends within 0.1 mm of each other and of the programmed depth; text centred within 0.5 mm; predicted time within 10 %; no hand command during the run; transcript, photo beside a scale; result on #569 | `01-…` §6 (the 10-25 sequence); #936 |
| **WP-15 (bench, #937)** Repeatability: three unclamp/re-seat/re-register cycles on the stick, origin spread X/Y/Z recorded; cut nothing | Spread on #570; the surface band judged for sawn timber | #570 |

#### Phase 4 — Samples 2–5 in hardwood (three bench sessions; coupon first, then the part)

| WP | Sample | Stock · holding · cutter | Acceptance (calipers unless stated) | Decide / fix first |
|---|---|---|---|---|
| **WP-16 (#938)** Flat-cutter feeds coupon ladder bracketing the catalogue hardwood row → the first measured hardwood row → a two-line flat-cutter label | stick, vise, the recommended flat cutter | coupon verdicts recorded, row `measured` and committed; letters open, floors flat and clean, no fuzz, no burn, no tear-out; depth ±0.1 | Session E: the 284 generator takes a hardwood ladder; `--tool` pinned; readback |
| **WP-17 (#939)** Pocket-and-bores face: 20 × 10 × 3 rect pocket r2, ⌀8 × 3 round pocket, four ⌀3.2 bores 6 deep (bored) | stick, vise, flat cutter at the measured row | pocket ±0.1, depth ±0.1; bores go 3.0 / no-go 3.3; clean floors, no burn | the 36 mm-tall stock's seat/proud/grip sentences right on the sheet |
| **WP-18 (#940)** Two-cutter job: 24 × 24 × 6 pocket with the flat, two initials V-carved 0.8 deep on its floor; the tool change through the app's prompt | stick, vise, flat then V/chamfer | both programs from the app with no hand command; initials legible, centred ±0.5; pocket ±0.1 | #655's prompt seen once; the safer of one-program/two-program forms chosen and recorded |
| **WP-19 (#941)** Chamfer the four top edges 1 × 45°, then a 6 × 10 through-slot across the 36 mm width, open both sides | stick, vise, chamfer then flat | legs 1.0 ±0.2; slot 6.0/10.0 ±0.1; exit edges without tear-out deeper than 0.3 mm; no burn | the chamfer's feeds row named; the slot exits over the jaws pass both the plan-view and the engine fixture check (#923) |

#### Phase 5 — Close out (1 day)

| WP | Deliverable |
|---|---|
| **WP-20** `docs/bench/milestone-1-clean-samples.md` filled with the measured results, photos and run records; every feeds row used flipped to `measured` and committed; each cnc-guide section the samples exercised flipped to Available; #767 fully ticked or re-filed; the Milestone 1 issue closed with the six lines each pointing at its evidence |

### 4.4 Sample acceptance numbers (proposed — the repo has none; hardwood)

Written as the operator's checklist; a caliper reads 0.01 mm, so each number has an instrument.
Hardwood moves and tears, so depth is ±0.1 mm, not the ±0.05 a plastic would allow. Adjust after the
first part and record the adjustment on #943.

| Property | Number | Instrument |
|---|---|---|
| Engrave depth (text) | within 0.1 mm of the programmed depth, centre vs ends within 0.1 mm | depth gauge |
| Text placement | centred on the face within 0.5 mm | calipers to the stock edges |
| Legibility | every item readable at arm's length; no fused counters | eye |
| Stroke and pocket edges | no tear-out, no fuzz standing above the surface, no burn mark | eye, loupe, photo beside a scale |
| Pocket dimensions | ±0.1 mm length/width/diameter; depth ±0.1 | calipers / depth gauge |
| Bores | go 3.0 pin / no-go 3.3 (⌀3.2 nominal) | pins or calipers ±0.1 |
| Slot | width and depth ±0.1; walls square; exit tear-out ≤0.3 mm deep | calipers, eye |
| Chamfer | legs 1.0 ±0.2 mm, even along the length | calipers |
| Tool change | both programs from the app, no hand command | transcript |
| Time | predicted within 10 % of the clock, per program | run record |
| Repeatability (sample 1) | origin spread over three re-seats recorded; depth criterion met each time | registration record |

### 4.5 Bench sessions (six, ≤90 min each, in order)

| Session | Purpose | Needs | Issue |
|---|---|---|---|
| S1 (Phase 2) | air: #767 ticks, WP-10/11, D3 timing, junction read | wired + 3D probe, any cutter, one stick (not cut) | #935 |
| S2 (Phase 3) | groove coupon on the stick's end; the flagship text job from the GUI; calipers | stick, recommended cutter, wired probe, calipers/depth gauge | #936 |
| S3 | repeatability ×3; cut nothing | the same stick | #937 |
| S4 | flat-cutter coupon ladder → measured row → flat text | stick(s), flat cutter | #938 |
| S5 | pocket-and-bores face; start the two-cutter job | stick, flat cutter, pins | #939, #940 |
| S6 | two-cutter job; chamfer + through-slot | stick, flat, V/chamfer cutters | #940, #941 |

Every session: `power.sh on` (CR-stripped `ha-api.sh` copy ready; `--cycle` on standby), `$H` before
hands in the machine and as the last command, `M821` for the whole job, `M331` before play (wood dust),
one instruction per message, frame each touch, save the transcript after every run.

### 4.6 Exit criteria

Milestone 1 closes when the six lines of §1 each point at a dated record: the gate's ten statements
on three jobs (WP-1…9), five measured parts (WP-14, 16–19), the repeatability spread (WP-15), the
measured rows committed, time within 10 %, and #767 empty or re-filed.

---

## 5. Issue mapping

**Becomes the milestone spine:** a new Milestone 1 issue (WP-0a); #569, #570, #567 stay as records.
**Absorbed into work packages:** #767 → WP-0e/13; #790 → WP-10; #304/#499 → WP-11 (watch-only);
#284 → WP-16/17/20; #592 → WP-12 (its "FIND the stock" proposal is parked: the datum path already
finds it); #501 → WP-14's calipers decide whether G32 is needed at all; #913 → its numbers feed WP-17, its
implementation stays in 1.1; #208 → D3 in WP-13, the rest parked; #443/#444 → parked (bracket).
**Close as "already done"/duplicate:** #663, #676 (per their last comments), #729 (per its last
comment, after confirming the three fixes are on `main`).
**Re-file (lost):** #736 part 2 (vise lift as through-cut clearance); the tape-job/vise run-sheet
observation; the chamfer's unnamed feeds row; the UI/CLI divergence (WP-2) if the peer has not filed
it; the #580/#584 record correction.
**Park with the label:** everything in §4.2.

---

### 5.1 Issues filed (2026-11-02)

GitHub milestone *Milestone 1 — Clean samples from the app* (#22); tracking issue **#943**; marching
orders for the manager session in `2026-11-02-manager-marching-orders.md` (team shape, file ownership,
test tiers, waves, landing and bench protocol).

| WP | Issue | WP | Issue | WP | Issue |
|---|---|---|---|---|---|
| WP-0a | #943 (tracking) | WP-6 | #926 | WP-13 | #935 |
| WP-0b | #918 | WP-7 | #927 | WP-14 | #936 |
| WP-0d | #919 | WP-8 | #928 | WP-15 | #937 |
| WP-0e | #920 | WP-9 | #929 | WP-16 | #938 |
| WP-1 | #921 | WP-9a | #930 | WP-17 | #939 |
| WP-2 | #922 | WP-9b | #931 | WP-18 | #940 |
| WP-3 | #923 | WP-10 | #932 | WP-19 | #941 |
| WP-4 | #924 | WP-11 | #933 | WP-20 | #942 |
| WP-5 | #925 | WP-12 | #934 | WP-21 | #944 |
| WP-22 | #945 | WP-23 | #946 | | |

## 6. Risks and unknowns

1. **Dome vs tilt on printed blanks.** The chain (re-post vs G32 vs accepted floor) rests on whether
   the colour plane bows with the blank. The 10-25 part that could have decided it was discarded
   unmeasured; WP-14's calipers decide it; until then WP-12 keeps the G32 text hidden.
2. **Printed-plastic feeds.** Every flat-cutter sample runs on seeded rows the maintainer's own
   guidance calls wrong; the coupon-first order in Phase 4 is the mitigation. If the coupons show the
   seeds are rubbing, WP-17's readback flips the row before any part is judged.
3. **The link under a silent drop mid-motion.** Nothing tests it; the bench has not reproduced a drop
   since 10-08. WP-11 bounds the damage; it does not prevent it.
4. **Capacity habits.** The rules in §4.1 cut parallelism from five slots to two and ban the slot
   refilling that generated most of the fortnight's issues. If they are not held, Phase 1 will be
   overtaken by breadth again within a week, as the 10-25 review's rule was.
5. **Scope drift inside Phase 1.** WP-4 (independent oracle) and WP-6 (efficiency) can each grow into
   a month. Their acceptance lines are deliberately narrow: three jobs, two thresholds.
6. **Hardwood is new ground.** Nothing has been cut in wood on this Z1; the hardwood rows are seeded
   guesses; a 36 mm-tall stick in the low-profile vise has never been held; sawn faces may read a larger
   surface spread than the printed badge. Mitigations: a coupon on the same stick before every sample,
   the frame air-run, the catalogue row over the seed, the re-seat offer before any re-post.

---

## Appendix — method and sources

Seven background reads on 2026-11-02 against `main` 5bcc5a88, none editing the project, none
touching k3, the Z1 or the plug: `01-bench-history.md` (every `docs/bench` record, trace and 24
issues), `02-engine-review.md` (module map, pipeline trace, churn, schema, 18 pipeline specs run:
591/591), `03-simulation-gate.md` (verifier/sweep/oracle/time/caps, 14 specs run: 144 pass),
`04-registration-bridge.md` (executor, bridge, 40 issues), `05-samples-corpus.md` (corpus, six CLI
runs against a local fixture), `06-process-churn.md` (827 commits themed, 381 issues), `07-ui-walk.md`
(the first-job flow driven headless on a private port). The peer session's UI-vs-CLI finding (§2.7)
is reported as received. Commit and issue counts are from `git log --since=2026-10-19` and `gh`
on 2026-11-02.
