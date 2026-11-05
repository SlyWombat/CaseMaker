# Tool organizer — the standard render set at `91e2618f` (the v5 gate on the 966-collapse tip)

- **Run:** `/tmp/e966-tip.sh 91e2618f` — the real STEP, the Makera catalogue, the #943 vise; the
  pair's acceptance 634.56 s (see the tray README). Mesh: `Tool_Organizer_Z1-msfh3m77.step`,
  45,544 triangles; goal grid 1611 × 1611 at 0.1 mm; stock 170 × 170 × 26.8; five programs over
  four cutters (flat-6 · flat-3.175 coverage rest · ball-6 · chamfer-90 · flat-6 contour).
- **Scored lines (posted facts):** coverage **98.6111 %**; cut-into **0.00008 % adjudicated** —
  **2 cells, both 0.1098 mm**, at the v5 boundary (raw 1.9154 %: edge break 1.9083 %, wall
  0.0027 %, **shadow 0**); raw max 3.000 mm at (26.5, 143.5). Cycle 28,140.1 s; air 66.1 %;
  rapids 8,441 / 41.95 per 1,000.
- **The v5 delta, which is the point of this set:** under v4 these two cells sat inside a
  **114-cell wall-shadow class** excused wholesale. v5 excuses a shadow cell only on the rule's
  proof; with no CL stated for this measurement the conservative side applies, so **shadow 0**:
  **2 cells are adjudicated at 0.1098 mm** (0.00008 %) and the other **112 are raw-only, ≤ 0.063 mm**
  (`class-depth.json`: rawOnly 112, max 0.063, median 0.019). The rest of the line is unchanged
  from `91a9ba3a` (the plan is the same; only the gate moved).
- **Leftover:** 36,000 cells > 0.1 mm; 5,125 > 10 mm; max 22.000 at (15.1, 31.6) — wall sample.

Picture notes:

- `01-cut-into-top` — edge break only (blue); no purple shadow band remains; the two adjudicated
  cells are 0.11 mm and do not read at this scale (legend: adjudicated 0.00 %).
- `02-leftover-top` — the rim bands and numeral rims; floors pale.
- `03-toolpaths` / `06-simulated-stock` / `07-feature-tree` — unchanged from `91a9ba3a`.
- `04-section-worst-cut-into` — the worst **adjudicated** cell is now (26.5, 91.7, 0.110 mm): the
  section shows a 0.11 mm dip on the land — the wall-shadow boundary the v4 class used to hide.
- `05-section-worst-leftover` — floors at −22.8; the 22.000 mm is the rim cell above.

**Physical verdict: nothing stops the merge; v5 turns a hidden 114-cell shadow class into 2
judged cells at a tenth of a millimetre plus 112 sub-0.1 raw cells.**
