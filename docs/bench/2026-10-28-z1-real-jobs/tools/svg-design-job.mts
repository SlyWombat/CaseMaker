// A Case Maker job from a maker's SVG outline, through the app's own importer (#955, reference cards).
// usage: cd <repo>/casemaker-app && npx tsx --tsconfig tsconfig.app.json <this> \
//          <appDir> <outline.svg> <out.job.json> <stock.json>
// The stock JSON: {length,width,thickness,material,toolKey,hold:{...}}.
// #968 — a stroke with a width imports as its painted BAND (a region): each band contour becomes one
// `vector` item. A zero/hairline stroke keeps the #664/#678 reading and becomes `line` traces.
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
const imp = await import(appDir + '/src/engine/import/outlineImport.ts');
const { parseSvgOutline, toLineTraces, toVectorShape } = imp;

const text = readFileSync(svgPath, 'utf8');
const spec = JSON.parse(readFileSync(stockPath, 'utf8'));
// An explicit stroke width on the root, for a drawing whose own default the importer and the vendor
// read differently (stated on the card). Absent in the spec = the file's own.
const svgText = spec.strokeWidth === undefined ? text
  : text.replace(/<svg\b([^>]*)>/, (_m, attrs) => `<svg${attrs.replace(/\sstroke-width="[^"]*"/g, '')} stroke-width="${spec.strokeWidth}">`);
const parsed = parseSvgOutline(svgText, svgPath.split('/').pop());
if (!parsed.ok) {
  console.error('the app refused the SVG:', JSON.stringify(parsed));
  process.exit(1);
}
const o = parsed.outline;
const cx = spec.length / 2, cy = spec.width / 2;
// A maker's drawing is not always cut at the drawing's own size: `scale` fits it to the vendor's
// own cut (stated on the card), keeping the centred frame.
const s = Number(spec.scale ?? 1);
const scaled = (rings: [number, number][][]) =>
  s === 1 ? rings : rings.map((r) => r.map(([x, y]) => [x * s, y * s] as [number, number]));
let traces = [];
let vectors = [];
const closedPaths = (o.paths ?? []).filter((p) => p.closed && p.points.length >= 3);
if ((o.contours ?? []).length > 0 && (o.paths ?? []).length === 0) {
  // #968 — one vector per band contour, so the design check measures each stroke's band on its own.
  // `dropLargest` leaves out the drawing's own frame: its path carries a scale-1 matrix, so its band
  // is not the same width as the strokes', and the vendor cuts that rim as a contour, not as engraving.
  let bands = o.contours;
  if (spec.dropLargest && bands.length > 1) {
    const box = (ring: [number, number][]) => {
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    let worst = 0;
    bands.forEach((ring, i) => { if (box(ring) > box(bands[worst]!)) worst = i; });
    bands = bands.filter((_r, i) => i !== worst);
  }
  vectors = bands.map((ring, i) => toVectorShape(
    { ...o, contours: [ring] },
    { id: `svg-band-${i + 1}`, position: { x: cx, y: cy }, depth: spec.depth, name: `band ${i + 1}` },
  )).map((v) => ({ ...v, contours: scaled(v.contours) }));
} else if (spec.regions && closedPaths.length === (o.paths ?? []).length) {
  // `regions` — a drawing of closed rings with a hairline stroke is the OUTLINE of areas (the badge's
  // two-colour pattern): the rings become ONE region read EvenOdd, so a ring inside another is a hole,
  // exactly as the vendor's 2D pocket sees it. One vector, one design item.
  vectors = [toVectorShape(
    { ...o, contours: closedPaths.map((p) => p.points as [number, number][]), fillRule: 'EvenOdd' },
    { id: 'svg-regions', position: { x: cx, y: cy }, depth: spec.depth, name: 'the drawn areas' },
  )].map((v) => ({ ...v, contours: scaled(v.contours), fillRule: 'EvenOdd' as const }));
} else {
  traces = toLineTraces(o, {
    position: { x: cx, y: cy }, depth: spec.depth, idFor: (i) => `svg-line-${i + 1}`, name: 'makera-outline',
  });
  if (s !== 1) for (const t of traces) t.points = t.points.map(([x, y]) => [x * s, y * s] as [number, number]);
}
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
  ...(vectors.length ? { vectors } : {}),
  ...(traces.length ? { traces } : {}),
  workholding: spec.hold,
  targetObject: undefined as unknown,
};
delete (job as Record<string, unknown>).targetObject;
writeFileSync(outPath, JSON.stringify(job, null, 1));
console.log(JSON.stringify({ contours: o.contours.length, paths: (o.paths ?? []).length, traces: traces.length,
  vectors: vectors.length, width: o.width, height: o.height, notes: o.notes }));
