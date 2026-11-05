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
  after 84 / 82. **Lateral chords only** (the wall's near-vertical ramp steps, dy < 0.02 mm, are
  drawn grey and excluded — they are Z moves, not chords): planning mesh **−0.0429 … +0.1062 mm**
  before and **−0.0052 … +0.0051 mm** after; vendor STL −0.1552 … +0.0561 before and
  −0.1552 … +0.1712 after (the wall's raw values there include ramp-step samples too). The
  +0.10/+0.27 values seen at the wall are steps at nearly constant XY, not chords — see the raw
  sample in the #957 comment.
- **Reading:** on the mesh the engine plans on, the posted ball path lies on the exact CL within the
  chord tolerance at both sections; at x = 68.311 the fix moves the genuine chord gaps from
  **−0.0429/+0.1062 mm** to **−0.0052/+0.0051 mm** (B's own dump: worst −0.0048 mm — the same
  within sampling; the earlier −0.0154 was a near-vertical ramp step counted as a chord). The
  vendor STL shows a systematic −0.13…−0.16 mm difference on the same moves — the mesh-source
  effect the earlier table read as planner error.
