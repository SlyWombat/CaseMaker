# Organizer — #957 acceptance pictures: the posted ball row against the exact CL, no interpolation

- **Shas:** before `f5ce99cb` (`origin/cand/engine-int-merge`), after **`83a338dc`**
  (`origin/957-cl-surface`, B's fix: rowDropper checks the quarter points, the pencil goes through
  dropRow). Run: `opsAcceptance959` at 83a338dc with the real STEP, catalogue and vise; 16 passed /
  1 skipped, 506 s. Both figures carry all four panels (before/after × planning mesh/vendor STL).
- **Method (no interpolation between passes):** the ball-6 program's posted feed points at the
  section's own x are taken as dots; only **consecutive posted points** are joined, as straight
  lines (real moves); the exact ⌀6-ball `dropCutterHeight` is evaluated at every point and at each
  segment's quarter, midpoint and three-quarter point, on **both** meshes:
  - the planning mesh — the STEP's recognised tessellation, **45,544 triangles** (the mesh the
    engine plans on), and
  - the vendor STL — **12,482 triangles**,
  both placed at the same centre (85, 85) with the top at −0.8 mm.
- **Picture 1 — `957-section-x15.755.png`** (the section at y ≈ 97.954): 47 posted points, 46
  segments, **identical before and after**. On the planning mesh every labelled quarter/mid gap is
  within **−0.0040 … +0.0042 mm**; on the vendor STL the same segments read **−0.1268 … −0.0041 mm**
  — the mesh source, not a planner residual.
- **Picture 2 — `957-section-x68.311.png`** (the worst-chord row): before 78 points / 76 segments,
  after 84 / 82. On the planning mesh the mid/quarter gaps run **−0.0203 … +0.0048 mm** before and
  **−0.0154 … +0.1786 mm** after — the +0.18 is a real segment crossing the pocket wall's step,
  where the CL jumps between samples (visible at the right wall); on the vendor STL,
  −0.1552 … +0.0561 before and −0.1552 … +0.1712 after.
- **Reading:** on the mesh the engine plans on, the posted ball path lies on the exact CL within the
  chord tolerance, before and after the fix at x = 15.755, and within ~0.02 mm before at x = 68.311
  with the after adding points. The vendor STL shows a systematic −0.13…−0.16 mm difference on the
  same moves — the mesh-source effect the earlier table read as planner error. B's quoted worst
  chord (−0.0365 mm) is not reproduced by this row's own consecutive points: the worst mid-gap
  before is −0.0203 mm. The small positive values at the wall are steps, not chords.
