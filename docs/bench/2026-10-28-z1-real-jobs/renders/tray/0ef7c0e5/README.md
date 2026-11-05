# Tool tray 70 — at the corrected #970 merge `0ef7c0e5` (f5ce99cb + 7f915ce0)

- **Merge:** `origin/cand/engine-int-merge` f5ce99cb + the corrected `966-pocket-shadow`
  **7f915ce0** ("the deepest pass no longer excludes each pocket's own floor") → **0ef7c0e5**.
  Two conflicts in `plan.ts`, resolved keeping both sides. Run: `opsAcceptance959` with the real
  STEP, catalogue and vise; 17 passed / **1 failed** / 2 skipped — the failure is the acceptance's
  own `coverage ≥ 98 %` assertion.
- **Coverage 97.27 %** against f5ce99cb's **98.37 %** — a **1.10-point** loss (the d88a4e87 merge's
  14.28 % was the over-clip and is withdrawn). Cut-into **0.00 %** adjudicated; raw 1.64 % (all
  edge break under v4); raw max 3.000 mm at (9.0, 5.0); cycle 4,770 s.
- **Mesh source:** `70mm_Tool_Tray-msgtf7oi.step`, 13,208 triangles.

One line per picture:

- `01-cut-into-top` — no adjudicated cell; the raw band is the v4 edge break (1.64 %).
- `02-leftover-top` — 39,336 cells > 0.1 mm (3.7 % of covered), max 6.000 mm at (19.8, 12.1), a
  wall cell; none > 10 mm. Compared with f5ce99cb (23,488 cells), the fix leaves ~16k more cells
  just above the 0.1 mm band — the 1.1-point coverage cost.
- `03-toolpaths` — four programs, same shapes as f5ce99cb; the flat-6 pocket passes are slightly
  shorter at the clipped levels.
- `04-section-worst-cut-into` — the contour at the silhouette (wall class).
- `05-section-worst-leftover` — the 6 mm wall cell; floors cut.
- `06-simulated-stock` — union top −1.200, bottom −7.200 mm; the slots reached.
- `07-feature-tree` — unchanged (7 pockets, slots at −7.20).
