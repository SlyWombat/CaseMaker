/**
 * #1214's ruling (b) — THE PLUNGE TEST ON THE POSTED GRID.
 *
 * The feed word must be a pure function of the bytes the post writes: a move takes the plunge rate
 * exactly when its POSTED Z goes down. Both ends are rounded to the machine's printed axis
 * precision (0.001 mm on the Z1) and the ROUNDED values compared. The old test compared unrounded
 * Zs against a 1e-9 noise floor (`to.z < from.z - 1e-9`), so a height change of a few nanometres
 * decided the feed — the Set B hand-in found moves flip on the edge-contact closed form alone,
 * and the word would flip again on the next kernel change.
 *
 * THE PRECISION IS THE CALLER'S MACHINE'S, threaded in from the op's post context
 * (`dialect.axisPrecision`) — never a remembered three, and never read from a machine this module
 * guesses at. The op options carry it (`axisPrecision`); the plan takes it from
 * `PlanModelCamOptions` (the job's machine), defaulting to the Z1's only because the model planner
 * posts through `postZ1`; the rotary relief takes it from the mill its own post uses.
 *
 * The quantum is a machine fact, not a chosen value: #1207 exempts protocol and machine facts, so
 * this introduces no shop-defaults key. Registered values: none.
 *
 * `postedZ` reproduces `post/format.ts`'s `formatFixed` rounding exactly (`Number(v.toFixed(d))`);
 * the post strips trailing zeros and collapses −0 to 0, neither of which changes the numeric value
 * the comparisons here read. Comparing these values is therefore comparing the posted bytes.
 */

/** The value the post writes for `v` at `decimals` places, as a number. */
export function postedZ(v: number, decimals: number): number {
  return Number(v.toFixed(decimals));
}

/** TRUE when the move from `fromZ` to `toZ` changes a posted digit DOWNWARD — a plunge. */
export function isPlunge(fromZ: number, toZ: number, decimals: number): boolean {
  return postedZ(toZ, decimals) < postedZ(fromZ, decimals);
}
