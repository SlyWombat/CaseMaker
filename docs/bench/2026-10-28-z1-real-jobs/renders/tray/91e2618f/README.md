# Tool tray — the standard render set at `91e2618f` (the v5 gate on the 966-collapse tip)

- **Run:** `/tmp/e966-tip.sh 91e2618f` — `opsAcceptance959.spec.ts`, the real STEP, the Makera
  catalogue installed, the #943 vise; **18 passed / 2 skipped, 634.56 s** for the pair (the pair
  read 736.8 s at `91a9ba3a`; the v5 commit measured 718.5 s on its own box — 0.86×, no flag).
- **Mesh source:** `70mm_Tool_Tray-msgtf7oi.step`, 13,208 triangles; goal grid 1061 × 1361 at
  0.1 mm; stock 110 × 140 × 27.2; five posted programs over four cutters (flat-6 · flat-3.175 the
  coverage rest · ball-6 · chamfer-90 · flat-6 freeing contour).
- **Scored lines (posted facts):** coverage **99.3442 %**; cut-into **0.00 % adjudicated** (raw
  1.6977 %: edge break 1.6376 %, wall 0.0602 %, **shadow 0**); raw max 6.000 mm at (21.3, 25.0).
  Cycle 4,959.7 s; air 30.5 %; rapids 2,206 / 89.38 per 1,000.
- **Leftover:** 9,451 cells > 0.1 mm; none > 10 mm; max 6.000 at (19.8, 12.1) — wall sample.
- **v5 delta: none.** The tray has no shadow-band cut cells at this tip, so SIMULATOR_VERSION 5
  changes nothing on it (identical to the `91a9ba3a` set, line for line).

Picture notes (01/02/04/05 regenerate; 03/06/07 are the same plan as `91a9ba3a`):

- `01-cut-into-top` — all raw cells are the V's edge-break band; wall specks on the silhouette;
  no purple shadow band, nothing adjudicated.
- `02-leftover-top` — the one-cell rim bands and numeral rims; floors pale (cut).
- `03-toolpaths` / `06-simulated-stock` / `07-feature-tree` — unchanged from `91a9ba3a`: five
  programs beside the vendor's T1–T4, union top −1.200 / bottom −7.200, 7 pockets and 14
  remainder regions.
- `04-section-worst-cut-into` — the raw worst (21.3, 25.0) is a slot end wall, freed at full depth;
  no gouge.
- `05-section-worst-leftover` — every slot floor at −7.2; the 6.000 mm is the wall cell above.

**Physical verdict: nothing stops the merge; v5 is silent on this part.**
