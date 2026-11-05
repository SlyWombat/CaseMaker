> **Superseded:** this set was produced at the merge with the over-clipping `d88a4e87`
> ("the deepest pass excluded each pocket's own floor"). Its tray/organizer coverage numbers are
> **invalid**; the corrected fix is `7f915ce0`, merged at `0ef7c0e5` — see the `0ef7c0e5` set.

# Elephant — the (18.0, 43.7) cell after the pocket-shadow fix, Z-section through x = 18.0

- **Merge:** `origin/cand/engine-int` ca0bbabe + A's `966-pocket-shadow` d88a4e87 → merge commit
  **436792ab** (worktree tip `249b18b2`, the picture tool and harness on top, test-only).
- **Mesh source (planning mesh):** the job's own `samples/3d/lfs_elephant.stl`, **124,874
  triangles**, placed by the app's `placeTarget`; goal grid 0.1 mm (362 × 767).
- **Picture:** `z-section-x18-after.png` — same style and axes as the before picture
  (`../4611ebb2/z-section-x18-cut-through.png`): blue = mesh top, purple = mesh lowest surface,
  red = swept floor, green = goal at the cell, grey = the y = 43.7 line.
- **Read:** at y = 43.7 the swept floor is **−2.266** against the goal **−2.264** — it follows the
  mesh top across the whole section. The before picture had the floor at −26.104, passing through
  the body; now the floor sits **22.79 mm above** the mesh's lowest surface at that column
  (−25.054). The 22 mm cut-through is gone in this picture.
- **Overhang signature, same definition as before** (cells whose swept floor is below the mesh's
  lowest surface while the mesh top is above it): **95 cells = 1.0 mm² raw** (was 441.5 mm²);
  **0 cells = 0.0 mm² adjudicated** (was 70.0 mm²), using the page's wall-step / grid-border /
  3 mm wall-shadow exclusions.
- **Cost on the real parts:** the same fix collapses the tray and organizer coverage — see
  `../tray/436792ab/` and `../organizer/436792ab/`: 98.37 → 14.28 % and 98.61 → 31.06 %, with the
  deep pocket floors left standing. That loss is the fix's, not the harness's (ca0bbabe + F's
  harness alone reads 98.37/98.61 and passes).
