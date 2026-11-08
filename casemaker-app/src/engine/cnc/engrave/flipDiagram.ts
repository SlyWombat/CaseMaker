/**
 * #1073 — THE FLIP, DRAWN, AS ONE STRING. The same SVG is what the Setups row shows and what the
 * run sheet's setup-2 page prints (#489's `toolProfileSvg` precedent): a pure builder, no React,
 * so the app and the paper cannot draw different pictures.
 *
 * A top view of the seated blank BEFORE and AFTER the turn, the bracket's two arms, the corner
 * that lands in the fence (and whether it is the blank's square corner — the same
 * `flipFenceFacts` the sheet's words and the refusals read), the locating bores (frame method) or
 * the freed part's outline (vendor method), and the arrow for the axis. Work XY maps to the panel
 * with x to the right and y UP, so the front edge is at the bottom.
 */
import type { SetupFlip, StockCorner } from '@/types/engraveJob';

import { flipFenceFacts, FLIP_BORE_DIAMETER_MM } from './flipChoice';
import { FLIP_PROBE_ENTRY_DEPTH_MM } from '@/engine/cnc/registration/plan';

export interface FlipDiagramProps {
  /** The blank's seated extents, mm. */
  lengthMm: number;
  widthMm: number;
  flip: SetupFlip;
  /** The blank's stated square corners; absent reads all four. */
  squareCorners?: readonly StockCorner[];
  /** Frame method: the locating bores in SIDE 2's work frame (the setup's stored pins). */
  pins?: readonly { x: number; y: number }[];
  /** The job's breakthrough rule, mm — the vendor method's groove past the outline. */
  breakthroughMm?: number;
  /** The freed part's extents in side-1 work XY, when the caller has them. */
  part?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** A unique id prefix, so two drawings on one page cannot share element ids. */
  idPrefix?: string;
}

export const FLIP_DIAGRAM_PANEL_W = 150;
const PAD = 26;
const INK = '#d1d5db';
const WARN = '#e0b050';
const GOOD = '#8fd18f';

type Map2 = (p: { x: number; y: number }) => { x: number; y: number };

function makeMap(lengthMm: number, widthMm: number, ox: number, oy: number): Map2 {
  const s = Math.min((FLIP_DIAGRAM_PANEL_W - 2 * PAD) / Math.max(lengthMm, 1e-9), (FLIP_DIAGRAM_PANEL_W - 2 * PAD) / Math.max(widthMm, 1e-9));
  return (p) => ({ x: ox + PAD + p.x * s, y: oy + FLIP_DIAGRAM_PANEL_W - PAD - p.y * s });
}

const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/** One side-1 work point in side 2's frame (the flip's own reflection). */
function reflect(p: { x: number; y: number }, flip: SetupFlip, lengthMm: number, widthMm: number): { x: number; y: number } {
  return flip.axis === 'left-right' ? { x: lengthMm - p.x, y: p.y } : { x: p.x, y: widthMm - p.y };
}

