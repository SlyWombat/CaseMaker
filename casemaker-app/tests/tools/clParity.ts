/**
 * #964 — THE CL-SURFACE PARITY FIXTURES' COMPARATOR.
 *
 * #957's engine computes a cutter-location surface by dropping flat, ball, bull and V cutters on
 * triangles. The reference numbers in `tests/unit/fixtures/parity/cl/` were generated once on
 * three small analytic meshes (plane, ramp, step) by TWO independent implementations:
 *   - OpenCamLib (LGPL) — all four cutters, `samples`;
 *   - PyCAM (GPL-3.0) — flat, ball and bull, `pycamSamples` (a V cutter is OCL-only).
 * Both are numbers-only columns: no third-party code is copied or linked into the product. This module loads a
 * fixture and compares a candidate CL surface with it at the fixture's own sample points, within
 * the stated tolerance (one grid cell).
 *
 * The comparator is deliberately independent of the engine: the spec hands it a `(x, y) => z`
 * function, so the same code will judge #957's implementation, a ported Kiri:Moto surface, or the
 * analytic check that validates the fixture itself.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CL_FIXTURES_DIR = resolve(HERE, '..', 'unit', 'fixtures', 'parity', 'cl');

export interface ClSample {
  x: number;
  y: number;
  z: number | null;
}

export interface ClCutterFixture {
  /** `flat`, `ball`, `bull`, `v90` — the cutter the samples were dropped with. */
  shape: string;
  diameterMm: number;
  cornerRadiusMm?: number;
  angleDeg?: number;
  lengthMm?: number;
  /** OpenCamLib's drop at each grid point. */
  samples: ClSample[];
  /** PyCAM's drop at the same points (flat, ball, bull); null for the V cutter. */
  pycamSamples?: ClSample[] | null;
}

export interface ClFixture {
  id: string;
  description: string;
  mesh: { vertices: [number, number, number][]; triangles: [number, number, number][] };
  grid: { x0: number; x1: number; y0: number; y1: number; stepMm: number };
  cutters: ClCutterFixture[];
  tolerance: { withinGridCells: number; note: string };
  provenance: {
    opencamlib?: Record<string, string>;
    pycam?: Record<string, string> | null;
    kiriMoto?: Record<string, string> | null;
    kiriMotoNote?: string;
  };
}

export function loadClFixture(path: string): ClFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as ClFixture;
}

/** Every fixture in the directory, by id. */
export function loadClFixtures(dir: string = CL_FIXTURES_DIR): ClFixture[] {
  return ['plane', 'ramp', 'step'].map((id) => loadClFixture(join(dir, `${id}.json`)));
}

export interface ClMismatch {
  shape: string;
  x: number;
  y: number;
  referenceZ: number | null;
  candidateZ: number | null;
  delta: number | null;
}

export interface ClComparison {
  fixture: string;
  shape: string;
  samples: number;
  mismatches: ClMismatch[];
  maxDeltaMm: number;
  /** TRUE when every sample with a reference value agrees within the tolerance. */
  ok: boolean;
}

/**
 * Compare a candidate CL surface with one cutter's fixture samples.
 *
 * `candidate(x, y)` returns the CL height at that XY, or `null` where the engine states it cannot
 * compute one. A reference null (the library could not drop the cutter there) is skipped; a
 * candidate null where the reference has a value is a mismatch.
 *
 * `source` picks WHICH reference column: `opencamlib` (all cutters) or `pycam` (flat, ball, bull).
 * The two columns agree within one grid cell on every sample (a spec holds that), so either is a
 * fair judge of the engine; a disagreement between them is a reference problem, not an engine one.
 */
export function compareClSurface(
  fixture: ClFixture,
  shape: string,
  candidate: (x: number, y: number) => number | null,
  toleranceMm: number = fixture.grid.stepMm * fixture.tolerance.withinGridCells,
  source: 'opencamlib' | 'pycam' = 'opencamlib',
): ClComparison {
  const cutter = fixture.cutters.find((c) => c.shape === shape);
  if (cutter === undefined) {
    return {
      fixture: fixture.id,
      shape,
      samples: 0,
      mismatches: [{ shape, x: 0, y: 0, referenceZ: null, candidateZ: null, delta: null }],
      maxDeltaMm: Number.POSITIVE_INFINITY,
      ok: false,
    };
  }
  const samples = source === 'pycam' ? (cutter.pycamSamples ?? []) : cutter.samples;
  const mismatches: ClMismatch[] = [];
  let maxDelta = 0;
  let counted = 0;
  for (const sample of samples) {
    if (sample.z === null) continue;
    counted++;
    const z = candidate(sample.x, sample.y);
    const delta = z === null ? null : Math.abs(z - sample.z);
    if (delta === null) {
      mismatches.push({ shape, x: sample.x, y: sample.y, referenceZ: sample.z, candidateZ: null, delta: null });
      continue;
    }
    maxDelta = Math.max(maxDelta, delta);
    if (delta > toleranceMm + 1e-9) {
      mismatches.push({ shape, x: sample.x, y: sample.y, referenceZ: sample.z, candidateZ: z, delta });
    }
  }
  return {
    fixture: fixture.id,
    shape,
    samples: counted,
    mismatches,
    maxDeltaMm: maxDelta,
    ok: mismatches.length === 0,
  };
}
