/**
 * #1099 — THE PART ON THE BLANK, drawn to scale.
 *
 * The Stock step's size fields get this beside them: the blank's top view, the part's footprint
 * inside it, the four margins dimensioned, and a side strip with the part's height above the
 * blank and the skin under it. The same footprint answers the Holding step's top view, so every
 * step draws ONE part — the number fields moving do not change which part the pictures show.
 *
 * The part is centred today (the wizard places it at the stock's centre); a part larger than the
 * blank is drawn clipped in the warning colour, with the overrun said in millimetres.
 */

import { useId, type JSX } from 'react';

import type { PartFootprint } from './workShape';

export interface BlankWithPartProps {
  blank: { length: number; width: number; thickness: number };
  part: PartFootprint | null;
}

const n = (v: number): string => String(Number(v.toFixed(2)));
/** #1099 item 5 — one decimal, trailing .0 dropped (the skin reads "1 mm under it", not "1.0"). */
const one = (v: number): string => String(Number(v.toFixed(1)));
const fmt = (v: number): string => n(Math.abs(v));

/** The margin's own name in the operator's terms (the view is from the front-left corner). */
export type MarginSide = 'left' | 'right' | 'front' | 'back';

export interface BlankMargins {
  left: number;
  right: number;
  front: number;
  back: number;
  /** The length/width overrun, mm (0 when the part fits). */
  overLength: number;
  overWidth: number;
}

/** The four margins of a centred part on a blank; negative margin = overrun. */
export function blankMargins(blank: { length: number; width: number }, part: { length: number; width: number }): BlankMargins {
  return {
    left: (blank.length - part.length) / 2,
    right: (blank.length - part.length) / 2,
    front: (blank.width - part.width) / 2,
    back: (blank.width - part.width) / 2,
    overLength: Math.max(0, part.length - blank.length),
    overWidth: Math.max(0, part.width - blank.width),
  };
}

/** The sentence a part too large for the blank carries, or null when it fits. */
export function overrunSentence(margins: BlankMargins): string | null {
  if (margins.overLength > 0) return `the part is ${fmt(margins.overLength)} mm longer than the blank`;
  if (margins.overWidth > 0) return `the part is ${fmt(margins.overWidth)} mm wider than the blank`;
  return null;
}

