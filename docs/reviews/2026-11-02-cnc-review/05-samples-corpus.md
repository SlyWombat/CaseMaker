# CNC sample-job corpus review — candidates for a first "clean cut" milestone

Read-only review of `/mnt/c/Projects/Case Maker` at main `5bcc5a88`, 2026-11-02, on dave-1 (WSL).
No project file was edited, nothing committed, no `npm install`, no contact with k3 or the machine.

## 0. Method and the CLI harness used

Sources read: `docs/bench/2026-10-28-z1-real-jobs/{README.md,manifest.json,jobs/*.json,tools/}`,
`docs/bench/2026-10-27-z1-typical-jobs/{jobs-research.md,manifest.json}`,
`casemaker-app/tests/unit/benchTypicalJobs.spec.ts`, `samples/badge-blank/`, `samples/README.md`,
`docs/bench/{single-barrel*,450-*,284-*,165-*}`, `docs/bench/2026-10-1{6,7,8}-*.md`,
`docs/bench/2026-10-24-datum-path-bench.md` (run 9), `docs/design/cut-this-blank-wizard.md` §1,
`docs/design/first-job-flow.md` §6, `casemaker-app/src/engine/cnc/feeds.ts`,
`casemaker-app/src/engine/cnc/engrave/oracle.ts`, `tests/unit/fixtures/location-doc.json`, and
issues #732–#750, #753, #760, #569, #176, #221, #879, #913 plus the follow-ons the README names
(#751, #762, #764, #765, #766, #768, #767, #823, #284, #475, #486, #492, #450, #166, #391, #572, #575).

**CLI harness.** The checkout's `node_modules` is Windows-built (`@esbuild/win32-arm64`), so
`npm run casemaker` fails under WSL there. I copied `casemaker-app/` (46 MB, without `node_modules`)
to the scratchpad and symlinked `~/projects/CaseMaker/casemaker-app/node_modules` into it — that
clone's installed `manifold-3d` 3.5.4 and `occt-import-js` match main's `package.json`
(the other WSL clone, `~/projects/CaseMaker-bench`, is at 9538601f with manifold 3.4.1 and was not used).
Location: `tests/unit/fixtures/location-doc.json` plus the spec's `BENCH_CUTTERS`
(`kz-o-flute-3-175-25`, `kz-corn-1-7`, `kz-engrave-30-0-3`, `kz-engrave-30-0-5`) and, from the bench
records, `kz-o-flute-2-12` (2 mm flat, 12 mm flute) and `kz-chamfer-90` (90°, 0.1 mm tip per #740,
1.6 mm flute). **No `catalogue.json` beside it**, so only the compiled/seeded feeds rows served.
Written to `<scratchpad>/loc/location.json`; app copy at `<scratchpad>/app/casemaker-app`; receipts,
`.nc`, frames and run sheets under `<scratchpad>/runs/<run>/`.

Command pattern (from `<scratchpad>/app/casemaker-app`):

```
npm run -s casemaker -- cut <job.json> --out <dir> --json --location <scratchpad>/loc/location.json
npm run -s casemaker -- cut --from-3mf <design.3mf> --tool inv:kz-engrave-30-0-3 --rest none --out <dir> --json --location ...
```

| run | input | exit | wall | receipt | sim | est. cut | notes |
|---|---|---|---|---|---|---|---|
| a1 | `docs/bench/450-laminate-base.job.json` (laminate, 4 labels 0.1 deep, 30°×0.3) | 0 | 3.9 s | ok, `done`, 0 refusals | column, 0 errors, 25.2 mm³ | 5 min 55 s | 12000/F500/F200, 4×1 mm passes, pitch clamped 0.18→0.15 (warning ×4); `vise-stock-not-proud`, `vise-grip-shallow` |
| a2 | `samples/badge-blank/thin-film/single-thin.3mf`, `--tool inv:kz-engrave-30-0-3 --rest none` | 0 | 3.7 s | ok, `done` | column, 0 errors, 127 mm³ | 6 min 40 s | PETG; 3 items at the colour plane (split 1.3 mm above back face per the 3MF); `vcarve-surface-merge` on two items |
| b | `jobs/j03-vise-text.json` (PLA 90×75×12, vise, 1 mm corn, 0.5 deep) | 0 | 2.9 s | ok | exact, 0 errors, 124 mm³ | 2 min 20 s | 2×0.3 mm passes, 0.45 mm step-over; `printed-plastic-melts` info |
| c | `jobs/j16-chamfer-b-cutout.json` (PLA 70×50×6, tape+6 mm board, 3.175 O-flute, 2 tabs 4×1) | 0 | 3.0 s | ok | exact, 0 errors, 3077 mm³ | 9 min 26 s | 26×0.25 mm passes, 0.3 mm breakthrough into the board; `sacrificial-default` warning |
| d | `jobs/j05-sign-pla-proxy.json` (PLA 190×80×1.6, tape, 3.175 O-flute, text 0.4 deep) | 0 | 3.4 s | ok | exact, 0 errors, 606 mm³ | 1 min 55 s | 1×0.5 mm pass |
| e | `jobs/j16-chamfer-a-bevel.json` (90° chamfer, 1 mm×45° outer edge) | 0 | 2.8 s | ok | column, 0 errors, 169 mm³ | 20 s | 12000/F500/F200, 1×1 mm, step-over 1.429 — which seeded row served a 0.1 mm-tip chamfer on PLA is not stated on the sheet |

Six runs, six receipts, all `ok` on main 5bcc5a88 against a local fixture. Everything that follows about
"generates today" rests on these; nothing here was cut.

Two things the runs showed that are worth a look (observations, not verified defects):
- The two j16 jobs are `workholding.kind: "tape"`, yet their run sheets read "## 2 · Mount the vise … The
  blank's length runs left–right between the jaws" and "Checked: … the modelled fixture (Vise fixed jaw,
  Vise moving jaw)". Either the fixture location's active bed is the vise and a tape job is sheeted onto
  it, or a tape job is being rendered as a vise job. Check before a tape sample is cut.
