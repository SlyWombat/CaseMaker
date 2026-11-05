# Elephant — #970 verdict set at `origin/966-collapse` `a447d4f8`

- **Sha:** a447d4f8 — the over-clip fix on the rotary tip-field extraction (94c2e920), 965-int,
  reg-ambiguity and manifold-node. Run: `figureAcceptance965`, real mesh `lfs_elephant.stl`
  (**124,874 triangles**, the planning mesh), goal grid 362 × 767, stock 36 × 100 × 36; programs
  flat-6, flat-3.175, ball-2, flat-6.
- **#970 target — the overhang signature: MET.** 79 cells = **0.8 mm² raw; 0 cells = 0.0 mm²
  adjudicated** (0ef7c0e5: 95 cells / 1.0 mm² raw, 0.0 adjudicated; before the fix: 441.5 / 70.0).
  Section `z-section-x18-after.png`: at (18.0, 43.7) the swept floor is **−2.266** against the goal
  **−2.264**, following the mesh top; no cut-through.
- **The figure card's own cut-into at this sha — a new class, flagged for A:** **3.91 %
  adjudicated** (raw 5.10 %, wall 0.42 %, shadow 0.61 %, max 13.01 mm) against **0.00 %**
  (raw 0.50 %) at `0ef7c0e5`. The 01 map shows it: two elongated red bands on the body's flanks,
  owned by the flat-6 pocket program, plus pink raw cells along the outline — cells the sweep now
  takes >0.1 mm below the goal, on the same swept surface that leaves the leftover unchanged
  (25,695 cells, 13 > 10 mm, identical to `0ef7c0e5`). Not the overhang bug; a new cut-into class
  on this branch.
- **Coverage:** 83.63 % (identical to `0ef7c0e5`); the figure spec's ≥95 % coverage assertion
  fails, as it did there.

One line per picture: `01` the two flank bands (flat-6) are the 3.91 % adjudicated; the silhouette
band is wall/shadow. `02` leftover at the outline and wall steps; the old through-body pocket is
gone. `03` four programs, ball-2 panels on the surface. `04`/`05` sections at the worst raw
cut-into (13.01 mm, a wall step) and leftover cells. `06` the swept stock follows the top surface.
`07` the feature tree.
