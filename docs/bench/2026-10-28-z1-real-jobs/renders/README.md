# The standard render set (#972)

Per the maintainer's orders of 2026-11-05 (`#943`, comment 6650490372 §4), every scored sha gets a
picture set under `renders/<part>/<sha>/` before any verdict is posted on a cell, a class, a gouge,
a datum or a "no gain".

Each set holds, for the part:

| file | what it shows |
|---|---|
| `01-cut-into-top.png` | the adjudicated cut-into, coloured per program (owner of each cell's floor), with the gate's excluded classes in their own colours |
| `02-leftover-top.png` | material standing above the goal by > 0.1 mm, coloured by the program whose floor set the cell's top |
| `03-toolpaths.png` | one panel per posted program and one per vendor tool run, at the same scale: feed moves coloured by Z, rapids red, the part outline black |
| `04-section-worst-cut-into.png` | a Z-section through the worst adjudicated cut-into cell |
| `05-section-worst-leftover.png` | a Z-section through the worst leftover cell |
| `06-simulated-stock.png` | the union of every posted program's exact sweep, coloured by Z |
| `07-feature-tree.png` | the #958 feature tree: pocket regions and floors, islands, remainder, contour and rims |

**Every probe runs on the planning mesh** — the STEP's recognised tessellation the engine planned
on, not the vendor's STL — and prints its source and triangle count. The organizer's 0.1-floor share
on this mesh is 0.04 %, against the page's 0.14 % on the vendor STL; that gap is mesh-source.

The pictures are written by `casemaker-app/tests/tools/acceptancePics.ts` from the acceptance run's
own `<card>-plan.json` + `<card>-pics.json` (no re-plan), extended here with the per-program owner
colours, the vendor panels, the simulated stock and the feature tree; the extension is branch
**972-render-set** (`263df637`, off F's `d46f76b0`). The run directory also carries `grid.json`,
`goal.f32`, `union.f32` and the posted `program-*.nc` for offline zooms. The SVGs live beside them in
`~/casemaker-manager/pics/<sha>/<part>/` on the machine that rendered them; only the PNGs are
committed to keep the repository light.
