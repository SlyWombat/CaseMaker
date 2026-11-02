# Milestone 1 — marching orders for the manager session

*Written 2026-11-02 for the session that manages the Milestone 1 build. The evaluation and the plan are in
`2026-11-02-cnc-milestone-1-review.md`; this document is how to run it fast with six implementer
sessions and one manager across three machines, and where full regression testing is required.
Tracking issue: **#943**. GitHub milestone: *Milestone 1 — Clean samples from the app* (#22).*

**The maintainer's rules that frame everything:** (1) no further cutting until the simulation can
validate a job's correctness and efficiency — Phase 1 is that gate and it finishes before bench
session S2; (2) the first-job path is the deliverable — everything in the review's §4.2 freeze list is
parked, not worked, until #943 closes; (3) **the material is hardwood** — 36 × 36 × 100 mm sticks are on
hand; printed plastic and laminate need their own technique and are 1.1 (#913); (4) **a report every
12 hours** (§8); (5) **the Z1 Demo Jobs page is the gate** (#944): cleaned to cards the simulation can
visually validate, rebuilt on the pinned sha every wave, and **no bench work of any kind — not even the
air session — until the elephant (#945) and the panther (#946), **scaled in the app to fit the 36 × 36 × 100 stick**, read "Matches the design" on it.**

---

## 1. Shape of the team

Seven sessions: one manager and **four programmers on dave-1** (which has the three `heavy.sh` slots —
shared by all five sessions there), **one programmer on gpd-dave** (`case-maker-e9`), **one on davebook-5** (`case-maker-2c`) (each alone on
its machine, no slot contention). The two remote programmers take the columns whose landings need full
regression most often (the engines and the generator); the four on dave-1 take the targeted columns.

| Role | Session | Machine | Owns |
|---|---|---|---|
| **Manager** | this session | dave-1 (WSL + Windows side) | review of every hunk, gate, landing on `main`, k3 publish, bench driving and recording, the tracking issue's state line, the parked list, **the 12-hourly report** (§8); **has first claim on one heavy slot** |
| **A — gate** | programmer `case-maker-e9` | gpd-dave | the two sweep engines, routing, oracle, package hash, run gate; in Phase 2 the registration executor and the machine console/protocol |
| **B — pipeline + 3D goal CAM** | programmer `case-maker-2c` | davebook-5 | generator, validator, feeds, schema/types, the Z1 post; the headless CLI's engine seam (the fix half of #922); **the 3D goal CAM** (`generateGoalProgram`, surface3d, rough3d, goal*, underside, flip setups) that makes the elephant and panther pass (#945/#946, with #898/#914/#916) |
| **C — efficiency** | programmer | dave-1 WSL | the IR and time model, the run sheet, run-record fields, shop-default seeds (TS + `defaults.rs` + fixture), Simulate footer line |
| **D — operator path** | programmer | dave-1 WSL | the welcome wizard, EngravePanel, the Cut step, registration step UI, holding step, planner acceptance (WP-12 only) |
| **E — bench tooling, samples and the demo page** | programmer | dave-1 WSL | `scripts/**`, `tools/z1/**`, the committed sample jobs and coupon records under `docs/bench/`, readback, the D3 capture tooling, the `--tool` pin, the measured-row commits; **the demo-page generator** (`docs/bench/2026-10-28-z1-real-jobs/tools/**`, #944) and its rebuild at every T3 |
| **F — tests and harness** | programmer | dave-1 WSL | the golden artefact and its fixtures, the UI/CLI identity spec, the first-job e2e specs, the off-bench CDP walk and k3 smoke scripts, win32 baseline regen, the three-state Cut spec |

Why six columns and not fewer: the review's §4.1 asked for fewer streams because the fortnight's
regressions came from ten streams rewriting the same four files. Six is fine **only if the ownership
below is honoured** — a column never edits another column's file. A session that needs a hunk elsewhere
asks the manager, who sequences it (owner lands first, requester rebases) or has the owner make the hunk.
No reduced-blob surgery on shared files in this milestone.

### 1.1 File ownership (exclusive while the milestone runs)

| Session | Files |
|---|---|
| A (`case-maker-e9`, gpd-dave) | `src/workers/sim/session.ts`, `src/workers/sim/routeEngine.ts` (new), `src/workers/geometry/**`, `src/engine/cnc/engrave/oracle.ts` + `designCheck.ts` (new), `simCoverage.ts`, `src/engine/cnc/verify.ts`, `src/engine/cnc/engrave/package.ts`, `src/store/engraveRunGate.ts`; Phase 2: `src/engine/cnc/registration/execute.ts`, `outcome.ts`, `src/platform/machineConsole.ts`, `machineStop.ts`, `src/platform/desktop/protocol.ts`, `machineBridge.ts`, `machineRun.ts` |
| B (`case-maker-2c`, davebook-5) | `src/workers/sim/engraveGenerate.ts`, `src/engine/cnc/engrave/jobSetup.ts`, `partPlan.ts`, `feeds.ts`, `src/engine/cnc/cam/engraveJob.ts`, `src/engine/cnc/post/**`, `src/store/engraveJobSchema.ts`, `src/types/engraveJob.ts`, `src/platform/headless/**` (engine seam), the generated `engrave-job.json`; **3D goal CAM:** `src/engine/cnc/cam/surface3d.ts`, `rough3d.ts`, `adaptive*.ts`, `src/engine/cnc/engrave/goal*.ts`, `goalUnderside.ts`, `goalFlipSetups.ts`, `src/engine/jobs/poolSizing.ts` |
| C (dave-1) | `src/engine/cnc/cam/ir.ts`, `src/engine/cnc/machine.ts` (profile terms), `src/engine/cnc/engrave/runSheet.ts`, the run-record writer and schema, `src/platform/defaultsClient.ts`, `src-tauri/src/defaults.rs`, `tests/unit/fixtures/location-doc.json`, the Simulate footer summary line |
| D (dave-1) | `src/components/welcome/**`, `src/components/panels/EngravePanel.tsx`, `EngraveCutSurface.tsx`, `EngraveRegistrationStep.tsx`, `useMountTap.ts`, `src/store/engraveRunStore.ts` (step derivation), the default-job seed (`defaults.ts`, `blankLabelSeed.ts`), `src/engine/cnc/registration/plan.ts` (WP-12 only), `src/engine/cnc/engrave/surfaceSpread.ts` (verdict sentence) |
| E (dave-1) | `scripts/**` (CLI front end, readback, coupon and bench scripts; NOT `src/platform/headless`), `tools/z1/**`, `docs/bench/**/*.job.json`, `docs/bench/*-coupon-record.json`, `docs/bench/2026-10-28-z1-real-jobs/**` (jobs, manifest, README and **`tools/**` — the demo-page generator**), the measured-row data commits |
| F (dave-1) | `tests/unit/engraveGolden*.spec.ts` + `tests/unit/fixtures/golden/**`, `tests/unit/pipelineIdentity*.spec.ts`, `tests/e2e/**`, `tests/e2e/**/*-chromium-win32.png`, the CDP walk / k3 smoke scripts under `tests/tools/` (new), `playwright.config.ts` |
| Manager | `docs/**` prose, `cnc-guide.md` (ch. 8 rows are added by the owning session in the same commit; the manager runs `docs:sync`), issues, `CHANGELOG.md` |

Unit specs other than F's live beside the code they test and belong to the code's owner. F writes the
specs that cross columns (golden, identity, e2e, the three-state Cut spec) and never edits `src/`.

`cnc-guide.md` and the generated `engrave-job.json` are touched by several sessions by necessity; they
are the two files where the manager expects rebase conflicts and resolves them at landing.

---

## 2. Machines, worktrees and node_modules

- **One checkout per OS, never shared** (`node_modules` holds OS-specific binaries). Each implementer
  session has its own worktree(s) on its machine: `~/projects/cm-wt/<issue>` (Linux/WSL) or
  `C:\Projects\cm-wt\<issue>` (Windows). WSL vitest in a Windows-installed checkout fails on the rolldown
  binding — do not try; run Linux tests in a Linux-installed worktree (`npm ci` once per worktree).
- **Git on every worktree from WSL only** on dave-1 (Windows git cannot see a WSL-made worktree).
- **The gate copy is the repo root**, not `casemaker-app/` (specs read `../docs` and `../samples`; a
  flattened copy fails ~117 tests with ENOENT that look like regressions).
- **Heavy runs on dave-1 go through `~/casemaker-manager/heavy.sh`** (three slots, `--maxWorkers=6`), and
  the slots are machine-local: five sessions (manager + C, D, E, F) share them; A and B on their own
  machines never queue. The bottleneck the maintainer named is this queue. The relief is in §3: on dave-1
  the hand-over tier is **T1-lite** (no full vitest by the programmer — the manager's per-batch T2 is the
  full run), the manager has first claim on one slot, and the four dave-1 programmers share the other
  two for the few full runs they do need (a hot-file commit, a `package-lock` change, cargo). A and B run
  full T1 on their own machines before every hand-over, which is why they hold the engine and generator
  columns whose landings need it most.
- **Bench-day hold:** no heavy suites on dave-1 while a bench session is open (the harness and the
  CDP driver need the cores). Implementers on the other two machines carry on.
- **k3** (`192.168.10.38`) is published from dave-1 only (`publish <sha>` then `prune`). One publish per
  wave end, plus the pre-bench publish. Never during a bench session. Each publish costs ~1 GB until pruned.
- **Windows side of dave-1** is needed only for: the win32 e2e baselines (a `C:\Projects\cm-wt-win\<name>`
  worktree with its own `npm ci`), `cargo test --lib` in `cm-bench` with `dist/` present, and `tools/z1/`
  at the bench.

---

## 3. Test tiers

| Tier | When | Who | What | Time |
|---|---|---|---|---|
| **T0** | every edit | implementer, in the worktree | `npm run typecheck` (both tsconfigs; `tsc -b` alone misses `tests/`); `npx vitest run --changed <base-sha>` (vitest follows the import graph) plus the specs the issue names; `cncGuide.spec` if a diagnostic code moved; `docsRoundTrip.spec` if run-sheet text moved | 1–3 min |
| **T1 (full)** | hand-over of a slice | A and B, own machine | T0 + `npm run lint` + **full vitest** (unrestricted) + the e2e specs that use any testid the diff adds/renames/removes (`grep -rn <testid> tests/e2e`) + `cargo test --lib` (with `dist/`) if `src-tauri` changed. Report = the sha, the `Test Files … passed` line verbatim, the e2e spec names and results, rebased on current `main` | 5–10 min |
| **T1-lite** | hand-over of a slice | C, D, E, F on dave-1 | T0 + `npm run lint` + the specs the issue names + the e2e specs for touched testids (one spec at a time, own `CASEMAKER_PORT`) + cargo if `src-tauri` changed. **No full vitest** — that is the manager's T2 for the batch. Exception: a hot-file commit or a `package-lock.json` change runs the full suite through `heavy.sh` before hand-over. Same report line, stating "T1-lite" | 2–5 min |
| **T2** | landing a batch on `main` | manager, dave-1 | review every hunk → typecheck + **full vitest once per batch of ≤4 commits** (bisect only on red) + the union of the batch's e2e specs + cargo if any commit touched `src-tauri`. A batch that touches a hot file (`engraveGenerate.ts`, `jobSetup.ts`, `runSheet.ts`, `EngravePanel.tsx`, the schema trio, `session.ts`, `engraveRunGate/Store`) runs the full vitest **per commit** | 10–20 min per batch |
| **T3** | end of a wave; any cross-cutting package (#922, #923, #929); any schema or routing change; before every k3 publish | manager, dave-1 | T2 + **full Playwright** (3 projects, ~14 min; known load flakes named on #919 are re-run alone before being called red) + `cargo test --lib` + golden artefact (#921) + UI/CLI identity (#922) + win32 baseline regen if a snapshot changed + `npm run build` + **E rebuilds the Z1 Demo Jobs page on the candidate sha (#944) and the manager reads the elephant/panther verdicts and the five sample cards**. Then publish to k3, prune, `status`, and a CDP smoke of the first-job flow to the Cut step on k3 | 60–90 min |
| **T4** | the day before every bench session, on the pinned sha | manager, dave-1 | T3 on the pinned sha; print the run sheet of the session's job; a dry CDP walk of the exact flow the operator will take (to the Register step, no machine); the runbook of ≤5 items on the bench issue; `power.sh` CR-stripped copy ready | 60–90 min |

**Where full regression (T3) is mandatory, in words:** at the end of every wave; whenever #922 (one
pipeline), #923 (column-engine fixture), #929 (the extraction), any 3D goal CAM landing for #945/#946, or
any schema/routing change lands; before every k3 publish; before every bench session (as T4); after any
`package-lock.json` change (with `npm ci` in the gate copy first). The demo page is rebuilt at every T3. Everything else is T1 at hand-over and one T2 per batch. That is how six
sessions land a wave without the heavy queue exceeding the fortnight's 20-minute waits: A and B run their
full suites off dave-1; on dave-1 the full vitest runs once per manager batch (plus the rare hot-file
hand-over), and Playwright once per wave — about five heavy runs a day on dave-1 instead of twenty.

**Three traps the gate has already fallen into:** a "green" gate that re-ran the old commit because
Windows git could not check out the sha (always `git log -1` in the gate log); `tsc -b` reported clean
while `tests/` had errors (use `npm run typecheck`); an e2e failure called "pre-existing" that a removed
testid caused (grep first, reproduce on the prior sha before calling it environmental).

---

## 4. Waves

Each wave is a set of file-disjoint packages, one per session, landed in the stated order. A session
that finishes early takes the next package in ITS column, never one from another column. The manager
lands as reports arrive (T2 per batch) and runs T3 at the wave's end, then publishes once.

### Wave 0 — manager only (day 1)

#943 (this spine, the acceptance doc `docs/bench/milestone-1-clean-samples.md`), #918 (freeze list
applied), #919 (pinned sha, k3, T3 baseline), #920 (#767 reconciled). Send the four wake-up briefs (§7)
with wave 1's packages. No implementer code lands before #919's baseline exists.

### Wave 1 — the gate exists (days 2–5)

| Session | Packages, in order | Landing order |
|---|---|---|
| F | **#921 golden** (1 d) → the #922 identity spec (red on j13 first) → the #930/#931 e2e specs as D's screens land | #921 lands FIRST, same day; everyone rebases over it |
| B | #922 one pipeline — the fix half, against F's red spec (2 d) → **#945 elephant** (flat underside stop, the cutter plan for a figure that fits, reach-bounded setups; 2–3 d) | after #921; both T3 landings |
| E | **#944 the demo page** — card rule, computed verdicts, one-command rebuild with the sha as an argument, the five sample cards (2 d) → the hardwood coupon ladder for #938 (1 d) → the #939 pocket-and-bores sample job (0.5 d) | #944 lands early so every T3 can rebuild the page |
| A | #925 air error + version hash (0.5 d) → #928 routing table (0.5 d) → #923 column-engine fixture (2 d) | after #921 |
| C | #926 efficiency measures + thresholds (2 d) → #927 time model (1 d) | after #921; `defaults.rs` → cargo at T2 |
| D | #930 default job generates (1.5 d) → #931 Cut mode truth (1 d; needs #925 for the severity) | after #921; F supplies the e2e |

Wave-1 exit: T3 green; k3 published; the demo page rebuilt on the wave sha with the new card rule; the
Simulate panel prints the design-independent numbers it has so far; the default engrave and pocket reach
four ticks on the faked location (e2e). #922, #923 and the goal CAM are T3 landings on their own.

### Wave 2 — the gate is complete, the path is one path (days 6–9)

| Session | Packages | Notes |
|---|---|---|
| A | #924 independent design oracle **including the 3D half: the swept surface against the goal heightfield in-app (cut-into map, coverage %)** (2.5 d) | lands before the panther's final card |
| B | **#946 panther** — laid-flat plan, #914 reach-aware quarter turns, #898 part 2 tabbed freeing cut, the stored-orientation fix (3–4 d); then #929 extraction + schema v3 closed (2 d) **if the demo gate is ticked**, else #929 slips to wave 3 | #946 is the gate's last code; #929 lands LAST, after #924/#926/#927 |
| C | #927 remainder (readback, out-of-sample re-estimates); the chamfer feeds-row question for #941; the #939 ladder cells + `M811` | small items; then starts #935 tooling (D3 capture script) |
| D | #934 one registration procedure, hidden branches, re-seat offer (1.5 d) | D also wires the Stop call A exposes in #933 |
| E | the demo page rebuilt as #945/#946 land (each rebuild on the candidate sha; the elephant and panther cards are what the manager reads); the #940 two-cutter sample job and the #941 chamfer + slot programs on the stick | the page rebuild is on the critical path to the bench |
| F | the e2e for #934's single path; the CDP k3 smoke script the manager runs at every T3; the three-state Cut spec | |

Wave-2 exit: T3 green; k3 published; **the ten statements of review §2.3(e) hold on the flagship hardwood
job, j16 and the committed figure corpus** (the manager checks each statement against the panel and the
run sheet and writes the result on #943 line 1); **and the demo page, rebuilt on the wave sha, shows the
elephant and the panther as "Matches the design"** (#943 line 1b). Both lines ticked = the maintainer's
"simulation validates" condition met, and the bench may be scheduled. Until then, no bench session, S1
included.

### Wave 3 — bridge hardening and the air session (days 8–11, overlaps wave 2)

| Session | Packages |
|---|---|
| A | #932 G38.5 release + H:3 wording (1 d) → #933 poll window, cold-start `$H`, mid-motion Stop, G54 pre-flight (2 d) |
| D | the Stop button wiring for #933; the UI-walk small defects (file name on the door, units on vise fields, provenance chips, "Sacrificial material" wording) as ONE commit, no sweep beyond the first-job screens |
| B | fixes the bench produces in its column (hardwood rows, step-downs, the tool-change program form for #940) |
| C | the run-record actual-time fields (#927) ready for S1; the chamfer feeds-row answer for #941 (a 0.1 mm-tip chamfer on hardwood resolved an unnamed seeded row) |
| E | D3 capture tooling and `readback run` ready for S1; the S1 runbook's frame files on the card list checked |
| F | the dry CDP walk the manager runs at T4; win32 baselines for any D screen that moved |
| Manager | **#935 bench S1 (air)** once #932/#933 are on the pinned k3 sha AND #943 lines 1 and 1b are ticked (T4 the day before) |

### Waves 4–6 — the bench (every second day, ≤90 min, one runbook each)

| Session | Package | Prerequisite |
|---|---|---|
| S2 | **#936 Sample 1** — the flagship text job on the hardwood stick from the GUI, after a 10-min groove coupon on the stick's end; calipers | #943 line 1 written (Phase 1 done), S1 done, T4 |
| S3 | #937 repeatability ×3 | same day as S2 if time allows |
| S4 | #938 hardwood flat-cutter coupon ladder → measured row → flat text | E's ladder generator landed |
| S5 | #939 pocket-and-bores face; start #940 | #938's measured row |
| S6 | #940 two-cutter pocket + V text on its floor; #941 chamfer + through-slot | #655's prompt seen once; #923's fixture check on the slot exits |

Hardwood is new ground for this Z1 (every cut so far was PLA, PETG or laminate): a 36 mm-tall stock in
the low-profile vise (floor seat, grip height), seeded hardwood rows that are "conservative guesses for
a 150 W spindle", dust. Every bench cut is preceded by its coupon on the same stick and the frame
air-run; the vacuum is on for every cut.

Between sessions the six programmers take only the fixes the bench produced, each in its own column,
each closed with the next session's observation. The manager records results on the issues before
power-off, every time. Then #942 closes it out.

**Calendar, if the waves hold:** Phase 1 and the demo gate complete by about day 11 (the panther's
multi-side plan is the long pole); S1 by day 12; S2 by day 14; S6 by about day 22. About twenty-two working
days from the six sessions, one manager and six bench slots.

---

## 5. Landing protocol (the manager's loop)

1. **Report arrives** (sha, T1 lines, rebased). Fetch by FULL sha into the gate clone; `git log -1`
   in the log. Check `ListAgents` for a live peer with hunks in the same file before reading.
2. **Review every hunk** against the issue's acceptance line and the review doctrine: order of material
   removal, the non-happy document path, what the machine would do, a test that fails without the
   change. Bounce with the finding, not a fix. No landing on the peer's description.
3. **T2** per batch (≤4 commits; per commit on hot files). Read the fail line before anything else.
4. **Land** on `main` in the Windows checkout from WSL (`git worktree list` shows main only in the
   checkout; clean tree; tree match after cherry-pick), push, realign the clone.
5. **Close the issue only with evidence**: the sha, the T2 line, and — for anything that changes what
   the machine does or what the gate says — the bench record, or leave it open labelled `code-complete`.
6. **Wave end**: T3; publish k3; prune; `status`; CDP smoke; update #943's state line (base sha, k3 sha,
   wave, next bench date, last bench-observed closure).
7. **Fix-storm brake**: an issue with three `fix` commits in 24 h stops; the next thing is a one-page
   design note and a failing test, reviewed before more code.
8. **Never** implement yourself; **never** ask the maintainer mid-run (a question becomes a `question`
   issue with a default, except a bench decision, which waits for the bench); **never** publish during
   a bench session; **never** `pkill` by pattern on dave-1 (peers run there).

---

## 6. Bench protocol (every session)

`power.sh on` (CR-stripped `ha-api.sh` copy; `--cycle` if the Z1 is silent with the plug on) → `$H` →
`M821` for the whole session → hands in the machine only after `$H` and Idle → `M331` before any play →
`M119`/`M491` after every probe or cutter swap → one instruction per message to the maintainer → frame
each touch from the camera → save the transcript after every run → results written on the issues
BEFORE `$H` and `power.sh off`. The maintainer is at the machine for the hands-in steps only; the manager
drives the GUI walk-through for S1 but **a human drives the GUI for S2–S6** (that is milestone line 2).
A session is five items, in priority order, written on the bench issue the day before; whatever is not
reached rolls to the next session, nothing is squeezed in.

---

## 7. Wake-up briefs (send verbatim-ish; the issue is the source of truth, not a copy)

Addresses: `ListAgents` → `SendMessage`. A = `case-maker-e9` (gpd-dave), B = `case-maker-2c` (davebook-5); the four
dave-1 programmers are named when they are started — record their names on #943's state line.

**Common preamble.** "Milestone 1 is the only work: tracking #943, marching orders
`docs/reviews/2026-11-02-manager-marching-orders.md`, plan `docs/reviews/2026-11-02-cnc-milestone-1-review.md`.
Your column and your files are in §1.1; do not edit another session's file — ask me. One worktree per
issue off main <base sha>; the issue text is the spec, read its comments. Every hand-over: rebased on
current main, `npm run typecheck`, FULL vitest on your machine with the `Test Files … passed` line quoted,
the e2e specs for any testid you touched, cargo if `src-tauri`. Keep your own context small: one subagent
per slice, no diffs or test output in your parent turn; after a compaction message me 're-sync' and I send
this brief again. Never end a turn with a finished slice unreported. No sweeps, no follow-up issues of
your own without my go; a question becomes a comment on the issue with your default, and you continue."

- **A (`case-maker-e9`, gpd-dave):** "Take #925, then #928, then #923, in that order, after #921 lands (I will tell you
  the sha). #923 is a T3 landing — give me a fixture where a V-bit swings into a jaw. Then #924. Phase 2
  you take #932 and #933."
- **B (`case-maker-2c`, davebook-5):** "Take #922 — F is writing the identity spec that is red on j13; fix the feeds /
  step-down / rpm resolution so the worker and the CLI call one function, and land green against F's
  spec (a T3 landing). Then you own the 3D goal CAM: #945 the elephant (flat underside, the cutter plan
  for a figure that fits, reach-bounded setups), then #946 the panther (#914 quarter turns, #898 part 2
  tabs, the stored-orientation fix). The pass criteria are on those issues; the maintainer wants both
  reading 'Matches the design' on the demo page before any bench work. E rebuilds the page on your
  candidate sha — ask me for a rebuild when you think a figure passes. #929 comes after, if the gate is
  ticked; the runSheet split is C's hunk."
- **C (dave-1 WSL):** "Take #926, then #927. The thresholds are shop defaults — three edits (TS seed,
  `defaults.rs`, `location-doc.json`) and cargo at hand-over. Hand over at T1-lite: no full vitest from
  you — I run it per batch; the exception is a hot-file commit or a lockfile change. In wave 2 you own
  the runSheet half of #929."
- **D (dave-1 WSL):** "Take #930, then #931 (after #925). The captures are in
  `docs/bench/img/2026-11-02-ui-walk/` and the walk report in `docs/reviews/2026-11-02-cnc-review/07-ui-walk.md`.
  Grep `tests/e2e` for every testid you rename and tell F, who owns those specs and runs them. Hand over
  at T1-lite. In wave 2 you take #934; in wave 3 the Stop wiring for #933 and the small UI-walk defects
  as one commit."
- **E (dave-1 WSL):** "You own `scripts/**`, `tools/z1/**`, the committed sample jobs and coupon
  records under `docs/bench/`, and the Z1 Demo Jobs page generator (`docs/bench/2026-10-28-z1-real-jobs/tools/`).
  Take #944 FIRST: the page keeps only cards the simulation can visually validate against an objective
  reference (design overlay, goal mesh deviation map, or a reference program), computed verdicts, no
  photo-judged verdicts, the five hardwood sample cards, one command to rebuild on a given sha; the
  elephant and panther meshes are in `samples/3d/` (the maintainer's, local-input — never delete or move
  them). Rebuild the page whenever I name a candidate sha. The material is hardwood, stock 36 × 36 × 100 mm
  sticks. Then, in order: the #938 coupon ladder (the 284 generator with a hardwood ladder bracketing the catalogue row for the
  recommended flat cutter, `--tool` pinned, readback flipping the hardwood row to measured); the #939
  pocket-and-bores sample job on the stick's 36 × 100 face; the D3 capture script for #927/#935; then the
  #940 two-cutter job and the #941 chamfer + slot programs. Hand over at T1-lite. You never edit `src/` — if a sample needs an
  engine change, comment on the issue and I route it."
- **F (dave-1 WSL):** "You own the cross-column tests and never edit `src/`. Take #921 first and hand it
  over today — the golden badge/laminate/single-thin artefact, byte-compared, `--update` only by hand.
  Then the #922 identity spec: worker `engraveGenerate` vs `casemaker cut` on the badge, j13 and j16,
  red on j13 today, committed red and handed to B. Then the e2e for #930 and #931 as D's screens land,
  and the three-state Cut spec. Run one e2e spec at a time on your own `CASEMAKER_PORT`; never the suite.
  Hand over at T1-lite."

---

## 8. What to report, and to whom

**Every 12 hours** to the maintainer (one message; the same lines each time, so a change is visible):

1. #943 state line: base sha, k3 sha, wave in flight, next bench date.
2. Landed since the last report: issue → sha → tier it passed (T2/T3), one line each. Bounced: issue → the
   finding, one line each.
3. In flight per session (A–F): issue, state (coding / T1 / handed over / blocked), the blocker in words.
4. Bench: observations recorded since the last report (issue → what the machine did), #767 ticks, the
   one decision that waits on the maintainer, if any — with the default you will take if unanswered.
5. Numbers (no commit counts): bench-observed closures to date, % of landed commits on the path, fix:feat
   on the path.

Also on #943's state line after every wave, and on each bench issue before power-off. Nothing else goes
to the maintainer unasked.
