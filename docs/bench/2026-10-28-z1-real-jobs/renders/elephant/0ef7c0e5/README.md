# Elephant — the (18.0, 43.7) cell after the corrected pocket-shadow fix, Z-section through x = 18.0

- **Merge:** `origin/cand/engine-int-merge` f5ce99cb + the corrected `966-pocket-shadow` **7f915ce0**
  ("the deepest pass no longer excludes each pocket's own floor") → **0ef7c0e5**. This is the sha
  that ships, so the #970 verdict rests on this picture.
- **Mesh source (planning mesh):** the job's own `samples/3d/lfs_elephant.stl`, **124,874
  triangles**, placed by the app's `placeTarget`; goal grid 0.1 mm (362 × 767).
- **Picture:** `z-section-x18-after.png` — same style and axes as the before picture
  (`../4611ebb2/z-section-x18-cut-through.png`): blue = mesh top, purple = mesh lowest surface,
  red = swept floor, green = goal at the cell, grey = the y = 43.7 line.
- **Read:** at y = 43.7 the swept floor is **−2.266** against the goal **−2.264** — it follows the
  mesh top across the whole section. The before picture had the floor at −26.104 through the body;
  now the floor sits 22.79 mm above the mesh's lowest surface at that column. The cut-through is
  gone in this picture.
- **Overhang signature, same definition:** **95 cells = 1.0 mm² raw** (was 441.5 mm²);
  **0 cells = 0.0 mm² adjudicated** (was 70.0 mm²) with the page's wall/border/3 mm-shadow
  exclusions. Identical to the d88a4e87 merge — the correction changed the real parts' coverage,
  not the elephant's mechanism.
- **Cost on the real parts at this sha:** tray coverage 98.37 → **97.27 %**, organizer
  98.61 → **97.99 %** (the d88a4e87 over-clip's 14.28/31.06 is withdrawn). See
  `../tray/0ef7c0e5/` and `../organizer/0ef7c0e5/`.
