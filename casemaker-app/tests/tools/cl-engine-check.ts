/**
 * #964 — THE REBUILT ENGINE'S DROP-CUTTER, CHECKED AGAINST THE COMMITTED CL FIXTURES.
 *
 * `tests/unit/clParity.spec.ts` spawns this script when the engine's `cam/model/dropcutter.ts`
 * exists (it does on B's `957-cl-surface` branch, not on main). Keeping the engine behind a
 * subprocess means the harness commit on main typechecks and runs without the module, while the
 * same commit is red-first on the engine branch: `dropCutterHeight`'s per-facet barycentric
 * sampling read 0.007-0.09 mm LOW on the large facets for a ball, which the old one-grid-cell
 * tolerance could not see. This script compares every fixture and cutter against BOTH reference
 * columns at the fixtures' own sample points with the fixtures' 0.001 mm Z tolerance.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/cl-engine-check.ts
 *
 * Prints one JSON line: `{ available, ok, failures: [...] }`. Exit 0 when available and ok,
 * 1 when a comparison failed, 0 with `available: false` when the engine module is absent.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { compareClSurface, loadClFixtures, type ClCutterFixture, type ClFixture } from './clParity';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const DROPCUTTER = join(APP, 'src', 'engine', 'cnc', 'cam', 'model', 'dropcutter.ts');

interface EngineModule {
  profileOf: (tool: Tool) => unknown | null;
  dropCutterHeight: (
    profile: unknown,
    mesh: { positions: Float32Array | number[]; indices: Uint32Array | number[]; triangleCount: number },
    x: number,
    y: number,
  ) => number | null;
}

interface Failure {
  fixture: string;
  shape: string;
  source: 'opencamlib' | 'pycam';
  maxDeltaMm: number;
  samples: number;
  first: { x: number; y: number; referenceZ: number | null; candidateZ: number | null; delta: number | null }[];
}

const meshOf = (fixture: ClFixture): { positions: Float32Array; indices: Uint32Array; triangleCount: number } => ({
  positions: Float32Array.from(fixture.mesh.vertices.flat()),
  indices: Uint32Array.from(fixture.mesh.triangles.flat()),
  triangleCount: fixture.mesh.triangles.length,
});

/** The fixture cutter as the app's own `Tool` record, so `profileOf` reads the same geometry the
 * app would. The V fixture is a 90° included cone with an apex (tip 0), matching OpenCamLib's
 * `ConeCutter(diameter, π/4, length)` the numbers were generated with. */
function toolFor(cutter: ClCutterFixture): Tool {
  const base = flatEndMill(cutter.diameterMm, { number: 3, name: cutter.shape });
  if (cutter.shape === 'ball') return { ...base, shape: 'ball' };
  if (cutter.shape === 'bull') return { ...base, shape: 'bull', cornerRadius: cutter.cornerRadiusMm ?? 1 };
  if (cutter.shape === 'v90') {
    return {
      ...base,
      typeText: 'V-Bit',
      shape: 'chamfer',
      tipDiameter: 0,
      angle: cutter.angleDeg ?? 90,
      halfAngle: (cutter.angleDeg ?? 90) / 2,
    };
  }
  return base;
}

async function main(): Promise<number> {
  if (!existsSync(DROPCUTTER)) {
    process.stdout.write(`${JSON.stringify({ available: false })}\n`);
    return 0;
  }
  // A VARIABLE specifier on purpose: the module does not exist on main, so a literal import would
  // fail the harness commit's own typecheck. tsx resolves the file URL's TS and its `@/` imports.
  const specifier = pathToFileURL(DROPCUTTER).href;
  const engine = (await import(specifier)) as EngineModule;
  const fixtures = loadClFixtures();
  const failures: Failure[] = [];
  let compared = 0;

  for (const fixture of fixtures) {
    const mesh = meshOf(fixture);
    for (const cutter of fixture.cutters) {
      const profile = engine.profileOf(toolFor(cutter));
      if (profile === null) {
        failures.push({
          fixture: fixture.id,
          shape: cutter.shape,
          source: 'opencamlib',
          maxDeltaMm: Number.POSITIVE_INFINITY,
          samples: 0,
          first: [],
        });
        continue;
      }
      const candidate = (x: number, y: number): number | null => engine.dropCutterHeight(profile, mesh, x, y);
      const sources: ('opencamlib' | 'pycam')[] = ['opencamlib'];
      if (cutter.pycamSamples !== null && cutter.pycamSamples !== undefined) sources.push('pycam');
      for (const source of sources) {
        const result = compareClSurface(fixture, cutter.shape, candidate, undefined, source);
        compared++;
        if (!result.ok) {
          failures.push({
            fixture: fixture.id,
            shape: cutter.shape,
            source,
            maxDeltaMm: result.maxDeltaMm,
            samples: result.samples,
            first: result.mismatches.slice(0, 5).map((m) => ({
              x: m.x,
              y: m.y,
              referenceZ: m.referenceZ,
              candidateZ: m.candidateZ,
              delta: m.delta,
            })),
          });
        }
      }
    }
  }

  const ok = failures.length === 0;
  process.stdout.write(`${JSON.stringify({ available: true, ok, compared, failures })}\n`);
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stdout.write(`${JSON.stringify({ available: true, ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  },
);
