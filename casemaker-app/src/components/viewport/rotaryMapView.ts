/**
 * #716 — the rotary map's READ-OUTS, as data (design `rotary-flow.md` §3.7, R-UI-5).
 *
 * The viewport draws them; the panel and the specs read the SAME functions, so a ruler label, a
 * band's millimetres and the `⌀ · around` read-out cannot disagree between the picture and the
 * words beside it. Every number comes from `wrap.ts` — `angleToArc`, `rotaryFreeSpan` and
 * `rotaryBandFacts` — never from a second circumference or a guessed band.
 */
import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import { angleToArc, rotaryBandFacts } from '@/engine/cnc/rotary/wrap';

/** The map's numbers, three decimals at most — the units rule every field follows. */
export function rotaryNum(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/** One tick of the around ruler, at a quarter turn: the arc at the surface and the degrees. */
export interface RotaryRulerTick {
  deg: number;
  arc: number;
  /** The label the map prints: `0 mm · 0°`, `15.708 · 90°`, … */
  label: string;
}

/** The around ruler, every quarter turn, from the seam (0°) to the seam (360°). */
export function rotaryRulerTicks(map: RotaryMap): RotaryRulerTick[] {
  return [0, 90, 180, 270, 360].map((deg) => {
    const arc = angleToArc(deg, map.radius);
    return { deg, arc, label: `${deg === 0 ? '0 mm' : rotaryNum(arc)} · ${deg}°` };
  });
}

/** `⌀20 · around 62.832 mm` — the read-out above the map. */
export function rotaryReadout(map: RotaryMap): string {
  return `⌀${rotaryNum(map.radius * 2)} · around ${rotaryNum(map.circumference)} mm`;
}

/**
 * #716 — the canvas width below which the map is laid out for a small screen: the label rows move
 * apart, labels that would still collide are dropped (`rotaryMapLabels`), and the camera frames the
 * map inside the free area beside the Depth panel. The same 640 px the app's phone layout uses.
 */
export const ROTARY_MAP_NARROW_PX = 640;

/** One end band the map hatches: the jaws' keep-out, or the tailstock's. */
export interface RotaryBandView {
  id: 'jaws' | 'tailstock';
  /** Along-axis millimetres, from the jaws. */
  from: number;
  to: number;
  label: string;
  /** The provenance the hover states; both bands are Case Maker defaults until measured. */
  provenance: string;
}

/** The two bands as the map draws them, from the wrap module's EFFECTIVE lengths (#724 W7). */
export function rotaryBands(map: RotaryMap): RotaryBandView[] {
  const facts = rotaryBandFacts(map);
  const bands: RotaryBandView[] = [
    {
      id: 'jaws',
      from: 0,
      to: facts.jawsMm,
      label: `jaws 0–${rotaryNum(facts.jawsMm)} mm`,
      provenance: 'Case Maker’s default — not published; measured at the bench',
    },
  ];
  if (facts.tailstock) {
    const from = map.stickout - facts.tailstockMm;
    bands.push({
      id: 'tailstock',
      from,
      to: map.stickout,
      label: `tailstock ${rotaryNum(from)}–${rotaryNum(map.stickout)} mm`,
      provenance: 'Case Maker’s default — not published; measured at the bench',
    });
  }
  return bands;
}

/** The seam's two labels: the top edge is 0°, the bottom edge one full turn. */
export function rotarySeamLabels(): { top: string; bottom: string } {
  return { top: 'seam · 0°', bottom: 'seam · 360°' };
}

/** The along-axis ruler: 0, 20, 40 … and the stick-out, in millimetres from the jaws. */
export function rotaryAlongTicks(map: RotaryMap): number[] {
  const ticks: number[] = [];
  for (let x = 0; x <= map.stickout + 1e-9; x += 20) ticks.push(x);
  if (ticks[ticks.length - 1] !== map.stickout) ticks.push(map.stickout);
  return ticks;
}
