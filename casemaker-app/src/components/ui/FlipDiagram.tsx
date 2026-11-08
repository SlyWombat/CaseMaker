/**
 * #1073 — THE FLIP, DRAWN: a top view of the seated blank before and after the turn, with the
 * bracket's two arms, the corner that lands in the fence (and whether it is the blank's square
 * corner), the locating bores (frame method) or the freed part (vendor method), and an arrow for
 * the axis. Both methods' costs print on the choice — the deliverable the maintainer asked for:
 * "clear graphics to the user as to which way things are flipped".
 *
 * Pure props, no store: the same drawing is meant to print on the run sheet's setup-2 page, so
 * everything it shows is the setup record and the stock's own stated squares.
 */

import type { JSX } from 'react';

import type { SetupFlip, StockCorner } from '@/types/engraveJob';
import { flipFenceFacts } from '@/engine/cnc/engrave/flipChoice';
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
}

const PANEL_W = 150;
const PAD = 26;
const MUTED = '#9aa4b0';
const INK = '#d1d5db';
const WARN = '#e0b050';
const GOOD = '#8fd18f';

/** Work XY → the panel's SVG (x right, y up: the front edge is at the bottom). */
function makeMap(lengthMm: number, widthMm: number, ox: number, oy: number) {
  const s = Math.min((PANEL_W - 2 * PAD) / Math.max(lengthMm, 1e-9), (PANEL_W - 2 * PAD) / Math.max(widthMm, 1e-9));
  return (p: { x: number; y: number }) => ({ x: ox + PAD + p.x * s, y: oy + PANEL_W - PAD - p.y * s });
}

function Panel(props: {
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
}): JSX.Element {
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
  const part = props.partMarks === null || props.partMarks === undefined ? null : props.partMarks;
  return (
    <g data-testid={`flip-panel-${props.title.startsWith('Before') ? 'before' : 'after'}`}>
      <text x={props.ox + PANEL_W / 2} y={props.oy + 10} fill={INK} fontSize={11} textAnchor="middle">
        {props.title}
      </text>
      {/* The bracket's two arms: along the front edge and the left edge. */}
      <rect x={a.x - 7} y={a.y} width={b.x - a.x + 14} height={7} fill="#3a4048" data-testid="flip-arm-front" />
      <rect x={a.x - 7} y={b.y} width={7} height={a.y - b.y} fill="#3a4048" data-testid="flip-arm-left" />
      {/* The blank. */}
      <rect x={b.x} y={b.y} width={a.x - b.x} height={a.y - b.y} fill="none" stroke={INK} strokeWidth={1.2} />
      {/* The blank's stated square corners. */}
      {props.squares.map((k) => (
        <rect key={k} x={corners[k].x - 2.5} y={corners[k].y - 2.5} width={5} height={5} fill={GOOD} data-testid={`flip-square-${k}`} />
      ))}
      {/* The corner in the fence, and whether it is square. */}
      <circle cx={c.x} cy={c.y} r={6} fill="none" stroke={props.cornerColor} strokeWidth={1.6} data-testid="flip-fence-corner" />
      <text x={c.x} y={c.y + 16} fill={props.cornerColor} fontSize={9.5} textAnchor="middle" data-testid="flip-fence-label">
        {props.cornerLabel}
      </text>
      {/* Frame method: the locating bores. */}
      {(props.pins ?? []).map((p, i) => {
        const q = map(p);
        return <circle key={i} cx={q.x} cy={q.y} r={3.2} fill="none" stroke={WARN} strokeWidth={1.2} data-testid="flip-hole" />;
      })}
      {/* Vendor method: the freed part's outline. */}
      {part === null ? null : (
        <rect
          x={map({ x: part.minX, y: part.maxY }).x}
          y={map({ x: part.minX, y: part.maxY }).y}
          width={map({ x: part.maxX, y: part.minY }).x - map({ x: part.minX, y: part.maxY }).x}
          height={map({ x: part.minX, y: part.minY }).y - map({ x: part.minX, y: part.maxY }).y}
          fill="none"
          stroke={WARN}
          strokeDasharray="4 3"
          strokeWidth={1.2}
          data-testid="flip-part"
        />
      )}
    </g>
  );
}

