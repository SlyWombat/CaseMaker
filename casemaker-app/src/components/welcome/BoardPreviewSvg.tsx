import { useId, useState, type CSSProperties } from 'react';
import type { BoardProfile, BoardComponent, ComponentKind } from '@/types';

/**
 * Data-driven top view of a board profile. Everything is derived from the
 * JSON — PCB outline, gold-ringed mounting holes, components colored by
 * connector family — so every board (builtin, imported, hand-authored) gets
 * an honest visual with zero bundled artwork. Underside (-z) components are
 * drawn dashed + translucent, the way you'd see them through the board.
 *
 * #130 — when the profile carries a `visualAssets.topImage` (a bundled or
 * community-hosted photo), that photo is shown instead, with the licence and
 * source beside it; the SVG stays the fallback for every board without one,
 * and also takes over again if the image fails to load.
 */

interface KindStyle {
  fill: string;
  stroke: string;
}

/** Connector-family palette. Metallic shells silver, plastic bodies dark,
 * gold for contacts/antennas — close enough to physical reality that a Pi
 * is recognizable at a glance. */
const KIND_STYLES: Record<ComponentKind, KindStyle> = {
  'usb-c': { fill: '#b9c0cc', stroke: '#7d8592' },
  'usb-a': { fill: '#b9c0cc', stroke: '#7d8592' },
  'usb-b': { fill: '#b9c0cc', stroke: '#7d8592' },
  'micro-usb': { fill: '#b9c0cc', stroke: '#7d8592' },
  hdmi: { fill: '#aeb5c2', stroke: '#7d8592' },
  'micro-hdmi': { fill: '#aeb5c2', stroke: '#7d8592' },
  'barrel-jack': { fill: '#31353f', stroke: '#565c69' },
  'ethernet-rj45': { fill: '#c3cad4', stroke: '#828a97' },
  'gpio-header': { fill: '#181a20', stroke: '#3c414d' },
  'sd-card': { fill: '#9aa2b0', stroke: '#6d7482' },
  'flat-cable': { fill: '#d8d2c4', stroke: '#a49d8c' },
  'fan-mount': { fill: 'none', stroke: '#8c909f' },
  'text-label': { fill: 'none', stroke: 'none' },
  'antenna-connector': { fill: '#d4af37', stroke: '#98803a' },
  custom: { fill: '#7f8797', stroke: '#5a616e' },
};

const PIN_PITCH = 2.54;

/** Physical shell colours for the round fixtures — the component's `kind` is
 * usually 'custom' for these, so the generic palette would draw them grey. */
const ROUND_FIXTURE_STYLES: Record<string, KindStyle> = {
  'xlr-3': { fill: '#222222', stroke: '#4a5162' },
  'audio-jack-3-5': { fill: '#1c1c1c', stroke: '#565c69' },
};

/** Kinds whose real-world part is round, so a top view should be a circle. */
const ROUND_KINDS = new Set<ComponentKind>(['barrel-jack', 'antenna-connector']);

const XLR_PIN_COUNT = 3;

function isRoundConnector(c: BoardComponent): boolean {
  return (c.fixtureId && c.fixtureId in ROUND_FIXTURE_STYLES) || ROUND_KINDS.has(c.kind);
}

function isUnderside(c: BoardComponent): boolean {
  return c.facing === '-z' || c.position.z < 0;
}

/** Pin-grid dots for headers — the visual signature of a dev board. */
function HeaderPins({ c, toY }: { c: BoardComponent; toY: (y: number, h: number) => number }) {
  const cols = Math.max(1, Math.min(40, Math.round(c.size.x / PIN_PITCH)));
  const rows = Math.max(1, Math.min(40, Math.round(c.size.y / PIN_PITCH)));
  if (cols * rows > 200) return null;
  const px = c.size.x / cols;
  const py = c.size.y / rows;
  const dots = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      dots.push(
        <circle
          key={`${i}-${j}`}
          cx={c.position.x + px * (i + 0.5)}
          cy={toY(c.position.y, c.size.y) + py * (j + 0.5)}
          r={Math.min(px, py) * 0.18}
          fill="#d4af37"
        />,
      );
    }
  }
  return <g>{dots}</g>;
}

