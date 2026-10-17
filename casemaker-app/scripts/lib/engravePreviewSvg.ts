// The predicted cut, drawn to scale at the REAL cutter width (#410).
//
// The reachability table says what PERCENT of a region a bit can open. That number is true and it is
// not what an operator wants to look at before clamping a blank: a share does not show WHICH strokes
// survive, and the thing that decides whether a badge reads is exactly that. So this draws two
// outlines on top of each other in the stock's own frame — the region the project file asked for,
// and the region a cutter of this diameter actually opens — and the eye does the rest.
//
// PURE, and deliberately so: everything it needs is handed in as plain data — the opened polygons
// and the void footprints both come off the EVALUATED plan (`engraveRegions`), so a preview can be
// rendered in a test without wasm and the picture cannot disagree with the program about where a
// cut is or where a void is.
//
// It is a 2D plan view, not a 3D render: the question here is coverage at a cutter width, which is a
// question about a plane, and the panel's own 3D preview is the place to see the floors.

import type { EngraveJob } from '@/types/engraveJob';

/** One item's opened region, at the real cutter radius — `engraveCutRegions`' `CutRegion`. */
export interface PreviewCut {
  id: string;
  name?: string;
  /** Positive mm below the top face. */
  depth: number;
  /** Outer CCW, holes CW, in the stock frame. */
  polygons: [number, number][][];
}

/**
 * An under-surface void's footprint, already resolved to rings — `plan.stock.keepOuts[].footprint`
 * through `executeProfile`, which is where a keep-out's four kinds (rect, circle, slot, polygon) and
 * its rotation are turned into geometry ONCE, by the app, for both the depth limit and this picture.
 *
 * Handed in rather than derived from `job.keepOuts` here for exactly that reason: a second,
 * local drawing of "what a rounded rect is" would ignore `rotation`, have no answer for a circle or
 * a slot, and quietly draw nothing for them.
 */
export interface PreviewVoid {
  id: string;
  name?: string;
  polygons: [number, number][][];
}

export interface EngravePreviewSvgInput {
  job: EngraveJob;
  /** What the cutter really opens, per item. */
  cuts: readonly PreviewCut[];
  /** The cutting diameter the picture is drawn at, mm — or null when the job names no usable cutter. */
  diameter: number | null;
  /** Share of each item's ideal area the cutter opens, 0…1, by item id. */
  ratios?: ReadonlyMap<string, number>;
  /** The job's declared voids, as footprint rings. */
  keepOuts?: readonly PreviewVoid[];
}

/**
 * Pixels per millimetre. The blank of #165's badge is 76.2 mm on its long side, so this lands that
 * side near 1100 px — big enough to see a 0.6 mm stroke without the file being unusable.
 */
const SCALE = 14;

/**
 * Margin around the drawn geometry, mm. The side pads are for the caption, which is set at the
 * blank's own X=0 and has to FIT inside the picture — a caption that runs off the edge is worse
 * than no caption, because it looks like the picture ends where the text does. The pads in Y are the
 * two directions of the blank: `PAD_BACK` beyond the far (+Y) edge carries the title and the
 * caption, `PAD_FRONT` beyond the near (Y = 0) edge is breathing room.
 *
 * Careful with the SIGN: this document's page y is `−job y` (the same flip
 * `runSheetDiagramSvg` uses), so the far edge of the blank is at page y = `−width` and the title
 * above it is at `−width − n`.
 */
const PAD_LEFT = 16;
const PAD_RIGHT = 16;
const PAD_FRONT = 9;
const PAD_BACK = 22;