- The a2 sheet counts "11 cutters" where the location holds 1 user tool + 6 owned; harmless, but off.

## 1. What a "clean sample" is, in the repo's own words

**Where the repo does define it (always for the engraved two-colour badge):**

- **#569 pass criteria** (the open bench issue for the end-to-end badge cut): "Part matches the design
  within tolerance (placement centred on the blank, not skewed toward a jaw). Depth reveals the lower
  colour **evenly** — no film remaining, no cut-through past the plane. No collision, no alarm; clean
  finish." Evidence: a hand photo of the part, the time-lapse, a results comment with "measured engrave
  depth vs. the colour-plane depth". Still owed as of 2026-10-28 (triage comment): the caliper depth
  reading (centre vs ends) and the results comment.
- **#176, accepted 2026-10-17**: "every item cut and legible, no melt, first try" — the laminate V-carve
  (35 555 lines, 437 s). The record's own words: "clean floors, the whiskey line fully legible at 6.2 mm
  cap height, no melt, no strings".
- **Run sheet §9 "Record afterwards"** (every generated sheet): "Is the text legible? (yes / no) ·
  Surface finish (clean / fuzzy / burnt) · Anything that went wrong". That is the whole physical
  vocabulary the product asks an operator for.
- **Coupon records** (`450-laminate-v-feed-coupon-record.json`, `284-pla-feed-coupon-record.json`):
  verdict `ok / poor / broke`, "clean by eye", "no melt, no strings, no visible difference".
- **Simulated acceptance** (what the wizard gates on, `cut-this-blank-wizard.md` §1 step 4): "verified
  with 0 errors, simulated, matches prediction". The oracle compares under-/over-cut area per level
  against a derived band: `oracleBand = simplifyLevels(contours) × SWEEP_SIMPLIFY_EPS_MM +
  2 × ARC_CHORD_TOLERANCE_MM`, plus a grid term on the column engine (`oracle.ts:320, 434`). The 2026-10-25
  run 9 read "under-cut 0.0000 mm², over-cut 0.0000 mm²" — the first pass on the bench.
- **The demo verdicts** ("Matches the photo / Partly / Fails") are a reviewer's eye comparing a rendered
  height-field sweep against the maker's photo. Simulated only. The sweep agrees with the app's removed
  volume to ~2 % on flat and ball cutters; V-bits were 20–60 % over before #741.
- **Failure words the bench has actually used:** "patchily / could have been deeper" (10-17 PETG rest
  pass), "mottled interiors", "a grey halo = the V's flank", "'br' unreadable (13 % of its area lost)",
  "chipping at the lower-left edge (clamp)" (10-25), "fuses into one shape" (j02/j04 raised text),
  "the broken corn bit is melted into the PETG" (10-16).
- `first-job-flow.md` §6 acceptance is about the flow (under two minutes, eight clicks, "Step n of 4",
  no codes in the UI), not about the part.

**Where the repo never defines it physically** (gaps to state before calling anything "clean"):

