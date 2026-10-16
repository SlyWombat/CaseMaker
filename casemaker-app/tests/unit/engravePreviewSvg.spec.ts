// The predicted-cut picture (#410).
//
// The module is pure by construction — it is handed the opened polygons and the void footprints the
// EVALUATED plan produced — so this spec needs no wasm, and every case here is about the one thing
// the picture is for: showing which strokes survive a cutter of a stated width. Its load-bearing
// claim is not "an SVG came out"; it is that a region the job will NOT cut is still drawn, named and
// marked, and that the shares on it are the measured ones.

import { describe, it, expect } from 'vitest';

import { engravePreviewSvg, type EngravePreviewSvgInput } from '../../scripts/lib/engravePreviewSvg';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';

/** A square ring of `size` mm centred on the origin — an item's own outline. */
function square(size: number): [number, number][] {
  const h = size / 2;
  return [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
}

/**
 * A ring moved into the stock frame. This is the shape `measureLabels` hands over — its polygons
 * are ALREADY placed (the item's own outline offset by the cutter radius, in stock coordinates),
 * which is why the module draws them as given and never applies an item's position a second time.
 */
function move(ring: readonly [number, number][], dx: number, dy: number): [number, number][] {
  return ring.map(([x, y]) => [x + dx, y + dy]);
}

/**
 * A job whose three items are the picture's three cases: one cut in full, one cut partly (its
 * strokes are thinner than the bit), and one the job carries TURNED OFF — the design route's
 * "nothing on the bench reaches this" (#410).
 */
function job(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'preview-test',
    stock: { ...base.stock, length: 40, width: 30, thickness: 3 },
    labels: [],
    vectors: [
      {
        kind: 'vector',
        id: 'v-full',
        name: 'TITLE',
        sourceName: 'title.svg',
        contours: [square(10)],
        fillRule: 'NonZero',
        width: 10,
        height: 10,
        position: { x: 10, y: 10 },
        rotation: 0,
        depth: 1,
        enabled: true,
      },
      {
        kind: 'vector',
        id: 'v-part',
        name: 'br',
        sourceName: 'br.svg',
        contours: [square(6)],
        fillRule: 'NonZero',
        width: 6,
        height: 6,
        position: { x: 26, y: 20 },
        rotation: 0,
        depth: 1,
        enabled: true,
      },
      {
        kind: 'vector',
        id: 'v-off',
        name: '(Like the Whiskey)',
        sourceName: 'sub.svg',
        contours: [square(8)],
        fillRule: 'NonZero',
        width: 8,
        height: 8,
        position: { x: 20, y: 6 },
        rotation: 0,
        depth: 1,
        enabled: false,
      },
    ],
  };
}

const INPUT: EngravePreviewSvgInput = {
  job: job(),
  // `TITLE` opens whole; `br` opens a 3 mm square inside its 6 mm outline, i.e. 9 mm² of 36 mm².
  cuts: [
    { id: 'v-full', name: 'Pocket outline "TITLE" (1 contour, 10×10 mm)', depth: 1, polygons: [move(square(10), 10, 10)] },
    { id: 'v-part', name: 'Pocket outline "br" (1 contour, 6×6 mm)', depth: 1, polygons: [move(square(3), 26, 20)] },
  ],
  diameter: 0.6,
  ratios: new Map([
    ['v-full', 1],
    ['v-part', 9 / 36],
  ]),
  keepOuts: [{ id: 'ko1', name: 'Magnet pocket', polygons: [move(square(4), 35, 5)] }],
};

const svg = (over: Partial<EngravePreviewSvgInput> = {}): string => engravePreviewSvg({ ...INPUT, ...over });

/**
 * The text of one `<g>` — enough to read the labels out of the picture. Deliberately not a DOM:
 * the module returns a string, and parsing the string is what the browser will do.
 */
function groupText(markup: string, id: string): string {
  const m = new RegExp(`<g id="${id}"[^>]*>([\\s\\S]*?)</g>`).exec(markup);
  return m?.[1] ?? '';
}

