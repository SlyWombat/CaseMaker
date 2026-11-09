# M1 bench job files — the two that complete the set (#935–#941)

Added 2026-11-09 on `m1-bench-jobs` (base `main` ae4654753), as data beside the other sample
jobs. Each was validated with one CLI generate on that base; the other stick jobs are unchanged.

- **`936-groove-coupon.job.json`** — S2's pre-coupon (#936): two grooves across the stick's end
  — a 1.0 mm stroke at 0.5 mm deep (`groove-stroke`) and a 2.5 mm groove at 1.0 mm deep
  (`groove-flat`) — cut with the app's own recommendation for the S2 text job (`toolKey` empty;
  record the key at Generate). **Proves** the feeds row the S2 text job will use. **Acceptance:**
  per-groove verdict by eye — clean / fuzzy / burnt, with a photo; both grooves at their depth
  ±0.1 mm; wall clock ≈10 min; if the app recommends a V/engraving cutter the 1.0 mm stroke is
  the V test, otherwise it is the flat cutter's stroke test. **Pinned `flat-1.0`** so the coupon
  tests the S2 text job's own cutter; for the record, the unpinned search picks
  `inv:haocher-corn-0.9` for the coupon's narrow grooves (99 % worst-item fidelity, 114 s), which
  shares the same seeded 0.8–1.6 mm row. **Validated** (one CLI generate on `main` ae4654753,
  k3 house export): 1 program, 48 cutting moves, estimated 1 min 32 s, no verifier errors; the
  run sheet asks the operator to record the cutter's flute length and stick-out (the `flat-1.0`
  record states none — the known k3 inventory gap).
- **`938-flat-label-part.job.json`** — S4's part (#938): two 11 mm lines ("MEASURED" over
  "HARDWOOD", barlow bold, rotated along the 100 mm axis, centres x 12 / 24 at y 50, 1.0 mm deep)
  with `flat-1.0` pinned — the cutter whose seeded 0.8–1.6 mm row the #938 ladder measures.
  **Proves** the first measured hardwood row on a real part. **Acceptance:** letters open (no
  fused counters); floors flat and clean; no fuzz on the walls, no burn, no tear-out at the
  stroke edges; depth 1.0 ±0.1 mm; both lines ≥ 11 mm and legible at arm's length, centred within
  0.5 mm; predicted time within 10 % of the clock. **Validated** (one CLI generate on `main`
  ae4654753, k3 house export): `flat-1.0` pinned, 1 program, 11,871 cutting moves, estimated
  17 min 10 s, no verifier errors.
