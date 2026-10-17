/**
 * The cutter profile (#489): the model is the data, so these tests read the model rather than a
 * rendered bitmap. They pin the four promises the issue makes — dimension↔field links, missing
 * fields drawn dashed with `?`, a refusal drawn rather than hidden, and the V groove's arithmetic
 * — and then smoke every shape and both renderers.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCutterProfile,
  cutterDimensionSpecs,
  cutterProfileSvg,
  fmtMm,
  SHAPE_DIMENSION_CODES,
  type CutterField,
} from '@/engine/cnc/cutterProfile';
import { flatEndMill, type Tool, type ToolShape } from '@/engine/cnc/tool';

const FULL = { size: 'full' as const };

function tool(shape: ToolShape, overrides: Partial<Tool> = {}): Tool {
  return flatEndMill(3.175, {
    name: `${shape} cutter`,
    typeText: shape,
    shape,
    cornerRadius: null,
    angle: null,
    halfAngle: null,
    fluteLength: 12,
    shoulderLength: 20,
    ...overrides,
  });
}

const FLAT = tool('flat');
const BALL = tool('ball', { tipDiameter: 3.175, diameter: 3.175, cornerRadius: 1.5875 });
const TAPERED_BALL = tool('tapered-ball', {
  tipDiameter: 1,
  diameter: 1,
  halfAngle: 8,
  cornerRadius: 0.5,
});
const ENGRAVER = tool('engraving', {
  name: '30° engraving bit',
  tipDiameter: 0.3,
  diameter: 3.175,
  halfAngle: 15,
  // The real fixture: Makera's catalogue leaves the shoulder empty on every engraver.
  shoulderLength: null,
});
const CHAMFER = tool('chamfer', {
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 90,
  shoulderLength: null,
});
const DRILL = tool('drill', { tipDiameter: 2, diameter: 2, angle: 118 });
const THREAD = tool('thread', { tipDiameter: null, diameter: 4, shoulderLength: 12 });
const BULL = tool('bull', {
  tipDiameter: 6,
  diameter: 6,
  cornerRadius: 1,
  fluteLength: 12,
  shoulderLength: 20,
});

const SHAPES: Array<[string, Tool]> = [
  ['flat', FLAT],
  ['ball', BALL],
  ['tapered-ball', TAPERED_BALL],
  ['engraving', ENGRAVER],
  ['chamfer', CHAMFER],
  ['drill', DRILL],
  ['thread', THREAD],
  ['bull', BULL],
];

describe('cutterProfile (#489)', () => {
  it('names every field a dimension can link to, in the shape vocabulary', () => {
    // The vocabulary is the industry codes, and every code maps to a `Tool` field name.
    expect(SHAPE_DIMENSION_CODES.flat).toEqual(['DS', 'DC', 'LS', 'LC']);
    expect(SHAPE_DIMENSION_CODES.engraving).toEqual(['DS', 'DC', 'LC', 'AN', 'D1']);
    expect(SHAPE_DIMENSION_CODES.chamfer).toEqual(['DS', 'DC', 'LC', 'TI']);
    expect(SHAPE_DIMENSION_CODES.thread).toEqual(['DS', 'DC', 'LS']);
    expect(SHAPE_DIMENSION_CODES.unknown).toEqual([]);

    const seen = new Set<CutterField>();
    for (const [shape, t] of SHAPES) {
      for (const spec of cutterDimensionSpecs(t)) {
        seen.add(spec.field);
        expect(spec.code, `${shape} ${spec.code}`).toMatch(/^(DS|DC|LS|LC|CR|TI|AN|D1)$/);
      }
    }
    expect(seen).toContain('handleDiameter');
    expect(seen).toContain('tipDiameter');
    expect(seen).toContain('fluteLength');
    expect(seen).toContain('shoulderLength');
    expect(seen).toContain('cornerRadius');
    expect(seen).toContain('halfAngle');
    expect(seen).toContain('angle');
  });

  it('reads DC from the body diameter for a V-bit and from the tip for a flat end', () => {
    const eng = Object.fromEntries(cutterDimensionSpecs(ENGRAVER).map((s) => [s.code, s]));
    expect(eng.DC).toMatchObject({ field: 'diameter', value: 3.175, text: '3.175' });
    expect(eng.D1).toMatchObject({ field: 'tipDiameter', value: 0.3, text: '0.3' });
    expect(eng.AN).toMatchObject({ field: 'halfAngle', value: 15, text: '15°' });

    const flat = Object.fromEntries(cutterDimensionSpecs(FLAT).map((s) => [s.code, s]));
    expect(flat.DC).toMatchObject({ field: 'tipDiameter', value: 3.175 });
  });

  it('derives the included and half angle from whichever the record states', () => {
    const includedOnly = tool('chamfer', { tipDiameter: 0.1, diameter: 3.175, angle: 90, halfAngle: null });
    const ti = cutterDimensionSpecs(includedOnly).find((s) => s.code === 'TI')!;
    expect(ti).toMatchObject({ field: 'angle', value: 90, text: '90°' });

    const halfOnly = tool('chamfer', { tipDiameter: 0.1, diameter: 3.175, angle: null, halfAngle: 45 });
    const derived = cutterDimensionSpecs(halfOnly).find((s) => s.code === 'TI')!;
    expect(derived).toMatchObject({ field: 'halfAngle', value: 90, text: '90°' });

    const engraverDerived = tool('engraving', {
      tipDiameter: 0.3,
      diameter: 3.175,
      angle: 30,
      halfAngle: null,
    });
    const an = cutterDimensionSpecs(engraverDerived).find((s) => s.code === 'AN')!;
    expect(an).toMatchObject({ field: 'angle', value: 15, text: '15°' });
  });

  it('draws a missing field as a dashed dimension with ? and a dashed edge', () => {
    // Every Makera engraver/chamfer leaves shoulderLength empty: the shoulder must be visibly
    // unknown, not drawn as a measured length.
    const model = buildCutterProfile(ENGRAVER, FULL);
    const ls = model.dimensions.find((d) => d.code === 'LS');
    expect(ls).toBeUndefined(); // LS is not in the engraver vocabulary...
    const spec = cutterDimensionSpecs(ENGRAVER).find((s) => s.code === 'LC')!;
    expect(spec.missing).toBe(false); // ...but the flute is stated.

    expect(model.missingFields).toContain('shoulderLength');
    const neck = model.paths.find((p) => p.missingField === 'shoulderLength');
    expect(neck).toBeDefined();
    expect(neck!.dashed).toBe(true);
    expect(neck!.missing).toBe(true);

    // A flat's LS IS in its vocabulary, so it is a dashed `?` dimension.
    const flatModel = buildCutterProfile(tool('flat', { shoulderLength: null }), FULL);
    const flatLs = flatModel.dimensions.find((d) => d.code === 'LS')!;
    expect(flatLs.missing).toBe(true);
    expect(flatLs.text).toBe('?');
    expect(flatLs.textAt.missing).toBe(true);
    // The line and its extensions are dashed; the arrowheads are solid so they stay legible.
    for (const p of flatLs.paths.filter((p) => p.role === 'dimension' || p.role === 'extension')) {
      expect(p.dashed).toBe(true);
      expect(p.missing).toBe(true);
    }
    expect(flatLs.paths.some((p) => p.role === 'arrow')).toBe(true);
  });

  it('links every dimension line to its field in both directions', () => {
    const model = buildCutterProfile(ENGRAVER, FULL);
    for (const d of model.dimensions) {
      expect(d.paths.length).toBeGreaterThan(0);
      expect(d.field).toBe(
        cutterDimensionSpecs(ENGRAVER).find((s) => s.code === d.code)!.field,
      );
    }
    // The model carries the same field on the dimension and on any edge that depends on it, which
    // is what the React view keys its hover/focus highlight on.
    for (const p of model.paths) {
      if (p.missingField !== undefined) expect(model.missingFields).toContain(p.missingField);
    }
  });

  it('draws the V groove at the job depth from grooveRadiusAt, as a second outline', () => {
    const depth = 1;
    const model = buildCutterProfile(ENGRAVER, { ...FULL, grooveDepth: depth });
    expect(model.groove).not.toBeNull();
    const half = 15 * (Math.PI / 180);
    const expectedWidth = 0.3 + 2 * depth * Math.tan(half);
    expect(model.groove!.label.text).toBe(`Ø ${fmtMm(expectedWidth)} mm at 1.0 mm deep`);
    expect(model.groove!.label.text).toContain('0.836');
    expect(model.groove!.paths.length).toBeGreaterThanOrEqual(3);
    expect(model.groove!.paths.some((p) => p.role === 'groove' && !p.dashed)).toBe(true);
  });

  it('does not invent a groove for a non-V tool', () => {
    const model = buildCutterProfile(FLAT, { ...FULL, grooveDepth: 1 });
    expect(model.groove).toBeNull();
  });

  it('draws a refusal greyed with the simulator code and reason, and keeps the profile', () => {
    const refusal = { code: 'prior-removal-column', reason: 'the roughing pass already removed this column' };
    const model = buildCutterProfile(FLAT, { ...FULL, refusal });
    expect(model.refusal).toEqual(refusal);
    expect(model.refusalLines.join(' ')).toContain('prior-removal-column');
    expect(model.paths.length).toBeGreaterThan(0);
    expect(model.fillPath).not.toBeNull();

    const svg = cutterProfileSvg(FLAT, { size: 'print', refusal });
    expect(svg).toContain('is-refused');
    expect(svg).toContain('prior-removal-column');
    expect(svg).toContain('the roughing pass already removed this column');
  });

  it('refuses an unknown shape with tool-refused rather than guessing a silhouette', () => {
    const unknown = tool('unknown', { name: 'mystery bit', typeText: 'Laser Wand' });
    const model = buildCutterProfile(unknown, FULL);
    expect(model.refusal).toMatchObject({ code: 'tool-refused' });
    expect(model.refusal!.reason).toContain('Laser Wand');
    expect(model.dimensions).toEqual([]);
    expect(model.paths.filter((p) => p.role === 'tip' || p.role === 'flank').every((p) => p.dashed)).toBe(true);
    expect(cutterProfileSvg(unknown)).toContain('tool-refused');
  });

  it('draws all eight shapes without NaN and with a fill', () => {
    for (const [name, t] of SHAPES) {
      const model = buildCutterProfile(t, FULL);
      expect(model.viewBox.width, name).toBeGreaterThan(0);
      expect(model.viewBox.height, name).toBeGreaterThan(0);
      for (const value of Object.values(model.viewBox)) expect(Number.isFinite(value), name).toBe(true);
      for (const p of model.paths) expect(p.d, name).not.toContain('NaN');
      expect(model.fillPath, name).not.toBeNull();
      expect(model.fillPath!, name).not.toContain('NaN');
      expect(model.title, name).toContain(t.name);
      expect(model.desc, name).toContain('Side profile');
    }
  });

  it('clamps a tiny cutter to a readable width and says the length scale differs', () => {
    const tiny = flatEndMill(0.2, {
      name: '0.2 mm flat end',
      handleDiameter: 0.2,
      fluteLength: 6,
      shoulderLength: 20,
    });
    const model = buildCutterProfile(tiny, FULL);
    expect(model.scaleBars.length).toBeGreaterThanOrEqual(2);
    expect(model.scaleNote).not.toBeNull();
    expect(model.scaleNote).toContain('scale');
    expect(model.scaleNoteAt!.text).toContain('read the bars');
  });

  it('has no dimensions or scale bars in the picker thumbnail', () => {
    const model = buildCutterProfile(ENGRAVER, { size: 'thumb' });
    expect(model.dimensions).toEqual([]);
    expect(model.scaleBars).toEqual([]);
    expect(model.extraMarks).toEqual([]);
    expect(model.viewBox.width).toBeLessThan(200);
  });

  it('emits a standalone SVG with a title, a desc, and no external or bitmap art', () => {
    const svg = cutterProfileSvg(ENGRAVER, { size: 'print', grooveDepth: 0.8 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<title>');
    expect(svg).toContain('<desc>');
    expect(svg).toContain('30° engraving bit');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('href=');
    expect(svg).not.toContain('data:image');
    // The groove's width at the supplied depth is written on the drawing.
    expect(svg).toContain('0.729');
  });

  it('carries the owned cutter label colour as a shank band when one is supplied', () => {
    const withBand = buildCutterProfile(FLAT, { ...FULL, labelColor: '#e05a00' });
    expect(withBand.labelBand).not.toBeNull();
    expect(withBand.labelBand!.fill).toBe(true);
    expect(buildCutterProfile(FLAT, FULL).labelBand).toBeNull();
  });
});
