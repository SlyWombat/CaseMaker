/**
 * How the Manage surface writes a value down (#311).
 *
 * Two rules, both of them about not lying with a format:
 *
 *   - **UNKNOWN IS `—`, NOT `0.0`.** Every dimension in a `Tool` is `null` when no source stated
 *     it, and a null rendered as a number would turn "nobody measured the stick-out" into "the
 *     stick-out is zero" — which is a machine-crashing claim. `—` is what the list and the detail
 *     table print instead, and the detail table says why in words.
 *   - **NOT APPLICABLE IS `·`.** A catalogue row has no quantity: nothing owns it. That is a
 *     different statement from "unknown", so it gets a different glyph.
 *
 * Dimensions keep a trailing `.1` on whole millimetres (`4` reads as `4.0`) because the column is
 * a dimension column and the eye compares places, while a value with real precision keeps all of
 * it — `3.175` is the shank everyone actually has and rounding it to `3.2` would be a different
 * cutter.
 */

/** A dimension in mm, or `—` when no source stated one. */
export function mm(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** A value that is genuinely not applicable to this row. */
export const NOT_APPLICABLE = '·';

/** The date and time a stamp names, in this machine's own zone — `2026-10-09 07:12`. */
export function formatStamp(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso.length === 0) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The date alone — a possession's `addedAt` is a day, not a minute. */
export function formatDay(iso: string | null | undefined): string | null {
  const stamp = formatStamp(iso);
  return stamp === null ? null : (stamp.split(' ')[0] ?? stamp);
}