| Property | What exists | What is missing |
|---|---|---|
| Dimensional tolerance of a pocket, hole, outline | "Measure the blank; if it differs by more than 0.5 mm, regenerate" (run sheet §1); `cnc-job-workflow.md` lists "calipered pocket depth, hole diameter" as a post-run *record* | No acceptance number for any cut feature. Nothing says a 50×30 part may be 50.1 or a ⌀3.2 hole may be 3.3. |
| Depth | #569 "reveals the lower colour evenly"; depth band on the badge (reveal ≥ split, ≤ magnet-pocket roof, `blankLabelSeed.ts`) | No tolerance in mm; the caliper reading owed since 10-25 has never been taken. |
| Surface finish | clean / fuzzy / burnt | No definition of "fuzzy" (fuzz height? strings per mm?), no melt bead criterion, no re-welded-chip criterion. |
| Legibility | yes / no; the gate's `item-detail-lost` % and `raised-text-fused` gap warnings | No threshold: at what area loss or stroke width is text "legible"? ("br" at 13 % loss was called unreadable.) |
| Tabs | "cut each tab flush with the part and the blank; do not lever" (run sheet) | No acceptance for the cleaned tab (witness height, tear-out). |
| Chamfer | the design's 1 mm × 45° | No check of leg width or angle; no bench evidence at all. |
| Edges / burr | — | Nothing. |
| Placement | #569 "centred, not skewed"; registration residual defaults (`registration.probeResidualMm` etc.) in the location | No part-level number; the only XY slack named is the 1 mm edge margin, which the sheet itself says "is not a locating tolerance". |

