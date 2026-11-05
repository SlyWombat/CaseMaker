# Elephant — v4 render set at `0ef7c0e5` (f5ce99cb + the corrected #970 fix)

- **Run:** `figureAcceptance965` at 0ef7c0e5 (worktree merge-970b), real mesh `lfs_elephant.stl`
  (**124,874 triangles**, the planning mesh), goal grid 362 × 767 at 0.1 mm, stock 36 × 100 × 36;
  programs flat-6, flat-3.175, ball-2, flat-6 (4 runs). The spec's own coverage assertion **fails**
  (F's harness expects ≥ 95 %).
- **Card (v4):** coverage **83.63 %** (was 89.61 at `4611ebb2`); cut-into **0.00 % adjudicated**
  (was 6.122 %, max 26.07 mm); raw 0.50 %, wall 0.39 %, shadow 0.10 %, edge 0.00 %; max raw
  **13.01 mm**; cycle 7.7 h stated; air 67.99 %; rapids 82/1k; cutters 3; holding **vise**,
  29.9 mm proud.
- **Leftover (renderer):** 25,695 cells > 0.1 mm; only **13 cells > 10 mm** (max 10.94 mm at
  (9.2, 43.1) — a wall/step cell, not the old through-body pocket).

One line per picture: `01` no adjudicated cut-into; the raw band is wall/shadow at the silhouette.
`02` leftover concentrated at the outline and the deep wall steps; the old 22 mm through-body
pocket is gone (13 cells > 10 mm). `03` four programs beside — the ball-2 panels carry the
surface. `04`/`05` sections at the worst raw cut-into and leftover cells (both wall/step classes).
`06` simulated stock follows the model's top surface; `07` the feature tree (pockets, remainder).
