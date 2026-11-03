# Milestone 1 — progress and code review, 2026-11-03

*Non-invasive review for the maintainer: how the manager and the six programmers are doing against
`2026-11-02-manager-marching-orders.md`, and a quick code review of what landed. Window: `main`
3c58b91e (the plan, 2026-11-02 ~16:00) → 829708cc (2026-11-03 ~12:53), about 20 hours. Nothing in the
repo, the issues or k3 was changed by this review; five read-only code reviews of the landed commits are
summarised in §3 and kept in `2026-11-03-m1-progress-review/`.*

---

## 0. Summary

**Verdict: the team is working the plan, fast, and mostly by its rules; the engine side has produced two
real results and one real regression, and the code review finds that the gate the wave was meant to
build is not yet a gate (§3.6).** In 20 hours: wave 0 done in an hour; wave 1 landed in about
eight (golden artefact, one pipeline, errors-not-warnings, routing table, efficiency measures, honest
estimate, default job to four ticks, truthful Cut step, one registration procedure, the demo page under
the card rule, all five sample jobs written); the elephant and panther **cut-into went from 12.8 mm to 0**
on the real meshes; the gate found four true defects (#947–#950) that the old page never could. Against
that: the #924 activation stack reached `main` **before its T3 finished** (the manager's own error, owned
in writing) and left **two e2e specs red on main** (`engrave.spec.ts:180`, `pcbTwoSided.spec.ts:19`) with a
hotfix still in flight; Session A sat eight hours on a T3 bounce before the manager pulled a status; (Session E also
wrote shop data into k3 through the house API; the maintainer confirmed on 11-03 that k3 is the home test
environment and CaseMaker data is ours to write, so that is not a finding.) The five code reviews (§3) add: the "independent" design
oracle is built from the CAM's own opened region; the goal overcut guard has a reproducible blind spot
(a 3.5 mm gouge reads 0); no run record can carry the machine's elapsed time; the sample cards pass
with a cutter the k3 house does not own; samples 4 and 5 as committed are not the samples the acceptance
doc describes.

