# Tool organizer — the standard render set at `91a9ba3a` (the 966-collapse landing tip)

- **Run:** `/tmp/e966-tip.sh 91a9ba3a` — `opsAcceptance959.spec.ts`, the real STEP part, the Makera
  catalogue installed, the #943 vise holding; 18 passed / 2 skipped, **736.82 s** for the pair.
- **Mesh source (as printed by the renderer):** `Tool_Organizer_Z1-msfh3m77.step`, **45,544
  triangles** — the planning mesh; goal grid 1611 × 1611 at 0.1 mm; stock 170 × 170 × 26.8; five
  posted programs over four cutters: flat-6 · flat-3.175 (the #961 **coverage rest**) · ball-6 ·
  chamfer-90 · flat-6 (freeing contour).
- **Scored lines at this sha (posted facts):** coverage **98.6111 %** (vendor 98.98 %, passes);
  cut-into **0.00 % adjudicated** (raw 1.9154 %: edge break 1.9083 %, wall 0.0027 %, shadow
  0.0044 % = 114 cells, max 0.110 mm — the #970 wall-shadow class, three orders below the 8.11 %
  the reverted #974 branch carried), raw max 3.000 mm at (26.5, 143.5). Cycle posted
  **28,140.1 s**; air 66.1 %; rapids 8,441 moves, 41.95 per 1,000 feed lines; cutters ball-6,
  flat-6, flat-3.175, chamfer-90. The cycle is the same regime as `597d4824` (28,475.2 s) — the
  standing air/rapids/cycle-ratio failures F's table already carries (#962 territory), not a
  regression in this tip.
- **Leftover:** 36,000 cells (1.39 % of 2,595,321) stand > 0.1 mm; 5,125 cells (51.3 mm²) > 10 mm,
  all the one-cell band along the rims of the deep pockets; max 22.000 mm at (15.1, 31.6), where
  the goal sample is the deep row's floor (−22.8) and the sweep is the rim top (−0.8).

One line per picture, including what looks physically notable:

- `01-cut-into-top` — every raw cell is the chamfer's edge-break band (blue) on the pocket rims
  and the round pockets' rims; the only non-blue specks are 70 wall cells and 114 shadow cells
  (below the 0.1 mm floor). No red adjudicated cell anywhere.
- `02-leftover-top` — the 36,000 cells are the one-cell rim bands and the numerals' rims; every
  pocket floor reads pale (cut).
- `03-toolpaths` — our five programs beside the vendor's T1–T5 at one scale. The ball-6 finishes
  the whole part shallow; the flat-6 and flat-3.175 carry the deep rows; the vendor distributes
  the same work across T1–T5. Distribution differs, coverage does not; no rapid below the stock
  top.
- `04-section-worst-cut-into` — at (26.5, 143.5) the section crosses the square-slot row's wall:
  goal and sweep coincide on every floor, and the 3.000 mm is the wall cell, not a dip into the
  part.
- `05-section-worst-leftover` — the section across the deep row shows every floor cut to −22.8;
  the 22.000 mm is the rim cell above, not a standing island.
- `06-simulated-stock` — union top −0.800 mm, bottom −22.800 mm; the deep −22.8 row, the −5.8
  round pockets and the shallow −3.8/−1.4 levels all match the tree; the engraved labels are
  visible at their depth.
- `07-feature-tree` — 58 pockets and 7 remainder regions; the four large regions contain the round
  −5.80 children; the deep row and the −1.40 labels are both present; contour frees to −26.80.

**Physical verdict: no picture stops the merge** — adjudicated cut-into 0.00 % with only the
V's 0.5 mm edge-break leg, floors cut to the goal in every section, and the leftover map is the
wall-sample class.
