# Tool organizer — v4 render set at `origin/cand/engine-int-merge` `f5ce99cb`

- **Run:** `opsAcceptance959` at f5ce99cb (a4bc28c2 + F's `1199cd6c`, the who-gated v4 rule) with
  the real STEP, catalogue and vise; 18 passed / 2 skipped, 314 s. Mesh source
  `Tool_Organizer_Z1-msfh3m77.step`, **45,544 triangles**; goal 1611 × 1611 at 0.1 mm; stock
  170 × 170 × 26.8; five programs.
- **v4 card:** coverage **98.61 %** (passes); cut-into **0.00 %** adjudicated (was 0.04 % before
  v4; the chamfer's 0.5 mm link is gone) — edge break 1.91 %, raw 1.92 %, wall 0.00 %, shadow
  0.00 %; raw max 3.000 mm at (26.5, 143.5).
- **Cycle, both bases:** ours **7.9 h** (7.8 h cutting + 4 × 91.4 s bit changes) against the
  vendor's estimator **4.2 h** — within the 2× line, above the 1.25× goal; Makera's header `TIME`
  states **47.8 min** as a fact, never the reference. Air 65.50 %, rapids 42/1k, cutters 4.
- **Holding:** yes — **vise** — Z1 low-profile, 170 × 170 × 26.8 mm, 23.7 mm proud of the jaw tops.
- **Rims un-chamfered (#974):** the plan now states `rim "rim-5" not broken: its own loop is not
  closed (ends 77.20 mm apart) — a straight bridge there is not real geometry, so no chamfer is
  cut rather than gouging across it`. 77.20 mm is exactly the old stay-down link; the fix refuses
  it. Several other rims are un-chamfered by the same guard (loops open 21–27.5 mm).

One line per picture:

- `01-cut-into-top` — 0 adjudicated cells (the 1,080-cell chamfer link of the `389ed57e` set is
  gone); the raw band is the edge break under the v4 who gate.
- `02-leftover-top` — 36,000 cells > 0.1 mm; 5,125 cells > 10 mm (the deep pockets' rim band);
  max 22.000 mm at (15.1, 31.6) — the same rim-cell class as before.
- `03-toolpaths` — ours then vendor T1–T5; the chamfer panel no longer crosses the part (longest
  lateral G1 at depth is 11.00 mm, a pocket rim; the 77.20 mm line is absent).
- `04-section-worst-cut-into` — no adjudicated cell remains; the section is the wall-class raw cell.
- `05-section-worst-leftover` — deep floors cut; the 22 mm is the rim cell.
- `06-simulated-stock` — union top −0.800, bottom −22.800 mm; the deep row present.
- `07-feature-tree` — 58 pockets / 7 remainder; contour frees to −26.80.
- `08-zoom-cut-into-cell` — plan zoom ±5 mm at (59.6, 122.1): **no chamfer path crosses the cell**
  (the old 77.20 mm G1 link is gone); nearest wall 3.19 mm; adjudicated cut-into 0.
- `09-zoom-wall-section` — 0.01 mm section: model wall x = 14.005, sweep floor edge x = 14.110
  (+0.105 mm, one grid cell) — walls still cut to the model.
