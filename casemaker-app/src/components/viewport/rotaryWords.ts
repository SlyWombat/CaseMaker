/**
 * #716 slice 2 / #769 — THE ROTARY A's WORDS, in one place.
 *
 * A rotary program's A position reads as the angle WITHIN the turn plus the number of turns
 * (`A 154.5° · 3 turns`), never the unwound total alone (design `rotary-flow.md` §3.9, R9/R-UI-8):
 * the machine's own A is a degree count that a multi-turn pass pushes past 360, and "1 234.5°"
 * tells an operator nothing about where on the stock the cut is.
 *
 * The simulation's transport row and the status strip's DRO are two surfaces reading the same
 * machine axis, so they say the same words. This module is pure formatting and imports nothing —
 * the simulation's view module also carries path reading, and the strip (mounted on every project)
 * must not pull the simulation's geometry in to print a number.
 */

/** `154.5` — one decimal at most, the units rule the rest of the map's numbers follow. */
export function degrees(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/**
 * `A 154.5° · 3 turns` — the unwound A reduced to (turns, angle within the turn). The angle is in
 * [0, 360); a negative unwound A keeps its sign on the turn count, so `A = turns·360 + within`
 * always holds and the pair is never a rounded lie.
 *
 * #716 review — round FIRST, then carry: 359.96° is one decimal from a whole turn, and printing
 * "A 360° · 0 turns" would name an angle outside the turn it claims. It becomes `A 0° · 1 turn`;
 * symmetrically -0.04° becomes `A 0° · 0 turns` rather than `A 360° · −1 turns`.
 */
export function rotaryAngleWords(unwoundDegrees: number): string {
  let turns = Math.floor(unwoundDegrees / 360);
  let within = Number((unwoundDegrees - turns * 360).toFixed(1));
  if (within >= 360) {
    within = 0;
    turns += 1;
  }
  return `A ${degrees(within)}° · ${turns} ${Math.abs(turns) === 1 ? 'turn' : 'turns'}`;
}

/** `above the axis 9.5 mm` — Z on a rotary job is the radius from the axis, not the blank's face. */
export function aboveAxisWords(z: number): string {
  return `above the axis ${degrees(z)} mm`;
}
