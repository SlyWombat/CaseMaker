// #646 — a tool's name for people, from its own geometry: the strip, the run sheet and the pickers
// all read it from here, so they cannot disagree; the vendor label stays data (a hover).

import { describe, expect, it } from 'vitest';

import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { flatEndMill, parseLabelAngle, type Tool } from '@/engine/cnc/tool';

const tool = (over: Partial<Tool>): Tool => ({ ...flatEndMill(1, { number: 1, name: 'vendor label' }), ...over });

describe('#646 the tool display name', () => {
  it('names a V-bit by its tip diameter, its included angle and its kind', () => {
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: 30 }))).toBe('0.5 mm 30° engraver');
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.3, angle: 30 }))).toBe('0.3 mm 30° engraver');
  });

  it('names a flat end and a ball by diameter and kind', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, diameter: 1 }))).toBe('1 mm flat end');
    expect(toolDisplayName(tool({ shape: 'ball', tipDiameter: 3, diameter: 3 }))).toBe('3 mm ball');
  });

  it('drops trailing zeros rather than inventing precision', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1.0, diameter: 1.0 }))).toBe('1 mm flat end');
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 3.175, diameter: 3.175 }))).toBe('3.17 mm flat end'); // 3.175 is 3.1749… in binary
  });

  it('never reads the vendor label when the geometry states the size', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 2, name: '4*0.5mm*30º Engraving(Metal)' }))).not.toContain('Engraving');
  });

  // #651 — every shape has its own name. A chamfer, a tapered ball and an unparsed row all fell to
  // "flat end" before this, on the surface that answers "what is in the spindle".
  it('#651 names the remaining shapes', () => {
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: 1, angle: 90 }))).toBe('1 mm 90° chamfer');
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: 1, angle: null }))).toBe('1 mm chamfer');
    expect(toolDisplayName(tool({ shape: 'tapered-ball', tipDiameter: 3, cornerRadius: 1.5 }))).toBe('3 mm tapered ball R1.5');
    expect(toolDisplayName(tool({ shape: 'tapered-ball', tipDiameter: 3, cornerRadius: null }))).toBe('3 mm tapered ball');
    expect(toolDisplayName(tool({ shape: 'bull', tipDiameter: 3, cornerRadius: 0.5 }))).toBe('3 mm bull nose');
    expect(toolDisplayName(tool({ shape: 'thread', tipDiameter: 2 }))).toBe('2 mm thread mill');
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: 1 }))).toBe('1 mm drill');
  });

  it('#651 never guesses a kind for a row it cannot classify', () => {
    expect(toolDisplayName(tool({ shape: 'unknown', name: 'Corner Radius End Mill 3x6' }))).toBe('unknown cutter (Corner Radius End Mill 3x6)');
    expect(toolDisplayName(tool({ shape: 'unknown', name: '', typeText: '' }))).toBe('unknown cutter');
  });

  // #651 — `diameter=` is the SHANK for engravers, drills and chamfers (Makera writes it there), so
  // a 1 mm drill is never announced as "3.18 mm drill". With no tip the vendor label is the name.
  it('#651 names a shank-diameter kind by its TIP, never by the shank', () => {
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: 1, diameter: 3.175 }))).toBe('1 mm drill');
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: null, diameter: 3.175, name: '1mm Drill(Metal)' }))).toBe(
      'drill (1mm Drill(Metal))',
    );
    expect(
      toolDisplayName(tool({ shape: 'engraving', tipDiameter: null, diameter: 3.175, angle: 30, name: '4*0.5mm*30º Engraving(Metal)' })),
    ).toBe('engraver (4*0.5mm*30º Engraving(Metal))');
    expect(toolDisplayName(tool({ shape: 'chamfer', tipDiameter: null, diameter: 6, name: '' , typeText: 'Chamfer' }))).toBe(
      'chamfer (Chamfer)',
    );
    // No tip and no label at all: say the kind, and that nothing names its size.
    expect(toolDisplayName(tool({ shape: 'drill', tipDiameter: null, diameter: 3.175, name: '', typeText: '' }))).toBe('unknown drill');
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
    ).toBe('0.5 mm 30° engraver');
    // A stated `angle` still wins over the label.
    expect(
      toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: 60, name: '4*0.5mm*30º Engraving(Metal)' })),
    ).toBe('0.5 mm 60° engraver');
  });
});
