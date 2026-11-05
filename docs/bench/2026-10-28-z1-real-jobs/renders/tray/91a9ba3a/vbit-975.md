# The 90° V bit against the digits — the #975 facts at `91a9ba3a`

Read-only geometry, no code change. Picture: `12-vbit-vs-digits.png`.

- **The model:** the six engraving floors are flat at **−1.800** (0.60 mm below the −1.200 land),
  with vertical walls — the 0.1 mm goal field inside the digit boxes holds exactly two levels,
  −1.20 and −1.80. Stroke widths, measured on the goal field (Euclidean distance transform +
  run lengths): median **0.72–0.80 mm** per digit, range 0.60–1.13 mm (junctions).
- **The bit:** the set's chamfer-90 is the vendor's own T4 — `;@MKR|TOOL number=4 id=122111013890
  name=3.175mm*90º Chamfer type=V-Bit diameter=3.175 tipdiameter=0.1 angle=90`.
- **Its cutting width at the −1.800 floor depth:** **0.10 mm** (the tip). At the −1.200 surface for
  a 0.60 mm cut: **1.30 mm** (0.10 + 2 × 0.60).
- **Fixed-depth engrave, tip at −1.800:** reaches the floor only within 0.05 mm of the stroke
  centreline. At the stroke edge (0.36–0.40 mm off centre) the V still stands **0.31–0.35 mm above
  the floor** — material left standing inside the stroke — while outside the stroke it cuts the land
  **0.25–0.29 mm below −1.200** at the edge, tapering out 0.65 mm from the centre. A flat floor
  across the stroke needs overlapping passes, and the outer 45° wall still takes **0.60 mm of land
  per side** at the surface.
- **V-carve (depth varying with stroke width):** for these strokes the V would reach only
  **−1.61 to −1.65** (depth 0.41–0.45 mm) — **0.15–0.19 mm short of the −1.800 floor**. Forced to
  −1.800, it opens to 1.30 mm at the surface, i.e. 0.25–0.29 mm of land beyond each stroke edge.
- **So neither V mode reproduces the model's flat, vertical-walled engraving.** The exact cutter is
  a flat end mill no wider than the narrowest stroke (≈ 0.6 mm); the smallest flat in the set is
  ⌀3.175.
- **The vendor's T4, for comparison:** the same V bit, three 3D-contour toolpaths, tracing the
  stroke outlines in two passes at **Z −1.20 and Z −1.60 — never −1.80** over any of the six digit
  boxes. Their digits are 0.4 mm deep, **0.20 mm above the model floor**, with the same 45° flanks.
  So "the vendor cuts them" is visually true (outline V passes) but their engraving is an
  approximation of the model, not a flat −1.800 floor.

Measured numbers in the picture's table; the vendor Z levels come from its own NC
(`Tool_Tray_70mm_Top-msfi5w1b.nc`, T4 section, 61164–64567).
