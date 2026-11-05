# Tool organizer — at the corrected #970 merge `0ef7c0e5` (f5ce99cb + 7f915ce0)

- **Merge:** f5ce99cb + the corrected `966-pocket-shadow` **7f915ce0** → **0ef7c0e5**. Run:
  `opsAcceptance959` with the real STEP, catalogue and vise; 17 passed / 1 failed / 2 skipped.
- **Coverage 97.99 %** against f5ce99cb's **98.61 %** — a **0.62-point** loss (the d88a4e87 merge's
  31.06 % was the over-clip and is withdrawn). Cut-into **0.00 %** adjudicated; raw 1.92 %; edge
  1.91 %; raw max 3.000 mm at (26.5, 143.5); cycle 27,985 s.
- **Mesh source:** `Tool_Organizer_Z1-msfh3m77.step`, 45,544 triangles.

One line per picture:

- `01-cut-into-top` — no adjudicated cell; the raw band is the v4 edge break.
- `02-leftover-top` — 52,184 cells > 0.1 mm (2.0 %), 12,329 cells > 10 mm (the deep pockets' rim
  band, up from 5,125 at f5ce99cb), max 22.000 mm at (15.1, 31.6) — the same rim-cell class; the
  extra 0.6 points of leftover are the clipped deep-pocket rims.
- `03-toolpaths` — five programs; the chamfer panel carries rim passes only (no crossing).
- `04-section-worst-cut-into` — no adjudicated cell; the section shows the wall class.
- `05-section-worst-leftover` — deep floors cut; the 22 mm is the rim cell.
- `06-simulated-stock` — union top −0.800, bottom −22.800 mm; the deep row present.
- `07-feature-tree` — unchanged (58 pockets; the −22.80 row).
