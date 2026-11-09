# The goal check — the gate's rule, as proofs (v4 → v8)

*Design record, 2026-11-09, written by the review session from the rulings on #948, #964, #970, #996,
#1064, #1086, #1092, #1112 and #1113. The code is `src/engine/cnc/engrave/designCheck.ts` (flat) and
`src/workers/sim/goalCheckRotary.ts` (rotary); the version ladder is `src/workers/geometry/simVersion.ts`
(`SIMULATOR_VERSION`), and each version's fingerprint is pinned in `tests/unit/goalRuleFreeze948.spec.ts`.
v8 is ruled and landing in land14 (branch `gate-v8-relief`); where this page says v8 it says so.*

---

## 0. What the gate judges, in one paragraph

A posted program is **stamped** onto the goal's heightfield — the design sampled at 0.1 mm as a top-Z per
cell (flat) or a radius per (x, θ) (rotary) — and every covered cell reads a difference
`d = swept − design`: positive is material **standing** above the design, negative is **cut into** it.
The page prints two readings side by side and never hides one behind the other:

- the **raw** reading: the share of covered cells cut deeper than `GOAL_CUT_INTO_FLOOR_MM` (0.01) and the
  deepest cell with its position;
- the **adjudicated** reading: the same, after the cells a heightfield cannot judge have been **excused on
  proof** (§2), with every excused class counted and printed beside the verdict.

Coverage is `1 − (share standing more than 0.1 mm above the design)`; the leftover bands are
`GOAL_LEFTOVER_BANDS_MM = [0.1, 0.3, 1]`; the pass line is the shop's, `GOAL_PASS_COVERAGE_FALLBACK = 0.95`
when the shop states none. A cell counts as cut into for the verdict only beyond `ADJUDICATED_FLOOR_MM`
(0.1) after the excuses; the raw floor stays at 0.01 so the page can show what the verdict forgave.