interface PanelProps {
  title: string;
  lengthMm: number;
  widthMm: number;
  ox: number;
  oy: number;
  corner: StockCorner;
  cornerLabel: string;
  cornerColor: string;
  squares: readonly StockCorner[];
  pins?: readonly { x: number; y: number }[];
  partMarks?: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

function panelXml(props: PanelProps): string {
  const map = makeMap(props.lengthMm, props.widthMm, props.ox, props.oy);
  const a = map({ x: 0, y: 0 });
  const b = map({ x: props.lengthMm, y: props.widthMm });
  const corners: Record<StockCorner, { x: number; y: number }> = {
    FL: map({ x: 0, y: 0 }),
    FR: map({ x: props.lengthMm, y: 0 }),
    BL: map({ x: 0, y: props.widthMm }),
    BR: map({ x: props.lengthMm, y: props.widthMm }),
  };
  const c = corners[props.corner];
  const part = props.partMarks ?? null;
  const out: string[] = [];
  out.push(
    `<g data-testid="flip-panel-${props.title.startsWith('Before') ? 'before' : 'after'}">`,
    `<text x="${n(props.ox + FLIP_DIAGRAM_PANEL_W / 2)}" y="${n(props.oy + 10)}" fill="${INK}" font-size="11" text-anchor="middle">${esc(props.title)}</text>`,
    // The bracket's two arms: along the front edge and the left edge.
    `<rect x="${n(a.x - 7)}" y="${n(a.y)}" width="${n(b.x - a.x + 14)}" height="7" fill="#3a4048" data-testid="flip-arm-front"/>`,
    `<rect x="${n(a.x - 7)}" y="${n(b.y)}" width="7" height="${n(a.y - b.y)}" fill="#3a4048" data-testid="flip-arm-left"/>`,
    // The blank.
    `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(a.x - b.x)}" height="${n(a.y - b.y)}" fill="none" stroke="${INK}" stroke-width="1.2"/>`,
  );
  for (const k of props.squares) {
    out.push(`<rect x="${n(corners[k].x - 2.5)}" y="${n(corners[k].y - 2.5)}" width="5" height="5" fill="${GOOD}" data-testid="flip-square-${k}"/>`);
  }
  out.push(
    `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="6" fill="none" stroke="${props.cornerColor}" stroke-width="1.6" data-testid="flip-fence-corner"/>`,
    `<text x="${n(c.x)}" y="${n(c.y + 16)}" fill="${props.cornerColor}" font-size="9.5" text-anchor="middle" data-testid="flip-fence-label">${esc(props.cornerLabel)}</text>`,
  );
  (props.pins ?? []).forEach((p) => {
    const q = map(p);
    out.push(`<circle cx="${n(q.x)}" cy="${n(q.y)}" r="3.2" fill="none" stroke="${WARN}" stroke-width="1.2" data-testid="flip-hole"/>`);
  });
  if (part !== null) {
    const tl = map({ x: part.minX, y: part.maxY });
    const br = map({ x: part.maxX, y: part.minY });
    out.push(
      `<rect x="${n(tl.x)}" y="${n(tl.y)}" width="${n(br.x - tl.x)}" height="${n(br.y - tl.y)}" fill="none" stroke="${WARN}" stroke-dasharray="4 3" stroke-width="1.2" data-testid="flip-part"/>`,
    );
  }
  out.push('</g>');
  return out.join('');
}

/** The whole drawing, as standalone SVG markup (paper- and DOM-ready). */
export function flipDiagramSvg(props: FlipDiagramProps): string {
  const { lengthMm, widthMm, flip } = props;
  const facts = flipFenceFacts({ squareCorners: props.squareCorners }, flip);
  const square = facts.squareCorners;
  // The stored pins live in SIDE 2's frame; the before panel shows where they were drilled, so
  // it reflects them back through the same involution.
  const beforePins = (props.pins ?? []).map((p) => reflect(p, flip, lengthMm, widthMm));
  const part = props.part ?? null;
  const partAfter =
    part === null
      ? null
      : {
          minX: flip.axis === 'left-right' ? lengthMm - part.maxX : part.minX,
          maxX: flip.axis === 'left-right' ? lengthMm - part.minX : part.maxX,
          minY: flip.axis === 'front-back' ? widthMm - part.maxY : part.minY,
          maxY: flip.axis === 'front-back' ? widthMm - part.minY : part.maxY,
        };
  const before = panelXml({
    title: 'Before · side 1',
    lengthMm,
    widthMm,
    ox: 0,
    oy: 14,
    corner: 'FL',
    cornerLabel: 'FL — the fence',
    cornerColor: square.includes('FL') ? GOOD : WARN,
    squares: square,
    pins: beforePins,
    partMarks: part,
  });
  const after = panelXml({
    title: 'After · side 2',
    lengthMm,
    widthMm,
    ox: FLIP_DIAGRAM_PANEL_W,
    oy: 14,
    corner: facts.fenceCorner,
    cornerLabel: `${facts.fenceCorner} in the fence — ${facts.squareInFence ? 'square' : 'not square'}`,
    cornerColor: facts.squareInFence ? GOOD : WARN,
    squares: square,
    pins: flip.method === 'tabs-in-blank' ? props.pins : undefined,
    partMarks: flip.method === 'free-then-flip' ? partAfter : null,
  });
  const midY = FLIP_DIAGRAM_PANEL_W / 2 + 24;
  const arrow =
    `<g data-testid="flip-axis-arrow">` +
    `<line x1="${n(FLIP_DIAGRAM_PANEL_W - 8)}" y1="${n(midY)}" x2="${n(FLIP_DIAGRAM_PANEL_W + 8)}" y2="${n(midY)}" stroke="${INK}" stroke-width="1.2"/>` +
    `<path d="${
      flip.axis === 'left-right'
        ? `M ${n(FLIP_DIAGRAM_PANEL_W - 14)} ${n(midY - 8)} L ${n(FLIP_DIAGRAM_PANEL_W - 8)} ${n(midY)} L ${n(FLIP_DIAGRAM_PANEL_W - 14)} ${n(midY + 8)}`
        : `M ${n(FLIP_DIAGRAM_PANEL_W - 14)} ${n(midY - 8)} L ${n(FLIP_DIAGRAM_PANEL_W)} ${n(midY)} L ${n(FLIP_DIAGRAM_PANEL_W - 14)} ${n(midY + 8)}`
    }" fill="none" stroke="${INK}" stroke-width="1.2"/>` +
    `</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FLIP_DIAGRAM_PANEL_W * 2}" height="${FLIP_DIAGRAM_PANEL_W + 18}" ` +
    `role="img" aria-label="The blank before and after the flip" data-testid="flip-diagram-svg">` +
    before +
    after +
    arrow +
    `</svg>`
  );
}

/** The two methods' costs, as the choice prints them under the drawing. */
export function flipCostLines(props: Pick<FlipDiagramProps, 'flip' | 'breakthroughMm'>): { frame: string; vendor: string } {
  return {
    frame:
      'Frame method: the part stays in the blank on tabs; side 2 cuts the tab release as its last shallow pass, ' +
      `and the two ⌀${FLIP_BORE_DIAMETER_MM} bores guide the probe ${FLIP_PROBE_ENTRY_DEPTH_MM} mm in from side 2’s top.`,
    vendor:
      `Vendor method: side 1 cuts ${(props.breakthroughMm ?? 0.3).toFixed(1)} mm through the outline into the board ` +
      '(the freed part’s groove); no tabs, no locating bores.',
  };
}
