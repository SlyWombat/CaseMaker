/**
 * The ink box a LINE is measured into — and the estimate used before any face has been parsed
 * (#364, #365).
 *
 * One owner, because two readers ask the same question about the same line: `blankLabelSeed` sizes
 * and places a line by its box, and `voidLimitForItem` (`partPlan.ts`) decides how deep that line
 * may be cut from the voids the box reaches. They have to be the SAME box: a line laid out in the
 * free band beside a pocket, and then advised the pocket's depth, is exactly the bug #365 is.
 *
 * Leaf module, by the `materials.ts` precedent (#347): types only, so neither `partPlan.ts` nor
 * `blankLabelSeed.ts` gains an edge by sharing it.
 *
 * The estimate is an UPPER bound on BOTH sides of the box, deliberately (#364, #365). The hand-off
 * runs before any face is parsed (#180), so the widest box the bundled faces can set is what "this
 * line fits" is measured with: a fallback that erred small seeded a line the real face then ran off
 * the blank. The same direction serves the depth bound — an upper bound reaches AT LEAST as many
 * voids — so a number worked out before the fonts are up is the TIMID one, and a face that parses
 * later can only ever move the depth deeper, never into a refusal.
 *
 * "Upper bound" is a claim about the FACES, and both sides were once only claims about the text
 * somebody happened to measure (#365 review): a run of the widest CAPITAL for the width, `Åg` for the
 * height. Neither held — a face's widest glyph is not a capital and its tallest line is not a letter
 * pair — so `tests/unit/inkBoxEstimate.spec.ts` now scans every glyph of every bundled face and
 * checks both numbers against what the app's own typesetter really returns. The height took two
 * passes to get right: 2.0 was still a claim about SINGLE glyphs, and a line's box is the SPAN across
 * the glyphs it holds.
 *
 * Both sides are load-bearing, and the HEIGHT is the one that looks like it cannot be (#365): an
 * ink box is taller than its cap height whenever the text has a descender or a carried accent, so a
 * fallback of a bare `size` was not an upper bound at all — it under-reached the voids the real face
 * would hit, which is the direction that ends in a refusal rather than in a shallower line.
 */

import type { TextWeight } from '@/types/textLabel';
import type { Mm } from '@/types/units';

/**
 * Ink width per character, in em of cap height, for the FALLBACK ink box — an UPPER bound over every
 * bundled face, not a rule of thumb.
 *
 * It has to be an upper bound, and that is a fix rather than a preference (#364). The fallback is
 * the number the WIZARD's hand-off lays a line out with, before any panel or worker has parsed a
 * face (#180), so a fallback that errs small seeds a line the real face then runs off the blank: at
 * the old 0.6, 'Text' on a 60 × 40 blank came out at 24 mm and `generate` refused the job the wizard
 * had just built with `item-outside-stock` — one more version of the very bug this seed exists to
 * fix, this time created by the fix.
 *
 * 1.25 was #364's number, measured over a run of the widest CAPITAL (`WWWWWWWWWW` in Barlow bold, at
 * a 10 mm cap: 0.35 for `iiiiiiiiii`, 0.67 for `Text`, 0.88 for `Name`, 0.95 for `AAAAAAAAAA`,
 * 1.25 for that run) — and the #365 review was right that a widest capital is not the widest a face
 * can set. Scanned over every glyph of every bundled face (`inkBoxEstimate.spec.ts`), the widest is
 * the per-mille sign `‰`, and what a line of them costs is its ADVANCE rather than its ink: 1.907 of
 * cap per character in IBM Plex Serif bold (a line of `‰` converges on it — 1.877 at five, 1.899 at
 * twenty), 1.679 in Barlow bold, 0.957 in IBM Plex Mono. 1.95 is that with a little room, so a line
 * this size says fits does fit, whatever face the labels are set in.
 *
 * It costs a smaller placeholder than a real measurement would pick — the honest direction to be
 * wrong in, since the line is a starting point the person types over, and being one size small is
 * not a reason to refuse the job.
 */
export const ESTIMATED_ADVANCE_EM = 1.95;

/**
 * Box height, in em of cap height, for the FALLBACK ink box — an UPPER bound over every bundled
 * face, not a rule of thumb.
 *
 * Added by #365, and it is a fix rather than a second guess: the fallback used to be a bare `size`,
 * which is the CAP height, not the box. An ink box is the union of its glyphs' ink, so real text
 * measured over the bundled faces runs from 1.00 (a bare ascender, `l`) to a SPAN of **2.057** —
 * `Ắ` over `ķ` in IBM Plex Serif bold, which is 2.020 even without the Latin Extended-B pair. A bare
 * `size` therefore under-reached every void a face with a descender would really hit, and the depth
 * bound is only allowed to err the other way: measured small says a line is clear of a pocket the
 * cutter then walks into.
 *
 * 1.75 was #365's first answer, worked out from LETTERS (a carried accent over a descender, `Åg` in
 * Barlow bold, 1.706), and the review was right that it is not an upper bound. 2.0 was the second,
 * and the review was right again: it was pinned by SINGLE glyphs (the tallest, the shading block `▓`
 * in IBM Plex Mono, 1.926) and by lines of one repeated glyph, but a line's box is not one glyph's —
 * it is max top − min bottom across EVERY glyph on the line, and a line can hold a face's highest
 * ink over its lowest. 2.1 is that span with a little room.
 *
 * The box-drawing and block-element symbols (U+2500–259F) are the one thing this does NOT bound, and
 * are left out of the measurement deliberately: they are drawing glyphs drawn to the em to meet their
 * neighbours (only IBM Plex Mono has them), a line of them is not text a label holds, and they are
 * what the single-glyph reading was picking up (`▓` 1.926). A face's span with them is 2.149.
 *
 * The cost is only a smaller placeholder if a face ever does set one — the same honest direction
 * `ESTIMATED_ADVANCE_EM` is wrong in.
 */
export const ESTIMATED_HEIGHT_EM = 2.1;

/** The ink box of `text` at cap height `size`, mm — what the seed lays out and fits. */
export interface InkBox {
  width: Mm;
  height: Mm;
}

/**
 * Measure one candidate line, or answer `null` when the face is not available — in which case the
 * caller falls back to `ESTIMATED_ADVANCE_EM`. Injected so the readers stay free of the font
 * registry (and of its throw). `labelGlyphMeasure` (`partPlan.ts`) is the one implementation.
 */
export type InkMeasure = (
  text: string,
  font: string,
  weight: TextWeight,
  size: Mm,
) => InkBox | null;

/** The ink box of `text` at cap height `size`: the injected measurement, or the documented estimate. */
export function inkBoxOf(
  text: string,
  font: string,
  weight: TextWeight,
  size: Mm,
  measure?: InkMeasure,
): InkBox {
  const measured = measure?.(text, font, weight, size);
  if (measured) return measured;
  return { width: ESTIMATED_ADVANCE_EM * size * text.length, height: ESTIMATED_HEIGHT_EM * size };
}