**The one-oracle rule (#1092 R3).** The app's receipt goal block is the verdict. The card tool's python
stamp (`goal_check.py`) is a diagnostic: it treats the boundary cell differently (centre-in-disc against
the app's nearest-point stencil) and must never be quoted as the number. The vendor branch — Makera's own
NC scored against a goal, where no receipt exists — implements the identical proofs and carries a parity
test against the app on the tray and j29 fixtures.

## 1. The version ladder

| v | issue | what changed in the verdict |
|---|---|---|
| 1 | #925 | the version exists; a frozen package goes stale when the simulator changes |
| 2 | #947, #924 | boundary slivers opened before counting; the design check folded into `ok` |
| 3 | #948, #924 | cut-into judged on the page's own stamp; the raw outline judged at the cutter's radius at every level |
| 4 | #948 §8.6 | the rule frozen for Milestone 2: the part's silhouette is a design edge; the edge-break leg is inclusive; wall cells and the wall shadow excluded on every goal job; the raw reading printed beside the judged one; the V gate (stated 0.1 mm tip, the per-cell `who` map, edge break only where the V is the deepest cutter) |
| 5 | #970 | **the wall-shadow cell is excused only when the stamp proves it is a disc artefact** — the V cut it within its leg, or the deepest cutter's own CL point stays ≥ shadow radius − pitch from the wall; a CL driven into a wall's base (the tray's V at (19.800, 12.050, −4.692), 3.49 mm into the land) is adjudicated. The stamp carries the per-cell CL (`StampedTop.clX/clY`), read through `clAt` |
| 6 | #996 | **the straddling-cell excuse, on proof** — a cell on a vertical step is excused when the step over the cell (centre + four axial neighbours) is at least the read intrusion and the swept floor is within `STRADDLING_SLACK_MM` (0.005) of the design's low side; counted and printed, never silent; a one-cell gouge on flat ground (step 0) can never qualify |
| 7 | #1064 | **the edge-break band seeds only from the edges the job named** — `edges: 'silhouette' | 'all'`, default the part's own outline |
| 8 | #1092 (landing) | **every excuse is a proof bounded by the goal's own relief**; wall and border cells lose their unconditional excuse; the silhouette gets its own proof; the band seeds from the design silhouette as well as the grid border; fallbacks speak (§2.6) |

A version is bumped in the same commit as any change that can move a verdict, and the cards are re-scored
in that commit. v8 re-grades j29 from 18.03 % to an honest 25.79 % (11,825 class-excused cells now counted)
and leaves set B's verdicts unchanged.

## 2. The excuses, as proofs (v8)

Every cell cut deeper than the floor goes through the ladder below, in order; the first proof that holds
excuses it, and each excused class is counted and printed. A cell that holds no proof is **adjudicated**.

### 2.1 Edge break (the stated chamfer)

A job may state an edge break: the V bit's tool number, its reach and its leg. The band is the stated
edges dilated by the reach; the stated edges are the **design silhouette ∪ the grid border** (v8; v7 read
the grid border alone, which equals the part's outline only when the goal grid ends at the model — a goal
with a margin had no band at all, #1092 R-b) plus every interior wall when the job says `edges: 'all'`.
A cell in the band is excused when its depth is within the leg **and** the deepest cutter at that cell is
the stated V (`whoAt`). Through-hole rims are inner silhouettes and seed the band (ruled at the v8 freeze).

### 2.2 The relief bound (v8, R1)

A heightfield mis-reads a cutter beside a wall by **at most the wall's own height**. So no excuse may
forgive a cut deeper than the goal's local relief: `depth ≤ relief(k) + STRADDLING_SLACK_MM`, where
`relief(k)` is `max − min` of the goal's z over the sampled cells within the **shadow radius** (the largest
cutting tool's radius) of the cell. Where that disc reaches uncovered or off-grid cells the part's side face
is inside it, and the relief's high side is the stock top and its low side the floor beside the part
(§2.3). A constant depth cap was refused: 2 mm would count real artefacts at 20 mm walls, 20 mm would still
hide a 19 mm gouge at a 1 mm step.

### 2.3 The silhouette (v8, addendum)

A covered cell whose axial neighbour is uncovered grid is the part's own side face. Its step runs from the
stock top to the **legitimate floor beside the part**: `−T`, or `−(T + breakthrough)` where the verifier's
through rule allows a cut into the board there. It is excused only when **both** hold: the depth is within
that step (+ slack) **and** the deepest stamp's CL at the cell lies on the **uncovered side** of the outline,
at least `r − pitch` from it. Depth alone cannot tell a lateral cut into the part's side from the contour's
flank artefact; the CL can. A CL one radius inside the outline at full depth is a cut-in and counts. The
check needs the stock thickness for this proof (`stockThicknessMm`, `breakthroughMm`); when a job states
no edge break those fields still travel (the early return that dropped them was fixed post-freeze).

### 2.4 Wall and border cells → the straddling proof

v4–v7 excused a cell straddling a design step (> 0.2 mm to a neighbour) unconditionally. v8 sends it through
the v6 straddling proof — the step over the cell at least the read intrusion, the swept floor within the
slack of the design's low side — with the relief bound as the ceiling. A 20 mm cut at a cell on a 1.36 mm
step is counted (j29's blocks); a 2.448 mm cut on a 2 mm wall is counted (#1113's fixture, by construction).

### 2.5 The wall shadow (v5 + v8)

A cell within the shadow radius of a design wall is excused on the v5 proof — the V cut it within its leg,
or the deepest cutter's CL stays ≥ `r − pitch` from the wall — **and** within the relief bound. A shadow
cell that fails v5 still falls through to the straddling proof (v6); a silhouette cell that fails its CL
test falls through the same way (#1112: the open notch's wall cell whose deepest stamp is legitimately the
pocket's own pass).

### 2.6 Fallbacks speak

A proof that cannot run says so on the page: "silhouette proof unavailable — stock thickness not stated;
N rim cells counted"; a rest region refused for budget is a stated finding (`rest-region-over-budget`),
never a silently thinner plan. A verdict that passes never excuses a silent refusal (land14: coverage 98.80 %
hid a plan that had dropped a cutter).

## 3. What is printed beside the verdict

`cutIntoFraction` / `maxCutIntoMm` / `maxCutIntoAt` (raw); `adjudicatedFraction` / `adjudicatedMaxMm`;
`edgeBreakFraction`; `wallNotScoredFraction`; `shadowNotScoredFraction`; `straddlingNotScoredCells` and
`straddlingMaxStepMm`; v8 adds `silhouetteExcusedCells` with the deepest excused silhouette cell and its CL
distance, `wall/shadow/borderOverReliefCells` with the deepest such cell, and `silhouetteUnavailableCells`
when the thickness is missing. The rotary check prints the column read beside the stamp (#1086).

## 4. The pin rule

A spec pins a **class, not a number**: every counted cell belongs to a named class that is either a real
deviation (the number stays and says why) or a proof gap (fixed first). "8.32 %" and "0.0128 %" on the v8
branch were both gaps — a harness call that omitted the thickness, and the band seeding from the grid
border — and were never pinned (#1092, the dump at `/mnt/house/casemaker/v8-tray-gated/`). A new red from a
gate change is dumped per cell (class path, depth, `who`, CL, nearest wall) before anyone calls it a CAM
defect: #1112's "contour inside the silhouette" was the notch pocket's own pass; #1113's "0.448 mm over-cut"
was a number typed into a fixture.

## 5. Lessons the record keeps

- **Attribution:** the CL beside a depth must come from the same stamp that set the depth (the vendor tray's
  254 "cut-in" cells were a ⌀3.175 pass's CL attributed to a ⌀6-cut cell).
- **Harness wiring hides behind rule-shaped numbers:** an omitted argument and a silent fallback cost a day.
- **A hypothesis from area arithmetic is a thing to test:** the disc-radius hypothesis for the 8.32 % was
  refuted by the dump (3.0 mm on every row), which is how it should go.
- **Verdicts never excuse silence** (§2.6).

## Status

v5–v7 landed and frozen; v8 ruled 2026-11-08/09 on #1092 and signed off at `gate-v8-relief ee722ceb1`
(k3 879/0), landing in land14 with the post-freeze wiring fix (the early return carries the blank fields)
and the band seed. This page is updated with the version ladder; a change to a proof is a version bump,
a re-pin and a line here, in one commit.
