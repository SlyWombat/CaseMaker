# Mandala coasters (the painted band) — card scored on main `c4d93b58` (#968)

- **Run:** `build.py --repo ~/projects/cm-wt/968-main --sha c4d93b58 --only ref-coasters` with
  `CM_LOCATION=~/casemaker-manager/demo-build/location.json`, the Makerables downloads and the
  committed job (`jobs/ref-coasters.json`). Worktree HEAD = `c4d93b58fda126e8e9c2d21214c92161e3093285`.
  Run dir: `~/casemaker-manager/demo-build/runs/c4d93b58/ref-coasters/`; page written beside it.
- **Source:** the SVG `321-mrxcrxhw.svg` (sha256 `42b7bb96…`), imported as **regions**: 49 strokes
  at their stated **0.5003 mm** band and the frame's **1 mm** band — 50 items, 1,050.4 mm² of
  design area. That is the #968 change (`ba402d1b` + `c4d93b58`) doing its job: the importer reads
  the painted band, not a centre line.
- **Verdict at this sha: deviates.** Our independent design check reads **95.43 %** of the band area
  cut, worst item **60.0 %** left, 19 items between 8.6 % and 11.4 % left (`svg-band-1` 11.4 %,
  `svg-band-4` 8.6 %, `svg-band-8` 9.6 %, …); **outside the design 0.0 mm²**; verifier 0 errors;
  50/50 bands present in the NC (50 operations, 55,313 cutting moves, deepest 0.8 mm, 640 s).
  The vendor's T2 pass on the same band design reads 60.21 % coverage with 0.3 mm² outside.
- **Pictures:**
  - `design-overlay.png` — the design check's overlay: the 50 bands at their stated widths over the
    stock; no ink outside the bands (the 0.0 mm² outside shows as none).
  - `after-top.png` — the independent sweep's top view of our posted program: the 50 bands
    engraved (0.8 mm deep), the frame band visible; the shallow bands read faintly from above, as
    a 0.8 mm V-groove should.
  - `vendor-overlay.png` — the vendor's T2 scored against the same band design: it clears wide
    areas between the bands (its 2D area clear at a 0.15 mm step-over) and reads 60.21 % of the
    bands, i.e. the vendor's program is not the better band cut despite its longer reach.
- **Physically notable:** nothing outside the design is touched and no band is missed entirely; the
  8–11 % left on the worst bands is material left *inside* their 0.5 mm painted width — consistent
  with the V-bit's 0.3 mm tip not reaching the band's two edges on the tight curves. The frame band
  (1 mm wide, scale-1 matrix) is cut in the same pass, as the note on the card states.
