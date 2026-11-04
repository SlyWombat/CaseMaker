#!/usr/bin/env node
/**
 * #964 — GENERATE THE CL-SURFACE PARITY FIXTURES FROM OPENCAMLIB.
 *
 * Run ONCE, by hand, on a machine with the OpenCamLib Node bindings installed. The output is
 * committed under `tests/unit/fixtures/parity/cl/`; the specs read the numbers and never run this
 * script. That is the licence boundary: OpenCamLib is LGPL, so no OCL code is linked into the
 * product or the tests — only the NUMBERS it computed are stored.
 *
 *   npm install --no-save @opencamlib/opencamlib
 *   node tests/tools/gen-cl-fixtures.mjs
 *
 * Kiri:Moto (MIT) is the port source for the engine, not a drop-cutter: its CAM output on these
 * meshes arrives with the port (#957/#959) and is stored in the same fixture shape. The
 * `provenance.kiriMoto` field says so rather than inventing numbers.
 *
 * The meshes are analytic and small on purpose: a 26.57° ramp, a spherical cap and a two-level
 * step. Every triangle and every sample is in the fixture, so the comparison is reproducible
 * without the vendor files or a mesh import.
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ocl = require('@opencamlib/opencamlib');
const { STLSurf, CylCutter, BallCutter, BullCutter, ConeCutter, Path, Point, Line, PathDropCutter } = ocl;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'unit', 'fixtures', 'parity', 'cl');
mkdirSync(OUT, { recursive: true });

/** The sampling grid is 1 mm; the comparison tolerance below is one grid cell. */
const STEP = 1;

/** A mesh as vertices + triangle indices, plus its raw triangle list for OCL. */
function mesh(vertices, triangles) {
  return {
    vertices,
    triangles,
    raw: triangles.map(([a, b, c]) => [vertices[a], vertices[b], vertices[c]]),
  };
}

/**
 * The horizontal plane: ONE triangle, 40 mm across, at z = 0.
 *
 * A single triangle is deliberate. Both libraries resolve a contact that lands exactly on a shared
 * triangle edge differently (PyCAM's circle-plane routine uses the edge's triangle normal), and a
 * grid point whose cutter contact sits on a diagonal is then a coin toss between the two. One
 * large triangle makes every contact interior and the two references comparable.
 */
function plane() {
  const v = [
    [-20, -20, 0],
    [20, -20, 0],
    [0, 60, 0],
  ];
  return mesh(v, [[0, 1, 2]]);
}

/** The 26.57° ramp: z = 0.5 x, ONE triangle 40 mm across (see the plane's note). */
function ramp() {
  const v = [
    [-20, -20, -10],
    [20, -20, 10],
    [0, 60, 0],
  ];
  return mesh(v, [[0, 1, 2]]);
}

/** Two levels and a wall: z = 0 for x < 0, z = −2 for x ≥ 0. */
function steps() {
  const v = [
    [-8, -8, 0],
    [0, -8, 0],
    [0, 8, 0],
    [-8, 8, 0],
    [0, -8, -2],
    [8, -8, -2],
    [8, 8, -2],
    [0, 8, -2],
  ];
  return mesh(v, [
    [0, 1, 2],
    [0, 2, 3], // upper plane
    [4, 5, 6],
    [4, 6, 7], // lower plane
    [1, 4, 7], // wall
    [1, 7, 2],
  ]);
}

/** The cutter list, with the OCL constructor and the fixture's shape name. */
function cutters() {
  return [
    { shape: 'flat', diameterMm: 6, lengthMm: 20, make: () => new CylCutter(6, 20) },
    { shape: 'ball', diameterMm: 6, lengthMm: 20, make: () => new BallCutter(6, 20) },
    { shape: 'bull', diameterMm: 6, cornerRadiusMm: 1, lengthMm: 20, make: () => new BullCutter(6, 1, 20) },
    { shape: 'v90', diameterMm: 6, angleDeg: 90, lengthMm: 20, make: () => new ConeCutter(6, Math.PI / 4, 20) },
  ];
}

