# Tray — the #974 mouth-rim fix confirmed at `ac1814ec` (974-rim-branch)

- **Sha:** ac1814ec "a mouth rim's top is the material above it, not the parent's floor (#974)".
  Run: the tray test of `opsAcceptance959` with the real STEP, catalogue and vise; 2 passed /
  18 skipped, **24.6 s** (expected ~110 s for one part — faster than expected).
- **The contested feed:** the chamfer program now posts **(19.800, 12.050, −1.700)** — land (−1.2)
  minus the 0.5 mm edge-break leg — where 597d4824 had **−4.692** (3.49 mm inside solid land).
- **Shadow class: 0 cells / 0.00 %** (597d4824: 116,868 = 8.11 %). Card: coverage **98.3702 %**
  unchanged, adjudicated **0.00 %**, raw 4.00 % (all edge break, the V's leg), max 3.000 mm.
  Class depths: edge break 57,656 cells (max 0.5, median 0.3), wall 8 (max 3.0), shadow 0,
  adjudicated 0.
- **The x = 19.7 section** (`974-shadow-section-fixed.png`): at (19.7, 12.0) the goal is −1.2 and
  the swept floor **−1.638** — 0.438 mm below, inside the V's 0.5 mm leg (the edge break); 597d4824
  read −4.63 at the same cell.
- **Map** (`974-shadow-map-fixed.png`): no shadow band; the only large feature is the flat-6
  contour's own silhouette frame (owner colour).
- Leftover 23,488 cells (max 6.000 at (20.4, 12.6)) — the `f5ce99cb` map, restored.
