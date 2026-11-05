# Tool organizer — render set at `cand/engine-int` `ca0bbabe`

- **Run:** `acceptance-run.sh ca0bbabe tests/unit/opsAcceptance959.spec.ts` with
  `CM_CATALOGUE=~/casemaker-manager/demo-build/catalogue.json` and
  `CM_MAKERABLES=<repo>/.scratch/makerables` — 16 passed / 2 skipped, 354.5 s. Worktree at
  `7aaacb99` (ca0bbabe + F's picture tool `d46f76b0` + the extension `263df637`).
- **Mesh source (printed by the renderer):** `Tool_Organizer_Z1-msfh3m77.step`, **45,544 triangles**,
  the planning mesh; goal grid 1611 × 1611 at 0.1 mm; stock 170 × 170 × 26.8; five posted
  programs: flat-6 · flat-3.175 · ball-6 · chamfer-90 · flat-6 (freeing contour).
- **Scored lines:** coverage **98.61 %**, cut-into **0.04 %** adjudicated (1,080 cells; raw 3.68 %,
  edge break 3.59 %, shadow 0.04 %), raw max 3.000 mm at (26.5, 143.5); cycle **28,229 s** against
  34,723 s at `389ed57e` — same geometry, shorter path.

One line per picture:

- `01-cut-into-top` — the 1,080 adjudicated cells are the chamfer's 0.5 mm cuts (the 77.2 mm
  stay-down G1 link documented in the `389ed57e` set's 08; the link fix is not in this sha).
  Same counts as `389ed57e`.
- `02-leftover-top` — 36,000 cells > 0.1 mm; 5,125 cells (51.3 mm²) > 10 mm are the one-cell band
  along the deep pockets' rims; max 22.000 mm at (15.1, 31.6). Floors are cut (05).
- `03-toolpaths` — ours then vendor T1–T5 at one scale; Z ramp −26.80…1.81 mm, rapids red. Our
  flat-6 is now a full-surface raster and the ball-6 covers the whole top shallow — the linking
  that brought the cycle down; the vendor's T2/T5 still carry the rims and the bottom row.
- `04-section-worst-cut-into` — the 0.5 mm dip at (59.6, 122.1) sits in flat land; see the
  `389ed57e` set's 08 for the link that causes it (not yet fixed at this sha).
- `05-section-worst-leftover` — every deep floor cut to −22.8 with the sweep following; the 22 mm
  is the rim cell.
- `06-simulated-stock` — union top −0.800, bottom −22.800 mm; the four central rectangles at
  −3.8/−5.8, matching the tree.
- `07-feature-tree` — 58 pockets / 7 remainder; the −22.80 row and the −1.40 engraved labels;
  contour frees to −26.80.