/**
 * Drop one cutter at every grid point.
 *
 * OCL's `PathDropCutter` samples the path and REPLACES every sample's Z with its own `minimumZ`
 * (default 0), then lifts each cutter to contact. The path point's Z is discarded; `setZ` is the
 * only way to start below the model. It is set 10 mm below the mesh's lowest vertex, so every CL
 * value is the true contact height — the default 0 silently clamps any part of the mesh below
 * zero (the first two runs of this generator made exactly that mistake on `steps` and the ramp's
 * downhill half).
 */
function sample(m, cutter, x0, x1, y0, y1) {
  const surf = new STLSurf();
  surf.triangles = m.raw;
  const pdc = new PathDropCutter();
  pdc.setSTL(surf);
  pdc.setCutter(cutter);
  pdc.setSampling(0.001);
  const floor = Math.min(...m.vertices.map((v) => v[2])) - 10;
  pdc.setZ(floor);
  const samples = [];
  for (let y = y0; y <= y1 + 1e-9; y += STEP) {
    for (let x = x0; x <= x1 + 1e-9; x += STEP) {
      const p = new Point(x, y, floor);
      const path = new Path();
      path.append(new Line(p, p));
      pdc.setPath(path);
      pdc.run();
      const points = pdc.getCLPoints();
      const z = Array.isArray(points) && points.length > 0 ? points[0][2] : null;
      samples.push({ x: round(x), y: round(y), z: z === null ? null : round(z) });
    }
  }
  return samples;
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);

const CASES = [
  {
    id: 'plane',
    description: 'A horizontal plane at z = 0 (one 40 mm triangle).',
    mesh: plane(),
    grid: { x0: -5, x1: 5, y0: -5, y1: 5 },
  },
  {
    id: 'ramp',
    description: 'A plane inclined 26.57° (z = 0.5 x), one 40 mm triangle.',
    mesh: ramp(),
    grid: { x0: -5, x1: 5, y0: -5, y1: 5 },
  },
  {
    id: 'step',
    description: 'Two levels (z = 0 for x < 0, z = −2 for x ≥ 0) with a vertical wall at x = 0.',
    mesh: steps(),
    // Half-cell offset: a flat cutter of radius 3 whose centre sits at x = ±3 is exactly tangent
    // to the wall plane, and OCL (which models the cylinder side) and PyCAM (cutting face only)
    // then read different first contacts there. The offset keeps every sample off that tangency.
    grid: { x0: -5.5, x1: 5.5, y0: -5.5, y1: 5.5 },
  },
];

for (const c of CASES) {
  const measured = cutters().map((cutter) => ({
    shape: cutter.shape,
    diameterMm: cutter.diameterMm,
    ...(cutter.cornerRadiusMm === undefined ? {} : { cornerRadiusMm: cutter.cornerRadiusMm }),
    ...(cutter.angleDeg === undefined ? {} : { angleDeg: cutter.angleDeg }),
    lengthMm: cutter.lengthMm,
    samples: sample(c.mesh, cutter.make(), c.grid.x0, c.grid.x1, c.grid.y0, c.grid.y1),
  }));
  const fixture = {
    id: c.id,
    description: c.description,
    mesh: { vertices: c.mesh.vertices, triangles: c.mesh.triangles },
    grid: { ...c.grid, stepMm: STEP },
    cutters: measured,
    tolerance: {
      withinGridCells: 1,
      note: 'the new engine’s CL height at each sample must agree with this reference within one grid cell (1 mm); the finishing specs also compare their scallop/step-over Z at the same points',
    },
    provenance: {
      opencamlib: {
        library: 'OpenCamLib',
        version: '2023.01.11',
        binding: '@opencamlib/opencamlib (Node-API, emscripten build)',
        licence: 'LGPL-2.1 / LGPL-3.0 — NUMBERS ONLY: no OCL code is linked into the product or the tests',
        command: 'node tests/tools/gen-cl-fixtures.mjs',
        generated: new Date().toISOString().slice(0, 10),
      },
      kiriMoto: null,
      kiriMotoNote:
        'Kiri:Moto (MIT) is the port source for the engine (#957/#959); its CAM output on these meshes is stored in the `kiriMoto` slot of each fixture when the port lands. It has no drop-cutter entry point and its raster topography needs the full browser app, so no headless numbers were invented here.',
    },
  };
  const path = join(OUT, `${c.id}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${path}: ${measured.map((x) => `${x.shape} ${x.samples.length}`).join(', ')}`);
}
