// Bench helper (2026-10-28 second demo set): bring an outline in through the app's OWN importers,
// the same code the Design panel runs — parseOutlineFile for .svg/.dxf (#217), traceRaster for a
// bitmap (#252) — and print the OutlineImport as JSON, optionally scaled to a width in mm.
//   npx tsx --tsconfig tsconfig.scripts.json scripts/bench-import-outline.mts <file.svg|file.dxf> [widthMm]
//   npx tsx --tsconfig tsconfig.scripts.json scripts/bench-import-outline.mts <file.rgba> <w>x<h> [widthMm] [threshold] [invert]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { JSDOM } from 'jsdom';
(globalThis as any).DOMParser = new JSDOM('').window.DOMParser;
const { parseOutlineFile, scaleOutlineToWidth, traceRaster } = await import('../src/engine/import/outlineImport');
const args = process.argv.slice(2);
let r: any;
let width: string | undefined;
if (args[0]!.endsWith('.rgba')) {
  const [w, h] = args[1]!.split('x').map(Number);
  width = args[2];
  r = traceRaster(
    { width: w!, height: h!, data: new Uint8Array(readFileSync(args[0]!)) },
    { ...(args[3] ? { threshold: Number(args[3]) } : {}), ...(args[4] === 'invert' ? { invert: true } : {}) },
    basename(args[0]!),
  );
} else {
  width = args[1];
  r = parseOutlineFile(readFileSync(args[0]!, 'utf8'), basename(args[0]!));
}
if (!r.ok) { console.log(JSON.stringify({ ok: false, error: r.error })); process.exit(0); }
let o = r.outline;
if (width) o = scaleOutlineToWidth(o, Number(width));
console.log(JSON.stringify({ ok: true, outline: o }));
