# Panther — #970 verdict set at `origin/966-collapse` `a447d4f8`

- **Sha:** a447d4f8. Run: `figureAcceptance965`, real mesh `nude_pantherv2-final.stl` (**163,088
  triangles**), goal grid 362 × 629, stock 36 × 100 × 36; programs ball-2 and flat-6.
- **Overhang signature: 0 cells = 0.0 mm²** (unchanged). Cut-into **0.00 % adjudicated** (raw
  0.01 %, shadow 0.01 %, max 0.032 mm); coverage **73.20 %** (unchanged since `4611ebb2`); the
  spec's ≥95 % coverage assertion fails, as before.
- **Leftover:** 22,863 cells > 0.1 mm, 243 cells > 10 mm (max 18.00 mm at (3.0, 18.6)) — the
  same cells as `0ef7c0e5`, unchanged.

One line per picture: `01` no adjudicated cut-into. `02` leftover along the silhouette and the
steep flanks (the reach-limited areas). `03` the ball-2 and flat-6 panels. `04`/`05` sections at
the worst cells. `06` the swept stock; `07` the feature tree.
