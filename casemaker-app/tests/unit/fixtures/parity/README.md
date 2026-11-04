# Parity fixtures — the vendor references and the CL surface

## Makerables references (`makerables.json`)

Makera Studio's own NC files, scored on our checker (#955). The files are published under
CC BY-NC-SA / CC BY-NC-ND / CC BY-ND / CC0 at makerables.com; they are **evaluation-only and never
committed**. They live in `.scratch/makerables/` on dave-1 (215 MB). The manifest commits the
slugs, the licences, every file's sha256 and the numbers the page measured from them; the spec
resolves `CM_MAKERABLES` (default `.scratch/makerables`), verifies the hashes, and skips with the
reason on a machine without them.

Each card's `vendorScore` is the page's own measurement:

- `coverage` — `coverage0p1Pct / 100` (top surface within 0.1 mm of the goal);
- `cutInto.adjudicatedFraction` — `cutInto0p1Pct / 100` after edge break, wall cells and the wall
  shadow are excluded; `null` until the new checker scores that card (the scorer then says
  "stated", never pass);
- `cutInto.edgeBreakFraction`, `cutInto.wallNotScoredFraction`,
  `cutInto.shadowNotScoredFraction` — the excluded shares, printed beside the line;
- `cutInto.rawFraction` — the advisory 0.01 mm-floor figure before exclusions;
- `cutInto.maxMm` — the deepest cut below the goal;
- `cycleSeconds` — the vendor program's own `;@MKR|TIME|seconds=`;
- `rapidsPer1000FeedLines` and `cutters` — counted from the vendor `.nc` by `tests/tools/postedFacts.ts`.

`vendorEstimateSeconds` is #927 on the vendor's file, printed beside their TIME as a calibration
figure; it is never the vendor's line.

## CL surface (`cl/*.json`)

Three analytic meshes — a horizontal plane, a 26.57° ramp and a two-level step — dropped with
flat, ball, bull and 90° V cutters at a 1 mm grid. Two independent implementations:

- **OpenCamLib** (LGPL-2.1/3.0, `@opencamlib/opencamlib` 2023.01.11) — all four cutters, in
  `samples`. `tests/tools/gen-cl-fixtures.mjs` (run once; the numbers are committed, the library
  is not a dependency).
- **PyCAM** (GPL-3.0, 0.6.4) — flat, ball and bull, in `pycamSamples`; a V cutter is OCL-only.
  `tests/tools/gen-pycam-fixtures.py` (run once, after the OCL generator; the raw triangle order
  is swapped to PyCAM's clockwise convention and `use_kdtree=False` avoids its Python 3.12 kdtree
  bug — both are stated in the fixture's provenance).

Both columns are **numbers only**: no LGPL or GPL code is copied or linked into the product or the
tests. The two columns agree within one grid cell at every sample (a spec holds it). Kiri:Moto
(MIT) is the engine's port source, not a drop-cutter entry point; its output on the same meshes
fills the `provenance.kiriMoto` slot when the port lands (#957/#959).

The comparison tolerance is **0.001 mm in Z** at the fixtures' own sample points (the XY
placement is the grid itself, exact by construction). It was tightened after B measured
`dropCutterHeight`'s per-facet barycentric sampling reading 0.007-0.09 mm low on large facets for a
ball: a one-grid-cell tolerance (1 mm) could not see it. `tests/tools/cl-engine-check.ts` runs the
engine's own drop-cutter against every fixture and cutter when `cam/model/dropcutter.ts` exists.