| Measure | Plan (§4.1 / §8) | Observed |
|---|---|---|
| Commits landed | — | 87 in 20 h (feat 28 · fix 27 · test 20 · docs 6 · chore/sim 6) |
| Commits on the path | > 60 % | **100 %** (every commit names a Milestone 1 issue; one lint commit cites #919) |
| k3 publishes | once per wave end | **1** (3c5a8184; `status` confirms rig and web server) + the baseline 3c58b91e |
| Full regression (T3) runs | wave ends, cross-cutting, pre-publish | baseline + wave-1 exit + 1fc73baa (the activation, after the fact) |
| Golden regenerations | deliberate, with a review note | 6 (1 initial, 3 TIME-line only with two-sided diffs quoted, 1 field-add proven, 1 "two numbers + three timeouts" for #945) |
| Cross-column edits | declared, minimal | 4 commits, each titled "B's file" / "seams in B/D/E files" |
| Issues closed | with evidence | 6 (#918–#921, #928, #944), each with sha + T2 line; the code-complete ones stay OPEN awaiting bench — as the rule says |
| New issues | from the gate, not from slots | 4 (#947 sliver, #948 3D half, #949 oversized goal on the jaws, #950 design items to program 0) — all milestone-tagged |
| Questions to the maintainer | as issues with a default | 4 open (§4) |
| Bench sessions | none before #943 lines 1 and 1b | none held |
| 12-hour report | §8 format | not on #943; if it went to your chat, fine — I cannot see it |

---

## 1. What landed, package by package

| WP / issue | State | Evidence on the issue |
|---|---|---|
| #918 freeze list | closed | 43 issues labelled and un-milestoned, 3 closed; in-flight work parked as `held/*` branches (8) |
| #919 pinned build | closed | base 3c58b91e → k3; T3 baseline 690 files / 9258 tests, Playwright 245, cargo; flake list |
| #920 #767 reconciled | closed | ticks with trace lines; missing lines added |
| #921 golden artefact | closed | 562141d2; regeneration only via `CASEMAKER_UPDATE_GOLDEN=1` |
| #922 one pipeline | fix landed f83084ad; sample identity pending | one resolver `engraveFeedsFor` + one shop builder `engraveShopOpts`; j13 unskipped; a second divergence (cutter pick) found and a shared pick-input builder in gate |
| #923 column-engine fixture | **bounced at T3**, then a true finding | the goalTransform e2e now refuses an oversized goal whose finish runs along the jaws → #949; A's stall §2.3 |
| #924 independent oracle | dormant half landed; activation landed **un-gated**; hotfix in flight | §2.2; the 3D half split to #948 |
| #925 errors + sim version | code-complete | both engines; version in the hash; pre-#925 packages re-simulate once |
| #926 efficiency | code-complete | air fraction, hops, feed utilisation, rapid:cut; written-fraction warning withdrawn with a 39-program table; one threshold as a shop default |
| #927 honest estimate | code-complete; D3 at S1 | entry rapid + spindle ramp priced; `actualSeconds` on the record; `readback run --list`; `run --capture` |
| #928 routing table | closed | `routeEngine` + 14-row frozen table |
| #930 default job | code-complete | the 36 × 36 × 100 stick, 36 between the jaws; four ticks in e2e |
| #931 Cut truth | code-complete | `cutVerdict()` from the run's own fields; e2e for the three states |
| #934 one procedure | code-complete | refusals at the operator seam; vise only; re-seat before re-post; guide sections Planned |
| #944 demo page | closed | card rule, `tools/build.sh <sha>`, v14 published; 21 match · 6 deviate · 1 refused · 2 appendix |
| #936, #938–#941 sample jobs | written and carded | s1, s2, s3, s5 "Matches"; s4 "Deviates" (a checker mask bug, fixed in the tool) |
| #945 / #946 elephant, panther | cut-into fixed; coverage short | 0 cut-into (ac81676d); top-surface coverage 82.7 % / 82.5 % vs 95 %; whole-surface 32 % / 39 % |
| #932 / #933 bridge | re-homed to D; T2 green; await S1 | six-site `G38.5` release; poll window; Stop; G54 pre-flight |

---

## 2. How the manager is doing

### 2.1 What is working

- **The rules are being kept.** Every landing comment quotes the sha, the tier and the counts; batches of
  ≤4; closed means evidence or stays open as code-complete; questions become issue comments with a default
  (stick orientation, planed stock, local meshes, wave 1 without #922, the written-fraction warning);
  held branches instead of lost work; k3 published once; the page rebuilt on the pinned sha.
- **Reviews bounce.** #923 was bounced at T3 and the bounce turned into a real finding (#949) rather than
  a flake excuse; #947's landing broke the golden for three minutes and was repaired with the diff proven.
- **Re-homing to keep six sessions busy** (#932/#933 → D, #949 → C, #948 → C) is the right call when
  A and B hold every open engine package, and it was declared on #943 with the file grants.
- **Candour.** The un-gated landing is written up in the order it happened, with the fix to the process.

### 2.2 The one real breach: a landing before its T3 finished

The #924 activation stack (e39f4889 … 1fc73baa) reached origin at 11:50 on 11-03 because the candidate
was staged on local `main` and a one-file landing (F's win32 baselines, 673b3049) pushed it. T3 on that
tree: vitest 9327 green, **Playwright 2 red** — `engrave.spec.ts:180` (the default job's design check
refuses the ⌀1 flat on the MAKER label: `tooFar` 0.39 mm² at z −1) and `pcbTwoSided.spec.ts:19` (a
two-setup board no longer generates). Both were green on ac81676d. A is fixing forward on `924-hotfix`;
#950 (design items handed to program 0, not the program that cuts them) was found while fixing. **As of
829708cc, main's head is not T3-green by the manager's own account.** The manager's process fix
("candidates land from the gate copy, never staged on local main") is the right one; the win32 baseline
commit that carried the stack is also now moot (Windows moved to 1.1).

### 2.3 Smaller concerns

1. **A's eight-hour silence on the #923 bounce.** "Still verifying" from ~03:00 to ~12:00 until the
   manager interrupted for a status. The marching orders say never end a turn with a finished slice
   unreported; they should also say: a bounce gets a status line every two hours or the manager pulls it.
2. **k3 shop data.** Session E PATCHed `kz-chamfer-90`'s tip (0.1 mm) and five engraver angles, and
   POSTed a stock entry for the stick and a hardwood V feeds row, through the house API with before/after
   hashes and the reverse for each. **Authorised:** the maintainer confirmed on 11-03 that k3 is the home
   test environment and CaseMaker data is ours to write. One data nit remains (§3.5): the feeds row is
   stored as `source: chosen` (an operator decision) with a step-over and peck the vendor never stated;
   it should read as a library-sourced starting row so the bench knows to measure it.
3. **The page is committed as a 2.8 MB HTML with inline images and rewritten on every rebuild** (three
   times already; the pack is 396 MB). Either keep only `manifest.json` + the verdict table in git and
   publish the HTML as the artifact, or expect ~3 MB of repo growth per rebuild.
4. **The coverage vocabulary slipped twice.** "Beyond reach" was read as the geometric limit and then
   corrected to the plan-side shortfall; the state line was updated each time. The page should define its
   three numbers (top-surface coverage, whole-surface reach, ideal leftover) once, on the card.
5. **B's machine.** davebook-5's WSL crashed ~19:00 on 11-02 and the session was gone ~5 hours; the
   manager took the default (wave 1 exited without #922) and re-briefed the new session. Fine, but the
   #922 fix landed 5 hours later than it would have, and B's column is the long pole (#945/#946).
6. **Report cadence.** No 12-hour report appears on #943. If it is going to your chat, no action; if not,
   the first one is overdue.

---

## 3. Code review of what landed

Five read-only reviews, one per column, each with the diffs read hunk by hunk, the issue threads, and the
touched specs run in a scratch copy of `origin/main` (all green except where stated). Full reports with
file:line evidence: `2026-11-03-m1-progress-review/{A,B,C,D,E}-*.md`. Two of the highest-stakes claims
were re-checked by hand against `origin/main` before writing this section (3.1 B1 and 3.3 H1).

### 3.1 Session A — the gate (#924, #925, #928, #947)

**Blockers.**
- **B1 — the "independent" design oracle is built from the CAM's own region.** The items handed to the
  check (`designOf(e)`, `engraveGenerate.ts:2129–2148`) are the engravability's opened polygons — the
  CAM's `offset(offset(G, −r), +r)` — and `r` for a V item is the CAM's own `planeRadius` from its cone.
  Simulation.md §7 asked for point-in-polygon on the ORIGINAL outline precisely so a shared wrong `r` or
  a Clipper bug would show. Gate statement 5 is therefore not met, though the issue is being worked as
  if it were. Confirmed by hand: `designOf` returns `byId.get(id)?.polygons` and falls back to the raw
  profile only for variable-depth items.
- **B2 — V items are checked at one slice just above the floor**, where the groove is the tip trace;
  #741's flank widening lives above the floor and would pass. Neither "#741 class" test is #741's shape.
- **B3 — origin/main is red** (`engrave.spec.ts:180`, `pcbTwoSided.spec.ts:19`) from the un-gated
  activation (§2.2); the fix-forward sits on `cand/924-hotfix`, not landed.

**Major.** `SIMULATOR_VERSION` is still 1 although the oracle's verdict loosened (#947) and the design
check was folded into `ok` after the bump rule was written — a 11-02 package reads "current".
Gate 7 is not live: `combineOracles` (`engraveRunStore.ts:235–257`) rebuilds the report without
`sliverWidthMm` / `designCheck` / `goalCutInto`, so the Simulate footer and the sheet read `undefined`
and only hand-set unit tests see the sentence. The design check reaches the operator as an unexplained
cross (0/0 under/over, no sentence). Gate 6 (volume agreement) has no production caller. The sliver
width 0.01 mm is the smallest named multiple that passes (0.005 fails ⌀3.0/⌀3.175), with no margin and
a double count of the chord term already in the band. `routeEngine` mirrors the two predicates it
replaced, which still exist, with no agreement test.

**Solid.** #925: both engines flip the severity; the version rides in the hash with a mocked-v2 bump
test. The sliver spec runs the real pipeline. 6a6546ea is exactly four added lines; hashes untouched.
Cross-column edits declared and authorised. Specs: 85/85 across the new files.

### 3.2 Session B (+F) — pipeline and goal CAM (#921, #922, #945)

**High.**
- **The #945 overcut guard still misses an interior dip on a vertical wall.** `surface3d.ts:1761–1832`
  derives candidates from point-centre distance but admits by square distance, leaving up to 0.04 mm of
  each 0.1 mm step unsearched. A scratch spec (kept beside the reports) builds a step goal, a ⌀2 ball
  and the steepest tip pair; brute force over the guard's own model finds a **3.545 mm gouge** and
  `planGoalOvercut` returns **0** — on main and before the fix. The staircase emitter (bab37c2c) is
  sound and is what brought the cards to 0 cut-into; it also masks the guard's blind spot. No positive
  guard test exists for a segment whose endpoints are safe.
- **#922's "one shop-options builder" is called only by the CLI.** `engraveShopOpts` (`feeds.ts:132`)
  has one caller, `engrave.ts:552`; `engraveRunStore.ts:482–496` keeps its own literal; the identity
  spec drives the worker with a third hand copy, so it proves CLI == a transcription of the store, not
  the app. The feeds resolver IS shared (17 sites). Bytes are compared and j13 is green (3/3).

**Medium.** The cutter pick is still two implementations on main (the unification is on
`identity-samples`, not landed); 3 of 5 sample jobs pick different cutters per door. #945's acceptance
is judged by the guard that was the blind spot, not by the independent oracle path. The coverage
diagnosis moved three times in a day and rests on the `figure.stl` proxy, not a real-mesh card.

**Golden churn.** Fixtures touched 5× in 9 h; `.nc` hashes moved once (TIME line only, named). Because
the pin includes `;@MKR|TIME`, every estimator change regenerates "frozen bytes" — pin the program
minus TIME, and TIME separately. ac81676d bumps three timeouts 2.5–3.3× with no measured numbers.

### 3.3 Session C — efficiency and the estimate (#926, #927)

**High — no record the app writes carries the machine's elapsed.** b3d1ed8b gave `buildRunRecord` a
fourth `actualSeconds` argument; its only caller (`EngravePanel.tsx:3045`) passes two; `withActualSeconds`
has zero callers; `machineRunStore.ts:297` holds `elapsedS` and writes it nowhere. Confirmed by hand.
At S1 the done card reads "No timed run recorded", the sheet has no last-run line and `readback run
--list` prints "no actual" unless a human types minutes. The seam was named in C's design note as
"A's file, the manager must sequence" and never landed.

**Medium.** The 12 s spindle ramp is sourced to the right trace but the wrong observable (motion
resumes at ~7–8 s): ~4 s/program over-charge on a model whose bias is low, masking error. The new
terms are unlabelled where the estimate prints (`runSheet.ts:790`, `post/z1.ts:180` still say
"cutting + rapids"); the receipt schema strips the new keys. `readback run --list` reads an empty
history and maps `actualSeconds` only. `tourExcess` jumped 165→179 % because inter-op travel entered the
numerator but not the bound. One threshold ships (`efficiency.maxAirFraction` 0.35) as a real shop
default with the three seed edits, but **no per-job recommendation**, and its 26 % corpus basis
predates #927's denominator change. Redundant removal was dropped with a 39-program table and the
manager's acceptance — recorded, fine. Specs: 194/194.

### 3.4 Session D — the operator path (#930, #931, #934)

**High.**
- **The house stock is a hard-coded constant where a shop fact belongs.** `workShape.ts:38–56`
  `HOUSE_STOCK` (36/100/36 hardwood, `finish: 'finished'`, the sentence "The house's stock…");
  `proposedStockFor()` never consults the stock shelf the app already has (`/stock`, `useStockStore`,
  the fixture's own entry). If the k3 shelf or your answer on #936 differs, the wizard still asserts
  this stick. This is the "location.json, never a constant" rule.
- **Three #934 branches are refused late, not at the entry.** Disc is still offered at the Stock step
  and refused at registration; the "as bought" finish still seeds facing and is refused at RELEASE,
  after four ticks and a registration; the PCB flip is on the hide table but not refused by name.

**Medium.** `cutVerdict931.spec` injects the failure via `setState`, not the real collision walk;
"Register again" clicks a possibly disabled/folded Start button via `querySelector` (silent no-op);
two undeclared edits of B's and F's files (behaviour-neutral). **Solid:** `cutVerdict()` from the run's
own fields with eight states; "matches the design" requires `oracle.ok` AND zero error-severity design
findings; re-seat before re-post pinned in unit and e2e; removed testids grepped and the broken specs
skipped with a #934 header; 13 of the 20 UI-walk defects fixed (open: 9, 15, 18, 19, 20). Specs: 243/0.

### 3.5 Session E — the demo page and the sample jobs (#944, #936, #938–#941)

**High.**
- **"Owned cutters only" is false on the sample cards.** `flat-1.0` is a built-in (`toolLibrary.ts:153`),
  not one of the k3 house's 29 `kz-*` cutters, yet s1, s2, s4-p2 and s5-p2 post with it (s5's rest
  pass 10 mm deep with a ⌀1 flat, flute length unstated) and read "Matches the design". The bench cannot
  cut what the page passes.
- **Samples 4 and 5 as committed are not the samples the acceptance doc describes.** The initials are
  flat-engraved, not V-carved (the `vCarveDepth` field landed later and is a no-op on that card); the
  chamfer runs last, after the slot and an extra rest program; Sample 1 uses a flat, not an engraving
  cutter.
- **The #938 ladder (F400/700/1000/1200) does not bracket the row it claims:** the seeded hardwood row
  is F400 on both locations; the card title "F1000, the row's own value" is wrong.
- **The hardwood V feeds row on k3 is mislabelled** (`feed-m1-hardwood-v-0.1`, `source: chosen`, with a
  step-over and peck the Makera library does not state). The write itself is authorised (k3 is the test
  environment); the label is not: `chosen` is the operator-decision state, and s4's verdict now rests on
  it. Mark it as a library-sourced starting row with the two seeded fields named.

**Medium.** s5's "Matches" measures only the slot (no chamfer model); labels are judged by bounding
box only; s4's "3.4 % left" was the checker drawing every rectangle square (the fix is unlanded) — the
"deviates" B was handed was E's tool's bug; the committed page predates the s1 card and the coverage
labels; 3D cut-into mixes a 0.1 mm count with a 0.01 mm area while the rule says zero; j19/j23
(CC BY-NC-ND) remain full cards and 5ac51410 committed derivatives the README says are not committed.
**Solid:** every photo verdict and proxy retired; `build.sh <sha>` refuses a sha that does not match
HEAD; meshes injected by hash, never committed; render.py still independent; the acceptance doc
carries the six lines and the §4.4 table verbatim; every `.nc`/`.job.json` came from the app's pipeline.

### 3.6 What this adds up to

The engine work is real but the **gate it was meant to build is not yet a gate**: the design check
grades the CAM's own opening (A/B1), the goal guard has a reproducible blind spot (B), the operator never
sees the sliver width or the design verdict (A/M2–M3), the run record cannot receive the clock (C), and
the page passes cards with a cutter the house does not own (E). None of this contradicts the manager's
landing comments — each is a seam between columns that the per-column T1/T2 cannot see. That is the
argument for the T3 at every wave end and for the manager reading the acceptance line, not the diff,
before closing.

---

## 4. Decisions waiting on you

1. **Coverage pass line for the elephant and panther** (#943 state line, asked 11-03 11:20): the card's
   number is **top-surface** coverage (what a single top setup can reach; undercuts excluded by
   construction) — 82.7 % / 82.5 % today — or **whole-surface** (the sculpture, needing #914's turns and
   #898's tabs, about a week more). My read of your own words: the elephant lies flat by design, so
   top-surface ≥ 95 % is its honest line; the panther is a sculpture, and the plan said "after all
   setups", so whole-surface ≥ 95 % after the setups the app proposes is its line. Either way the ~17 %
   gap today is a plan-side shortfall (the rest pass ignores the cusp step-over), which B is fixing.
2. **Are the 36 × 36 × 100 sticks planed or rough-sawn?** Default taken: planed (no facing pass). If
   rough-sawn, facing and the re-touch return to Sample 1.
3. **The app picks a ⌀1 flat (`flat-1.0`) for Sample 1 that the k3 house does not own** (its 29 cutters
   are `kz-*`). On the demo location that cutter exists; on the bench it does not. Which owned cutter
   cuts "CASE / MAKER / first chips" on the stick — or is a ⌀1 flat bought?


---

## 5. What I would ask the manager to do next (no code from me)

1. Land the #924 hotfix and make `origin/main` T3-green before anything else; then bump
   `SIMULATOR_VERSION` to 2 (the verdict changed twice since 1).
2. Re-open the acceptance line of #924: the design check must take the raw outline and a tool-derived
   `r`, and check V items above the floor, or #943 line 1 statement 5 stays unticked.
3. Give #945 a red-first guard test from the scratch spec in `2026-11-03-m1-progress-review/` (a safe
   endpoint pair over a steep wall), and judge the elephant's cut-into by the oracle path, not the guard.
4. Wire `withActualSeconds` (one seam in `machineRunStore.ts`) before S1, or the time line of the
   milestone cannot be measured.
5. Replace `HOUSE_STOCK` with the shelf entry E already created on k3, and make the sample cards use
   the owned-cutter location only — a card that passes with `flat-1.0` is not a bench card.
6. Rewrite samples 4 and 5 to the acceptance doc (V-carved initials with an owned V bit; chamfer then
   slot, two programs), fix the #938 ladder's bracket, and re-run the five cards.
7. Carry `sliverWidthMm` / `designCheck` / `goalCutInto` through `combineOracles` and assert the
   sentence in one e2e, so gate statement 7 is visible to the operator and not only to unit tests.
8. Relabel the k3 feeds row (`feed-m1-hardwood-v-0.1`) from `source: chosen` to a library-sourced
   starting row with its two seeded fields named — a data edit, Session E.
9. Keep the page out of git as HTML (manifest + verdict table in, artifact out), or accept 3 MB per rebuild.
10. Status every two hours on a bounce; the 12-hour report in §8's format if it is not already arriving.
