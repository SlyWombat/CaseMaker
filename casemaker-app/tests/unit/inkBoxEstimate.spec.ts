// `inkBox.ts`'s fallback is documented as an UPPER bound over the bundled faces, and "upper bound"
// is a claim about the FACES rather than about whichever text somebody measured (#365 review). It
// was wrong twice over for exactly that reason: 1.25 em/char was measured over a run of the widest
// CAPITAL, and 1.75 em of height over `Åg` — but a face's widest glyph is not a capital and its
// tallest is not a letter.
//
// So this spec does not measure a hand-picked corpus. It walks every glyph of every bundled face,
// typesets it through the app's OWN path (`glyphProfile` → `aabbOfProfile`, the two calls
// `labelGlyphMeasure` makes) and reads its advance, then checks both constants against the worst the
// faces really set — for one glyph, and for a line of nothing but that glyph, which is the shape the
// fallback multiplies out by `text.length`.
//
// The tightness half of each check is deliberate: a constant bumped to 5 to silence a failure would
// be as wrong as one that errs small, only the other way round. "A little room" is what the
// docstrings claim, so a little room is what is pinned.

import { describe, it, expect } from 'vitest';
import { BUNDLED_FONTS, resolveFont, type BundledFontDef } from '@/engine/fonts/registry';
import { capHeightEm, glyphProfile, type ParsedFont } from '@/engine/compiler/glyphs';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { ESTIMATED_ADVANCE_EM, ESTIMATED_HEIGHT_EM, inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import type { TextWeight } from '@/types/textLabel';

/** The cap height every ratio below is per, mm. Whole millimetres are what the seed works in. */
const SIZE = 8;
const WEIGHTS: readonly TextWeight[] = ['regular', 'bold'];

/** One glyph as the fallback sees it, every length a ratio of the cap height it was set at. */
interface Glyph {
  char: string;
  cp: number;
  /** Its ink box, mm of ink per mm of cap. */
  inkWidth: number;
  inkHeight: number;
  /** What it costs a LINE, mm per mm of cap — the number `text.length` multiplies. */
  advance: number;
}

/**
 * The two fields of opentype's glyph record this spec reads. `Font.glyphs` is real at runtime (the
 * app's `textLabels` walks it indirectly through `getPath`, and `glyphs.spec.ts` builds one), but
 * the shipped typings do not declare it — so it is named once, here, rather than cast at each use.
 */
interface GlyphRecord {
  /** The code point it is mapped to, or the 0xFFFF sentinel when it is unmapped. */
  unicode?: number;
  advanceWidth: number;
}

/** The face's parsed glyph table — opentype's own `glyphs`, not its cmap internals. */
function glyphsOf(font: ParsedFont): Glyph[] {
  const cap = capHeightEm(font);
  const table = (font as unknown as { glyphs: { length: number; get(i: number): GlyphRecord } }).glyphs;
  const out: Glyph[] = [];
  for (let i = 0; i < table.length; i++) {
    const glyph = table.get(i);
    const cp = glyph.unicode;
    // Unmapped glyphs carry the 0xFFFF sentinel; control characters and the space have no ink.
    if (cp === undefined || cp === 0xffff || cp <= 0x20) continue;
    const char = String.fromCodePoint(cp);
    const box = aabbOfProfile(glyphProfile(char, font, SIZE));
    const inkWidth = box ? (box.max[0] - box.min[0]) / SIZE : 0;
    const inkHeight = box ? (box.max[1] - box.min[1]) / SIZE : 0;
    if (inkWidth <= 0 && inkHeight <= 0) continue;
    out.push({
      char,
      cp,
      inkWidth,
      inkHeight,
      advance: glyph.advanceWidth / font.unitsPerEm / cap,
    });
  }
  return out;
}

/** Every bundled face, regular and bold, with its glyph table. */
const FACES: { def: BundledFontDef; weight: TextWeight; glyphs: Glyph[] }[] = BUNDLED_FONTS.flatMap(
  (def) => WEIGHTS.map((weight) => ({ def, weight, glyphs: glyphsOf(resolveFont(def.id, weight)) })),
);

/** Every glyph of every face, tagged with the face it came from. */
const ALL: { glyph: Glyph; face: string }[] = FACES.flatMap((f) =>
  f.glyphs.map((glyph) => ({ glyph, face: `${f.def.id} ${f.weight}` })),
);

function worst(score: (g: Glyph) => number): { glyph: Glyph; face: string; value: number } {
  const at = (g: { glyph: Glyph; face: string }) => ({ ...g, value: score(g.glyph) });
  return ALL.map(at).reduce((a, b) => (b.value > a.value ? b : a));
}

const describeGlyph = (g: Glyph) => `${JSON.stringify(g.char)} U+${g.cp.toString(16).toUpperCase()}`;

/** A line of `n` copies of one glyph, as the fallback claims it: per character, per cap. */
function lineRatio(text: string, font: string, weight: TextWeight, n: number, dim: 'width' | 'height') {
  const box = labelGlyphMeasure([])(text, font, weight, SIZE);
  if (!box) throw new Error(`no measurement for ${JSON.stringify(text)} in ${font} ${weight}`);
  return dim === 'width' ? box.width / (SIZE * n) : box.height / SIZE;
}

describe('the fallback ink box is an upper bound over the bundled faces (#364, #365 review)', () => {
  it('scans every face for real — the tables are not empty', () => {
    for (const f of FACES) {
      expect(f.glyphs.length, `${f.def.id} ${f.weight} has no measurable glyphs`).toBeGreaterThan(100);
    }
  });

  it('bounds every glyph the faces can set, in width and in height', () => {
    // One glyph at a time first: neither its ink NOR the advance it costs a line may exceed the
    // constant, because the fallback sizes a line by BOTH (`width = ADVANCE × size × text.length`).
    const widestInk = worst((g) => g.inkWidth);
    const widestAdvance = worst((g) => g.advance);
    const tallest = worst((g) => g.inkHeight);
    expect(
      widestInk.value,
      `${describeGlyph(widestInk.glyph)} in ${widestInk.face} is ${widestInk.value.toFixed(3)} of cap of ink`,
    ).toBeLessThanOrEqual(ESTIMATED_ADVANCE_EM);
    expect(widestAdvance.value, `${describeGlyph(widestAdvance.glyph)} in ${widestAdvance.face} advances`).toBeLessThanOrEqual(
      ESTIMATED_ADVANCE_EM,
    );
    expect(tallest.value, `${describeGlyph(tallest.glyph)} in ${tallest.face} is that tall`).toBeLessThanOrEqual(
      ESTIMATED_HEIGHT_EM,
    );
    // …and not by much: the constants are the measured worst plus a little room, not a shrug.
    expect(ESTIMATED_ADVANCE_EM).toBeLessThanOrEqual(Math.max(widestInk.value, widestAdvance.value) * 1.15);
    expect(ESTIMATED_HEIGHT_EM).toBeLessThanOrEqual(tallest.value * 1.15);
    // The two answers #365 replaced cannot pass the assertions above — a widest CAPITAL is not the
    // widest a face can set, and `Åg` is not the tallest — so this test is the review's point and
    // not a restatement of it.
    expect(Math.max(widestInk.value, widestAdvance.value)).toBeGreaterThan(1.25);
    expect(tallest.value).toBeGreaterThan(1.75);
  });

  it('bounds a LINE of the widest glyph, which is the shape the fallback multiplies out', () => {
    // A line's width is its advances, not the sum of its glyphs' ink — so the case that has to hold
    // is a run of the glyph that costs the most per character. `‰` gets wider per character as the
    // line grows (its ink is narrower than its advance), so the short lines are the tight ones.
    for (const f of FACES) {
      const widest = f.glyphs.reduce((a, b) => (Math.max(b.inkWidth, b.advance) > Math.max(a.inkWidth, a.advance) ? b : a));
      for (const n of [1, 2, 3, 5, 10, 20]) {
        const text = widest.char.repeat(n);
        const where = `${JSON.stringify(text)} in ${f.def.id} ${f.weight}`;
        expect(lineRatio(text, f.def.id, f.weight, n, 'width'), where).toBeLessThanOrEqual(ESTIMATED_ADVANCE_EM);
        expect(lineRatio(text, f.def.id, f.weight, n, 'height'), where).toBeLessThanOrEqual(ESTIMATED_HEIGHT_EM);
        // The fallback itself, against the app's own measure of the same line — the one-line form of
        // the whole claim.
        const real = labelGlyphMeasure([])(text, f.def.id, f.weight, SIZE)!;
        const estimated = inkBoxOf(text, f.def.id, f.weight, SIZE, () => null);
        expect(real.width, where).toBeLessThanOrEqual(estimated.width);
        expect(real.height, where).toBeLessThanOrEqual(estimated.height);
      }
    }
  });

  it('bounds the seeded placeholders the fallback actually lays out, in every face', () => {
    // The strings the app seeds (`Name` on a badge, `Text` on a bare blank) and the demo job's own
    // words — the text a person is most likely to have in front of them before the faces are up.
    for (const text of ['Name', 'Text', 'CASE', 'MAKER', 'TEXT', 'Åg', 'Ậ', 'Ǻ', 'a badge']) {
      for (const f of FACES) {
        const where = `${JSON.stringify(text)} in ${f.def.id} ${f.weight}`;
        const real = labelGlyphMeasure([])(text, f.def.id, f.weight, SIZE)!;
        const estimated = inkBoxOf(text, f.def.id, f.weight, SIZE, () => null);
        expect(real.width, where).toBeLessThanOrEqual(estimated.width);
        expect(real.height, where).toBeLessThanOrEqual(estimated.height);
      }
    }
  });
});