/** One side-1 work point in side 2's frame (the flip's own reflection). */
function reflect(p: { x: number; y: number }, flip: SetupFlip, lengthMm: number, widthMm: number): { x: number; y: number } {
  return flip.axis === 'left-right' ? { x: lengthMm - p.x, y: p.y } : { x: p.x, y: widthMm - p.y };
}

export function FlipDiagram(props: FlipDiagramProps): JSX.Element {
  const { lengthMm, widthMm, flip } = props;
  const facts = flipFenceFacts({ squareCorners: props.squareCorners }, flip);
  const square = facts.squareCorners;
  // The stored pins live in SIDE 2's frame; the before panel shows where they were drilled, so
  // it reflects them back through the same involution.
  const beforePins = (props.pins ?? []).map((p) => reflect(p, flip, lengthMm, widthMm));
  const part = props.part ?? null;
  const partBefore = part === null ? null : part;
  const partAfter =
    part === null
      ? null
      : {
          minX: flip.axis === 'left-right' ? lengthMm - part.maxX : part.minX,
          maxX: flip.axis === 'left-right' ? lengthMm - part.minX : part.maxX,
          minY: flip.axis === 'front-back' ? widthMm - part.maxY : part.minY,
          maxY: flip.axis === 'front-back' ? widthMm - part.minY : part.maxY,
        };
  const frameCost =
    `Frame method: the part stays in the blank on tabs; side 2 cuts the tab release as its last shallow pass, ` +
    `and the two ⌀6 bores guide the probe ${FLIP_PROBE_ENTRY_DEPTH_MM} mm in from side 2’s top.`;
  const vendorCost =
    `Vendor method: side 1 cuts ${(props.breakthroughMm ?? 0.3).toFixed(1)} mm through the outline into the board ` +
    '(the freed part’s groove); no tabs, no locating bores.';
  const frame = flip.method === 'tabs-in-blank';
  return (
    <div data-testid="flip-diagram" style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
      <svg width={PANEL_W * 2} height={PANEL_W + 18} role="img" aria-label="The blank before and after the flip">
        <Panel
          title="Before · side 1"
          lengthMm={lengthMm}
          widthMm={widthMm}
          ox={0}
          oy={14}
          corner="FL"
          cornerLabel="FL — the fence"
          cornerColor={square.includes('FL') ? GOOD : WARN}
          squares={square}
          pins={beforePins}
          partMarks={partBefore}
        />
        <Panel
          title="After · side 2"
          lengthMm={lengthMm}
          widthMm={widthMm}
          ox={PANEL_W}
          oy={14}
          corner={facts.fenceCorner}
          cornerLabel={`${facts.fenceCorner} in the fence — ${facts.squareInFence ? 'square' : 'not square'}`}
          cornerColor={facts.squareInFence ? GOOD : WARN}
          squares={square}
          pins={flip.method === 'tabs-in-blank' ? props.pins : undefined}
          partMarks={flip.method === 'free-then-flip' ? partAfter : null}
        />
        {/* The axis arrow, between the panels. */}
        <g data-testid="flip-axis-arrow">
          <line x1={PANEL_W - 8} y1={PANEL_W / 2 + 24} x2={8 + PANEL_W} y2={PANEL_W / 2 + 24} stroke={INK} strokeWidth={1.2} markerEnd="" />
          <path
            d={
              flip.axis === 'left-right'
                ? `M ${PANEL_W - 14} ${PANEL_W / 2 + 16} L ${PANEL_W - 8} ${PANEL_W / 2 + 24} L ${PANEL_W - 14} ${PANEL_W / 2 + 32}`
                : `M ${PANEL_W - 14} ${PANEL_W / 2 + 16} L ${PANEL_W} ${PANEL_W / 2 + 24} L ${PANEL_W - 14} ${PANEL_W / 2 + 32}`
            }
            fill="none"
            stroke={INK}
            strokeWidth={1.2}
          />
        </g>
      </svg>
      <p data-testid="flip-cost-frame" style={{ margin: '2px 0', color: frame ? INK : MUTED, fontWeight: frame ? 600 : 400 }}>
        {frameCost}
      </p>
      <p data-testid="flip-cost-vendor" style={{ margin: '2px 0', color: frame ? MUTED : INK, fontWeight: frame ? 400 : 600 }}>
        {vendorCost}
      </p>
    </div>
  );
}
