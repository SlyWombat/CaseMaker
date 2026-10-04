/**
 * Number formatting for the Z1 post (#173).
 *
 * Makera Studio writes plain decimal text: a fixed number of places, trailing zeros
 * stripped, no exponent, and never a negative zero. The stripping is not cosmetic — the
 * post's sticky output COMPARES the FORMATTED strings, not the floats, so two feeds that
 * print the same are one word and a coordinate that prints the same is omitted (§ "Modal,
 * sticky output").
 */

/**
 * `value` at `decimals` places, then trailing zeros and a trailing dot stripped.
 * `70.110 → 70.11`, `5.000 → 5`, `-0.050 → -0.05`, and any negative zero becomes `0`.
 *
 * Never exponent notation: `1e-7` at 3 places rounds to `0`, not `1e-7`. (`toFixed` only
 * falls back to exponent form for `|value| ≥ 1e21`, far outside any coordinate this machine
 * can reach; a non-finite value is refused upstream, before it gets here.)
 */
export function formatFixed(value: number, decimals: number): string {
  // `toFixed` rounds; `Number(...)` collapses "-0.000" to -0 and "5.000" to 5. That is what
  // makes both the negative-zero case and the trailing-zero strip below work on one path.
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return '0';
  let text = rounded.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

/**
 * An `;@MKR|` field value, made safe for the record format.
 *
 * The record is `|`-separated, so a `|` inside a name would appear to the machine's reader
 * as the start of a new field; a newline would split the record across two lines. Both
 * become a space (#173: a label called `A|B` must not corrupt the header).
 */
export function sanitizeMkrValue(value: string): string {
  return value.replace(/[|\r\n]/g, ' ');
}