describe('the predicted-cut preview (#410)', () => {
  it('draws the opened polygons the cutter produces, and nothing of its own', () => {
    // The cut group is exactly the handed-in polygons: one path per cut, no re-derivation. A
    // preview that measured its own offset could disagree with the program it is a picture of.
    const cut = groupText(svg(), 'cut');
    expect(cut.match(/<path/g)).toHaveLength(2);
    // The 3 mm square the bit can open inside `br`, at its own corners in the stock frame — and the
    // page flip (`page y = −job y`) is part of the answer, because getting it wrong mirrors the
    // picture while leaving the numbers on it looking plausible.
    expect(cut).toContain('M24.5,-18.5L27.5,-18.5L27.5,-21.5L24.5,-21.5Z');
    expect(cut).toContain('M5,-5L15,-5L15,-15L5,-15Z');
  });

  it('draws an item the job will NOT cut, and says so', () => {
    // The design route turns a region off when no owned cutter reaches it. Leaving it out of the
    // picture is the one lie this picture must not tell: the file asked for it, and the operator is
    // about to cut a badge without it.
    const ideal = groupText(svg(), 'ideal');
    expect(ideal.match(/<path/g)).toHaveLength(3);
    // Hollow and dashed, never filled: it is not material being removed.
    expect(ideal).toContain('fill="none"');
    expect(ideal).toContain('stroke-dasharray');
    // …and it is NAMED as not cut, in the void red, with no percentage to misread as a share.
    expect(svg()).toContain('(Like the Whiskey) — not cut');
    expect(svg()).not.toContain('(Like the Whiskey) ·');
  });

  it('labels each item with the JOB’s name, not the plan’s sentence about it', () => {
    // `plan.engraves[].name` is an operations-list sentence — "Pocket outline "TITLE" (1 contour,
    // 10×10 mm)". Set across a 10 mm letter it is unreadable, and it is the item's own name that a
    // person checks the picture against.
    const markup = svg();
    expect(markup).toContain('TITLE · 100 %');
    expect(markup).toContain('br · 25 %');
    expect(markup).not.toContain('Pocket outline');
  });

  it('prints the measured share, and a dash — not 0 % — for an item never measured', () => {
    // "No cutter reached it" and "nothing measured it" are different facts, and `measureLabels`
    // answers a zero-area item ratio 1, so 0 % would be a number nobody took.
    expect(svg({ ratios: undefined })).toContain('TITLE · —');
  });

  it('draws the void footprint it is handed, not a rectangle of its own', () => {
    // The badge's magnet pocket is an imported 144-point ring. A local "rounded rect is four
    // corners" would ignore the void's `rotation`, and would have no answer at all for a circle or
    // a slot — the app's own `executeProfile` is what resolves all four kinds.
    const markup = svg();
    expect(markup).toContain('stroke-dasharray="1.6 1"');
    expect(markup).toContain('M33,-3L37,-3L37,-7L33,-7Z');
    expect(markup).toContain('Magnet pocket');
  });

  it('draws the cutter at its true diameter beside the 10 mm rule', () => {
    // The two lengths the picture is read against. If the disc is not the real width, the reader
    // cannot tell a 0.6 mm bit from a 1 mm one — which is the whole question.
    const scale = groupText(svg(), 'scale');
    expect(scale).toContain('r="0.3"');
    expect(scale).toContain('10 mm');
    expect(scale).toContain('⌀ 0.6 mm cutter, to scale');
    // A job with no usable cutter still draws the rule and says what the picture is of.
    expect(groupText(svg({ diameter: null }), 'scale')).not.toContain('<circle');
    expect(svg({ diameter: null })).toContain('— the predicted cut at the cutter');
  });

  it('escapes a name rather than emitting it into the markup', () => {
    // An item name comes from a project file, i.e. from outside. `&` and `<` end an attribute or
    // open an element: an unescaped name is a picture that will not open, or worse.
    const job = INPUT.job;
    const named = { ...job, vectors: job.vectors?.map((v) => (v.id === 'v-full' ? { ...v, name: 'A & B <x>' } : v)) };
    expect(svg({ job: named })).toContain('A &amp; B &lt;x&gt; · 100 %');
  });

  it('states the blank, the viewing direction and the two inks', () => {
    const markup = svg();
    expect(markup).toContain('preview-test — the predicted cut at ⌀ 0.6 mm');
    expect(markup).toContain('40 × 30 × 3 mm blank, seen from above.');
    expect(markup).toContain('+X right, across the jaws. +Y away from the operator.');
    expect(markup).toContain('Grey: what the file asked for. Dark: what the cutter opens.');
  });
});