/**
 * Round connector in top view: a circle sized to the component's bounding box,
 * with the fixture-specific detail that makes it recognisable — XLR-3's three
 * gold pins, a 3.5 mm jack's dark bore, a barrel jack's centre hole.
 */
function RoundConnector({
  c,
  style,
  strokeWidth,
  under,
}: {
  c: BoardComponent;
  style: KindStyle;
  strokeWidth: number;
  under: boolean;
}) {
  const r = Math.min(c.size.x, c.size.y) / 2;
  const cx = c.position.x + c.size.x / 2;
  const cy = -c.position.y - c.size.y / 2;
  const fixture = c.fixtureId ?? '';
  // A 3.5 mm jack and a barrel jack both read as a dark recess in the middle.
  const boreR = fixture === 'audio-jack-3-5' ? r * 0.45 : c.kind === 'barrel-jack' ? r * 0.45 : 0;
  const pins = fixture === 'xlr-3' ? XLR_PIN_COUNT : 0;
  return (
    <g opacity={under ? 0.5 : 1}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={under ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined}
      />
      {boreR > 0 && <circle cx={cx} cy={cy} r={boreR} fill="#0b1326" />}
      {pins > 0 &&
        Array.from({ length: pins }, (_, i) => {
          const theta = (Math.PI * 2 * i) / pins - Math.PI / 2;
          return (
            <circle
              key={i}
              cx={cx + Math.cos(theta) * r * 0.42}
              cy={cy + Math.sin(theta) * r * 0.42}
              r={Math.max(0.3, r * 0.2)}
              fill="#d4af37"
            />
          );
        })}
    </g>
  );
}

/** Silkscreen legend for a `text-label` component. Sized to fit the
 * component's box (average glyph advance ≈ 0.6 em) so it never spills. */
function SilkscreenLabel({ c }: { c: BoardComponent }) {
  const text = c.text?.trim();
  if (!text) return null;
  return (
    <text
      x={c.position.x + c.size.x / 2}
      y={-c.position.y - c.size.y / 2}
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="ui-monospace, monospace"
      fontSize={Math.min(c.size.y * 0.9, (c.size.x * 1.6) / text.length)}
      fill="#dfe7dc"
    >
      {text}
    </text>
  );
}

