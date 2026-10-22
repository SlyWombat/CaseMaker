// #573 — the shared cutter/material metal-line predicate. The wizard's step-2 gate and the worker's
// `metalLineFindings` both read this, so the refusal a job sees and the gate the wizard shows can
// never disagree. This pins the three cases the pair check has.

import { describe, it, expect } from 'vitest';
import { cutterOnMetalLine, cutterRefusedOnMaterial } from '@/engine/cnc/engrave/cutterMaterial';
import { flatEndMill } from '@/engine/cnc/tool';

describe('cutterMaterial (#573 shared metal-line predicate)', () => {
  /** The 30° engraving bit, named for metal but a V-profile cone — dual-use (#575). */
  const engravingMetal = flatEndMill(0.5, {
    shape: 'engraving',
    name: 'Engraving V-bit 30 x 0.5 (Metal)',
    tipDiameter: 0.5,
    diameter: 3.175,
    angle: 30,
    halfAngle: 15,
  });
  /** Makera's metal FLAT end mill, on the "(Metal)" line and genuinely metal-only (#405). */
  const flatMetal = flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)' });

  it('does not refuse a V-profile engraving bit on PLA, even with a metal name (#575)', () => {
    expect(cutterOnMetalLine(engravingMetal, 'pla')).toBe(false);
    expect(cutterRefusedOnMaterial(engravingMetal, 'pla', undefined)).toBe(false);
  });

  it('refuses a flat metal cutter on PLA, and the override acknowledges it (#572)', () => {
    expect(cutterOnMetalLine(flatMetal, 'pla')).toBe(true);
    expect(cutterRefusedOnMaterial(flatMetal, 'pla', undefined)).toBe(true);
    expect(cutterRefusedOnMaterial(flatMetal, 'pla', true)).toBe(false);
  });

  it('does not put a flat metal cutter on a metal blank on the line (#405)', () => {
    expect(cutterOnMetalLine(flatMetal, 'aluminium-6061')).toBe(false);
  });
});
