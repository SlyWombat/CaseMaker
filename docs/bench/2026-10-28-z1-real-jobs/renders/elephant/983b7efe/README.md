# Elephant — the follow-chord fix at `983b7efe` (cand/970-follow-chord)

- **Run:** `figureAcceptance965.spec.ts`, elephant only, the local mesh matching `j29-elephant-stick`;
  **209.90 s** spec (parent at `6e08117e` without the fix: 209.23 s). Same-tip A/B, only the fix
  differing. The acceptance still fails its coverage line (83.67 %, as before — the underside class,
  not links); the facts and the picture inputs are written before the assert.
- **Adjudicated cut-into: 12 cells → 11.** The one that goes is **(29.6, 42.1), depth 0.3154 mm,
  owner the ball-2 finish** — its parent stamp is a dip-following link chord
  (`program-3-131012203812.nc` line 22379, `G1 X29.953 Y41.234 Z-0.627`, in a Z climb from −14.4 to
  −0.6). The fix lays that link's points with `dropRow`, so the chord no longer cuts the corner.
- **The 11 remaining are all flat-6 (program 1) rim cells**, each stamped by a raster row whose disc
  edge sits at **d = 3.00 mm** (the tool's own radius): (21.7, 42.0) `G1 Y41.583` z −2.000;
  (0.7, 43.5) `G1 X-2.231 Y42.907` z −3.000; the six-cell run at x = 7.1, y 63.3–63.8 and the
  three at x = 6.7, y 69.8–70.0, all at z −9.000 (lines 14767 / 14773). These are the same class as
  the organizer's two rim cells at 0.1098 mm — the flat's edge grazing a rising design at the rim,
  not a link.
- **Raw cut-into 1,188 → 714 cells** (−474): the link chords were grazing many wall-class cells
  besides the one adjudicated cell.
- **Coverage 83.6805 → 83.6690 %** (−0.0115 points — unchanged for this purpose).
- **Cycle 9,356.9 → 9,615.9 s (+259.0 s, +2.77 %)** — the follow's subdivision adds feed travel on
  the elephant's many finish links. The organizer's cycle moved +0.22 s; this is the elephant's cost
  of the same rule.