export function BlankWithPart({ blank, part }: BlankWithPartProps): JSX.Element {
  const clip = useId().replace(/[:]/g, '');
  const W = 260;
  const topH = 150;
  // The margins are written OUTSIDE the blank: a 5 mm band is a few pixels at this scale, and a
  // number sitting on the part's edge is not a dimension.
  const pad = 34;
  const bLength = Math.max(blank.length, 0.001);
  const bWidth = Math.max(blank.width, 0.001);
  const scale = Math.min((W - pad * 2) / bLength, (topH - pad * 2) / bWidth);
  const bw = bLength * scale;
  const bh = bWidth * scale;
  const bx = (W - bw) / 2;
  const by = (topH - bh) / 2;
  const margins =
    part === null ? null : blankMargins({ length: blank.length, width: blank.width }, { length: part.length, width: part.width });
  const overrun = margins === null ? null : overrunSentence(margins);
  const pw = part === null ? 0 : Math.max(part.length * scale, 0.5);
  const ph = part === null ? 0 : Math.max(part.width * scale, 0.5);

  return (
    <div data-testid="blank-with-part" style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
      <svg
        viewBox={`0 0 ${W} ${topH}`}
        width="100%"
        role="img"
        aria-label={part === null ? 'The blank, with no part yet' : 'The part on the blank, with its margins'}
        style={{ display: 'block', border: '1px solid #2a2f36', background: '#10151b', borderRadius: 4 }}
      >
        <defs>
          <clipPath id={`blank-clip-${clip}`}>
            <rect x={bx} y={by} width={bw} height={bh} />
          </clipPath>
        </defs>
        <rect data-testid="blank-with-part-blank" x={bx} y={by} width={bw} height={bh} fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
        {part !== null && (
          <rect
            data-testid="blank-part-footprint"
            className={overrun === null ? 'blank-part' : 'blank-part blank-part--clipped'}
            x={bx + (bw - pw) / 2}
            y={by + (bh - ph) / 2}
            width={pw}
            height={ph}
            fill={overrun === null ? 'rgba(240, 217, 181, 0.42)' : 'rgba(240, 164, 140, 0.45)'}
            stroke={overrun === null ? '#f0d9b5' : '#f0a48c'}
            strokeWidth="1.4"
            strokeDasharray="4 2"
            clipPath={`url(#blank-clip-${clip})`}
          />
        )}
        {margins !== null && (
          <>
            {/* The blank's four edges are the dimension lines: each margin is written just
                outside the edge it belongs to, where there is room for the number. */}
            <text x={bx - 6} y={by + bh / 2 + 3} textAnchor="end" fontSize="10" fill="#c8d3de" data-testid="blank-part-margin-left">
              {fmt(margins.left)} mm
            </text>
            <text x={bx + bw + 6} y={by + bh / 2 + 3} fontSize="10" fill="#c8d3de" data-testid="blank-part-margin-right">
              {fmt(margins.right)} mm
            </text>
            <text x={bx + bw / 2} y={by - 8} textAnchor="middle" fontSize="10" fill="#c8d3de" data-testid="blank-part-margin-back">
              {fmt(margins.back)} mm
            </text>
            <text x={bx + bw / 2} y={by + bh + 14} textAnchor="middle" fontSize="10" fill="#c8d3de" data-testid="blank-part-margin-front">
              {fmt(margins.front)} mm
            </text>
          </>
        )}
      </svg>
      {/* The side strip: the blank's thickness, the work standing above it and the skin under it. */}
      <svg
        viewBox="0 0 260 52"
        width="100%"
        role="img"
        aria-label="Side view: the blank's thickness and the work standing above it"
        data-testid="blank-with-part-side"
        style={{ display: 'block', border: '1px solid #2a2f36', background: '#10151b', borderRadius: 4 }}
      >
        {(() => {
          // #1099 item 5 — the part is cut DOWN from the blank's top, and the skin left under it
          // is the dimension: 20.1 mm blank, 19.1 mm part → "1 mm under it".
          const s = 32 / Math.max(blank.thickness, 0.001);
          const tPx = Math.max(blank.thickness * s, 0.5);
          const top = 40 - tPx;
          const height = part?.height ?? null;
          const hPx = height === null ? 0 : Math.min(Math.max(height * s, 0), tPx);
          const skin = height === null ? null : blank.thickness - height;
          return (
            <>
              <rect data-testid="blank-with-part-side-blank" x="90" y={top} width="80" height={tPx} fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.2" />
              {hPx > 0 && height !== null && (
                <rect data-testid="blank-with-part-side-work" x="102" y={top} width="56" height={hPx} fill="rgba(240, 217, 181, 0.28)" stroke="#f0d9b5" strokeWidth="1" />
              )}
              {hPx > 0 && skin !== null && skin >= 0 && (
                <>
                  {/* The skin's witness line: from the part's floor down to the blank's bottom. */}
                  <line x1="174" x2="180" y1={top + hPx} y2={top + hPx} stroke="#9aa4b0" strokeWidth="0.8" />
                  <line x1="174" x2="180" y1={top + tPx} y2={top + tPx} stroke="#9aa4b0" strokeWidth="0.8" />
                  <line x1="178" x2="178" y1={top + hPx} y2={top + tPx} stroke="#9aa4b0" strokeWidth="0.8" />
                  <text x="184" y={(top + hPx + top + tPx) / 2 + 3} fontSize="10" fill="#c8d3de" data-testid="blank-with-part-side-skin">
                    {one(skin)} mm under it
                  </text>
                </>
              )}
              <text x="8" y="50" fontSize="10" fill="#9aa4b0">
                {n(blank.thickness)} mm blank
                {hPx > 0 && height !== null ? ` · ${n(height)} mm part` : ''}
              </text>
            </>
          );
        })()}
      </svg>
      {part !== null && (
        <span data-testid="blank-with-part-facts" style={{ fontSize: 11, color: '#9aa4b0' }}>
          blank {n(blank.length)} × {n(blank.width)} × {n(blank.thickness)} mm · part {n(part.length)} × {n(part.width)}
          {part.height === null ? '' : ` × ${n(part.height)}`} mm
        </span>
      )}
      {overrun !== null && (
        <span data-testid="blank-part-overrun" style={{ fontSize: 11, color: '#f0b4ad' }}>
          {overrun}
        </span>
      )}
    </div>
  );
}
