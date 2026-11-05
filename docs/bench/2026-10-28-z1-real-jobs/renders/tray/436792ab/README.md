> **Superseded:** this set was produced at the merge with the over-clipping `d88a4e87`
> ("the deepest pass excluded each pocket's own floor"). Its tray/organizer coverage numbers are
> **invalid**; the corrected fix is `7f915ce0`, merged at `0ef7c0e5` — see the `0ef7c0e5` set.

# Tool tray 70 — render set at the #970 merge `436792ab` (ca0bbabe + d88a4e87)

- **Merge:** `origin/cand/engine-int` ca0bbabe + A's `966-pocket-shadow` d88a4e87 → merge commit
  **436792ab**; the run's worktree tip is `249b18b2` (F's harness `1a45f155` + the picture tool
  `d46f76b0` + extension `263df637`, all test-only above the merge). Two conflicts in `plan.ts`
  (the sequence/setups imports and the notes composition), resolved keeping both sides.
- **Run:** `opsAcceptance959` with the real STEP, catalogue and vise (F's harness). Mesh source:
  `70mm_Tool_Tray-msgtf7oi.step`, **13,208 triangles**; goal 1061 × 1361 at 0.1 mm; stock
  110 × 140 × 27.2; four programs (flat-6, ball-6, chamfer, flat-6 contour).
- **Coverage 14.28 %** against `ca0bbabe`'s **98.37 %** — the acceptance's own
  `coverage ≥ 0.98` assertion **fails**. Cut-into 0.00 % adjudicated (raw 3.88 %, all edge break),
  raw max 3.000 → **2.000 mm**; cycle 4,582 s (4,865 at ca0bbabe).
- **Attribution:** `ca0bbabe` + F's harness only (no fix) reads **98.37 %** and passes; the fix
  alone on its own base (`d88a4e87`) reads **17.01 %**. The loss is the pocket-shadow fix, not the
  harness or the merge.

One line per picture:

- `02-leftover-top` — **the finding**: the six slot floors (goal −7.2) are standing (red, up to
  6.2 mm) while the shallow substrate is cut; 1,235,384 cells (12,354 mm²) > 0.1 mm left. The
  clipping removed the deepest pocket levels on the real part.
- `01-cut-into-top` — no adjudicated cut-into; the raw band is the chamfer's edge break, as before.
- `03-toolpaths` — the programs still post and run (4 runs, 4,582 s); the flat-6's pocket paths are
  visibly shorter than the ca0bbabe set's.
- `04-section-worst-cut-into` — the worst raw cell is 2.000 mm (was 3.000), the same wall position.
- `05-section-worst-leftover` — the section now runs through uncut slot floors (leftover 6 mm on the
  floors themselves, not only the wall cell).
- `06-simulated-stock` — the union surface stays near −1.0 mm over the slots instead of reaching
  −7.2.
- `07-feature-tree` — the tree itself is unchanged (7 pockets, slots at −7.20).
