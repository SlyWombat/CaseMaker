# Z1 demo jobs, cut for real (2026-10-28, re-run 2026-10-29)

## The card rule and the one command (2026-11-02, #944)

The published page is the gate. **A card stays only if its reference is objective and drawn on the
card beside the simulated result**, and its verdict is computed, never judged by eye:

- **2.5D** — the job's own design: the design outline overlaid on the swept "after" (`overlay.png`),
  with the design check's under/over numbers per item and per label box.
- **3D** — the app's own goal heightfield: the goal rendered from the same view, the cell-by-cell
  deviation map, and the coverage percentage.
- **Reference program** (j01) — Makera's own `TopClamp.nc` swept on the same blank, beside the
  design check of the job.
- **No photo decides a verdict.** The maker's page is the provenance line only. Material proxies are
  retired: the as-filed job is judged, and refused is refused. The five hardwood samples (#936–#941)
  join the page as their job files are committed.

Verdicts: **Matches the design** (verifier 0 errors; every measured item at its floor and nothing cut
outside the design — 3D: zero cut-into the goal and coverage ≥ the shop's `goal.passCoverage`, seeded
95 % and read by both the app's goal check and `goal_check.py` from the location), **Deviates** (the
number and where), **Refused** (the app's sentence), **Not checkable** (the interim check has no
measurable item — chamfers and plain cut-outs need #924's oracle). Until #924 lands, the design check is this repo's
own sweep against the job's design, and the page says so.

**One command rebuilds the page on a given sha** (the worktree must be checked out at that sha; its
`HEAD` is what the page states):

```sh
docs/bench/2026-10-28-z1-real-jobs/tools/build.sh <sha>
```

The two stick-scale goal jobs (`j28-panther-stick`, `j29-elephant-stick`) carry no mesh bytes: the
meshes stay shop-owned local inputs in `samples/3d/`, and `build.py` puts the named file back into a
copy of the job in the run directory, refusing unless its SHA-256 is the job's own. `--meshes`
(default `/mnt/c/projects/Case Maker/samples/3d`, or `CM_MESHES`) says where they live.

`CM_REPO` (default `~/projects/cm-wt/944-demo-page`), `CM_PY` (default
`~/casemaker-manager/venv/bin/python`, needs numpy + PIL) and `--location` / `--out` override the
defaults. The location is the bench location document — the shop's own cutters plus the full Makera
library (134 entries, 129 with Makera ids), the demo runs' convention — with the synced
`catalogue.json` beside it. The k3 house service's export (`/api/v1/export`) carries only the 29
owned cutters and no Makera ids, so every metal or laminate job refuses at feeds on it; that is a
statement about the shop's data, not the app. Both paths are arguments, never baked into a script. Per
card `build.py` runs `casemaker cut`, sweeps the posted `.nc` independently (`render.py`), runs
`design_check.py` or the goal pair (`goal-hf.mts` + `goal_check.py`), and writes `page.html` and
`manifest.json` into the build directory. Rebuild on every T3 and publish once per wave.

Not reproducible here, so listed on the page and not cards: j06 (the wolf model is CC BY-NC-ND), j08
(rotary carving cannot be described yet), j09 (PCB, needs a login), j26 (posted NC halves with no
design to check them against).

## The goal check's proofs, one rule with the app (gate v8, #1092)

Since #1092 the page's checker (`tools/goal_check.py`) applies the same proof set as the app's
`checkGoalCutInto` (`casemaker-app/src/engine/cnc/engrave/designCheck.ts`), cell for cell. Every
excuse is a PROOF bounded by the goal's own relief; no class of cells is excused by name.

- **Edge break** — only when the job states one: a V bit's band, that bit's own leg, and that bit's
  stamp the deepest at the cell. `--job <job.json>` reads the statement (`targetObject.edgeBreak`,
  or its old name `chamfer`); with no statement — or no `--job` — there is no allowance, which is
  what the app itself does for a job that states none. `edges` defaults to `silhouette` (the part's
  own outline); `all` seeds interior walls too.
- **Wall / border** — excused only on the straddling proof, and only when the depth is within the
  goal's local relief (max − min of the covered goal top within the largest cutting tool's radius;
  a border cell counts the stock top as a high side) plus 0.005 mm. The class proof's step TEST also
  carries that 0.005 mm — the sampled heightfield step can be a hair short of the design floor
  (measured 0.0004 mm on the tray's 2.885 mm floor) — while the general proof keeps only its 1e-12.
- **Wall shadow** — the v5 proof (the V within its leg, or the deepest stamp's CL at the disc's
  rim), bounded by the same relief. A cell that fails the bound is counted, not excused.
- **Straddling** (v6) — any other cell deeper than 0.1 mm is excused only when the step over its
  axial neighbours is at least as tall as the read intrusion and the swept floor is at the design's
  low side.

The judged figure is `adjudicatedFraction` — the share of covered cells cut below the 0.1 mm floor
after those exclusions — and it is the app receipt's `details.goal.adjudicatedFraction`. The raw
figures at 0.01 mm, each excluded class, and the over-relief counters (`wallOverReliefCells`,
`borderOverReliefCells`, `shadowOverReliefCells`, `overReliefDeepest`) are written beside it, so an
excuse is never silent.

`tools/goal-check-parity.py` is the parity test: given a card run directory (the
`runs/<sha>/<card>` one `build.py` writes, or any directory with `receipt.json`, `job.json`, the
goal heightfield pair and the posted programs), it re-runs the checker over the same programs and
the same goal grid and compares the two goal blocks. The adjudicated fraction must agree within
**0.01 %** of the covered cells (#1092's acceptance); the raw figure and each class are printed
beside it and called out when they are noisier. A run whose receipt was written before gate v8
reports the old rule and is expected to disagree — the parity is run on a fresh card run of the
branch that carries the rule.

```sh
CM_LOCATION=<the location the card ran with> \
  ~/casemaker-manager/venv/bin/python tools/goal-check-parity.py runs/<sha>/j29 runs/<sha>/ref-tray70
```

`tools/test_goal_check.py` pins the rule on synthetic fields with hand-known answers: the strict
stamp edge, a clean pocket, a boundary-tangent contour, the relief ceiling on wall and border cells,
the class ordering, the who gate, the edge-break allowance from the statement, and the two
step-test slacks. Run it with the bench venv before a page rebuild.

---

This run replaces `docs/bench/2026-10-27-z1-typical-jobs/` as the record of whether Case Maker can make the 18 typical jobs and the seven jobs of the second set. The 2026-10-27 run counted "a program was written and passed its own simulation" as success, and most of its inputs were stand-ins that did not resemble the parts. In this run, each job models the part in the maker's photo or file. Every card was then compared by eye with that photo. The cards were first run on 2026-10-28; the **2026-10-29 re-run on main 207e8a11** is the current verdict, and the first-run tables below are kept as history.

- Main **207e8a11** (re-run), `casemaker cut <job> --json --location <bench location>`.
- Location: the desktop app's `location.json` (29 owned cutters) with the synced Makera catalogue (129 cutters, 1,328 feed rows). Three house cutters carry an assumed Makera match, named on their cards: `kz-engrave-30-0-3` → `121011033830` (j15), `kz-o-flute-2-12` → `111011203812` (j12 proxy), `kz-o-flute-m-2-8` → `112111203808` (j12 aluminium). No cutter the house does not own was needed.
- No machine was used.
- `manifest.json` holds each job's verdict, its sentence, the issues filed and every run's result.
- The page: https://claude.ai/artifact/EZ2yRActt2oECe57cYGhGc (first run).

## Re-run 2026-10-29 (main 207e8a11)

All 25 cards were run again after the fixes the first issue list asked for had landed: #732 (owned cutters carry their Makera ids, so aluminium, acrylic and laminate get Makera's feeds), #746 (one job, several cutters, the later one taking through work), #747 (the frame file kept inside the envelope), #748 (a cut on a pocket floor planned from that floor), #749 (a kernel crash now prints a receipt), #750 (a tab is not a loose part), #741 (a V-carve deeper than its cone is refused), #736 (tabs on traced straight sides), and the #734/#735/#737/#738 fixes.

- 60 recorded runs, all completed: 33 in set 1 (the jobs and their proxies or alternative cutters) and 27 in set 2 (the one-job runs and the hand splits shown on the cards).
- **Set 1:** 4 match the photo (j01, j03, j12, j13), 8 partly (j02, j04, j05, j06, j07, j10, j11, j15), 4 have no photo to compare (j14, j16, j17, j18), and 2 cannot be described (j08, j09; no job can be written, so they were not run).
- **Set 2:** 1 matches (j24), 5 partly (j19, j20, j22, j23, j25), 1 fails (j21).
- **Most of the first run's refusals are gone.** The remaining differences are mostly in the modelled parts — a stand-in artwork, a simplified fork, a flat pocket floor where the maker sculpted one — not in the app. Aluminium now generates on every job that has a metal cutter, three of the set-2 jobs that needed a hand split (j19, j24, j25) now run as one multi-cutter job each, and the male inlay plug now derives.
- **j21 still produces no part.** The as-drawn job and the pocket-only split abort the geometry kernel (`RuntimeError: Aborted()`); the V-carve split is refused because its vectors are 14 mm deep from the top and the 30° bit reaches 4.99 mm; the chamfer split and the cut-out generate (the cut-out took 26 minutes to write). A new issue (#751) is filed; its fixture is `jobs/fx-dense-circle-pocket.json`, a synthetic 6,000-point circle pocket in the same blank (no coaster artwork).
- **j23's as-drawn job is refused** because 2 of its 4 tabs cannot be placed on the traced outline (#736); the split jobs generate.

The tables below are the first runs (2026-10-28); this section supersedes their verdicts.

## Verdicts (first run, 2026-10-28)

| Verdict | Jobs |
|---|---|
| Matches the photo | j03 |
| Partly | j02 (raised "Software" fuses, #739), j06 (wolf relief only 3.5 mm deep, #738) |
| Fails | j01, j04, j05, j12, j14, j15, j17 (no feeds for the material, #732); j07 (own simulation refuses the program, #738); j13 (own simulation refuses the program; a false positive of the sweep floor, #734 item 1); j08, j09 (cannot be described, #723, #743); j10, j11 (V-bit planning and inlay plug, #740, #741, #742) |
| No photo to compare | j16, j18 |

On a PLA stand-in, the Top Clamp (j01) comes out matching Makera's own program, and so do the sign (j05) and the wrench plate (j12). The coin (j04) and the keychain outline (j15) come out partly.

## Inputs not in the repository

The job files that embed them are committed **without** the bytes (`targetObject.data` removed). Rebuild them as follows:

- **j06 wolf relief:** "Wolf Relief Sculpture Wall Art" by Triple G Workshop, https://www.printables.com/model/1261158 (CC BY-NC-ND 4.0), file `wolf relief wall art stl.stl`. For the job it is scaled to 80 mm wide and to 8 mm deep (2 mm ball) or 3.5 mm deep (1 mm ball), and turned 180° (the file lies ears-down). The reviewer's own model is not published.
- **j07 portrait:** Alexander Gardner's 1863 portrait of Abraham Lincoln, public domain, Wikimedia Commons `File:Abraham_Lincoln_O-77_matte_collodion_print.jpg`, 960 px wide, greyscale, resized to 360 × 464. The PNG is embedded in the committed job (128 KB).
- **j15 helmet artwork:** OpenMoji `darth-vader` (CC BY-SA 4.0), via https://api.iconify.design/openmoji/darth-vader.svg. The polygons in the job files are derived from it.
- **j01 intended:** Makera's own `TopClamp.nc`, https://github.com/MakeraInc/CarveraProfiles/releases/download/v0.9.1/TopClamp.nc. The clamp's geometry in `j01-*.json` was read from it.

## How the "after" pictures were made

They come from an independent height-field sweep of the posted `.nc`, with the cutter's real cutting shape on a ≤0.1 mm grid. On flat and ball cutters it agrees with the app's removed volume to within about 2%. On V-bits the app removes 20–60% more (#741).

The 2026-10-27 sweep drew every ball and drill at its 3.175 mm shank, not its cutting diameter. That is part of why the old wolf card showed a dish. It also produced the "terraced" inlay plug: today's plug (`j11-v1-star-male-90.json`) has a flat floor.

## Fixtures

Each issue names its job files in `jobs/`:

- #738: j06-wolf-2mm-ball, j07-photo-relief, j07-photo-relief-1mm-ball
- #739: j02-raised-cnx, j04-coin-pla-proxy
- #740: j10-plaque-90v, j11-inlay-female-90v
- #741: j11-v1-star-female-90, j11-v1-star-male-90, j11-inlay-female-30v
- #742: j11-inlay-female-30v
- #743: j04-coin-pla-proxy
- #734: j15-vader-pla-proxy-b-engrave, j17-faceplate-pla-proxy, j13-tool-tray (a false positive of the sweep floor, not a surfacing defect)
- #735: j13-tool-tray-b-small-holes, j18-thread-a-bore-pla-proxy

## Split-helix column (#753, 2026-10-29, simulated)

`jobs/j26-split-helix-A.nc` and `j26-split-helix-B.nc` are the two posted halves of the split-helix acceptance: a ⌀20 rod, a 360° helix over X 5–25 with the ⌀3.175 flat's tip on the axis, piece B at A 180°. They are not hand-written — `casemaker-app/tests/unit/helpers/splitHelix.ts` builds the IR and posts it, and `tests/unit/exportSplitHelix.spec.ts` asserts the committed files are that generator's exact text, so the bench record cannot drift from the fixture. **No machine was used.**

The app's Simulate panel was asked to open piece A on the rod's 30 × 20 × 20 box, and at the time it **refused the program in the panel's own words** (`docs/bench/img/2026-10-29-split-helix/`): the setup was a prism and the rotary engine needs a cylinder stock, and the exact route reported that an A word is tracked but not interpreted — only the tool path was drawn, with the transport reading A 0° · 1 turn. The screens are `split-helix-opened.png`, `split-helix-refusal.png` and the refusal's full text `split-helix-refusal-words.png` / `.txt`; they are kept as the record that found #761. **#761 fixed the door**: the panel now offers a rod (⌀20 prefilled from the file's own ROTARY record) and sweeps piece A on the column engine — the real turning and Unroll screens are under `docs/bench/img/2026-10-29-761-sim-rotary/`, recorded in `docs/bench/761-sim-rotary-open.md`.

The split-helix acceptance itself is **simulated, not runnable today**: `casemaker-app/tests/unit/splitHelixColumn.spec.ts` sweeps both halves on the column engine and checks the removed volume, the complement and the mating band against an analytic oracle. A cut that reaches the axis exactly is refused by the verifier's R8 rule, and the rotary rules keep every Y at 0, so a flat end mill cannot run its side on the split face. A bounded below-axis allowance is a design decision on #753; the spec pins those two refusals (and the ball/V micro-finish and 3D-relief refusals) in their exact words.

## Second set (first run, 2026-10-28, later the same day)

Seven more jobs, from sources that publish the finished part and something real to build from:
- **CutRocket** (Carbide 3D's project site): the maker's own Carbide Create `.c2d` design file.
- **Makerables** (Makera's project library): the maker's stated sizes, artwork or photos.

They cover categories the first set did not: a Z1 accuracy sample in aluminium, a hardwood tray with a raised letter, an epoxy-inlay coaster, a compartment tray, a two-colour laminate sign, and two aluminium bike tools.

- Main **9538601f** (#744 landed afterwards, at 3cce07a2), `casemaker cut <job> --json --location <bench location>`.
- **Location:** the desktop app's `location.json`, with each owned cutter's Makera match confirmed as an operator would in Manage → Tools (#732), and the synced `catalogue.json` beside it. `tools/set2/bench_location.py` rebuilds it, and its table lists every owned cutter → Makera id.
- **Wood:** the three wood jobs (spoon rest, coaster, tray) are cut in PLA, as in set 1, because this shop cuts printed plastics, not wood. Their refusals were the same in hardwood.
- **Verdicts:** 0 match the photo, 4 partly, 3 fail. `manifest.json` → `set2` holds each card's verdict, sentence, runs and issues.

| Verdict | Jobs |
|---|---|
| Partly | j19 accuracy sample (raised text pitted; one job refused, #746), j22 snack tray (flat floors, no roundover), j23 laminate sign (one job refused, #746; tabs refused on the traced outline, #736), j25 truing wrench (one job refused, #746) |
| Fails | j20 spoon rest (tab read as a loose piece, #750; frame outside the machine, #747), j21 coaster (frame, #747; V-carve judged from the top face, #748; the whole job ran >15 min), j24 spoke wrench (the cut-out crashes the command, #749; one job refused, #746) |

**Issues filed:** #746 (a later cutter can only rest-machine), #747 (frame file outside the envelope blocks a verified program), #748 (engraving on a pocket floor judged from the top face), #749 (wasm crash on a disc cut-out), #750 (a tab reported as a loose piece). A comment on #736 adds tabs on traced straight sides.

### Inputs not in the repository (set 2)

These jobs' files are not committed: their sources' licence is unstated or forbids modified copies. Rebuild them with `tools/set2/jobs3.py`, after placing the downloads where it expects them:
- **j20 spoon rest:** `https://cutrocket.com/api/project/4htqf68iz0lle/download/4htqf68iz0lle_Personalized-Spoon-Rest.c2d`, read with `tools/set2/c2d.py` into `x/4htqf68iz0lle/`.
- **j21 coaster:** `https://cutrocket.com/api/project/qljwa0rs3485g/download/qljwa0rs3485g_Coaster-with-initial-and-script-name.c2d`, read into `x/qljwa0rs3485g/`. The first coaster (x < 130 mm) is the one used.
- **j23 sign:** the maker's artwork, `https://cdn.makerables.com/cdn-cgi/image/format=auto/projects/gallery/blue_shell_sign-mqwrjwus.png` (CC BY-NC-ND 4.0). Ink = pixels with R+G+B < 200, outline = pixels with min channel < 230, written as RGBA and traced by `tools/set2/bench-import-outline.mts` (the app's `traceRaster`) at 110 mm wide.

### Fixtures (set 2)

- #746: j19-accuracy-sample, j24-spoke-wrench, j25-truing-wrench (the `-a/-b/-c/-z` files are the hand split that generates)
- #747: fx-frame-pocket
- #748: j24-spoke-wrench-c (after -a)
- #749: j24-spoke-wrench-z
- #750: fx-hex-svg-import (from `hex-cw.svg` through the app's SVG importer), fx-hexv (passes)

### Not run (set 2)

- **Elephant puzzle (Makerables):** it is carved as well as cut; its files need a login, and the photo cannot be traced faithfully.
- **Nordic iceberg, Morgan coin and Wild Spirit (Makerables):** 3D reliefs whose model files need a login.
- **Box hinges (CutRocket):** a Carbide Create 3D component, which cannot be read here.
- **Morakniv template (CutRocket):** an open knife outline, not a region.
- **Nomad wasteboard and table (CutRocket):** bigger than the Z1's bed, and shown only as renders.
- **Gear, stencil, clock face, ruler, Eurorack panel, phone stand, two-sided part, rotary pawn:** no source had both a photo of the finished part and inputs that could be obtained.

The "after" pictures use `tools/set2/render.py` (v2's sweep, plus a two-colour laminate). Each program of a split job is swept in order onto the same stock.

## 2026-10-29 v5 re-run: the app chooses every cutter

The page (version 5) re-runs the set on main 9fcda93e with **no cutter named in any job**, so `casemaker cut` picks from the house tools plus Makera's full catalogue (#760's CLI path). The maintainer's question that started it: "why is the text in some of those demos not clear, are we selecting the wrong tool". The last page had pinned every cutter by hand. Results and fixes: #762 (cutters by item kind), #760 (raised text by its gaps), #765 (the coin's 3.6 mm "Software": the app says no cutter fits, a 0.6 mm corn reads), #766 (smart tool selection by simulated outcome — the top priority), #764 (a 3D goal item ends in a pit), #768 (an empty rest cutter crashes the command).

New job files: `jobs/j04-coin-disc-faithful.json` (the proxy coin's items on a ⌀30 × 3 disc, #743), `jobs/j04-coin-disc-rest06.json` (the same with a 0.6 mm corn as the rest cutter, chosen by hand to test the app's claim), and `jobs/j27-mouse-shell-side1.json` (side 1 of the #754 shell as a goal mesh, generated from the test's closed form). The split-helix column's programs are `jobs/j26-split-helix-A.nc` / `-B.nc` (#753).
