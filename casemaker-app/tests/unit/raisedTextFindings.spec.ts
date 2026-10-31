// #739/#765 — THE RAISED-TEXT SENTENCE NAMES THE PINCHES, NOT THE WHOLE WORD. The old warning
// quoted the label's single tightest gap and said "the letters will join"; since #765 it is built
// from the measured pinch list, so it names only the pairs the cut leaves joined, says how many
// separate, and quotes a width to compare — the cutter's diameter for a flat, its TOP-FACE
// opening for a V (where the raised letters stand), never the tip.

import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import {
  RAISED_EDGE_LOSS_TOLERANCE_MM,
  raisedTextPinchFindings,
  type RaisedTextDetail,
  type RaisedTextPinch,
} from '@/workers/sim/engraveGeometry';

function pinch(over: Partial<RaisedTextPinch> = {}): RaisedTextPinch {
  return { a: 'S', b: 'o', gapMm: 1.08, separated: false, edgeLossMm: 0, areaMm2: 2, ...over };
}

/** One measured label, carrying the values the j02 fixtures produce unless a case overrides. */
function detail(over: Partial<RaisedTextDetail> = {}): RaisedTextDetail {
  const pinches = over.pinches ?? [pinch()];
  return {
    cutawayId: 'clear',
    labelId: 'software',
    text: 'Software',
    size: 14,
    cutterRadius: 1.5875,
    letterAreaMm2: 100,
    sliverAreaMm2: 10,
    letterLossMm2: 0,
    gapMm: 1.08,
    joined: pinches.some((p) => !p.separated),
    counterFilled: false,
    pinches,
    fidelity: 0.9,
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

describe('#765 the raised-text warning names only the joined pinches', () => {
  it('a flat cutter is named by its diameter, and the pairs by their letters', () => {
    const finding = raisedTextPinchFindings([detail()], flatEndMill(3.175))[0]!;
    expect(finding.code).toBe('raised-text-fused');
    expect(finding.severity).toBe('warning');
    expect(finding.message).toContain('Raised text "Software" at 14 mm');
    expect(finding.message).toContain('1 of its 1 pinch point stays joined at a 3.175 mm cutter');
    expect(finding.message).toContain('(1.08 mm at the tightest), between S–o.');
    expect(finding.message).toContain('Use a cutter 1.08 mm or smaller, or text 42 mm or more.');
  });

  it('a V-bit is named by its top-face opening width, not its tip', () => {
    // 2 × 1.2975 = 2.595 mm at the top face; the 1.08 gap is far inside it, so the pair stays.
    const finding = raisedTextPinchFindings(
      [detail({ cutterRadius: 1.2975, pinches: [pinch({ gapMm: 1.08 })] })],
      V_BIT,
    )[0]!;
    expect(finding.message).toContain('stays joined at the 2.595 mm width a 0.3 mm 30° V-bit opens at the top face');
    expect(finding.message).toContain('Use a cutter no wider than 1.08 mm at the top face, or text 34 mm or more.');
  });

  it('names only the joined pairs, and says how many separate', () => {
    const loss = RAISED_EDGE_LOSS_TOLERANCE_MM;
    const finding = raisedTextPinchFindings(
      [
        detail({
          pinches: [
            pinch({ a: 't', b: 'f', gapMm: 0.9 }),
            pinch({ a: 'w', b: 't', gapMm: 0.95 }),
            pinch({ a: 'S', b: 'o', gapMm: 0.98, separated: true, edgeLossMm: loss, areaMm2: 0 }),
            pinch({ a: 'o', b: 'f', gapMm: 1.0, separated: true, edgeLossMm: loss, areaMm2: 0 }),
            pinch({ a: 'r', b: 'e', gapMm: 1.02, separated: true, edgeLossMm: 0, areaMm2: 0 }),
          ],
        }),
      ],
      V_BIT,
    )[0]!;
    expect(finding.message).toContain('2 of its 5 pinch points');
    expect(finding.message).toContain('between t–f, w–t.');
    expect(finding.message).not.toContain('S–o');
    expect(finding.message).not.toContain('o–f');
    expect(finding.message).toContain("The other 3 separate, taking up to 0.03 mm off the letters' edges.");
  });

  it('says nothing when every pinch separates', () => {
    expect(
      raisedTextPinchFindings(
        [detail({ joined: false, pinches: [pinch({ separated: true, edgeLossMm: 0.016 })] })],
        flatEndMill(0.6),
      ),
    ).toEqual([]);
  });
});
