/**
 * #966 — count a goal mesh's defects, and say whether the repair can close them.
 *
 * Every open (boundary) edge is a missing facet. The drop-cutter can take a neighbour's edge
 * contact there, which is lower than the true surface, so a mesh is either repaired by closing the
 * holes or refused by name — never planned as-is. This prints the counts `repairMesh` acts on, per
 * file: an STL, or a job JSON whose goal mesh is `targetObject.data` (base64 STL).
 *
 *   npx tsx --tsconfig tsconfig.tests.json tests/tools/mesh-defects.ts <file>...
 *
 * Exit code 1 if any file is refused.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import ManifoldModule, { type ManifoldToplevel } from 'manifold-3d';

import { parseStl } from '../../src/engine/import/stlParser';
import { DEFAULT_FEATURE_TOLERANCES } from '../../src/engine/cnc/cam/model/features/patches';
import { repairMesh } from '../../src/engine/cnc/cam/model/features/tree';

const require = createRequire(import.meta.url);

async function manifold(): Promise<ManifoldToplevel> {
  const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
  tl.setup();
  return tl;
}

function stlBytes(file: string): ArrayBuffer {
  let bytes: Buffer;
  if (path.extname(file).toLowerCase() === '.json') {
    const data = (JSON.parse(readFileSync(file, 'utf8')) as { targetObject?: { data?: unknown } }).targetObject
      ?.data;
    if (typeof data !== 'string') throw new Error(`${path.basename(file)}: the job carries no targetObject.data`);
    bytes = Buffer.from(data, 'base64');
  } else {
    bytes = readFileSync(file);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const tl = await manifold();
let refused = 0;
for (const file of process.argv.slice(2)) {
  const name = path.basename(file);
  try {
    const mesh = parseStl(stlBytes(file));
    const repair = repairMesh(tl, mesh, DEFAULT_FEATURE_TOLERANCES.weldMm);
    const outcome =
      repair.openEdges === 0
        ? 'already closed — plans as-is'
        : `REPAIRED: ${repair.cappedLoops} hole loop(s) closed before planning`;
    console.log(
      `${name}: ${mesh.triangleCount} triangle(s), ${repair.openEdges} open edge(s), ` +
        `${repair.degenerateTriangles} degenerate triangle(s) — ${outcome}`,
    );
  } catch (err) {
    refused++;
    console.log(`${name}: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exitCode = refused > 0 ? 1 : 0;
