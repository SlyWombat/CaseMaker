# Rapids per 1,000 — attribution at `a52c0c1d` (D's 961x960 + 962 strip-tour)

- **Sha:** a52c0c1d (`cand` combination of #960 + #961 + #962 strip-tour; v4 gate). Run:
  `opsAcceptance959` with the real STEPs, catalogue and vise; 18 passed / 4 skipped, 536 s.
  Tray card: coverage **99.34 %** (up from 98.37), rapids/1k **71.3**; organizer: coverage
  **98.61 %**, rapids/1k **15.95**.
- **Method:** every G0 move of the posted programs (per program) and of the vendor NC is classified
  by geometry and context: **tool-change approach** = G0 before the first feed of the program (or
  vendor T-run); **retract/plunge leg** = G0 with |ΔXY| < 0.05 mm; **row hop** = |ΔXY| < 3 mm;
  **region move** = |ΔXY| ≥ 3 mm.
- **Organizer:** ours **3,170 rapids / 199,063 feed moves = 15.9 per 1k**; vendor **1,386 /
  581,524 = 2.4 per 1k**. Classes (ours → vendor): retract/plunge **2,081 → 861**, region moves
  **974 → 464**, row hops 100 → 58, tool-change 15 → 3.
- **Tray:** ours **1,483 rapids / 20,890 feed moves = 71.0 per 1k**; vendor **384 / 65,163 =
  5.9 per 1k**. Classes (ours → vendor): retract/plunge **980 → 251**, region moves **404 → 96**,
  row hops 84 → 34, tool-change 15 → 3.
- **Reading:** the class *mix* matches the vendor's (ours ~66 % retract/plunge, 27–31 % region,
  3–6 % row hop, 1 % tool-change; vendor 62–65 / 25–33 / 4–9 / 1). The per-1k failure is **volume
  on sparser programs**: 3.9× (tray) and 2.3× (organizer) the vendor's absolute rapid count while
  posting 1/3 the vendor's feed moves — every row end still retracts (~980 / 2,081 legs) and
  regions are crossed (~404 / 974 long moves). The vendor's per-1k is diluted by its dense raster
  (65k / 581k feed lines), not by fewer hazardous lifts — it makes the same classes, just fewer of
  them in absolute terms.
- **Picture:** `rapid-classes.png` — ours beside the vendor's at one scale, every rapid coloured:
  green tool-change approach, grey dot retract/plunge, blue row hop, red region move. The tray's
  is `../tray/a52c0c1d/rapid-classes.png`.
- Per-program counts: tray — flat-6 639 legs/329 region/3 TC, flat-3.175 118/61/3, ball-6
  183/13 + 84 hops, chamfer 2 legs, contour 38/1; organizer — flat-6 **1,781 legs / 866 region**,
  flat-3.175 28/26, ball-6 194/42 + 63 hops, chamfer 41/39, contour 37/1.
