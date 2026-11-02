# Process review — Case Maker, 2026-10-19 → 2026-11-02 (main at 5bcc5a88)

Read-only review of the git log, the GitHub issue tracker (550 issues fetched with comments, #368–#917,
plus #238/#240/#241/#323/#347/#391), the milestones, `docs/reviews/2026-10-25-24h-code-review.md`,
`docs/design/first-job-audit-2026-10-26.md`, the bench records under `docs/bench/`, and the orchestration
conventions recorded in the maintainer's Claude memory files. Nothing was edited, built or installed.

**One premise correction.** The last physical cut was **2026-10-25 13:42–13:46**, not 10-17: the badge
("Single Barrel" + "br") was cut from the app's own registration → re-post → upload → run path
(`docs/bench/2026-10-24-datum-path-bench.md` §"THE FIRST CUT"). Its result: *"Single Barrel" reads … "br"
unreadable exactly as the gate warned … chipping at the lower-left edge (clamp)*; the calipers that would
settle the dome-vs-bow question (#631) were "owed" and **never recorded**. #569 (the first-cut acceptance)
and #570 (repeatability) are still open. Since then the bench was powered on 10-30 (3D-probe wiring
survey), 10-31 (probe-bore attempt: `[timeout]` lines, `$X` twice) and 11-01 (accessory switches, `ls`),
and **no program has been cut**. So the window contains 827 commits and one unaccepted cut.

---

## 1. Commit themes (827 commits, 800 of them citing an issue)

Classification: each commit's first cited issue was mapped to a theme (table of ~330 issue→theme
assignments, built from `gh` titles/milestones), with scope-keyword fallback for the 27 commits that cite
no issue. #723 was split by slice tag (R-* = rotary relief → (c); P2-* = two-sided flip → (d)). Theme (a)
is split into the badge path proper and the adjacent "new mount kinds" work, because the second is new scope
wearing the first's vocabulary.

