# Tool tray 70 — the standard render set at `91a9ba3a` (the 966-collapse landing tip)

- **Run:** `/tmp/e966-tip.sh 91a9ba3a` — `opsAcceptance959.spec.ts`, the real STEP part, the Makera
  catalogue installed, the #943 vise holding; **18 passed / 2 skipped, 736.82 s** (the pair read
  549 s at `597d4824`; 1.34×, under the 3× flag).
- **Mesh source (as printed by the renderer):** `70mm_Tool_Tray-msgtf7oi.step`, **13,208
  triangles** — the planning mesh the plan was made on; goal grid 1061 × 1361 at 0.1 mm; stock
  110 × 140 × 27.2; five posted programs over four cutters: flat-6 · flat-3.175 (the #961
  **coverage rest**) · ball-6 · chamfer-90 · flat-6 (freeing contour).
- **Scored lines at this sha (posted facts):** coverage **99.3442 %** (vendor 99.52 %; passes the
  98.52 % line — this is the `cand/961-sequence` level, up from 98.3702 % at `597d4824`);
  cut-into **0.00 % adjudicated** (raw 1.6977 %: edge break 1.6376 %, wall 0.0602 %, shadow 0),
  raw max 6.000 mm at (21.3, 25.0). Cycle posted **4,959.7 s**; air 30.5 %; rapids 2,206 moves,
  89.38 per 1,000 feed lines; cutters flat-6, ball-6, flat-3.175, chamfer-90.
- **Leftover:** 9,451 cells (0.65 % of 1,444,021) stand > 0.1 mm above the goal; **none > 10 mm**;
  max 6.000 mm at (19.8, 12.1), where the goal sample is a slot floor (−7.2) and the sweep is the
  slot's ridge (−1.2) — a wall-straddling sample, not standing material.

One line per picture, including what looks physically notable:

- `01-cut-into-top` — nothing red: every raw cell is the chamfer's edge-break band (blue) around
  the pocket rims; wall cells are the grey specks on the silhouette; no shadow cells. No gouge.
- `02-leftover-top` — the 9,451 cells are the one-cell bands along the slot end walls and the
  engraved numerals' rims; the slot floors are cut and read pale (within the band).
- `03-toolpaths` — our five programs beside the vendor's T1–T4 at one scale. The flat-6 raster
  matches the vendor T1's footprint; the ball-6's central strip matches T3's; the chamfer panel is
  the V's rim pass; the contour's diagonals are links, not cuts. No rapid is drawn below the stock
  top.
- `04-section-worst-cut-into` — at (21.3, 25.0) the section runs along a slot end wall and shows
  the contour passing at full depth beside the 6.000 mm cell: a freed edge cell, correctly wall,
  not a gouge.
- `05-section-worst-leftover` — the section across the six slots shows the sweep following every
  floor to −7.2; the 6.000 mm at (19.8, 12.1) is the wall cell above, not a standing island.
- `06-simulated-stock` — union top −1.200 mm, bottom −7.200 mm (the six slot floors); the number
  column reads as the shallow −4.20 level the tree gives it; the slots are six flat-bottomed
  pockets, as the model has them.
- `07-feature-tree` — 7 pockets and 14 remainder regions; the six slots are children (floor
  −7.20) of the −4.20 substrate, the numerals are rims on the slot floors, contour frees to
  −27.20.

**Physical verdict: no picture stops the merge** — coverage up, adjudicated cut-into 0.00 %,
the leftover map only wall samples, and the sections show swept floors coincident with the goal.
