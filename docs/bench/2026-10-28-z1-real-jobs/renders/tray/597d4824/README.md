# Tool tray 70 — #970 verdict set at `origin/966-collapse` `597d4824`

- **Sha:** 597d4824 "the #970 redo — a real ceiling is geometry, not distance". Run:
  `opsAcceptance959` with the real STEP, catalogue and vise; 18 passed / 2 skipped, 558 s. Mesh:
  `70mm_Tool_Tray-msgtf7oi.step`, 13,208 triangles.
- **Against `f5ce99cb`:** coverage **98.38 %** (target 98.37; 23,344 leftover cells vs 23,488, 144
  fewer); cut-into **0.00 % adjudicated**; raw **11.67 %** — edge break 2.99 %, **wall shadow
  8.11 %** (the shadow class reads far larger at this sha than f5ce99cb's 0.00 %; the judged line
  is unaffected); raw max 3.492 mm; cycle 5,168 s.
- **Leftover map:** 23,344 cells > 0.1 mm; **max 3.258 mm at (20.6, 54.1)** — the old 6.000 mm
  wall cell at (19.8, 12.1) is gone; none > 10 mm.
- One line per picture: `01` no adjudicated cut-into; the raw band is the v4 edge break plus the
  enlarged wall shadow. `02` the leftover map above. `03` ours beside the vendor's at one scale.
  `04`/`05` sections at the worst raw cut-into and leftover cells. `06` the swept stock. `07` the
  feature tree.
