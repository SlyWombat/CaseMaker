// A Case Maker job from a maker's SVG outline, through the app's own importer (#955, reference cards).
// usage: cd <repo>/casemaker-app && npx tsx --tsconfig tsconfig.app.json <this> \
//          <appDir> <outline.svg> <out.job.json> <stock.json>
// The stock JSON: {length,width,thickness,material,toolKey,hold:{...}}. The SVG's stroke paths become
// `line` traces at the stated depth, which is how Studio engraves a mandala: cut along the drawing.
import { readFileSync, writeFileSync } from 'node:fs';

const [appDir, svgPath, outPath, stockPath] = process.argv.slice(2);
if (!appDir || !svgPath || !outPath || !stockPath) {
  console.error('usage: svg-design-job.mts <appDir> <outline.svg> <out.job.json> <stock.json>');
  process.exit(2);
}
await import(appDir + '/scripts/lib/casemaker/nodeTarget.ts');
// The app's SVG reader uses DOMParser (browser); Node needs the dev dependency's implementation.
const { JSDOM } = await import(appDir + '/node_modules/jsdom/lib/api.js');
(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM().window.DOMParser;
const { parseSvgOutline } = await import(appDir + '/src/engine/import/outlineImport.ts');
const { toLineTraces } = await import(appDir + '/src/engine/import/outlineImport.ts');

const text = readFileSync(svgPath, 'utf8');
const parsed = parseSvgOutline(text, svgPath.split('/').pop());
if (!parsed.ok) {
  console.error('the app refused the SVG:', JSON.stringify(parsed));
  process.exit(1);
}
const o = parsed.outline;
const spec = JSON.parse(readFileSync(stockPath, 'utf8'));
const cx = spec.length / 2, cy = spec.width / 2;
const traces = toLineTraces(o, {
  position: { x: cx, y: cy }, depth: spec.depth, idFor: (i) => `svg-line-${i + 1}`, name: 'makera-outline',
});
// A maker's drawing is not always cut at the drawing's own size: `scale` fits it to the vendor's
// own cut (stated on the card), keeping the centred frame.
const s = Number(spec.scale ?? 1);
if (s !== 1) for (const t of traces) t.points = t.points.map(([x, y]) => [x * s, y * s] as [number, number]);
const job = {
  schemaVersion: 3,
  name: spec.name ?? 'SVG outline reference',
  machineId: 'Z1',
  stock: { length: spec.length, width: spec.width, thickness: spec.thickness, material: spec.material },
  labels: [],
  toolKey: spec.toolKey ?? '',
  minFloor: 1,
  edgeMargin: 1,
  customFonts: [],
  sacrificial: { under: null, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
  breakthrough: 0.3,
  jawClearance: 1,
  shapes: [],
  traces,
  workholding: spec.hold,
  targetObject: undefined as unknown,
};
delete (job as Record<string, unknown>).targetObject;
writeFileSync(outPath, JSON.stringify(job, null, 1));
console.log(JSON.stringify({ contours: o.contours.length, paths: (o.paths ?? []).length, traces: traces.length,
  width: o.width, height: o.height, notes: o.notes }));
