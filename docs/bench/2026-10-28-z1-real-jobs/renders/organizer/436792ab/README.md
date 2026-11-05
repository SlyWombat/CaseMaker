> **Superseded:** this set was produced at the merge with the over-clipping `d88a4e87`
> ("the deepest pass excluded each pocket's own floor"). Its tray/organizer coverage numbers are
> **invalid**; the corrected fix is `7f915ce0`, merged at `0ef7c0e5` — see the `0ef7c0e5` set.

# Tool organizer — render set at the #970 merge `436792ab` (ca0bbabe + d88a4e87)

- **Merge:** `origin/cand/engine-int` ca0bbabe + A's `966-pocket-shadow` d88a4e87 → merge commit
  **436792ab**; worktree tip `249b18b2` (F's harness + the picture tool + extension, test-only).
- **Run:** `opsAcceptance959` with the real STEP, catalogue and vise. Mesh source:
  `Tool_Organizer_Z1-msfh3m77.step`, **45,544 triangles**; goal 1611 × 1611 at 0.1 mm; stock
  170 × 170 × 26.8; five programs.
- **Coverage 31.06 %** against `ca0bbabe`'s **98.61 %**; cut-into 0.04 % adjudicated (1,080 cells,
  the same chamfer link), raw 3.68 %, shadow 0.04 %; raw max 3.000 → **2.000 mm**; cycle 30,827 s.
- **Attribution:** `ca0bbabe` + F's harness only reads **98.61 %** and passes; the fix alone on its
  own base (`d88a4e87`) reads **32.11 %**. The loss is the pocket-shadow fix.

One line per picture:

- `02-leftover-top` — the deep pockets (goal −22.8) are standing; 1,786,919 cells > 0.1 mm left,
  12,329 cells > 10 mm, max 22.6 mm at (33.8, 32.2) where the sweep stays at −0.2.
- `01-cut-into-top` — the 1,080 adjudicated cells are unchanged (the chamfer's 0.5 mm link).
- `03-toolpaths` — the programs still post; the flat-6 pocket coverage is visibly reduced.
- `04-section-worst-cut-into` — same link dip at 0.5 mm; max raw 2.000 elsewhere.
- `05-section-worst-leftover` — the deep floors are uncut, so the section shows standing material
  rather than the rim-cell class.
- `06-simulated-stock` — union surface near −0.2 mm over the deep pockets instead of −22.8.
- `07-feature-tree` — unchanged (58 pockets; the −22.80 row present).
