# Tool tray 70 — v4 render set at `origin/cand/engine-int-merge` `f5ce99cb`

- **Run:** `opsAcceptance959` at f5ce99cb (a4bc28c2 + F's `1199cd6c`, the who-gated v4 rule) with
  the real STEP, catalogue and vise; 18 passed / 2 skipped, 314 s. Mesh source
  `70mm_Tool_Tray-msgtf7oi.step`, **13,208 triangles**; goal 1061 × 1361 at 0.1 mm; stock
  110 × 140 × 27.2; four programs.
- **v4 card:** coverage **98.37 %** (fails the "vendor − 1 point" line by 1.15); cut-into
  **0.00 %** adjudicated; **edge break 1.64 %** (down from 3.88 % under the geometry-only rule —
  the who gate excuses only cells the V cut deepest), raw 1.64 %, wall 0.00 %, shadow 0.00 %;
  raw max 3.000 mm at (9.0, 5.0).
- **Cycle, both bases:** ours **1.4 h** (1.3 h cutting + 3 × 91.4 s bit changes) against the
  vendor's estimator **1.3 h** — within the 1.25× goal; Makera's own header `TIME` states
  **47.6 min**, printed as a fact, never the reference (#943). Air 25.25 %, rapids 94/1k, cutters 3.
- **Holding (posts as filed):** yes — **vise** — Z1 low-profile, stock 110 × 140 × 27.2 mm, 24.1 mm
  proud of the jaw tops (jaws at x = 0 / 110 mm), 0.1 mm.

One line per picture:

- `01-cut-into-top` — 0 adjudicated cells; the 1.64 % raw band is the chamfer's edge break under
  the v4 who gate (was 3.88 % geometry-only — the gate removed the cells other cutters took deepest).
- `02-leftover-top` — 23,488 cells > 0.1 mm, max 6.000 mm at (19.8, 12.1) — a wall cell; none > 10 mm.
- `03-toolpaths` — ours then vendor T1–T4 at one scale; feeds by Z, rapids red, subpath-clean
  (the contour panel shows only the perimeter; the flat-6's diagonals are real ramps).
- `04-section-worst-cut-into` — (9.0, 5.0) is the contour at the silhouette; excluded as wall.
- `05-section-worst-leftover` — the 6 mm is the wall cell; the floors are cut.
- `06-simulated-stock` — union top −1.200, bottom −7.200 mm; the six slots at −7.20.
- `07-feature-tree` — 7 pockets / 14 remainder; slots are children (−7.20) of the −4.20 substrate.
