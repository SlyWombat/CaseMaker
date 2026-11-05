# Tool organizer — the standard render set at `1fba811a` (full tour stack: region tour + skin corners)

- **Run:** `/tmp/e966-tip.sh 1fba811a` — acceptance 18 passed / 2 skipped, **406.11 s** pair.
  Mesh 45,544 triangles; five programs over four cutters.
- **Scored lines:** coverage **98.6112 %**; cut-into **0.00031 % adjudicated** — **8 cells, max
  0.1771 mm, median 0.1498** (all 8 above 0.1, none above 0.5); raw 3.6788 % (edge break 3.6695 %,
  wall 0.0023 %, **shadow 0**); raw max 3.000 mm. Raw-only class 173 cells ≤ 0.079 mm. Cycle
  **9,904.7 s** (16,113.7 at `a79bab6b`, **−6,209 s, −38.5 %**); air **7.5 %** (41.5); rapids
  **776** (2,760).
- **Leftover:** 35,998 cells > 0.1 mm (2 fewer than `a79bab6b`); 5,125 > 10 mm; max 22.000 at
  (15.1, 31.6) — wall sample.
- **The stack:** the region tour plus the corrected corner read. The two cells the prior tip
  covered are now cut; the adjudicated class is 8 cells at ≤ 0.177 mm (the v5 boundary cells),
  still 0.00 % at the card's precision.

**Physical check:** edge break band on every rim, the 8 boundary cells at 0.11–0.18 mm, no shadow
band, floors at −22.8. Nothing stops the merge.