Recommendation for milestone 1: write the physical acceptance once, per operation, in plain numbers
(a caliper has 0.01 mm resolution; the repo's `measured` convention requires an instrument and a date).
Proposed starting numbers are in §6; the repo has none to cite.

## 2. Candidate table, ordered by risk

House cutter names as the real-jobs README/`bench_location.py` use them; all are 1/8" shank, yellow
(non-metal) line unless `-m-`. Feeds provenance words follow `feeds.ts`: *seeded* (compiled placeholder),
*observed* (one bench run, not a coupon), *measured* (coupon + readback), *catalogue* (Makera row, needs
`catalogue.json` beside the location and, for PLA/PETG/plastic, is a labelled ABS/acrylic mapping, #455).

### (a) Text V-carve on the two-colour badge — the proven one. Risk: lowest

- **Job files:** `samples/badge-blank/thin-film/single-thin.3mf` (printed PETG thin-film badge; the
  2026-10-17 evening used this design on the laminate; run a2 above) and `samples/badge-blank/single.3mf`
  (the 10-16/10-17/10-25 badge). `docs/bench/450-laminate-base.job.json` (laminate, four labels). The
  10-25 cut used the app's badge import of `single.3mf` with the 0.5 mm engraver.
- **Stock/holding:** two-colour badge blank 76.2 × 38.1 × 3.81 (PETG as printed, PLA in the job files),
  colour change 3.0 mm (`single.3mf`) or 1.3 mm above the back face (`single-thin.3mf`); vise, long side
  front-to-back, 38 mm between the jaws; or the purchased laminate 76 × 25.4 × 1.5, cap ~0.075 (assumed),
  sitting 1.6 mm below the jaw tops on the ledge (`vise-grip-shallow` warning, no packer).
- **Cutter:** `kz-engrave-30-0-3` (Makera match assumed 121011033830). 10-25 used the 0.5 mm engraver.
- **Simulated verdict:** generates today (a1 3.9 s, a2 3.7 s), 0 errors; warnings
  `vcarve-stepover-clamped` (pitch 0.18/0.24 → 0.15), `vcarve-surface-merge` on the badge's two long
  items (strokes closer than 0.107 mm at the surface).
- **Feeds provenance:** PLA V row *seeded* from the 10-15 hand groove (185); PETG and `plastic` V rows
  *observed* 10-17 (S12000/F500/F200, 856 s, no melt); the laminate's F1000 row is the **only measured
  row anywhere**, and it lives in the house `location.json` on k3 (not committed, not in the compiled
  table; #284 tracking still open).
- **Bench evidence:** 10-17 laminate: all items legible, no melt, first try (#176 accepted). 10-18
  laminate coupon F400–F1000: all four clean, chose 1000. 10-25 printed badge via the app's own
  registration + run: "Single Barrel reads", interiors mottled, "br" unreadable (13 % area loss, as
  warned), chip at the clamp edge; oracle 0/0; calipers owed (#569/#631). 10-17 afternoon PETG badge
  with the V as a *rest* pass: patchy (Z0 referenced to the dome's ridge, #475 — fixed).
- **Open against it:** #569 (open; the caliper reading and results comment), #631 dome/G32 route
  (on #767's bench list), #913 (plastic guidance; the V rows are not in its scope but the spindle-fan
  M811 request is).

### (b) Engraved / raised text with a flat end mill on PLA. Risk: medium

- **Job files:** engraved: `jobs/j03-vise-text.json` ("Matches the photo", 1 mm corn, 8 mm text 0.5 deep,
  run b), `docs/bench/284-PLA-feed-coupon-F{350,500,700,900}.job.json` (2 mm O-flute, "F500" 11 mm Barlow
  bold 0.8 deep on the badge, vise — the 284 feed coupon, **never cut**, verdicts `null`),
  `jobs/j05-sign-pla-proxy.json` (3.175 O-flute, text 0.4 deep, run d). Raised: `jobs/j02-raised-cnx.json`
  (PLA 100×90×10 vise, field 1 mm deep around "CNX"/"Software"; since #760 the pick adds a ⌀1 rest, which
  on the house inventory is the 1 mm **corn**).
- **Cutter reality:** the maintainer's 2026-10-16 rule (#455, after the 0.6 mm corn melted into PETG and
  broke): a cutter the catalogue lists for no row of the material is not recommended, and Makera lists
  corn bits for PCB/carbon fibre only. So j03's and #760/#765's 1 mm/0.6 mm corn picks are **not a plastic
  recommendation**; the 10-17 record says the house owns no 1 mm plastic flat. The plastic-safe flat is
  `kz-o-flute-2-12` (2 mm), which cut the 10-16 and 10-17 rough passes "cleanly" (134–136 s, "all good"),
  and `kz-o-flute-3-175-25`.
- **Feeds provenance:** PLA flat rows *seeded* (12000/F500/F200, step-down 0.3 for 0.8–1.6, 0.5 for
  1.6–3.2, 0.2 for the 0.5–0.8 placeholder). #913 (open) says plastic wants 10–16k rpm and **F1500–2500**,
  ½ D step-down — 3–5× the seeded feed; the 284 coupon's ladder stops at F900.
- **Simulated verdict:** b and d generate today (2.9 s / 3.4 s), 0 errors. j02 "Partly" (fused
  "Software" unless a sub-1.08 mm cutter).
- **Bench evidence:** the 2 mm O-flute region passes of 10-16/10-17 (PETG) — the only flat-cutter
  evidence on plastic, and it was clean. The corn break. No raised-text cut ever.
- **Open against it:** #913 (seeds, chip-load check, O-flute preference, ramps, fan), #284 (no coupon
  cut on a flat), the unresolved contradiction between F500 seeds and #913's numbers. Closed, simulated
  only: #739 (fuse warning), #760/#765/#766 (pick by outcome), #762.

### (c) Rectangular / rounded pocket. Risk: medium

- **Job files:** `docs/bench/165-depth-ladder-row-{A,B}.job.json` (5×5 pockets 0.6–1.2 deep on the badge,
  2 mm O-flute, vise; the 10-16 record calls that blank "the scrap ladder blank", so a ladder was cut
  before 10-16 — I did not read that day's record); `jobs/j12-wrench-pla-proxy.json` (⌀60 pocket 1.5
  deep with an island, 2 mm O-flute, PLA 150×75×6.35, vise, 9.5 min; the aluminium twin "Matches");
  `jobs/j16-chamfer-b-cutout.json` carries a 50×30 rect (through); `jobs/j22-snack-tray.json` (2.5 h, too big).
  A badge-sized pocket sample (one 20×10 × 1 mm pocket + one ⌀8 round) needs a **new small job**.
- **Cutter:** `kz-o-flute-2-12` or `kz-o-flute-3-175-25`. **Feeds:** PLA flat *seeded*.
- **Simulated:** the class generates (#734's pocket-ring fix); j12 proxy simulated 10-29.
- **Bench evidence:** none for a pocket as a part feature (the ladder was a depth test).
- **Open:** #913 (ramped entry, fan). No tolerance to judge it by (§1).

### (d) Plunge-drilled hole pattern. Risk: medium-high

- **Job files:** `jobs/j17-faceplate-pla-proxy.json` (⌀7.2 ×3 + ⌀8.1 + window through 3 mm PLA, bracket,
  3.175 O-flute — bored, not drilled), `jobs/j18-thread-a-bore-pla-proxy.json` (2 holes 6 deep, 2 mm
  **corn**, vise), `jobs/j13-tool-tray-b-small-holes.json` (2 mm corn). The house owns one drill,
  `kz-drill-3-12` (3 mm TiN, Makera 142212303812) — no job file uses it.
- **Feeds:** a drill on PLA has no row of its own; the catalogue lists drills for PCB/metal lines (not
  checked here — the catalogue is not committed). **No peck cycle for plastic** (#913 item 5, open).
- **Bench evidence:** none. The drill-point angle on the CLI path was fixed in #733 (simulated).
- **Open:** #913 items 4–5 (ramps, pecks), the corn-on-plastic rule, bracket/clamps never fitted
  (10-18: "all still in their bags"). Recommend bored holes with the 2 mm O-flute instead of drilling.

### (e) Cut-out with tabs. Risk: medium

- **Job files:** `jobs/j16-chamfer-b-cutout.json` (run c: 2 tabs 4×1, 26 × 0.25 mm passes, 0.3 mm into
  a 6 mm board, 9.5 min), `jobs/j01-topclamp-pla-proxy.json` (3 tabs, bracket, 5 min), `jobs/j15-vader-pla-proxy.json`
  (tape, 3 tabs 3×0.8). Fixtures `fx-hexv.json`, `fx-hex-svg-import.json` (#750).
- **Holding:** tape on a board, or the bracket — **neither has ever held a part on this Z1 under the
  app**; every cut so far was in the vise. A through cut in the vise is refused without an under-board
  (`through-needs-board`); #736 part 2 (does the vise's lift satisfy it) was left "waiting for the bench
  measurement" and #736 was then closed on part 1 — no issue carries part 2 now.
- **Cutter:** `kz-o-flute-3-175-25`. **Feeds:** PLA flat *seeded* (26 passes at 0.25 mm = the 1.6–3.2
  row's 0.5 halved by… the sheet does not say).
- **Simulated:** generates today (3.0 s). Closed, simulated only: #736 (tabs on arcs/traced sides; cut
  with the tabs that fit), #750 (tab ≠ loose piece), #747 (frame height), #749/#751 (kernel crashes).
- **Bench evidence:** none by the app. Makera's own TopClamp.nc (aluminium, 10-17 record) is the only
  tabbed part the machine has made.

### (f) Shallow pocket + text sign on laminate. Risk: low-medium

- **Job files:** `jobs/j05-sign-laminate.json` (190×80×1.6 `plastic`, tape, 3.175 O-flute, "CNX
  Software" 0.4 deep through the cap — "Partly": colours modelled wrong, geometry right). The house
  sheet is 76 × 25.4 × 1.5 with a ~0.075 mm cap, so a flat pocket 0.1–0.2 deep.
- **Feeds:** `plastic` has **only a V row** in the compiled and fixture tables; a flat on `plastic`
  resolves only through the catalogue mapping (ABS/acrylic rows), which needs `catalogue.json` beside
  the location — absent in my fixture, present on k3. Not run (budget); expect a feeds refusal on the
  fixture. The 10-18 app-side verdict said exactly this ("has a V-bit row for PLA, PETG and plastic only").
- **Bench evidence:** laminate cuts cleanly with the V (10-17, 10-18). A flat on laminate: none.
- **Open:** none specific; #913 applies only loosely (laminate is not printed plastic).

### (g) Chamfered edge. Risk: medium-low

- **Job files:** `jobs/j16-chamfer-a-bevel.json` (run e: 1 mm × 45° on the 50×30 outer edge, 20 s, column
  sim 0 errors). Must be followed by `-b-cutout`; as one job that is #746's multi-cutter path (closed,
  simulated).
- **Cutter:** `kz-chamfer-90` (Makera 122111013890, tip 0.1, flute 1.6; #740/#741 closed). **Feeds:** the
  sheet printed 12000/F500/F200, 1 × 1 mm, step-over 1.429 — a seeded row, but which (the PLA V row is
  0.3–0.5 tip; the flat row is 0.5–3.2 ⌀) is not stated. Check `feedsFor` for a 0.1 mm-tip chamfer.
- **Bench evidence:** none. Makera's own table (jobs-research §A): plastic/hardwood 12000/1000/500/1.

## 3. Simple-operation defects from the 2026-10-28/29 runs — state today

| Issue | Operation | State | Last comment | Bench check? |
|---|---|---|---|---|
| #736 tabs on arcs / traced sides; cut with the tabs that fit; vise lift as through clearance | cut-out | CLOSED 2026-11-01 | "Landed on main in 82072be7" (part 1 + fold-in). **Part 2 (vise lift) was "waiting for the bench measurement" on 10-29 and has no issue now.** | No |
| #747 frame file outside the envelope | all (frame) | CLOSED 10-29 | frame traced at a reachable Z; withheld with reason; receipt carries its findings | No |
| #748 engraving on a pocket floor judged from the top | text in pocket | CLOSED 10-29 | planned/judged from the floor; j21 13G: 8 → 0 false warnings | No |
| #749 wasm crash on ⌀44 disc cut-out | cut-out | CLOSED 10-29 (+42f854f7) | receipt on any kernel fault | No |
| #751 6,000-point pocket aborts the kernel | pocket | CLOSED | pocketLoops no longer posts every ring at full density | No |
| #750 tab reported as loose piece | cut-out | CLOSED 10-29 | tabs subtracted per contour (kerf + 0.05 bridge) | No |
| #739 raised text fuses silently | raised text | CLOSED 10-28 | warns `raised-text-fused` — the letters **still fuse physically** with a 3.175 | No |
| #760 / #765 / #766 cutter pick by gap / by simulated outcome | text | CLOSED 10-29 / 11-01 / d98991dd | j02 now ⌀3.175 + ⌀1 rest; "0.6 mm corn makes the word read" — **both small picks are corn bits, not recommended on plastic (#455)** | No |
| #746 later cutter only rest-machines | multi-cutter | CLOSED 10-29 | each cutter cuts its own items; cut-out posts last | No |
| #734 / #738 rapids through stock; V runs > 10 min | pockets, drills, 3D | CLOSED 10-28 | fixed; j13 was a sweep false positive | No |
| #740 / #741 chamfer tip; V deeper than cone | chamfer, V-carve | CLOSED 10-28/29 | tip from record; cone bound refuses | No |
| #913 cut printed plastic properly | all on PLA/PETG | **OPEN**, 1.1 | spindle fan M811/M812 in the post for plastic jobs; acceptance: PLA program carries M811/M812 | — |
| #284 measured-not-assumed tracking | feeds | **OPEN** | first coupon cut 10-18 (laminate V); no flat coupon cut | — |
| #569 end-to-end badge cut | badge | **OPEN** | satisfied 10-25 per the record; calipers + results comment owed | Partly (10-25) |
| #767 bench verification checklist | machine | OPEN | 11 items; none of the CAM fixes above is on it | — |

Net: **every CAM fix since 2026-10-28 is "fixed, simulated only"**. The last physical cut from an app
program was 2026-10-25 (run 9, V on the printed badge); the last flat-cutter cut on plastic was
2026-10-17 (2 mm O-flute rough pass). The 10-29 v5 re-run and all of #732–#768 have no bench witness.

## 4. Material reality check

- **Default is hardwood** (#879, landed 801a6531 on 2026-11-02): `defaults.ts` names a 100 × 60 × 12
  hardwood plate with "CASE" at 14 mm, cut with the three house cutters. Hardwood rows: *seeded*
  12000/F400/F150, step-down 0.3 (0.8–1.6) / 0.6 (1.6–3.2), unmeasured. **The shop has no hardwood blank
  on record** — the stock list in the fixture is aluminium plate + a PLA printed blank; the real-jobs
  set cut its wood jobs "in PLA, because this shop cuts printed plastics, not wood". So the flagship job
  cannot be cut as a sample here without buying stock.
- **Plastic rows today** (`feeds.ts` `UNMEASURED_FEEDS_TABLE`; the fixture location mirrors them):

  | material | edge | ⌀ | rpm / feed / plunge / step-down | provenance |
  |---|---|---|---|---|
  | pla | flat | 0.5–0.8 | 12000 / 500 / 200 / 0.2 | PLACEHOLDER (for the 0.6 corn, which then broke) |
  | pla | flat | 0.8–1.6 | 12000 / 500 / 200 / 0.3 | seeded |
  | pla | flat | 1.6–3.2 | 12000 / 500 / 200 / 0.5 | seeded ("#284's coupons measure it") |
  | pla | V | 0.3–0.5 tip | 12000 / 500 / 200 / 1.0 | from the 10-15 hand groove (185); starting values |
  | petg | V | 0.3–0.5 | same | OBSERVED 10-17 (856 s, no melt), not measured |
  | plastic | V | 0.3–0.5 | same | carried from the PETG observation; unmeasured on laminate |
  | plastic | V | 0.3–0.5 | 12000 / **1000** / 200 / 1.0 | **MEASURED 2026-10-18**, house location on k3 only (`450-laminate-v-feed-coupon-record.json`) |

  `MEASURED_ROWS` in `feeds.ts` is empty. No PETG flat row, no `plastic` flat row, no drill or chamfer
  row for any plastic. The catalogue path (#455/#732) answers PLA/PETG/plastic with Makera's ABS/acrylic
  rows as a labelled mapping, and only when `catalogue.json` sits beside the location (k3 yes, fixture
  no, dev browser no). Makera's own plastic numbers for the O-flute are 10000/1000/300/1 (jobs-research §A).
- **#913 vs the seeds:** #913 asks for F1500–2500 at 10–16k rpm with ½ D step-down, a chip-load check,
  O-flute preference, ramped entries, pecks, and M811 fan. The seeded F500 is 3–5× slower; by #913's own
  physics it is the rubbing regime. The 284 coupon (F350–F900, 2 mm O-flute, 0.8 deep, 11 mm text) is the
  instrument the repo built to settle this and it has never been cut; its ladder does not reach #913's floor.
- **What this means for a clean plastic sample now:** the V-bit path (a, f) stands on one observed run and
  one measured row and is the only operation with a physically clean result on record. Every flat-cutter
  sample on PLA/PETG (b–e, g) would run on placeholder feeds the maintainer's own guidance calls wrong,
  with a cutter pick that may name a corn bit, and without ramps or a fan. Those should be cut only as
  coupons first (one variable at a time, verdict recorded, readback flips the row), then as samples.

## 5. Inputs: committed vs needing downloads

**Rebuildable from committed files alone, licence-clean (house-made or photo-measured geometry):**
j01 (geometry read from Makera's public `TopClamp.nc`), j02, j03, j04 (all variants), j05, j10, j11
(all), j12, j13, j14, j16, j17, j18, j19, j22, j24, j25, `fx-*`; the badge blanks (`make_badge.py`,
`*.3mf`, `*.stl`, `br.*`); `450-laminate-base.job.json`; `284-*`, `165-*`, `single-barrel.*`. The
`samples/badge-blank/br.*` and `thin-film/thin-film-*` files are untracked in the working tree (git
status) but present; `single.3mf`, `single-thin.3mf`, `make_badge.py` and the T2/T3 pair are committed.

**Need a download or a login (not for milestone 1):** j06 wolf relief (Printables, CC BY-NC-ND, bytes
stripped), j07 portrait (public domain; the PNG *is* embedded, 128 KB — fine, but it is a 2–5 h relief),
j15 helmet (OpenMoji CC BY-SA; derived polygons committed — share-alike obligations if published),
j20/j21 (CutRocket `.c2d`, licence unstated, not committed), j23 (Makerables CC BY-NC-ND, not committed),
everything in "Not run" (logins, 3D components).

## 6. Assessment: milestone-1 samples, in order

Not needed for milestone 1: **3D relief** (j06/j07: hours, ball noses, #738), **rotary** (#545/#238
gated: code before bench), **aluminium** (j01/j04/j12/j14/j17/j19/j24/j25: no stock, no metal evidence),
**thread mill** (j18: no published feeds), **inlay** (j11: wood pairs, glue gap), **PCB** (#823),
**coin disc** (#743 P-7). None of them teaches anything about "clean" that the five below do not.

Proposed physical acceptance numbers are mine (the repo has none, §1); state them as the milestone's
definition and adjust after the first part.

| # | Sample | Job | Blank · holding | Cutter | Operator acceptance (calipers / eyes) | Fix or decide first |
|---|---|---|---|---|---|---|
| 1 | **Badge V-carve "Single Barrel"** — re-cut the proven one through the app's own flow (register → generate → run) | `samples/badge-blank/thin-film/single-thin.3mf` (or `single.3mf`) via the badge import, or `casemaker cut --from-3mf … --tool inv:kz-engrave-30-0-3 --rest none` (run a2) | fresh two-colour PETG badge 76.2×38.1×3.81, vise, long side front-to-back, 38 mm between jaws | yellow 30° × 0.3 engraver (`kz-engrave-30-0-3`) | all 3 items legible by eye at arm's length; lower colour continuous in every stroke (no top-colour film, no cut past the plane); no strings or melt bead; floor depth at centre and both ends within 0.1 mm of each other (depth gauge); text centred on the blank within 0.5 mm (calipers to the edges) | nothing blocking. Owed: #569 calipers + results comment; take the 5-touch Z0 route the sheet prints; M821 light, M331 vacuum, `$H` first and last |
| 2 | **Laminate name plate at the measured row** | write a 2-label job from `docs/bench/450-laminate-base.job.json` (name + a second line, 6–8 mm, 0.1 deep) | purchased laminate 76×25.4×1.5, vise ledge (1.6 below jaw tops, no packer) | same V-bit | full-contrast core in every stroke, no cap remnant, edges crisp; no visible difference from the 10-18 coupon cells | the F1000 row exists only in k3's location — confirm the location used carries it (`source: measured`); nothing else |
| 3 | **Engraved text with the 2 mm O-flute on a badge** — coupon first, then the sample | coupon: `docs/bench/284-PLA-feed-coupon-F{350…900}.job.json` as written; **add F1200/F1500 cells** per #913 before cutting; sample: a 2-line label job on `single.3mf`'s blank with ≥ 11 mm Barlow bold | PETG badge, vise | `kz-o-flute-2-12` | letters open (no fused counters); floor matte and flat, no re-welded chips; no fuzz on the walls; lower colour shows in the whole floor; record `ok/poor/broke` per cell and the chosen feed in the coupon record, then `scripts/feeds-readback.ts` | decide #913's seeds vs F500 (extend the coupon rather than wait); M811 fan in the post (#913 comment); the pick must not name a corn bit on plastic — pin `--tool` |
| 4 | **Pocket + bored holes on a PLA plate** ("fit coupon" style) | **write**: 70×50×6 PLA plate, one 20×10 rect pocket 1.0 deep (r 2), one ⌀8 round pocket 1.0 deep, four ⌀3.2 through bores; vise with a 6 mm board under, or tape on the board | 6 mm printed PLA plate | `kz-o-flute-2-12` | pocket 20.0×10.0 within ±0.1, depth 1.00 ±0.05 (calipers / depth gauge); bores accept a 3.0 pin and refuse a 3.3 (or calipers ±0.1); no melt in the bores, no lifted edge | #913 ramps/pecks (open) — accept the risk or cut after the coupon; the sacrificial-board dims are defaults (`sacrificial-default`); if on tape, resolve the tape-job-sheets-the-vise observation in §0 first |
| 5 | **Chamfer, then cut out with tabs** | `jobs/j16-chamfer-a-bevel.json` then `jobs/j16-chamfer-b-cutout.json` (runs e, c), or one two-cutter job per #746 | 70×50×6 PLA, tape on a 6 mm board (or vise + board) | `kz-chamfer-90` then `kz-o-flute-3-175-25` | part 50.0×30.0 ±0.1; 2 tabs snapped and dressed flush (no witness above 0.1 mm); chamfer legs 1.0 ±0.2 by caliper; part did not move (no step at a tab); no melt on the 26 passes | first tape/board holding ever on this Z1 — dry run the frame, check the board is taped not just placed; which feeds row served the 0.1 mm-tip chamfer (§2 g); #746's one-job path is simulated only — two programs with a tool change is the safer first run |

Order rationale: 1 and 2 re-establish "clean" on the only operation with physical evidence, with the
app's full flow (the 10-25 run) and the only measured row; 3 converts the unmeasured flat-cutter feeds
into a measured row before any flat-cutter *sample* is judged; 4 adds the two features (pocket, bore)
every enclosure needs; 5 is the first part that leaves the blank, on a holding the app has never used.
Nothing in (d) plunge drilling is needed — bore with the O-flute until #913's pecks exist.

### Before the bench (desk work the milestone needs)
1. Write the acceptance numbers above into the milestone (or a `docs/bench/milestone-1-clean-samples.md`)
   so §9 of each run sheet has something to be judged against; add a `depth` and `dimensions` line to
   the sheet's "Record afterwards" if the maintainer agrees (that is a product change — file it).
2. File: #736 part 2 (vise lift as through-cut clearance) lost its issue; the tape-job/vise run-sheet
   observation; the chamfer's unnamed feeds row; the 284 coupon's ladder vs #913.
3. Decide #913's seeds for the 2 mm and 3.175 O-flutes on PLA/PETG, or at minimum extend the 284 coupon
   values, before sample 3.
4. Pin `--tool`/the job's `toolKey` for every plastic sample so the pick cannot choose a corn bit.
5. Memory rules that apply at the bench: power on/off via `power.sh`, `$H` before any hands in the
   machine and as the last command, M821 light for the whole job, M331 before play, one instruction per
   message, save the transcript after every run, photograph every part next to a scale.
