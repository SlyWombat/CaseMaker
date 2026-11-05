# Tool tray 70 — render set at `cand/engine-int-merge` `389ed57e`

- **Run:** `acceptance-run.sh 389ed57e tests/unit/opsAcceptance959.spec.ts` with
  `CM_CATALOGUE=~/casemaker-manager/demo-build/catalogue.json` and
  `CM_MAKERABLES=<repo>/.scratch/makerables` — the real STEP part, the catalogue installed,
  16 passed / 2 skipped, 367 s. Worktree at `108f096b` (389ed57e + F's picture tool `d46f76b0`).
  Log: `~/casemaker-manager/955-958-masks/logs/opsAcceptance959.spec-389ed57e.log`.
- **Mesh source (as printed by the renderer):** `70mm_Tool_Tray-msgtf7oi.step`, **13,208 triangles**
  — the planning mesh the plan was made on; goal grid 1061 × 1361 at 0.1 mm; stock
  110 × 140 × 27.2; four posted programs: flat-6 · ball-6 · chamfer-90 · flat-6 (freeing contour).
- **Scored lines at this sha (posted facts):** coverage **98.37 %** (vendor 99.52 %; the card's one
  line that fails, by 1.15 points against a 1-point allowance); cut-into **0.00 %** adjudicated
  (raw 3.88 %, edge break 3.88 %, wall 0.00 %, shadow 0.00 %), raw max 3.000 mm at (9.0, 5.0).

One line per picture, including what looks physically notable:

- `01-cut-into-top` — nothing red: every raw cell is the chamfer's edge-break band (blue) around
  the pocket rims; no gouge survives the exclusions. The engraving numerals are visible in the
  hillshade but are not cut-into.
- `02-leftover-top` — 23,488 cells (1.63 % of the covered area) stand > 0.1 mm above the goal;
  max 6.000 mm at (20.4, 12.6), a single cell where the goal sample is a slot floor (−7.2) and the
  sweep is the slot's ridge (−1.2) — a wall-straddling sample, not standing material; **no cell is
  > 10 mm**. The blue bars at the slot ends are the same one-cell class along the end walls.
- `03-toolpaths` — our four programs (top row and middle) beside the vendor's T1–T4 at one scale.
  Our flat-6 raster matches the vendor T1's coverage; our ball-6's central strip is the same shape
  as the vendor T3's; the contour panel's long diagonals are link moves, not cuts. No rapid is
  drawn below the stock top.
- `04-section-worst-cut-into` — the worst raw cell (9.0, 5.0, 3.000 mm) is a wall cell on the
  part's silhouette; the section runs along the edge and shows the contour passing at full depth.
  Physically a freed edge, not a gouge into the part — correctly excluded as wall.
- `05-section-worst-leftover` — the section across the six slots shows the sweep following every
  floor; the 6 mm leftover is the single wall cell above, and the floors themselves are cut.
- `06-simulated-stock` — union top −1.200 mm, bottom −7.200 mm (the six slot floors), matching the
  tree's −7.20 level; the slots read as six flat-bottomed pockets, as the model has them.
- `07-feature-tree` — 7 pockets and 14 remainder regions; the six slots are children (floor −7.20)
  of the −4.20 substrate, and the red numerals are the rims of the engraved 1–6 on the slot floors;
  contour frees to −27.20.
