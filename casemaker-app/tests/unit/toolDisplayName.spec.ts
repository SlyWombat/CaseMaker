// #646 — a tool's name for people, from its own geometry: the strip, the run sheet and the pickers
// all read it from here, so they cannot disagree; the vendor label stays data (a hover).
//
// #687 — the one form is `⌀ 3.175 mm flat end · 12 mm flute` (+ a metal tag), with at most three
// decimals and trailing zeros dropped. The no-cutting-size branch no longer prints the vendor label
// (`drill (1mm Drill(Metal))`), and an unclassifiable row is never given a guessed kind.

import { describe, expect, it } from 'vitest';

import { TOOL_GROUPS, toolDisplay, toolDisplayName } from '@/engine/cnc/toolDisplay';
import { flatEndMill, parseLabelAngle, type Tool } from '@/engine/cnc/tool';

const tool = (over: Partial<Tool>): Tool => ({ ...flatEndMill(1, { number: 1, name: 'vendor label' }), ...over });

describe('#646 the tool display name', () => {
  it('names a V-bit by its tip diameter, its included angle and its kind', () => {
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: 30 }))).toBe('⌀ 0.5 mm 30° engraver');
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.3, angle: 30 }))).toBe('⌀ 0.3 mm 30° engraver');
  });

  it('names a flat end and a ball by diameter and kind', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, diameter: 1 }))).toBe('⌀ 1 mm flat end');
    expect(toolDisplayName(tool({ shape: 'ball', tipDiameter: 3, diameter: 3 }))).toBe('⌀ 3 mm ball');
  });

  it('#687 drops trailing zeros and never invents a second number for 3.175', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1.0, diameter: 1.0 }))).toBe('⌀ 1 mm flat end');
    // The audit's D3: this used to print "3.17" beside records that say 3.175.
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 3.175, diameter: 3.175 }))).toBe('⌀ 3.175 mm flat end');
    // At most three decimals, and a binary tail is not a fourth decimal.
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1.23456, diameter: 1.23456 }))).toBe('⌀ 1.235 mm flat end');
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 0.1 + 0.2, diameter: 0.1 + 0.2 }))).toBe('⌀ 0.3 mm flat end');
  });

  it('#687 names the flute length when the record states one, and omits it otherwise', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, fluteLength: 7 }))).toBe('⌀ 1 mm flat end · 7 mm flute');
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, fluteLength: null }))).toBe('⌀ 1 mm flat end');
    // "unset" is written as 0 by Studio for every bit whose collar nobody measured; it is not a length.
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, fluteLength: 0 }))).toBe('⌀ 1 mm flat end');
  });

  it('#687 prints the vocabulary table’s example: metal duty, 3.175 mm, 12 mm flute', () => {
    const display = toolDisplay(
      tool({ shape: 'flat', tipDiameter: 3.175, diameter: 3.175, fluteLength: 12, name: '3.175*12mm Flat End(Metal)' }),
    );
    expect(display.name).toBe('⌀ 3.175 mm flat end · 12 mm flute');
    expect(display.metal).toBe(true);
  });

  it('#687 states the metal fact from either spelling of the vendor line, and never as the name', () => {
    expect(toolDisplay(tool({ name: '3.175*12mm Flat End(Metal)' })).metal).toBe(true);
    expect(toolDisplay(tool({ name: 'Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm' })).metal).toBe(true);
    expect(toolDisplay(tool({ name: '1 mm flat end' })).metal).toBe(false);
    expect(toolDisplayName(tool({ name: '1 mm flat end' }))).not.toContain('flat end(Metal)');
  });

  it('never reads the vendor label when the geometry states the size', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 2, name: '4*0.5mm*30º Engraving(Metal)' }))).not.toContain(
      'Engraving',
    );
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 2, name: '[diameter washed out on label; code says 3.175]' }))).toBe(
      '⌀ 2 mm flat end',
    );
  });

  // #651 — every shape has its own name. A chamfer, a tapered ball and an unparsed row all fell to
  // "flat end" before this, on the surface that answers "what is in the spindle".
  it('#651 names the remaining shapes', () => {
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: 1, angle: 90 }))).toBe('⌀ 1 mm 90° chamfer');
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: 1, angle: null }))).toBe('⌀ 1 mm chamfer');
    expect(toolDisplayName(tool({ shape: 'tapered-ball', tipDiameter: 3, cornerRadius: 1.5 }))).toBe(
      '⌀ 3 mm tapered ball R1.5',
    );
    expect(toolDisplayName(tool({ shape: 'tapered-ball', tipDiameter: 3, cornerRadius: null }))).toBe('⌀ 3 mm tapered ball');
    expect(toolDisplayName(tool({ shape: 'bull', tipDiameter: 3, cornerRadius: 0.5 }))).toBe('⌀ 3 mm bull nose');
    expect(toolDisplayName(tool({ shape: 'thread', tipDiameter: 2 }))).toBe('⌀ 2 mm thread mill');
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: 1 }))).toBe('⌀ 1 mm drill');
  });

  it('#651/#687 never guesses a kind or prints a label for a row it cannot classify', () => {
    expect(toolDisplayName(tool({ shape: 'unknown', name: 'Corner Radius End Mill 3x6' }))).toBe('unknown cutter');
    expect(toolDisplayName(tool({ shape: 'unknown', name: '', typeText: '' }))).toBe('unknown cutter');
    // The old form was `unknown cutter (vendor label)`: the label is data, not the name.
    expect(toolDisplayName(tool({ shape: 'unknown', name: 'Corner Radius End Mill 3x6' }))).not.toContain('(');
  });

  // #651 — `diameter=` is the SHANK for engravers, drills and chamfers (Makera writes it there), so
  // a 1 mm drill is never announced as "3.18 mm drill". #687 — with no tip the name says the kind and
  // that the size is unstated, rather than falling back to the vendor label in a parenthetical.
  it('#651/#687 names a shank-diameter kind by its TIP, never by the shank or the label', () => {
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: 1, diameter: 3.175 }))).toBe('⌀ 1 mm drill');
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: null, diameter: 3.175, name: '1mm Drill(Metal)' }))).toBe(
      'drill — cutting diameter unknown',
    );
    expect(
      toolDisplayName(
        tool({ shape: 'engraving', tipDiameter: null, diameter: 3.175, angle: 30, name: '4*0.5mm*30º Engraving(Metal)' }),
      ),
    ).toBe('engraver — cutting diameter unknown');
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: null, diameter: 6, name: '', typeText: 'Chamfer' }))).toBe(
      'chamfer — cutting diameter unknown',
    );
    // No tip and no label at all: the same honest sentence, never a guessed "unknown drill".
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: null, diameter: 3.175, name: '', typeText: '' }))).toBe(
      'drill — cutting diameter unknown',
    );
    // A zero diameter is not a size to print.
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: 0, angle: 90 }))).toBe(
      'chamfer — cutting diameter unknown',
    );
  });

  it('#658 reads a cone angle from a vendor label, and only from a degree sign', () => {
    // The three label shapes the catalogue shows: the angle reads off the °/º sign; a length never does.
    expect(parseLabelAngle('4*0.5mm*30º Engraving(Metal)')).toBe(30);
    expect(parseLabelAngle('3.175*1*4mm Ball Nose')).toBeNull(); // 4 mm flute, not 4°
    expect(parseLabelAngle('3.175*12mm Flat End')).toBeNull(); // 12 mm flute, not 12°
    // The house's own label spells the degree sign as °: both signs are the same statement.
    expect(parseLabelAngle('Single Flute Engraving Bit - 1/8" Shank 60° * 0.1mm')).toBe(60);
  });

  it('#658 names a label-only engraver by its tip and the label angle', () => {
    expect(
      toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: null, name: '4*0.5mm*30º Engraving(Metal)' })),
    ).toBe('⌀ 0.5 mm 30° engraver');
    // A stated `angle` still wins over the label.
    expect(
      toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: 60, name: '4*0.5mm*30º Engraving(Metal)' })),
    ).toBe('⌀ 0.5 mm 60° engraver');
  });

  // #687 — the cutter list's groups, in the design's order. A bull nose is a flat end with a
  // rounded corner; a tapered ball is a ball with a radius; an unclassifiable row has no group.
  it('#687 groups the cutter list by kind in the design’s order', () => {
    expect(TOOL_GROUPS.map((g) => g.label)).toEqual([
      'flat end',
      'ball',
      'V and chamfer',
      'engraver',
      'drill',
      'thread',
    ]);
    for (const group of TOOL_GROUPS) {
      expect(group.shapes.length).toBeGreaterThan(0);
    }
    const shapesIn = (label: string): readonly string[] =>
      TOOL_GROUPS.find((g) => g.label === label)?.shapes ?? [];
    expect(shapesIn('flat end')).toContain('flat');
    expect(shapesIn('flat end')).toContain('bull');
    expect(shapesIn('ball')).toContain('ball');
    expect(shapesIn('ball')).toContain('tapered-ball');
    expect(shapesIn('V and chamfer')).toEqual(['chamfer']);
    expect(shapesIn('engraver')).toEqual(['engraving']);
    // No group invents a heading for a row this build cannot classify.
    expect(TOOL_GROUPS.some((g) => g.shapes.includes('unknown'))).toBe(false);
  });
});
