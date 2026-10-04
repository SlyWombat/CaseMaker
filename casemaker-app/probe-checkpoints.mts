// Causal-checkpoint counts per corpus file: parseGcode + buildTimeline, no wasm.
import { readFileSync } from 'node:fs';
import { parseGcode, buildTimeline, stubSetup, Z1 } from '@/engine/cnc';

const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 100] as [number, number] }, thickness: 5 };
const hold = { kind: 'tape-down' as const, contact: part.outline };

for (const f of process.argv.slice(2)) {
  const text = readFileSync(`reference-gcode/${f}`, 'utf8');
  const tl = buildTimeline(parseGcode(text), stubSetup(part, hold, {}, Z1), Z1);
  const zs = new Set(tl.checkpoints.map((c) => c.zKey));
  const largest = tl.checkpoints.reduce((a, c) => Math.max(a, c.steps.length), 0);
  console.log(`${f}\tcuts=${tl.summary.cuttingMoves}\tdistinctZ=${zs.size}\tcheckpoints=${tl.checkpoints.length}\tlargest=${largest}`);
}
