# Tool organizer — #970 verdict set at `origin/966-collapse` `a447d4f8`

- **Sha:** a447d4f8 (over-clip fix on 94c2e920 / 965-int / reg-ambiguity / manifold-node). Run:
  `opsAcceptance959` with the real STEP, catalogue and vise; 18 passed / 2 skipped, 317 s. Mesh
  source `Tool_Organizer_Z1-msfh3m77.step`, 45,544 triangles.
- **Against `f5ce99cb`: identical, cell for cell.** Coverage **98.61 %** (target 98.61 ✓);
  cut-into **0.00 %** adjudicated; raw 1.92 %, edge break 1.91 %, wall 0.00 %, shadow 0.00 %; raw
  max 3.000 mm at (26.5, 143.5); cycle 28,130 s. Leftover: **36,000 cells** > 0.1 mm, 5,125 cells
  > 10 mm (the deep pockets' rim band), max 22.000 mm at (15.1, 31.6) — the same counts and cells
  as `f5ce99cb`, i.e. the over-clip left nothing behind.
- One line per picture: `01` no adjudicated cut-into (the chamfer link stays gone). `02` leftover
  identical to `f5ce99cb`. `03` ours beside vendor T1–T5; chamfer carries rim passes only.
  `04`/`05` sections unchanged (wall class). `06` union to −22.8 mm; `07` the feature tree.
