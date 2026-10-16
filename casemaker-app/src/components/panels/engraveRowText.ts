/**
 * The words on an engrave item's collapsed line (#411), apart from the row that draws them.
 *
 * A file of its own rather than an export of `EngraveItemRow.tsx` because that file is a component
 * module and the fast-refresh lint rule wants it to export components only — the same reason
 * `engraveUploadCopy.ts` sits beside the machine-run panel.
 */

import type { EngraveLabel } from '@/types/engraveJob';

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

/**
 * The intent word that follows the number on the same line (#170, §5.3's list): `surface`,
 * `reveal`, or nothing at all.
 *
 * The design's collapsed line reads "the depth with its intent word", and the word earns its place
 * because `0.3 mm surface` and `0.3 mm` are different claims — one says a rule chose the number to
 * stay in the top colour, the other says it is simply a depth. That is exactly what a person
 * scanning ten folded rows needs to know without opening one.
 *
 * The two words are byte-for-byte the ones the two-state control already shows (`EngraveLabelRow`),
 * and that is deliberate: the line and the control must not be able to disagree about what an
 * intent is called. Everything else draws NOTHING:
 *
 *   - `custom` is the person's own number with no rule behind it, so a word on it would claim a
 *     provenance it does not have;
 *   - an unstated intent is the same case by another route;
 *   - and no other kind of item states an intent at all (a drill's `through` is refused before it
 *     can be a fact about the job, `drill-through-unavailable`).
 *
 * So this returns the word for the one kind that has one, and the row draws the span only when it
 * gets something — which is also why the prop is `string | null` rather than an enum.
 */
export function intentWord(depthIntent: EngraveLabel['depthIntent']): string | null {
  return depthIntent === 'surface' || depthIntent === 'reveal' ? depthIntent : null;
}
