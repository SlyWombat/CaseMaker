/**
 * #1214's ruling (b) — THE PLUNGE TEST ON THE POSTED GRID.
 *
 * The feed word must be a pure function of the bytes the post writes: a move takes the plunge rate
 * exactly when its POSTED Z goes down. Both ends are rounded to the machine dialect's printed axis
 * precision (0.001 mm on the Z1) and the ROUNDED values compared. The old test compared unrounded
 * Zs against a 1e-9 noise floor (`to.z < from.z - 1e-9`), so a height change of a few nanometres
 * decided the feed — the Set B hand-in found 137 moves flip on the edge-contact closed form alone,
 * and the word would flip again on the next kernel change.
 *
 * THE QUANTUM IS A MACHINE FACT read from the dialect, not a chosen value: #1207 exempts protocol
 * and machine facts, so this introduces no shop-defaults key. Registered values: none.
 *
 * `postedZ` reproduces `post/format.ts`'s `formatFixed` rounding exactly (`Number(v.toFixed(d))`);
 * the post strips trailing zeros and collapses −0 to 0, neither of which changes the numeric value
 * the comparisons here read. Comparing these values is therefore comparing the posted bytes.
 */
import { dialectOf, Z1 } from '@/engine/cnc/machine';

/** The machine's printed Z precision, from its own dialect — never a remembered three. */
export const POSTED_Z_DECIMALS: number = dialectOf(Z1).axisPrecision;

/** The value the post writes for `v`, as a number. */
export function postedZ(v: number, decimals: number = POSTED_Z_DECIMALS): number {
  return Number(v.toFixed(decimals));
}

/** TRUE when the move from `fromZ` to `toZ` changes a posted digit DOWNWARD — a plunge. */
export function isPlunge(fromZ: number, toZ: number, decimals: number = POSTED_Z_DECIMALS): boolean {
  return postedZ(toZ, decimals) < postedZ(fromZ, decimals);
}