/** The palette, as the run sheet's diagram uses one: recess light, cut dark, keep-out red. */
const INK_IDEAL = '#c8ccd2';
const INK_CUT = '#1b232c';
const INK_KEEP_OUT = '#a00';
const INK_STOCK = '#9aa3ad';
const INK_GRID = '#e7eaee';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A millimetre figure with no float noise: 0.6, 38.1, 3.81. */
function mm(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** A point in an item's own contour frame, placed in the stock frame — rotate, then translate. */
function place(
  p: [number, number],
  position: { x: number; y: number },
  rotationDeg: number,
): [number, number] {
  const a = (rotationDeg * Math.PI) / 180;
  const [x, y] = p;
  return [x * Math.cos(a) - y * Math.sin(a) + position.x, x * Math.sin(a) + y * Math.cos(a) + position.y];
}

/** A ring as an SVG path, using the job→page flip that `runSheetDiagramSvg` uses: page y = −job y. */
function ringPath(ring: readonly [number, number][]): string {
  if (ring.length === 0) return '';
  const parts = ring.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${mm(x)},${mm(-y)}`);
  return `${parts.join('')}Z`;
}

/** An item's ideal region: its own outline, where the job puts it, and whether it is being cut. */
interface IdealItem {
  id: string;
  name: string;
  /** False for an item the job carries but does not cut — drawn as an outline, and named as such. */
  enabled: boolean;
  rings: [number, number][][];
}

/**
 * The ideal regions: every imported item's OWN contours, placed where the job puts it.
 *
 * Only the vector items have rings to draw — a label's ideal glyph is a font outline this module
 * has no business re-typesetting, and on the design route (#410) every region IS an imported
 * outline, which is the case this picture exists for.
 *
 * A DISABLED item is drawn too, deliberately. The design route turns a region off when no cutter on
 * the bench can reach it (#410), and hiding it would be the one lie this picture must not tell: the
 * file asked for it, the operator is about to clamp the blank, and "the subtitle is not cut at all"
 * is the fact they most need to see. It gets a hollow outline and the word `not cut`.
 */
function idealItems(job: EngraveJob): IdealItem[] {
  return (job.vectors ?? []).map((v) => ({
    id: v.id,
    name: v.name !== undefined && v.name !== '' ? v.name : v.id,
    enabled: v.enabled,
    rings: v.contours.map((ring) => ring.map((p) => place(p, v.position, v.rotation))),
  }));
}

/** The centre of a set of rings, in the stock frame — where an item's label goes. */
function ringCentre(rings: readonly [number, number][][]): [number, number] | null {
  const pts = rings.flat();
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** `100 %`, or `—` when the item was never measured. */
function pct(ratio: number | undefined): string {
  return ratio === undefined ? '—' : `${Math.round(ratio * 100)} %`;
}

/**
 * An average advance width for the label font, in ems. The browser lays the text out; this is used
 * ONLY to decide whether a centred label would run off the page, so an approximate figure is right
 * for the job — a label moved a millimetre more than it had to be is still fully readable.
 */
const LABEL_ADVANCE_EM = 0.55;

/**
 * A centred label, kept inside the picture (#437).
 *
 * Labels are set at their item's box centre, and a rest program's items are small regions near the
 * blank's edge carrying long names (`rest of (Like the Whiskey)`). Centred there, the text ran past
 * the SVG viewport and the rasteriser CLIPPED it mid-word — the PNG then read as if the item's name
 * simply stopped. The label is moved just far enough to fit, and shrunk when it could not fit at
 * all; it is still centred in its item's box whenever the page has room for it.
 */
function fitLabel(
  centreX: number,
  text: string,
  fontSize: number,
  minX: number,
  maxX: number,
): { x: number; size: number } {
  const usable = maxX - minX;
  const needed = Math.max(text.length * LABEL_ADVANCE_EM * fontSize, 0);
  const size = needed > usable ? (usable / Math.max(text.length * LABEL_ADVANCE_EM, 1)) : fontSize;
  const half = (text.length * LABEL_ADVANCE_EM * size) / 2;
  return { x: Math.min(Math.max(centreX, minX + half), maxX - half), size };
}

/** The whole picture, as one standalone SVG document. */
export function engravePreviewSvg(input: EngravePreviewSvgInput): string {
  const { job, cuts, diameter, ratios } = input;
  const { length, width } = job.stock;
  const x0 = -PAD_LEFT;
  const y0 = -(width + PAD_BACK);
  const vw = length + PAD_LEFT + PAD_RIGHT;
  const vh = width + PAD_FRONT + PAD_BACK;

  const ideal = idealItems(job);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(vw * SCALE)}" ` +
      `height="${Math.round(vh * SCALE)}" viewBox="${mm(x0)} ${mm(y0)} ${mm(vw)} ${mm(vh)}" ` +
      `font-family="ui-sans-serif, Segoe UI, system-ui, sans-serif">`,
  );
  parts.push(`<rect x="${mm(x0)}" y="${mm(y0)}" width="${mm(vw)}" height="${mm(vh)}" fill="#fff" />`);

  // The blank, and a 5 mm grid so a stroke has a size the eye can read without a ruler.
  parts.push(
    `<rect x="0" y="${mm(-width)}" width="${mm(length)}" height="${mm(width)}" ` +
      `fill="#fbfcfd" stroke="${INK_STOCK}" stroke-width="0.25" />`,
  );
  for (let gx = 5; gx < length; gx += 5) {
    parts.push(`<line x1="${mm(gx)}" y1="${mm(-width)}" x2="${mm(gx)}" y2="0" stroke="${INK_GRID}" stroke-width="0.12" />`);
  }
  for (let gy = 5; gy < width; gy += 5) {
    parts.push(`<line x1="0" y1="${mm(-gy)}" x2="${mm(length)}" y2="${mm(-gy)}" stroke="${INK_GRID}" stroke-width="0.12" />`);
  }

  // The declared voids, so the picture shows what the cut is OVER as well as what it takes: a
  // pocketed floor is the other reason a job's depth is what it is. The rings are the app's own
  // footprint — an imported magnet pocket arrives as its measured 144-point outline, not as the
  // bounding rectangle of it.
  for (const ko of input.keepOuts ?? []) {
    const d = ko.polygons.map(ringPath).filter((p) => p !== '').join(' ');
    if (d === '') continue;
    parts.push(`<path d="${d}" fill="none" stroke="${INK_KEEP_OUT}" stroke-width="0.25" stroke-dasharray="1.6 1" />`);
    const centre = ringCentre(ko.polygons);
    if (centre === null) continue;
    // Well above the void's own centre line: a job's biggest item is usually centred over its
    // biggest void, so an item label and a void label land on the same point and print on top of
    // each other unless they are set deliberately apart.
    const name = ko.name ?? ko.id;
    const label = fitLabel(centre[0], name, 2.2, x0 + 1, x0 + vw - 1);
    parts.push(
      `<text x="${mm(label.x)}" y="${mm(-(centre[1] + 5))}" ` +
        `fill="${INK_KEEP_OUT}" font-size="${mm(label.size)}" text-anchor="middle">${esc(name)}</text>`,
    );
  }

  // 1 · what the file asked for, as a ghost. An item the job does NOT cut is drawn hollow and
  // dashed — see `idealItems` — so the picture shows what is being left out and not only what is
  // being cut.
  const ghost: string[] = [];
  for (const item of ideal) {
    const d = item.rings.map(ringPath).join(' ');
    if (d === '') continue;
    ghost.push(
      item.enabled
        ? `<path d="${d}" fill="${INK_IDEAL}" fill-rule="nonzero" />`
        : `<path d="${d}" fill="none" stroke="${INK_IDEAL}" stroke-width="0.3" stroke-dasharray="1.4 1" />`,
    );
  }
  if (ghost.length > 0) {
    parts.push(`<g id="ideal" data-ideal="true">${ghost.join('')}</g>`);
  }

  // 2 · what a cutter of THIS diameter opens. Nothing is redrawn smaller: these polygons already
  // are the offset region `measureLabels` produced, so the picture is the cutter's own footprint
  // and not an approximation of it.
  const opened: string[] = [];
  for (const cut of cuts) {
    const d = cut.polygons.map(ringPath).filter((p) => p !== '').join(' ');
    if (d === '') continue;
    opened.push(`<path d="${d}" fill="${INK_CUT}" fill-rule="nonzero" />`);
  }
  if (opened.length > 0) {
    parts.push(`<g id="cut" data-cut="true" opacity="0.82">${opened.join('')}</g>`);
  }

  // 3 · the names and the shares, at each item's own box centre. The NAME is the item's, not the
  // plan's: `plan.engraves[].name` is a sentence for the operations list ("Pocket outline … (19
  // contours, 10.53…×66.91…mm)"), and a sentence set across a 10 mm letter is not a label.
  for (const item of ideal) {
    const centre = ringCentre(item.rings);
    if (centre === null) continue;
    const [cx, cy] = centre;
    const label = item.enabled
      ? `${item.name} · ${pct(ratios?.get(item.id))}`
      : `${item.name} — not cut`;
    const fitted = fitLabel(cx, label, 2.2, x0 + 1, x0 + vw - 1);
    // A halo, because the text sits ON the artwork and has to survive over both inks.
    parts.push(
      `<text x="${mm(fitted.x)}" y="${mm(-cy)}" font-size="${mm(fitted.size)}" text-anchor="middle" fill="#fff" ` +
        `stroke="#fff" stroke-width="0.6" paint-order="stroke">${esc(label)}</text>`,
    );
    parts.push(
      `<text x="${mm(fitted.x)}" y="${mm(-cy)}" font-size="${mm(fitted.size)}" text-anchor="middle" ` +
        `fill="${item.enabled ? '#111' : INK_KEEP_OUT}">${esc(label)}</text>`,
    );
  }

  // 4 · the scale bar: the cutter's own diameter, and 10 mm. A picture of a cut is worthless
  // without the two lengths it is read against. It sits in the FRONT margin, below the blank, so it
  // never lies across the artwork it is measuring.
  const barY = 5.6;
  parts.push(
    `<g id="scale" data-scale="true">` +
      `<line x1="0" y1="${mm(barY)}" x2="10" y2="${mm(barY)}" stroke="#111" stroke-width="0.4" />` +
      `<line x1="0" y1="${mm(barY - 1)}" x2="0" y2="${mm(barY + 1)}" stroke="#111" stroke-width="0.4" />` +
      `<line x1="10" y1="${mm(barY - 1)}" x2="10" y2="${mm(barY + 1)}" stroke="#111" stroke-width="0.4" />` +
      `<text x="11.5" y="${mm(barY + 1)}" font-size="2.4" fill="#111">10 mm</text>` +
      (diameter === null
        ? ''
        : `<circle cx="22" cy="${mm(barY)}" r="${mm(diameter / 2)}" fill="${INK_CUT}" />` +
          `<text x="${mm(22 + diameter / 2 + 2)}" y="${mm(barY + 1)}" font-size="2.4" fill="#111">` +
          `⌀ ${mm(diameter)} mm cutter, to scale</text>`) +
      `</g>`,
  );

  // 5 · what the picture is, and the axis convention, so a printed copy stands alone. THREE SHORT
  // LINES, not one long one: the picture is only as wide as the blank, and a caption that runs off
  // the edge reads as if the blank stops where the sentence does.
  parts.push(
    `<text x="0" y="${mm(-width - 17)}" font-size="3.2" fill="#111">` +
      `${esc(job.name)} — the predicted cut at ${diameter === null ? 'the cutter' : `⌀ ${mm(diameter)} mm`}` +
      `</text>`,
  );
  const caption = [
    'Grey: what the file asked for. Dark: what the cutter opens.',
    `${mm(length)} × ${mm(width)} × ${mm(job.stock.thickness)} mm blank, seen from above.`,
    '+X right, across the jaws. +Y away from the operator.',
  ];
  caption.forEach((line, i) => {
    parts.push(`<text x="0" y="${mm(-width - 13 + i * 3.4)}" font-size="2" fill="#555">${esc(line)}</text>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}
