# Tool organizer — the standard render set at `5b73a6bb` (the #974 rim fix re-taken on v5)

- **Run:** `/tmp/e966-tip.sh 5b73a6bb` — the real STEP, Makera catalogue, vise; the pair's
  acceptance 664.18 s. Mesh 45,544 triangles; five programs over four cutters.
- **Scored lines:** coverage **98.6111 %**; cut-into **0.00008 % adjudicated** (2 cells, 0.1098 mm,
  the v5 boundary); raw **3.6740 %**: edge break **3.6698 %**, wall 0.0009 %, **shadow 0**; raw max
  3.000 mm at (26.5, 143.5). Cycle 28,497.6 s; air 65.4 %; rapids 8,457 / 41.75 per 1,000.
- **Leftover:** 36,000 cells > 0.1 mm; 5,125 > 10 mm; max 22.000 at (15.1, 31.6) — wall sample.
- **The tip's story:** the #974 mouth-rim fix under v5. The newly closed rims give the chamfer a
  rim to break: **edge break 1.9083 → 3.6698 %** (raw 1.9154 → 3.6740 %) against `91e2618f`, cycle
  28,140.1 → 28,497.6 s (+358 s). Adjudicated stays at the two 0.1098 mm cells and **shadow 0**.
- **Physical check:** `01` edge break on every rim (the round pockets, the square slots, the
  labels); no red cell, no shadow band; `04` the two adjudicated cells remain 0.11 mm on the land;
  `05` floors at −22.8; `06`/`07` unchanged in structure.

**Verdict: physically clean; the rim fix adds correct edge break.**
