// Re-export named rack parts from the mini-rack template as ASCII STL into
// samples/, matching the app's export naming.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { compileProject } from '../src/engine/compiler/ProjectCompiler';
import { executeOpSync } from '../src/workers/geometry/evaluateOp';
import { buildAsciiStl } from '../src/workers/export/stlAscii';
import { findTemplate } from '../src/library/templates';
import type { Project } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', '..', 'samples');
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

const tpl = findTemplate('mini-rack-10in')!;
const proj = tpl.build() as Project;
// The one-piece exports are opt-in; turn them on so the frame is emitted.
const rack = (proj.case as { rack?: Record<string, unknown> }).rack;
if (rack) rack.assembledExport = true;
const plan = compileProject(proj);

const WANTED = process.argv.slice(2);
for (const node of plan.nodes) {
  if (WANTED.length && !WANTED.some((w) => node.id === w)) continue;
  const m = executeOpSync(tl, node.op);
  const mesh = m.getMesh();
  const stl = buildAsciiStl(
    [{ positions: new Float32Array(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts) }],
    node.id,
  );
  const out = join(samples, `Mini_rack_10_-${node.id}.ascii.stl`);
  writeFileSync(out, stl);
  console.log(`${node.id.padEnd(24)} ${(stl.length / 1048576).toFixed(2)} MB  -> ${out.split('samples/')[1]}`);
  m.delete();
}
