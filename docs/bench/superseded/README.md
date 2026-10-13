# Superseded bench files — do not run

`165-depth-ladder-1mm-wrong-orientation.*` is the 2026-10-04 ladder: a 1 mm flat, and the blank
modelled with its 76.2 mm side across the jaws, squares out to X 58.1. The bench clamps the blank
the other way (#383), so on today's setup this program drives the cutter past the 38.1 mm blank
into the moving jaw. It was replaced on 2026-10-12 by `../165-depth-ladder-row-A.nc` and
`-row-B.nc`. Its copy on the Z1's card (`/sd/gcodes/165-depth-ladder.nc`) was deleted on 2026-10-12.

`208-D3-three-strokes-air-high-pre-lift.nc` is the hand-raised air file used for D3 on 2026-10-12.
It opens with `G0 X10 Y8 Z55` and no `G53` lift, which the verifier now refuses (#392). Use the
regenerated `../208-D1-three-strokes-air.nc` instead.
