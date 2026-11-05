# Tool organizer — render set at `cand/engine-int-merge` `389ed57e`

- **Run:** `acceptance-run.sh 389ed57e tests/unit/opsAcceptance959.spec.ts` with
  `CM_CATALOGUE=~/casemaker-manager/demo-build/catalogue.json` and
  `CM_MAKERABLES=<repo>/.scratch/makerables` — the real STEP part, the catalogue installed,
  16 passed / 2 skipped, 367 s. Worktree at `108f096b` (389ed57e + F's picture tool `d46f76b0`).
  Log: `~/casemaker-manager/955-958-masks/logs/opsAcceptance959.spec-389ed57e.log`.
- **Mesh source (as printed by the renderer):** `Tool_Organizer_Z1-msfh3m77.step`,
  **45,544 triangles** — the planning mesh the plan was made on; goal grid 1611 × 1611 at 0.1 mm;
  stock 170 × 170 × 26.8; five posted programs: flat-6 · flat-3.175 · ball-6 · chamfer-90 ·
  flat-6 (freeing contour).
- **Scored lines at this sha (posted facts):** coverage **98.61 %** (vendor 98.98 %, passes);
  cut-into **0.04 %** adjudicated (1,080 cells; raw 3.68 %, edge break 3.59 %, wall 0.00 %,
  shadow 0.04 %), raw max 3.000 mm at (26.5, 143.5). The 0.04 % is the chamfer's 0.500 mm at rim
  cells the edge band does not reach — on the planning mesh; the page's STL-derived goal reads
  0.14 % for the same program, and that gap is mesh-source.

One line per picture, including what looks physically notable:

- `01-cut-into-top` — the 1,080 adjudicated cells are the chamfer's 0.5 mm cuts at pocket rims
  (a few red dots at the small upper-edge pockets); everything else raw is the edge-break band
  (blue). The purple strip upper-left is the 0.04 % wall shadow along the rim.
- `02-leftover-top` — 36,000 cells (1.39 %) > 0.1 mm; 5,125 cells (51.3 mm²) > 10 mm, all of them
  the one-cell band along the rims of the deep pockets; max 22.000 mm at (15.1, 31.6), where the
  goal sample is the deep row's floor (−22.8) and the sweep is the rim top (−0.8). The floors
  themselves are cut — `05` shows the sweep on every floor — so this is the wall-sample class,
  not uncut pockets.
- `03-toolpaths` — our five programs beside the vendor's T1–T5 at one scale. Our ball-6 finishes
  the whole part shallow; the vendor's T2/T5 carry the pocket rims and the bottom row of square
  slots. Physically the two programs distribute the work differently but both reach the floors.
- `04-section-worst-cut-into` — the worst adjudicated cell (59.6, 122.1, 0.500 mm) is the chamfer
  at a rim; the section shows only the 0.5 mm dip and the sweep coincident with the goal elsewhere.
- `05-section-worst-leftover` — the section across the deep square row shows every floor cut to
  −22.8 with the sweep following; the 22 mm is the rim cell above, not a standing island.
- `06-simulated-stock` — union top −0.800 mm, bottom −22.800 mm; the four central rectangles stand
  at −3.8/−5.8 (the shallow pocket and its three round children) surrounded by the deeper rows —
  matches the tree's levels.
- `07-feature-tree` — 58 pockets and 7 remainder regions: the deep −22.80 row and the −1.40
  engraved labels are both visible; pockets carry their children (the four large regions contain
  the round −5.80 pockets); contour frees to −26.80.
