# Elephant — the (18.0, 43.7) cut-through, Z-section through x = 18.0

- **Part / sha:** `j29-elephant-stick`, planned and posted at the merge `4611ebb2`
  (`cand/engine-int f210f0da` + `origin/965-int dfe9c4511911989fbe21edf999b409c4bbd269fe`).
- **Mesh source (planning mesh):** the job's own `samples/3d/lfs_elephant.stl`, **124,874 triangles**,
  placed by the app's `placeTarget` — the mesh the engine planned on. Goal grid 0.1 mm (362 x 767).
- **Picture:** `z-section-x18-cut-through.png` — vertical section at x = 18.0 mm, y 18.7..68.7 mm.
  Blue = mesh top surface, purple = mesh lowest surface, green = goal at (18.0, 43.7),
  red = the `01-flat-6` pocket floor, **-26.104 mm**.
- **Read:** at y = 43.7 the mesh has material from **-2.266** (top = goal) to **-24.782** (four
  crossings: -2.266 / -20.774 / -21.343 / -24.782). The pocket floor at -26.104 passes through the
  whole body (~22 mm) and finishes 1.3 mm below the mesh's lowest surface. This is the cut-through
  filed as #970; it is not a rim/edge cell, so the border rule has nothing to excuse.
- **Data behind the picture:** `/tmp/e965-elephant-section-x18.csv` (per-point top/lowest/floor),
  mesh and floor fields from the posted programs listed in `#965` (comment 6649622855).
