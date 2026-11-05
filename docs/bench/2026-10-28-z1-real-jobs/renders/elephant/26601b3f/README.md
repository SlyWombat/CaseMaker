# Elephant — the figure acceptance at `26601b3f` (the 957-cl-surface merge)

- **Run:** `figureAcceptance965.spec.ts`, elephant only (`CM_ELEPHANT_STL`, sha matches
  `j29-elephant-stick.json`), Makera catalogue auto-found. **Spec wall 190.89 s** — against the
  ~440–500 s expectation (plan 198.8 s + stages); the spec's 600 s timeout not approached. The
  acceptance **fails its coverage line** (see below); the facts and the plan/pics inputs were
  written before the assert, and the picture pass ran on them.
- **Mesh:** `lfs_elephant.stl`, 124,874 triangles; goal grid 362 × 767 at 0.1 mm; stock
  36 × 100 × 36. Programs: flat-6 · flat-3.175 · ball-2 · flat-6 (contour) — three cutters.
- **Facts (posted):** whole-surface coverage **83.69 %** against the **95 %** line;
  cut-into **adjudicated 0.0076 %** (12 cells, max **0.315 mm**, median 0.134 mm), raw 0.77 %
  (wall 0.57 %, shadow 0, **edge break 0** — no V in the set), raw max 13.21 mm; cycle 9,353.1 s;
  air 15.9 %; rapids 1,239.
- **Leftover:** **25,604 cells > 0.1 mm = 16.31 % of covered** (8,184 > 1 mm); max **10.937 mm at
  (9.2, 43.1)**.

**What the pictures show.** `05` (the worst leftover section) is the answer: the model's black
profile steps down to −15…−20 on the **underside**, and the swept floor (red) runs at ~−26 below it
— the belly, leg and trunk **undersides and overhangs** stand above the goal, up to 10.9 mm. `02`
paints the shortfall in the program-colour band around the silhouette, the ear/head edges and the
trunk's ridges; the top surface itself is pale (cut). `03` shows why: a full flat-6 rough, a
flat-3.175 pass with 26 feeds (almost nothing), the ball-2 finish and the contour — one top setup.
`06` the stock is a smooth body with the trunk channel; `04` the raw worst is a wall cell.

**Reading.** The cut-into side is now essentially clean (adjudicated 0.0076 % vs 3.91 % at
`a447d4f8`; the 13.21 mm raw max sits in the wall class), so the stack fixed what it was meant to.
The **coverage failure is the elephant's underside**: a single top setup cannot reach the belly,
legs and trunk underside, and the spec's exclusion covers only cells on the stock bottom, not the
belly 15–20 mm above it. Passing the whole-surface line needs a **flip/underside setup** — the
#966 multi-setup/end-state work — not a cut change here. No pictures stop a merge; this is a
findings note for #965/#966.
