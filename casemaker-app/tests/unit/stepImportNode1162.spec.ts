/**
 * #1162 — a STEP is readable through the app's own door under PLAIN Node/tsx.
 *
 * The Sample Bench harness (`tools/samples/run-gdrive-samples.mts`) is a tsx process with no Vite
 * transform. `stepMesh.ts` loaded the occt wasm with a `?url` dynamic import in one `Promise.all`
 * beside the module import, so the specifier was resolved even though Node discards its value:
 * Node's resolver reported `Cannot find package 'a'` (the tail of `…occt-import-js.wasm?url`) and
 * both STEP samples in the #1121 baseline failed at import. The fix mirrors #966's
 * `ManifoldRuntime.ts`: the `?url` import lives behind a browser-only branch that Node never
 * evaluates.
 *
 * The proof is a REAL SPAWNED CHILD, not an import: vitest resolves `?url` itself through Vite, so
 * only a plain tsx process reproduces the harness's loader (`tests/tools/tsxCli.ts`'s convention,
 * as #966 and #964 established). The child calls `stepToMesh` on the in-repo #873 STEP plate.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tsxArgs } from '../tools/tsxCli';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const HELPER = join(APP, 'tests', 'tools', 'stepReadNode.ts');
const STEP = join(APP, 'tests', 'fixtures', 'goals', 'step-accuracy.step');

interface ReadOut {
  ok: true;
  triangles: number;
  parts: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

describe('#1162 STEP import under plain Node/tsx', () => {
  it('reads the #873 STEP plate without touching the Vite-only ?url specifier', () => {
    const run = spawnSync(process.execPath, tsxArgs(HELPER, [STEP]), {
      cwd: APP,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const stderr = run.stderr ?? '';

    expect(run.status, `stderr:\n${stderr}`).toBe(0);
    // The exact failure a regression produces, named so it is unmistakable, not a timeout.
    expect(stderr).not.toContain("Cannot find package 'a'");
    expect(stderr).not.toContain('?url');

    const out = JSON.parse((run.stdout ?? '').trim()) as ReadOut;
    expect(out.ok).toBe(true);
    expect(out.parts).toBe(1);
    expect(out.triangles).toBeGreaterThan(0);
    // The #873 solid: a 60 x 40 x 10 mm plate with a 2 mm dome standing off the top.
    expect(out.bbox.max[0] - out.bbox.min[0]).toBeCloseTo(60, 1);
    expect(out.bbox.max[1] - out.bbox.min[1]).toBeCloseTo(40, 1);
    expect(out.bbox.max[2] - out.bbox.min[2]).toBeCloseTo(12, 1);
  }, 180_000);
});