| theme | commits | % | fix | feat | test | docs | other | touch `src` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| (a1) the clean-cut path proper — registration, run, oracle/verifier/sim on the badge job, Z1 bridge/protocol/status strip/probe/accessories, bench records | 192 | 23.2 | 82 | 65 | 12 | 27 | 6 | 155 |
| (a2) adjacent holdings — bed profiles, bed mounts (tape, bracket+clamps), change-the-machine wizard, stock orientation | 31 | 3.7 | 12 | 15 | 2 | 2 | 0 | 27 |
| (b) first-job UI redesign + the UI waves (wizard, Design/Cut panel, #726 exercise, right panel 1–16, wizard re-order) | 108 | 13.1 | 57 | 30 | 7 | 11 | 3 | 88 |
| (c) rotary — wrap, indexed faces, relief, neck, chuck/tailstock, rotary sim/UI | 89 | 10.8 | 36 | 35 | 11 | 6 | 1 | 74 |
| (d) mesh-to-part / goal / 3D CAM — placement, flip plan, adaptive rough, budgets, parallel planning, 3D rest | 126 | 15.2 | 32 | 56 | 17 | 8 | 13 | 102 |
| (e) operations matrix / parity / new operations / cutter pick / PCB & disc / refusal audit (#786) | 162 | 19.6 | 64 | 69 | 13 | 15 | 1 | 135 |
| (f) GRBL and other machines (Carvera frame + ATC, GRBL presets/post, USB serial) | 19 | 2.3 | 2 | 12 | 3 | 1 | 1 | 18 |
| (g) release / packaging / docs / welcome / spelling / desktop hardening | 46 | 5.6 | 20 | 12 | 5 | 7 | 2 | 35 |
| (h) headless CLI / MCP | 13 | 1.6 | 9 | 4 | 0 | 0 | 0 | 7 |
| (i) other — 3D-printing features (racks, dividers, magnets, stack connector), e2e infra, lint | 41 | 5.0 | 7 | 22 | 9 | 1 | 2 | 30 |
| **total** | **827** | 100 | 321 | 320 | 79 | 78 | 29 | 671 |

**The path proper is 23 % of the fortnight, and it is front-loaded.** By day (a1 / total):
10-20 3/4 · 10-21 3/3 · 10-22 9/16 · 10-23 24/25 · 10-24 41/47 · 10-25 40/57 — then 10-26 4/72 ·
10-27 1/51 · 10-28 14/77 · 10-29 9/63 · 10-30 13/77 · 10-31 39/155 · 11-01 4/140 · 11-02 1/40.
From 10-26 onward the badge path is **~85 of 675 commits (12.6 %)**, and most of those 85 are new
machine features (3D-probe centre-find #827, Carvera files #772, relay #821, diagnose monitor #826,
accessory switches #289) rather than the badge job. Meanwhile fix:feat is 1:1 overall and **57:30 in the
UI theme** — the redesign shipped and was then repaired.

Per-theme files (distinct files; top directories; hottest files):

| theme | files | where the work went | hottest files |
|---|---:|---|---|
| a1 | 6 390 (5 532 are bench PNGs under `docs/bench/img/2026-10-2{3,4,5}-register`) | `src/engine/cnc` 189, `components/panels` 120 | `registration/execute.ts` 30, `EngraveRegistrationStep.tsx` 28, `EngravePanel.tsx` 25, `engraveGenerate.ts` 22 |
| a2 | 113 | `engine/cnc` 43, `components/welcome` 20 | `HoldingStep.tsx` 11, `MachineChangeWizard.tsx` 8, `jobSetup.ts` 8 |
| b | 341 | `components/panels` 144, `components/welcome` 72 | `EngravePanel.tsx` 32, `engravePanel.spec.tsx` 27, `StartWizard.tsx` 18 |
| c | 253 | `engine/cnc` 127, `components/viewport` 39, `workers/sim` 31 | `cnc-guide.md` 24, `jobSetup.ts` 19, `engraveGenerate.ts` 16, `session.ts` 11 |
| d | 358 | `engine/cnc` 147, `components/panels` 59, `workers/sim` 57 | `engraveGenerate.ts` 37, `surface3d.ts` 30, `EngravePanel.tsx` 27, `jobSetup.ts` 25 |
| e | 356 | `engine/cnc` 230, `components/panels` 97, `workers/sim` 78 | `engraveGenerate.ts` 42, `EngravePanel.tsx` 39, `jobSetup.ts` 33, `engraveJobSchema.ts` 21 |
| f | 88 | `engine/cnc` 40, `components/manage` 10 | `machine.ts` 7, `runSheet.ts` 4 |
| g | 230 | `src/docs/img` 21, `components/manage` 12 | `cnc-guide.md`, `index.css`, `lib.rs`, `user-manual.md` |
| h | 41 | `scripts/lib/casemaker` 11, `platform/headless` 8 | `engrave.ts` 8 |
| i | 153 | `engine/compiler` 52, `library/boards` 15 | `ProjectCompiler.ts` 10, `parts.ts` 8 |

**Every theme flows through the same four files.** Source files touched by ≥ 4 themes, with the commit
count per theme (a1/a2/b/c/d/e/f/g/h/i):

| file | commits | per theme |
|---|---:|---|
| `components/panels/EngravePanel.tsx` | 144 | a1 18 · a2 7 · b 32 · c 9 · d 27 · e 46 · f 2 · h 2 · i 1 |
| `docs/cnc-guide.md` (and its `src/docs` mirror) | 135 | a1 9 · a2 10 · b 7 · c 24 · d 26 · e 51 · f 3 · g 4 · h 1 |
| `workers/sim/engraveGenerate.ts` | 134 | a1 15 · a2 5 · b 6 · c 15 · d 35 · e 54 · f 3 · g 1 |
| `engine/cnc/engrave/jobSetup.ts` | 104 | a1 2 · a2 8 · b 3 · c 19 · d 26 · e 42 · f 2 · g 2 |
| `store/engraveJobSchema.ts` / `types/engraveJob.ts` / `engraveJobStore.ts` | 63 / 57 / 56 | 7–8 themes each |
| `engine/cnc/engrave/runSheet.ts` | 59 | a1 17 · e 19 · c 8 · d 6 · f 4 |

Ten parallel streams rewriting `EngravePanel.tsx` 144 times and `engraveGenerate.ts` 134 times in 14 days
is where the "regression" commits come from (90acca01 "#786 regression", 57d6e5e9/3664f6a0/ba55f3b4
"#766 regression", #856 "cone clamp (#786 slice 3) clamps a pocket's depth above its own floor",
f92a2bf4/7c3b9bdf "#839 drift / survive the #839 rebase", a60fe772 "merge the … rows main carried as
conflict markers").

Rate: 155 commits on 10-31 and 140 on 11-01, sustained at 9–15 commits/hour from 10-31 12:00 through
11-01 16:00 (a 28-hour stretch). Nine distinct implementer tags appear in issue comments (d3 27, e5 25,
88 12, d1 12, 47 11, 3e 10, b2 9, 67 5, 1d 5), typically three per day.

---

## 2. Churn chains — the top issues by commit count

Legend: (i) one feature landed in slices · (ii) fix-after-fix churn on the same thing · (iii) rework after
a review bounce / retroactive review · (iv) re-gated or scope moved.

| # | commits | days open | kind | what the chain shows |
|---|---:|---|---|---|
| #743 PCB from Gerbers + disc | 32 | 10-28→10-31 | (i)+(ii) | Design "not yet approved" (3970a427) on 10-28; 31 commits follow. **P-8 (two-sided board) is 14 commits in one day, 10 of them `fix`** (c1d155ca, cd5062d4, 010c221f, 2098c75a, 590510a0, 7d58a033, f1d089cf "review" …). Closed with "The bench step P-7 is split out to #823 so it doesn't hold up the parity milestone." |
| #786 refusal audit | 27 | 10-30→11-01 | (i)+(ii) | Maintainer one-liner ("review all refusal points to see if it should be inform") → audit of 131 codes → 27 commits in 48 h; then 90acca01 "(#786 regression)", #835 "Substitution gaps left by #786 slice 6" (4 commits), #856 "V-carve cone clamp (#786 slice 3) clamps a pocket's depth above its own floor". |
| #723 goal on rotary + manual rotation | 26 | 10-27→10-31 | (i) | Two unrelated features under one issue: rotary relief R-1…R-4 (13) and two-sided flip P2-1a…P2-3 (13). **Seven "R-4 review" fix commits on 10-30** (3077e256, 7417a6cb, 83494bab, dd02a81c, 5b11b445, 19a4104f…). Closed: "Running it on the machine (rotary) waits on #238, the bench issue outside this milestone." |
| #726 off-bench exercise, first-job screens | 25 | 10-27→10-28 | (ii)/(iii) | Filed the morning after #679 was declared **"DONE — landed, published and accepted"** (10-26). 25 `fix(wording|setup|simulate|cut|start)` commits in 36 h (W8…W24, P1…P16). The redesign was repaired the day after it shipped. |
| #881 parallel level planning | 13 | 11-01→11-02 | (ii) | `feat` ×2 then five pool-sizing fixes within 24 h (bab19e7e, 20ede224, ea931470, 8935dfe7…). Follow-ups #902/#908/#916; #902 then "**Parked per the maintainer's 'stop optimizing, get to a correct cut' direction**". |
| #241 indexed rotary faces | 13 | 10-05→11-01 | (iv)+(iii) | Landed 10-26 (863e32d3), then the retroactive review #729 found "the sweep never checks the chuck or tailstock". 10-27 comment: "waiting for the maintainer's look"; 10-31: "**There is no maintainer gate on this issue.** The 'waiting for the maintainer's look' … never pointed at anything to decide" → 12 commits that day. Closed: "Running indexed jobs on the machine waits on #238". |
| #889 goal move budget | 10 | 11-01→11-02 | (ii) | Six `perf` commits, then c96f90f6 and 2a176861 fixing the tests/dome regression the perf work caused ("the dome regression is fixed and proved against the old ride"). Triggered by the maintainer trying the panther on k3. |
| #766 smart tool selection | 12 | 10-29→10-30 | (ii) | Body: "Tonight's demo re-runs went through **three rule sets**, and each exposed the next gap" (#762 → #760 → #765) before #766. Then slices A–E plus **four "regression" fixes**, one of them landed twice with the same subject (3664f6a0 and ba55f3b4 "the measured search never does worse than the rule"). |
| #724 off-bench exercise, rotary | 11 | 10-27→10-28 | (iii) | 11 `fix` in 30 h for defects (26 rapids through stock on the default job) in code landed the previous day. Closing line: "**Not bench-verified: the rotary module itself (#545).**" |
| #845 GRBL machines | 9 | 11-01→11-02 | (i) | New scope filed as "Competitive gap, 2026-10-31"; nine commits; closed next day on a green chain. No operator asked for it. |
| #869 flat rough + ball finish | 8 | 11-01→11-02 | (i)+(ii) | Two feats, two CLI fixes, one style, two docs, and a60fe772 "merge the #847/#869 diagnostic rows main carried **as conflict markers**" — conflict markers had reached main. |
| #854 stack-connector follow-ups | 8 | 11-01 | (i) | 3D-printing work (not CNC) — one day, eight commits, despite the standing "We are only doing CNC work" rule (memory, 2026-10-12). |
| #729 retroactive review of #241/#708/#714 | 8 | 10-27→OPEN | (iii) | Hunk-by-hunk review **after** landing found 8 defects incl. a safety one; fixes 10-29/10-31; 11-02 bot comment: "Already done … Close it". Still open. |
| #880 docs carry no issue numbers | 7 | 11-01→11-02 | (i) | 470 issue references stripped from the CNC guide. The guide had accumulated them because every diagnostic code gets a "ch. 8 row" by rule. |
| #878 welcome page | 7 | 11-01→11-02 | (i) | "redesign by marketing … gorgeous graphics" → 7 commits in 24 h incl. 2 fixes to its own CSS/line endings. |
| #876 goal placement handles | 7 | 11-01→11-02 | (i) | Slices 1–4 in one day from a PrusaSlicer screenshot; fine. |
| #847 3D rest machining | 7 | 11-01 | (i) | New scope filed as "Competitive gap, 2026-10-31"; design pinned "while implementing". |
| #607 bracket + 4th-axis taps | 7 | 10-23→11-01 | (iv) | Bracket tap landed 10-24 "dormant until … measured-only `bracket.armTopMm`"; rotary tap built 10-31 for a module that has never been fitted (#238 open). |
| #599 executor mount-tap | 7 | 10-23 (same day) | (ii) | 4 `feat` + 3 `fix` (87e9fde4, f692ba6d, a137f862) in one day — the fixes repair the feats landed hours earlier. |
| #737 rotary parting neck | 6 | 10-28→10-29 | (ii)/(iii) | feat → fix → feat → "fix: the review's six neck faults" → fix → fix, all in ~20 h. |
| #747 frame refused on hardwood | 6 | 10-28→10-29 | (iii) | Six `fix` commits, "Two review rounds." |
| #740 chamfer bit with no tip | 6 | 10-28 (same day) | (ii) | Six `fix` commits to one record field in one day. |
| #785 tall goal crashes tab | 6 | 10-30→10-31 | (i)→(ii) | Introduced `GOAL_MOVE_BUDGET`; #889, #902, #908, #916 then spent 4 days repricing and removing budgets ("no arbitrary time limits"). |
| #728 retroactive review (meshes etc.) | 6 | 10-27→10-29 | (iii) | 12 findings on four landed commits. |
| #897 wizard step order | 5 | 11-01→11-02 | (iv) | The wizard built 10-26 (#681–#685), tidied 11-01 (#874/#875), re-ordered 11-01 (#897): three passes in six days. |

Three concrete "waste" chains, quoted:

1. **The cut flow was built three times in nine days.** #573 "Cut this blank" wizard shipped 10-22
   (0408a72d); #689 on 10-26: "Cut mode is the ONE cut flow: **remove the full-page 'Cut this blank'
   wizard**"; #796 on 10-31: "Three cut steps, not four". Each was declared done with a green gate.
2. **The redesign was declared accepted and then repaired for two days.** #679 (10-26): "**DONE — the
   first-job redesign is landed, published and accepted.**" #726 (10-27, filed by the same manager
   session): 25 fix commits; #724: 11; #725/#727: bed-mount blockers "a bracket job with stored setups gets
   no clamp check" — a verified BLOCKER in code that had passed the gate.
3. **Review after landing, not before.** Memory `feedback_review_every_hunk_every_commit` (10-27): "as
   volume rose I passed #241, #708, #709–#712, #714, #720, #706, #702, #704, #719 and #724-B2 on the peer's
   description, a few spot-read lines and a green gate … Thinned review let ~30 findings land." The
   retroactive reviews #727/#728/#729 produced 20 fix commits and #729 is still open.

Also: 10-29's re-run of the 25 demo jobs produced three rule sets for cutter choice in one night (#762 →
#760 → #765 → #766), and a duplicate commit; 11-01/02's panther work produced a budget (#785), a
re-priced budget (#889), a parked re-pricing (#902), a pool whose size was fixed five times (#881), and an
issue to remove budgets (#916) — all inside 72 hours.

---

## 3. Issue hygiene

**Volume.** 381 issues created and 379 closed since 10-19 (fetched range); **353 were both created and
closed inside the window**. Closed per day: 10-25 29 · 10-26 36 · 10-29 62 · 10-31 40 · **11-01 72** ·
11-02 35. Created per day peaks: 10-25 49 · 10-31 48 · **11-01 61**.

**Speed.** Of the 379 closures: **282 (74 %) within 24 h of creation, 142 (37 %) within 6 h, 32 within
1 h; median 10.2 h.** Only 2 issues were ever reopened (#846, #699). The tracker is a commit log with
extra steps, not a backlog.

**Evidence in the closing comment.** 240 of 378 closing comments cite a test gate ("vitest N passed /
Playwright N passed / gate GREEN") as the evidence; **3 of 378 cite an observation on the machine.**
Issues labelled `bench-test` closed in the window: 20.

**The 10-29 sweep.** 18 issues were closed on one day with the stock sentence *"Code-complete and
verified on main (triage by case-maker-d3 on 9fcda93e …). The one remaining machine check moves to the
bench checklist #767. Closing so the open list shows only work still to do."* (#547, #548, #550, #586,
#588, #589, #590, #591, #593, #594, #597, #615, #627, #630, #631, #647, #656, #659). A further 19 closing
comments explicitly defer a machine check ("Bench check owed", "Not bench-verified", "waits on #238",
"the bench half is on #767"): #422, #530, #598, #599, #618, #621, #635, #644, #648, #655, #657, #723,
#724, #727, #753, #756, #757, #827, #834.

**Milestones as scoreboards.** "Parity with Makera Studio" was created 10-29 and closed 11-01 with 19
issues; "Release 1.0" was created 11-01 and reached 22 closed / 0 open on 11-02; "Mesh to part" created
11-01, 19 closed / 5 open; "1.1" and "2.0" created 11-02. Two milestones created and completed in four
days, while CNC-2 ("First chips"), CNC-2.2 ("Measured, not assumed"), CNC-5 (rotary), CNC-9 (registration)
remain open with their bench items.

**Where issues come from** (first 400 chars of the body, 381 issues): maintainer quoted 66 (17 %);
follow-up / slice of another issue 62; "competitive gap" / matrix / Studio parity 39; the agents' own
off-bench exercise or demo re-run 26; a bench observation 24; a review 4; other 160. Memory
`feedback_demand_driven_features` (10-12): "An issue's existence is not evidence of demand, and a
SESSION-authored issue least of all." Roughly five of six issues this fortnight were session-authored.

**Open issues (57) by cluster, with duplicates/overlaps:**

| cluster | n | issues | note |
|---|---:|---|---|
| bench: cut/registration verification | 9 | #208, #284, #443, #444, #567, #569, #570, #767, #823 | five lists of the same bench work; #767 is "the" checklist but holds 11 of the 72 closed-with-a-bench-item issues |
| bench: rotary measurement | 8 | #238, #626, #790, #545, #223, #240, #729, #810 | everything rotary waits on #238 (open since 10-05); #729 "Already done … Close it" |
| operations matrix | 2 | #663, #676 | both last comments say "Already done" |
| panther / multi-side goal | 7 | #898, #914, #915, #916, #902, #892, #917 | #914/#915/#898 overlap (how a goal is finished from several sides); #902 parked |
| 3D-printing (parked by the CNC-only rule) | 14 | #131, #147, #151, #155, #156, #160, #161, #262, #322, #376, #903–#906 | #903–#906 filed 11-02 for "2.0" |
| registration v2 umbrella vs tilt | 2 | #592, #501 | both "mostly done / software half landed", waiting on the bench |
| bench network | 2 | #304, #499 | #499 observed fine on 11-01 (#767 comment) but not closed |
| other | 13 | #189, #222, #251, #268, #269, #278, #498, #529, #536, #609, #707, #907, #913 | |

---

## 4. The 10-25 review and the 10-26 audit — what they said, what happened

**`docs/reviews/2026-10-25-24h-code-review.md`** (46 commits, four reviewers) found one machine-safety
blocker (#632), seven majors (#633–#639), four sweeps (#640–#643), then a second pass (#650–#653). Its
verdict: "most of them in the seams the day's speed left open: results of house writes not read, state
not cleared between runs … claims in commit messages that no spec pins." Its one process recommendation:
"**the manager reads every source hunk of a peer commit before its gate, not the hunks named in the
report.**" Its one design question to settle "BEFORE tomorrow's cut is read": bow vs dome (#631), "tomorrow's
calipers decide".

What the following week did with it:

- The **findings** were fixed fast: #632 same day (fbad1643), #633–#639 all on 10-25, #650–#653 on 10-25.
  Good.
- The **process recommendation was reversed within 48 hours.** The manager's own 10-27 memory: "as volume
  rose I passed [13 commits] on the peer's description … Thinned review let ~30 findings land", and the
  rule it then wrote — "if volume makes that impossible, **slow the queue, don't thin the review**" — was
  followed by 77, 63, 77, **155, 140** commits/day. Review moved to after landing (#727/#728/#729) and
  then to the maintainer's screen (#785 "Aw, Snap", #830 "Working…", #896 crash, #885 "can't scroll",
  #882 "Offline for a machine the location already knows").
- The **calipers were never taken.** #631's closing comment (10-29): "Machine-only and still open: the badge
  cut and calipers that settle bow vs top-only dome" → moved to #767 → not ticked. The question the review
  said must be settled before the next cut is still open, and there has been no next cut.
- The review's "rules checked" (new diagnostic code → guide chapter 8 row) kept being applied by every
  slice; by 11-01 the end-user guide carried **470 issue references** and #880 spent 7 commits removing them.

**`docs/design/first-job-audit-2026-10-26.md`** opens with the maintainer's verdict — *"I don't think we
are following any design and this is a hacked together mess, not world class software"* — and diagnoses:
"the built flow follows the designs piecemeal — **each slice landed its own screen, its own numbering and
its own words, and nobody owned the path between them.**" The remedy chosen was fourteen gated children
(#680–#693) run as "five file-disjoint worktree slots … refill slots as they free … do not stop for
approval again" (memory `project_orchestration_handoff_2026_10_26`): **72 commits on 10-26, 42 of them UI**,
then #726's 25 repairs on 10-27/28, the 16-slice right-panel redesign #792–#807 on 10-31, and
#870/#874/#875/#897 on 11-01. The method that produced the piecemeal flow was reused to fix it, four times.

**Conventions visible in CLAUDE.md and the memory files** that shape this: one manager session that
"never implements", gates (typecheck + full vitest + Playwright) and lands; an implementer peer with
"at least five background worktrees" to keep full; "a subagent per slice, nothing waits on a human at the
peer console"; "questions → issues, not blocking prompts"; "Reserve bench time for hardware only" (10-19:
"a lot of this could have been tested without a bench session"). Each rule is sensible alone; together they
define a system whose steady state is maximum merged volume with the machine out of the loop.

---

## 5. Verification debt

Closed since 10-19 and bench-labelled, or whose title / closing comment names the bench, the Z1 or the
machine: **72 issues**. In #767's checklist (body + comments): 11 of them (#586, #588, #615, #618, #627,
#628, #631, #647, #659, #743, #772). **Not in #767: 61.** The ones whose closing text itself says a machine
check is owed are marked ●.

| # | closed | in #767 | what still needs the machine |
|---|---|---|---|
| #422 ● | 10-25 | no | work light M821/M822 "after a one-line bench check" — the switch was heard on 11-01 via #289's test, never recorded on #422 |
| #448, #511, #526 | 10-19 | no | machine limits / bed scene / live strip — pre-window landings, closed on gate only |
| #527, #530 ● | 10-24/25 | no | translucent tool body at live WPos; camera pane — no frame seen from the live camera recorded |
| #535 | 10-26 | no | goal program as a release source — never run |
| #559→#585 | 10-23/29 | no | typed-seat search; #585's "guarded deeper search" never exercised |
| #568 | 10-21 | no | closed "Not doing this as a bench test" (antistatic auto-enable) |
| #573, #574 | 10-23 | no | Cut-this-blank wizard (removed 10-26 by #689) |
| #584, #623 | 10-29, 10-24 | no | oracle under-cut — **bench verified 10-24/25** (the honest two) |
| #586, #588, #615, #627, #630, #631, #647, #659 | 10-29 | yes | the 10-29 sweep; all unticked |
| #598, #599 ● | 10-23 | no | "bench verification of the tap-the-jaw → datum path is the next bench session's first item" — the datum path ran 10-24/25, but these were never updated |
| #602, #608, #613, #616, #619, #620, #621, #624 | 10-24/29 | no | datum path write-backs; run 5/6/9 exercised some; none recorded against the issues |
| #628 | 11-02 | yes | "Already fixed … reproduced on current main" — a unit reproduction, not the badge re-post on the machine |
| #632, #635 ●, #638, #639 | 10-25 | no | the 24 h review's blocker and majors — "Bench check: the morning's dome route must now refuse a package frozen against last night's tilt" — not recorded |
| #644 ●, #648 ● | 10-25 | no | "$X only in Alarm", indicators — "Bench check owed: press each once with the Z1 idle" |
| #645 | 10-25 | no | closed "the maintainer asked a question, not for work; this was filed without being asked" |
| #655 ●, #657 ● | 10-25 | no | Tool-state prompt; estimate vs actual — "Bench check owed: the next single-tool run"; there has been none |
| #669 | 10-26 | no | chamfer operation — tip flat on the house bit still unmeasured (memory: "measure the house 90° chamfer bit's TIP flat") |
| #679, #682, #684, #687, #689, #693 ●, #694, #695, #696 | 10-26/28 | no | first-job flow and the change-the-machine wizard — "bench validation of the physical steps is NOT possible without the maintainer — land it tested against the simulator and say so" |
| #706, #710, #711, #718, #725, #727 ● | 10-27 | no | bed mounts / rotary fitting — "Not verified on the bench." Tape holdRatio, bracket arms, clamps: all still "assumed" (#444 open) |
| #723 ●, #724 ●, #753 ●, #754, #756 ●, #757 ●, #761, #834 ● | 10-28→11-01 | #743 only | every rotary item: "waits on #238" / "the bench half is on #767 and #238" — #238 has been open since 10-05 and the module has never been fitted |
| #743 | 10-31 | yes (P-7 → #823) | PCB: the bench board test is its own open issue |
| #772 | 10-30 | yes | SD file list/delete — `ls -e -s` **was seen on 11-01** (console log), not ticked |
| #827 ● | 11-01 | no | bore/boss centre-find — the 10-31 probe-bore attempt shows `[timeout]` and `$X`; not recorded as a pass or fail on the issue |
| #884 | 11-02 | no | "external output IS the vacuum" — observed 11-01 (#767 comment), closed on the code |

Net: of 72 bench-flavoured closures, two record a machine observation on the issue (#584, #623), three
more were observed but recorded elsewhere (#289→#884, #772, #499), and **67 are code-complete only**.
#767 tracks 11 of them.

---

## 6. Assessment — why lots of motion produced little progress

1. **Breadth over the one acceptance path.** 77 % of commits are off the badge path; after 10-25 the path
   is 12.6 % of commits. Ten themes ran at once, rewriting the same four files (`EngravePanel.tsx` 144
   times, `engraveGenerate.ts` 134, `jobSetup.ts` 104). Two milestones were created and filled in four
   days (Parity 10-29→11-01; Release 1.0 11-01→11-02) while CNC-2 "First chips", CNC-2.2 "Measured, not
   assumed" and CNC-9 "Registration" stay open. The maintainer's 11-02 words: *"stop optimizing, get to a
   correct cut"* (#902).
2. **"Closed" means merged with a green suite, not an outcome observed.** 240/378 closing comments cite
   test counts; 3 cite the machine. 74 % of issues closed within 24 h; the 10-29 sweep closed 18 at once
   "so the open list shows only work still to do", moving the checks to #767 — which tracks 11 of the 72
   bench-flavoured closures. The same memory that records the first-cut night says it: "Green suite ≠
   reviewed — 3 GREEN commits bounced in one night."
3. **Nobody owns the end-to-end cut.** #567/#569/#570 (verify registration, the first cut, repeatability)
   have been open since 10-21; the 10-25 badge's calipers were "owed" and never taken; #631's bow-vs-dome
   question — flagged as "settle BEFORE tomorrow's cut is read" — is unanswered; the three later bench
   sessions were probe-wiring and switch surveys. The manager session is the only bench driver, and it also
   gates, lands, publishes, reviews, triages and writes the design docs.
4. **Design-first slices were replaced by fix storms and retroactive review.** Patterns: feat followed by
   5+ fixes to itself within a day (#599, #737, #740, #747, #881, #743 P-8); a redesign declared "DONE and
   accepted" and repaired for two days (#679 → #726/#724/#725); three cutter-choice rule sets in one night
   (#762→#760→#765→#766); review after landing (#727/#728/#729, ~30 findings, a verified blocker). The 10-25
   review's rule "slow the queue, don't thin the review" was written on 10-27 and the queue tripled.
5. **Parallel capacity became the objective.** "Five file-disjoint worktrees … refill each slot as a job
   lands" and "questions → issues, keep moving" guarantee that work is generated to fill slots: 5 of 6
   issues are session-authored (follow-ups 62, "competitive gaps" 39, exercise findings 26); 41 commits of
   3D-printing work landed despite "We are only doing CNC work"; GRBL/Carvera (#845/#828, 24 commits)
   appeared and closed in 48 h with no operator request. The tax shows as rebase-repair commits
   (82072be7, 7c3b9bdf, f92a2bf4), conflict markers on main (a60fe772) and a commit landed twice
   (3664f6a0/ba55f3b4).
6. **A maintainer remark becomes a 25-commit umbrella within 48 hours, with no sizing step.** "review all
   refusal points" → 27 commits over 131 codes (#786) plus three regression issues; "support mounting in 4d
   and manual rotation" → 26 commits (#723); "redesign by marketing" → 7; a crash on a tall mesh (#785) →
   budgets → re-pricing → pool → "no arbitrary time limits" (#916) in 72 h. Nothing in the loop asks
   "is this on the path to a clean cut?".
7. **The bench is the only true gate and it is scarce, so the system optimised around it.** "Reserve
   bench time for hardware only" is right, but the counterpart — a scheduled bench slot with a runbook and a
   results recorder — never existed. Every rotary, bed-mount, PCB and probe feature closes with "waits on
   #238 / #767"; #238 (fit and characterise the rotary) has been open 28 days, and ~90 rotary commits sit
   on top of it.

### Rules for the next milestone

- **One acceptance issue, and it is the milestone.** "A clean badge (or hardwood plaque) cut on the Z1 from
  the app, caliper-verified against the prediction, repeated twice after re-seating" — i.e. #569 + #570
  with the calipers. Everything that lands on `main` must name how it moves that issue; anything that does
  not is held on a branch.
- **WIP limit: two implementer worktrees, both on the path.** No slot-refilling. A third slot only for a
  P0 regression. Cross-cutting sweeps (wording, spelling, docs lint) are banned until the cut is in.
- **"Closed" = outcome observed.** For anything that touches what the machine does: a dated bench record
  (transcript + photo or caliper reading) linked from the issue, or it stays open with a `code-complete`
  label. No more "moves to #767"; #767 becomes the bench runbook, each line owned by a dated slot, and a
  closure without a tick is reverted to open.
- **Bench cadence, not bench opportunism.** One slot every two days, ≤ 90 min, with a written runbook of
  at most five items from #767 in priority order, and a recorder whose only job is to write results onto
  the issues before power-off. The calipers from the 10-25 badge are item 1.
- **Fix-storm brake.** An issue that collects three `fix` commits in 24 h stops; the next commit is a
  one-page design note (what order material comes out in; what the non-happy document does; what the
  machine would do) and a failing test, reviewed before more code.
- **No umbrella issues over ten commits, and no retroactive review.** A maintainer remark gets a sizing
  comment (slices, files, risk, path relevance) and the maintainer's one-word go before the first commit.
  Review happens before landing or the commit waits; if the reviewer is behind, the queue stops.
- **Freeze list until the acceptance issue closes:** rotary (all of it, until #238 is measured), PCB/disc,
  GRBL/Carvera/USB, mesh-to-part beyond what the current flat goal already does, welcome/docs/spelling,
  3D-printing features, parity-matrix rows, 1.1/2.0 planning. Park, don't close, their open issues.
- **Measure the right thing weekly:** bench-observed closures (target > 0 every week), % of commits on the
  acceptance path (target > 60 %), #767 ticks, and the fix:feat ratio on the path. Commit counts and
  milestone burndown are not reported.
