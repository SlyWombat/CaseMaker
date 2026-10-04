// Causal-checkpoint counts per corpus file: parseGcode + buildTimeline, no wasm.
// Usage: npx tsx --tsconfig tsconfig.scripts.json probe-checkpoints.mts <file-or-dir>...
// Paths are relative to reference-gcode/; a directory is expanded to its .nc files.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { parseGcode, buildTimeline, stubSetup, Z1 } from '@/engine/cnc';

const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 100] as [number, number] }, thickness: 5 };
const hold = { kind: 'tape-down' as const, contact: part.outline };

const files = process.argv.slice(2).flatMap((a) =>
  statSync(`reference-gcode/${a}`).isDirectory()
    ? readdirSync(`reference-gcode/${a}`).filter((f) => f.endsWith('.nc')).map((f) => `${a}/${f}`)
    : [a],
);
for (const f of files) {
  const text = readFileSync(`reference-gcode/${f}`, 'utf8');
  const tl = buildTimeline(parseGcode(text), stubSetup(part, hold, {}, Z1), Z1);
  const zs = new Set(tl.checkpoints.map((c) => c.zKey));
  const largest = tl.checkpoints.reduce((a, c) => Math.max(a, c.steps.length), 0);
  console.log(`${f}\tcuts=${tl.summary.cuttingMoves}\tdistinctZ=${zs.size}\tcheckpoints=${tl.checkpoints.length}\tlargest=${largest}`);
}
