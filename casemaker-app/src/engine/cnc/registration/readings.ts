/**
 * One probe answer, read (#430). The controller's `[PRB:x,y,z:flag]` (machine coordinates; flag 1 =
 * it touched, 0 = it travelled the whole distance and touched nothing — `ALARM: Probe fail`), and
 * what a touch MEANS against the measured surface:
 *
 *   - `stock` — a hit within `surfaceBandMm` of the surface, either side: the probe is on the blank;
 *   - `above` — a hit higher than that: something on the stock (a clamp) — the scan stops;
 *   - `below` — a hit lower than that (a jaw top, the rounded edge's roll-off): off the blank;
 *   - `miss`  — nothing within the cap: off the blank.
 *
 * The bench's 2026-10-15 readings, for scale: the blank at −56.17, its rolled edge −56.39, a jaw top
 * −56.64 (a hit 0.47 below, inside a 0.5 cap), a miss reported at the cap with flag 0.
 */

export interface Prb {
  x: number;
  y: number;
  z: number;
  touched: boolean;
}

/** Every `[PRB:…]` in a reply, in order. */
export function parsePrbs(text: string): Prb[] {
  const out: Prb[] = [];
  for (const m of text.matchAll(/\[PRB:\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)(?:,[^:\]]*)*:(\d)\]/g)) {
    out.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), touched: m[4] === '1' });
  }
  return out;
}

/** The last `[PRB:…]` in a reply — `M491` answers two (fast, slow); the slow one is the reading. */
export function lastPrb(text: string): Prb | null {
  const all = parsePrbs(text);
  return all.length === 0 ? null : (all[all.length - 1] as Prb);
}

/**
 * `above` — a hit HIGHER than the surface band (#430 review): a clamp, a taller jaw, a chip. It is not
 * the stock and it is not the edge; a scan that meets one stops and says so.
 */
export type TouchKind = 'stock' | 'below' | 'above' | 'miss';

export function classifyTouch(prb: Prb, surfaceZ: number, bandMm: number): TouchKind {
  if (!prb.touched) return 'miss';
  if (prb.z > surfaceZ + bandMm) return 'above';
  return prb.z >= surfaceZ - bandMm ? 'stock' : 'below';
}
