# Panther — v4 render set at `0ef7c0e5` (f5ce99cb + the corrected #970 fix)

- **Run:** `figureAcceptance965` at 0ef7c0e5, real mesh `nude_pantherv2-final.stl` (**163,088
  triangles**), goal grid 362 × 629 at 0.1 mm, stock 36 × 100 × 36; programs ball-2 and flat-6.
  The spec's coverage assertion **fails**.
- **Card (v4):** coverage **73.20 %** (73.17 at `4611ebb2`); cut-into **0.00 % adjudicated**
  (0.00 before; max 0.032 mm); raw 0.01 %; shadow 0.01 %; cycle 8.3 h stated; air 65.85 %;
  rapids 424/1k; cutters 2; holding **vise**, 47.9 mm proud.
- **Leftover (renderer):** 22,863 cells > 0.1 mm (228.6 mm²); 243 cells > 10 mm (2.4 mm²), max
  18.00 mm at (3.0, 18.6) — a rim/step cell.

One line per picture: `01` no adjudicated cut-into. `02` leftover along the silhouette and the
steep flanks (the reach-limited areas); 243 cells > 10 mm at steps. `03` the ball-2 and flat-6
panels. `04`/`05` sections at the worst cells. `06` simulated stock over the model top. `07` the
feature tree.
