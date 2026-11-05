# Tool tray 70 — render set at `cand/engine-int` `ca0bbabe`

- **Run:** `acceptance-run.sh ca0bbabe tests/unit/opsAcceptance959.spec.ts` with
  `CM_CATALOGUE=~/casemaker-manager/demo-build/catalogue.json` and
  `CM_MAKERABLES=<repo>/.scratch/makerables` — 16 passed / 2 skipped, 354.5 s. Worktree at
  `7aaacb99` (ca0bbabe + F's picture tool `d46f76b0` + the extension `263df637`).
- **Mesh source (printed by the renderer):** `70mm_Tool_Tray-msgtf7oi.step`, **13,208 triangles**,
  the planning mesh; goal grid 1061 × 1361 at 0.1 mm; stock 110 × 140 × 27.2; four posted
  programs: flat-6 · ball-6 · chamfer-90 · flat-6 (freeing contour).
- **Scored lines:** coverage **98.37 %**, cut-into **0.00 %** adjudicated (raw 3.88 %, edge break
  3.88 %), raw max 3.000 mm at (9.0, 5.0); cycle **4,865 s** against 6,073 s at `389ed57e` — same
  geometry, shorter path.

One line per picture:

- `01-cut-into-top` — nothing adjudicated; the raw band is the chamfer's edge break on the pocket
  rims. Identical cell counts to the `389ed57e` set (0 adjudicated).
- `02-leftover-top` — 23,488 cells > 0.1 mm, max 6.000 mm at (20.4, 12.6): the single
  wall-straddling cell at a slot end; none > 10 mm. Same as `389ed57e`.
- `03-toolpaths` — ours then the vendor's T1–T4 at one scale; Z ramp −27.20…0.80 mm, rapids red.
  The flat-6 panel's diagonal strokes are real ramp/link feeds (the polyline-join artefact is
  fixed), and the contour panel shows only the four perimeter edges. Our ball-6 strip matches the
  vendor T3's shape.
- `04-section-worst-cut-into` — (9.0, 5.0) is the contour along the part's silhouette; excluded as
  wall, not a gouge.
- `05-section-worst-leftover` — the 6 mm is the slot-end wall cell; the floors are cut.
- `06-simulated-stock` — union top −1.200, bottom −7.200 mm; the six slots at the −7.20 level.
- `07-feature-tree` — 7 pockets / 14 remainder; slots are children (−7.20) of the −4.20 substrate;
  the red numerals are the engraved 1–6 rims; contour frees to −27.20.
