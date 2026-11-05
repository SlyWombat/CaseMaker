# Tool tray 70 — #970 verdict set at `origin/966-collapse` `a447d4f8`

- **Sha:** a447d4f8 — the over-clip fix on the rotary tip-field extraction (94c2e920), 965-int,
  reg-ambiguity and manifold-node. Run: `opsAcceptance959` with the real STEP, catalogue and vise;
  18 passed / 2 skipped, 317 s. Mesh source `70mm_Tool_Tray-msgtf7oi.step`, 13,208 triangles.
- **Against `f5ce99cb` (the pre-fix reference): identical, cell for cell.** Coverage **98.37 %**
  (target 98.37 ✓); cut-into **0.00 %** adjudicated; raw 1.64 % (all edge break under v4), wall
  0.00 %, shadow 0.00 %; raw max 3.000 mm at (9.0, 5.0); cycle 4,776 s. Leftover: **23,488 cells**
  > 0.1 mm, max 6.000 mm at (19.8, 12.1) — the same cell and count as `f5ce99cb` (23,488 at the
  same point), i.e. the over-clip left nothing behind.
- One line per picture: `01` no adjudicated cut-into; the raw band is the v4 edge break. `02`
  leftover identical to `f5ce99cb` (the over-clip's extra cells are gone; none > 10 mm). `03` ours
  beside the vendor's T1–T4 at one scale. `04`/`05` sections at the worst raw cut-into and
  leftover cells (wall class), unchanged from the reference. `06` union stock to −7.2 mm; `07`
  the feature tree.
