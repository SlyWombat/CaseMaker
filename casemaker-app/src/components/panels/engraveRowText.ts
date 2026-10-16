/**
 * The words on an engrave item's collapsed line (#411), apart from the row that draws them.
 *
 * A file of its own rather than an export of `EngraveItemRow.tsx` because that file is a component
 * module and the fast-refresh lint rule wants it to export components only — the same reason
 * `engraveUploadCopy.ts` sits beside the machine-run panel.
 */

/**
 * The one number on a collapsed line: `0.3 mm`, `12.7 mm`. Three places of a millimetre, the
 * precision the run sheet prints a depth at, with the trailing zeros dropped — a depth typed as
 * `2` reads as `2 mm`, and a derived one cannot arrive as `0.30000000000000004`.
 *
 * Shared by all seven rows so they put the same string on their line rather than each rounding its
 * own way.
 */
export function rowSummary(value: number, unit = 'mm'): string {
  return `${Number(value.toFixed(3))} ${unit}`;
}
