# Set 2 pipeline (2026-10-28)

- `bench_location.py`: the bench location, with confirmed Makera matches and the catalogue beside it.
- `c2d.py` and `c2dgeom.py`: read a Carbide Create `.c2d` (SQLite: the design SVG, params, every item) and turn its elements into rings in mm.
- `jobs3.py`: builds the set-2 job files, and splits each multi-cutter job into one job per cutter (`-a/-b/-c`, cut-out last as `-z`) as a workaround for #746.
- `bench-import-outline.mts`: brings an SVG or DXF, or a raw RGBA bitmap, through the app's own importers (`parseOutlineFile`, `traceRaster`). Copy it into `casemaker-app/scripts/`.
- `bench-probe.mts`: runs `engraveGenerate` like `casemaker cut` and prints the verifier findings of the program AND its frame file. The CLI receipt only counts the frame's (#747). Copy it into `casemaker-app/scripts/`.
- `run.sh` runs one job and summarises its receipt; `render.py` is the independent sweep and renderer (two-colour laminate added). `set2_cards.py` holds the verdicts.

Like set 1's tools, these were written for a one-off run. `jobs3.py` expects set 1's `lib.py` at `../real/` and the downloads under `x/`, `trace/` and `dl-*/` beside it, and `run.sh` has the scratchpad path at its top. Point those at a working folder before re-running.