const IMAGE_WRAP_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  minHeight: 0,
};
const IMAGE_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  maxWidth: '100%',
  objectFit: 'contain',
  borderRadius: 4,
};
const CREDIT_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 9,
  lineHeight: 1.2,
  opacity: 0.65,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function BoardPreviewSvg({
  board,
  className,
}: {
  board: BoardProfile;
  className?: string;
}) {
  const uid = useId();
  const assets = board.visualAssets;
  const [imageFailed, setImageFailed] = useState(false);

  // #130 — a real photo beats the synthesised view. Falls back to the SVG on
  // error (offline, 404, a licence-less community URL that moved) so the card
  // never renders blank.
  if (assets?.topImage && !imageFailed) {
    return (
      <span className={className} style={IMAGE_WRAP_STYLE} data-testid="board-preview-image">
        <img
          src={assets.topImage}
          alt={`Top view of ${board.name}`}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          style={IMAGE_STYLE}
        />
        <span style={CREDIT_STYLE} data-testid="board-preview-credit">
          {assets.license}
          {assets.sourceUrl ? ` · ${assets.sourceUrl}` : ''}
        </span>
      </span>
    );
  }

  const pcb = board.pcb.size;

  // Bounds include connector overhang (negative positions / past-edge sizes).
  let minX = 0;
  let minY = 0;
  let maxX = pcb.x;
  let maxY = pcb.y;
  for (const c of board.components) {
    minX = Math.min(minX, c.position.x);
    minY = Math.min(minY, c.position.y);
    maxX = Math.max(maxX, c.position.x + c.size.x);
    maxY = Math.max(maxY, c.position.y + c.size.y);
  }
  const pad = Math.max(1.5, (maxX - minX) * 0.03);
  const vb = {
    x: minX - pad,
    y: -(maxY + pad), // see toY: board +y is up, SVG +y is down
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
  /** Board coords → SVG coords (flip Y so +y edge renders at the top). */
  const toY = (y: number, h: number) => -(y + h);

  const isModule = Boolean(board.enclosure);
  const pcbFill = isModule ? `url(#${uid}-shell)` : `url(#${uid}-pcb)`;
  const pcbStroke = isModule ? '#4a5162' : '#2e7d4f';

  const sorted = [...board.components].sort(
    (a, b) => Number(isUnderside(b)) - Number(isUnderside(a)),
  );

  return (
    <svg
      className={className}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Top view of ${board.name}`}
    >
      <defs>
        <linearGradient id={`${uid}-pcb`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1e6a3c" />
          <stop offset="100%" stopColor="#14472a" />
        </linearGradient>
        <linearGradient id={`${uid}-shell`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#343b4a" />
          <stop offset="100%" stopColor="#232936" />
        </linearGradient>
      </defs>

      {/* PCB / module outline */}
      <rect
        x={0}
        y={toY(0, pcb.y)}
        width={pcb.x}
        height={pcb.y}
        rx={Math.min(2, pcb.x * 0.04, pcb.y * 0.04)}
        fill={pcbFill}
        stroke={pcbStroke}
        strokeWidth={vb.w * 0.006}
      />

      {/* Vendor-shell modules: rear body + screen hint instead of silkscreen */}
      {board.enclosure && (
        <rect
          x={board.enclosure.body.x}
          y={toY(board.enclosure.body.y, board.enclosure.body.height)}
          width={board.enclosure.body.width}
          height={board.enclosure.body.height}
          rx={1.5}
          fill="#1b2029"
          stroke="#4a5162"
          strokeWidth={vb.w * 0.004}
        />
      )}

      {/* Components */}
      {sorted.map((c) => {
        const style = KIND_STYLES[c.kind] ?? KIND_STYLES.custom;
        if (c.kind === 'text-label') return <SilkscreenLabel key={c.id} c={c} />;
        const under = isUnderside(c);
        const y = toY(c.position.y, c.size.y);
        if (c.kind === 'fan-mount') {
          return (
            <circle
              key={c.id}
              cx={c.position.x + c.size.x / 2}
              cy={y + c.size.y / 2}
              r={Math.min(c.size.x, c.size.y) / 2}
              fill="none"
              stroke={style.stroke}
              strokeWidth={vb.w * 0.006}
              strokeDasharray={`${vb.w * 0.015} ${vb.w * 0.01}`}
            />
          );
        }
        if (isRoundConnector(c)) {
          return (
            <RoundConnector
              key={c.id}
              c={c}
              style={ROUND_FIXTURE_STYLES[c.fixtureId ?? ''] ?? style}
              strokeWidth={vb.w * 0.005}
              under={under}
            />
          );
        }
        return (
          <g key={c.id} opacity={under ? 0.5 : 1}>
            <rect
              x={c.position.x}
              y={y}
              width={c.size.x}
              height={c.size.y}
              rx={Math.min(0.8, c.size.x * 0.15, c.size.y * 0.15)}
              fill={style.fill}
              stroke={style.stroke}
              strokeWidth={vb.w * 0.004}
              strokeDasharray={under ? `${vb.w * 0.012} ${vb.w * 0.008}` : undefined}
            />
            {c.kind === 'gpio-header' && !under && <HeaderPins c={c} toY={toY} />}
          </g>
        );
      })}

      {/* Mounting holes — gold annular ring, board-colored bore */}
      {board.mountingHoles.map((h) => (
        <g key={h.id}>
          <circle
            cx={h.x}
            cy={-h.y}
            r={h.diameter / 2 + Math.max(0.6, h.diameter * 0.3)}
            fill="#c9a24b"
            stroke="#8a6f30"
            strokeWidth={vb.w * 0.003}
          />
          <circle cx={h.x} cy={-h.y} r={h.diameter / 2} fill="#0b1326" />
        </g>
      ))}
    </svg>
  );
}
