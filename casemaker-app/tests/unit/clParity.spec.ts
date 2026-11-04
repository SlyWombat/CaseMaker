/**
 * #964 — THE CL-SURFACE PARITY FIXTURES.
 *
 * Three analytic meshes — a horizontal plane, a 26.57° ramp and a two-level step — dropped with
 * flat, ball, bull and 90° V cutters. Two independent implementations produced the reference
 * numbers: OpenCamLib (LGPL; all four cutters) and PyCAM (GPL-3.0; flat, ball and bull). Both are
 * NUMBERS-ONLY columns: no third-party code is in this tree, and neither library is a dependency.
 *
 * Proven here today:
 *   1. the fixtures are internally consistent (grid coverage, valid meshes, provenance, licences);
 *   2. on the planar ramp the numbers equal the closed-form drop-cutter answers;
 *   3. the two references agree to 0.001 mm at every sample — so either can judge the engine, and
 *      a divergence between them is a reference problem, not an engine one.
 *
 * THE Z TOLERANCE IS 0.001 mm (the XY placement is the fixtures' own grid points, exact by
 * construction). B measured `dropCutterHeight`'s per-facet barycentric sampling reading
 * 0.007-0.09 mm LOW on large facets for a ball, which the old one-grid-cell tolerance could not
 * see. When B's engine module exists (`src/engine/cnc/cam/model/dropcutter.ts`), the spec runs
 * `tests/tools/cl-engine-check.ts` through tsx and requires it to agree on every fixture and
 * cutter; on main the module is absent and the case skips.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { compareClSurface, loadClFixtures, type ClFixture } from '../tools/clParity';
import { tsxArgs } from '../tools/tsxCli';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const DROPCUTTER = join(APP, 'src', 'engine', 'cnc', 'cam', 'model', 'dropcutter.ts');
const HAVE_ENGINE = existsSync(DROPCUTTER);
const ENGINE_CHECK = join(APP, 'tests', 'tools', 'cl-engine-check.ts');

const fixtures = loadClFixtures();
const byId = (id: string): ClFixture => {
  const found = fixtures.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
};

const gridPoints = (f: ClFixture): number => {
  const nx = Math.round((f.grid.x1 - f.grid.x0) / f.grid.stepMm) + 1;
  const ny = Math.round((f.grid.y1 - f.grid.y0) / f.grid.stepMm) + 1;
  return nx * ny;
};

describe('#964 the CL fixtures are well formed', () => {
  it('carries the three meshes and four cutters each', () => {
    expect(fixtures.map((f) => f.id)).toEqual(['plane', 'ramp', 'step']);
    for (const f of fixtures) {
      expect(f.cutters.map((c) => c.shape)).toEqual(['flat', 'ball', 'bull', 'v90']);
      expect(f.tolerance.zMm).toBe(0.001);
      expect(f.tolerance.withinGridCells).toBe(1);
      expect(f.grid.stepMm).toBe(1);
    }
  });

  it('samples exactly the grid, with valid triangle indices', () => {
    for (const f of fixtures) {
      const expected = gridPoints(f);
      const n = f.mesh.vertices.length;
      for (const [a, b, c] of f.mesh.triangles) {
        expect(Math.min(a, b, c)).toBeGreaterThanOrEqual(0);
        expect(Math.max(a, b, c)).toBeLessThan(n);
      }
      const xs = f.cutters[0]!.samples.map((s) => s.x);
      expect(new Set(xs).size).toBe(Math.round((f.grid.x1 - f.grid.x0) / f.grid.stepMm) + 1);
      for (const cutter of f.cutters) {
        expect(cutter.samples).toHaveLength(expected);
        expect(cutter.samples.every((s) => s.z === null || Number.isFinite(s.z))).toBe(true);
        // OpenCamLib covers every cutter; PyCAM has no cone, so the V cutter is OCL-only.
        if (cutter.shape === 'v90') {
          expect(cutter.pycamSamples ?? null).toBeNull();
        } else {
          expect(cutter.pycamSamples).toHaveLength(expected);
          expect(cutter.pycamSamples!.every((s) => s.z === null || Number.isFinite(s.z))).toBe(true);
        }
      }
    }
  });

  it('states both licence boundaries and the Kiri:Moto slot', () => {
    for (const f of fixtures) {
      const ocl = f.provenance.opencamlib;
      expect(ocl).toBeDefined();
      expect(ocl!['licence']).toContain('NUMBERS ONLY');
      expect(ocl!['library']).toBe('OpenCamLib');
      const pycam = f.provenance.pycam;
      expect(pycam).toBeDefined();
      expect(pycam!['licence']).toContain('NUMBERS ONLY');
      expect(pycam!['licence']).toContain('GPL-3.0');
      expect(pycam!['version']).toBe('0.6.4');
      expect(f.provenance.kiriMoto).toBeNull();
      expect(f.provenance.kiriMotoNote).toContain('Kiri:Moto');
    }
  });
});

describe('#964 the two references agree to 0.001 mm', () => {
  for (const fixture of fixtures) {
    for (const cutter of fixture.cutters) {
      if (cutter.pycamSamples === null || cutter.pycamSamples === undefined) continue;
      const pycam = new Map(cutter.pycamSamples.map((s) => [`${s.x},${s.y}`, s.z]));
      it(`${fixture.id} ${cutter.shape}: OpenCamLib vs PyCAM`, () => {
        const result = compareClSurface(fixture, cutter.shape, (x, y) => pycam.get(`${x},${y}`) ?? null, undefined, 'opencamlib');
        expect(result.ok).toBe(true);
        expect(result.samples).toBe(gridPoints(fixture));
      });
    }
  }
});

describe('#964 the ramp fixtures equal the closed-form answers', () => {
  // The ramp is a plane z = 0.5 x with a 26.57° slope. For a cutter wholly on the plane:
  //   flat — the disc's highest touched point is the uphill rim: z = 0.5x + R·0.5;
  //   ball — the sphere touches the plane at distance r from its centre: z = 0.5x + r(√(1.25) − 1).
  const R = 3;
  const flat = (x: number): number => 0.5 * x + R * 0.5;
  const ball = (x: number): number => 0.5 * x + R * (Math.sqrt(1.25) - 1);

  it('flat and ball agree to 1e-5 mm on every sample', () => {
    const ramp = byId('ramp');
    const flatCutter = ramp.cutters.find((c) => c.shape === 'flat')!;
    const ballCutter = ramp.cutters.find((c) => c.shape === 'ball')!;
    for (const s of flatCutter.samples) {
      if (s.z === null) continue;
      expect(Math.abs(s.z - flat(s.x))).toBeLessThan(1e-5);
    }
    for (const s of ballCutter.samples) {
      if (s.z === null) continue;
      expect(Math.abs(s.z - ball(s.x))).toBeLessThan(1e-5);
    }
  });
});

describe('#964 the comparator', () => {
  const ramp = byId('ramp');
  const flatCutter = ramp.cutters.find((c) => c.shape === 'flat')!;
  const reference = new Map(flatCutter.samples.map((s) => [`${s.x},${s.y}`, s.z as number]));
  const exact = (x: number, y: number): number => reference.get(`${x},${y}`) as number;

  it('passes a candidate that matches the reference', () => {
    const result = compareClSurface(ramp, 'flat', exact);
    expect(result.ok).toBe(true);
    expect(result.maxDeltaMm).toBeCloseTo(0, 6);
    expect(result.samples).toBe(gridPoints(ramp));
  });

  it('passes at 0.001 mm and fails at 0.0011 mm', () => {
    const within = compareClSurface(ramp, 'flat', (x, y) => exact(x, y) + 0.001);
    expect(within.ok).toBe(true);
    expect(within.maxDeltaMm).toBeCloseTo(0.001, 6);

    const beyond = compareClSurface(ramp, 'flat', (x, y) => exact(x, y) + 0.0011);
    expect(beyond.ok).toBe(false);
    expect(beyond.mismatches.length).toBeGreaterThan(0);
    expect(beyond.mismatches[0]!.shape).toBe('flat');
  });

  it('judges against the PyCAM column too', () => {
    const pycam = new Map((flatCutter.pycamSamples ?? []).map((s) => [`${s.x},${s.y}`, s.z as number]));
    const result = compareClSurface(ramp, 'flat', (x, y) => pycam.get(`${x},${y}`) ?? null, undefined, 'pycam');
    expect(result.ok).toBe(true);
    expect(result.samples).toBe(gridPoints(ramp));
  });

  it('fails a candidate that states no height where the reference has one', () => {
    const result = compareClSurface(ramp, 'flat', () => null);
    expect(result.ok).toBe(false);
    expect(result.mismatches.every((m) => m.candidateZ === null && m.delta === null)).toBe(true);
  });

  it('skips the reference’s own nulls', () => {
    const synthetic: ClFixture = {
      ...ramp,
      cutters: [
        {
          shape: 'flat',
          diameterMm: 6,
          samples: [
            { x: 0, y: 0, z: 1.5 },
            { x: 1, y: 0, z: null },
          ],
        },
      ],
    };
    const result = compareClSurface(synthetic, 'flat', (x) => (x === 0 ? 1.5 : 999));
    expect(result.ok).toBe(true);
    expect(result.samples).toBe(1);
  });
});

// The rebuilt engine's own drop-cutter (#957). `cl-engine-check.ts` runs under tsx because this
// harness commit lives on main, where `cam/model/` does not exist yet: the module is loaded by a
// variable specifier there and the failure message names the offending samples.
describe.skipIf(!HAVE_ENGINE)('#964 the rebuilt engine’s drop-cutter agrees to 0.001 mm (#957)', () => {
  it('every fixture and cutter agrees with OpenCamLib and PyCAM at every sample', () => {
    // spawnSync, not execFileSync: a FAILING comparison exits non-zero, and the failure detail is
    // in its stdout — execFileSync would replace it with "Command failed". `process.execPath` +
    // tsx's CLI, never `npx.cmd`: the .cmd shim needs a shell on Windows (EINVAL on Node >=20.12).
    const run = spawnSync(process.execPath, tsxArgs(ENGINE_CHECK), {
      cwd: APP,
      encoding: 'utf8',
      env: process.env,
    });
    expect(run.error, String(run.error)).toBeUndefined();
    const out = run.stdout;
    expect(out, `cl-engine-check wrote no JSON; stderr:\n${run.stderr}`).toBeTruthy();
    const report = JSON.parse(out) as {
      available: boolean;
      ok: boolean;
      compared?: number;
      failures?: { fixture: string; shape: string; source: string; maxDeltaMm: number; first: unknown[] }[];
    };
    expect(report.available, 'the engine module is present, so the check must run').toBe(true);
    const detail = (report.failures ?? [])
      .map((f) => `${f.fixture}/${f.shape} vs ${f.source}: max ${f.maxDeltaMm} mm; ${JSON.stringify(f.first)}`)
      .join('\n');
    expect(report.ok, `CL parity failures:\n${detail}`).toBe(true);
  }, 120_000);
});
