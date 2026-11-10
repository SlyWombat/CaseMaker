/**
 * #1162 — read one STEP file through the app's own importer under PLAIN Node/tsx.
 *
 * The Sample Bench harness (`tools/samples/run-gdrive-samples.mts`) is a tsx process: there is no
 * Vite transform, so `stepMesh.ts`'s `?url` wasm import must never be evaluated there. This helper
 * is spawned by `tests/unit/stepImportNode1162.spec.ts` as the real proof — it imports and CALLS
 * the importer exactly as the harness does, then prints the mesh facts as one JSON line.
 *
 *   node --import tsx tests/tools/stepReadNode.ts <file.step>
 */
import { readFileSync } from 'node:fs';

import { stepToMesh } from '@/engine/import/stepMesh';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: stepReadNode.ts <file.step>');
  process.exit(2);
}

try {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const read = await stepToMesh(buffer);
  console.log(JSON.stringify({ ok: true, triangles: read.mesh.triangleCount, parts: read.parts, bbox: read.mesh.bbox }));
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
