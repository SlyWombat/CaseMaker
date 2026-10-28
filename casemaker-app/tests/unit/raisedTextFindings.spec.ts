// The raised-text sentence (#739) must quote the number it actually compared. For a flat cutter
// that is its own diameter; for a V-bit it is its width at the cut-away's depth, not the tip — a
// sentence that said "narrower than a 0.3 mm V-bit" about a 1.6 mm gap would be false.

import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import { raisedTextFindings, type RaisedTextMeasurement } from '@/workers/sim/engraveGeometry';

/** One measured row, carrying the values the flat bench fixtures produce unless a case overrides. */
function row(over: Partial<RaisedTextMeasurement> = {}): RaisedTextMeasurement {
  return {
    cutawayId: 'clear',
    labelId: 'software',
    text: 'Software',
    size: 14,
    cutterRadius: 1.5875,
    gap: 1.08,
    joined: true,
    counterFilled: false,
    minSize: 42,
    ...over,
  };
}

/** A 30° engraver with a 0.3 mm tip, the shape the bench's V jobs carry. */
const V_BIT = flatEndMill(3.175, {
  name: '30° V-bit',
  typeText: 'Engraver',
  shape: 'engraving',
  tipDiameter: 0.3,
  halfAngle: 15,
  angle: 30,
});

describe('#739 the raised-text sentence quotes the width it compared', () => {
  it('a flat cutter is named by its diameter', () => {
    const finding = raisedTextFindings([row()], flatEndMill(3.175))[0]!;
    expect(finding.message).toContain('narrower than a 3.175 mm cutter');
    expect(finding.message).toContain('Use a cutter 1.08 mm or smaller, or text 42 mm or more.');
  });

  it('a V-bit is named by its width at the cut-away depth, not its tip', () => {
    // The measurement stores the plane radius it opened the field with; 2 × 1.2975 = 2.595 mm.
    const finding = raisedTextFindings([row({ cutterRadius: 1.2975 })], V_BIT)[0]!;
    expect(finding.message).toContain(
      'narrower than the 2.595 mm width a 0.3 mm 30° V-bit cuts at that depth',
    );
    expect(finding.message).toContain(
      'Use a cutter no wider than 1.08 mm at that depth, or text 42 mm or more.',
    );
  });
});
