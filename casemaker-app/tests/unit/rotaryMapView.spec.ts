// #716 — the map's read-outs come from the wrap module, not from a second circumference.
import { describe, expect, it } from 'vitest';
import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import {
  rotaryAlongTicks,
  rotaryBands,
  rotaryReadout,
  rotaryRulerTicks,
  rotarySeamLabels,
} from '@/components/viewport/rotaryMapView';

const MAP: RotaryMap = { radius: 10, circumference: 2 * Math.PI * 10, stickout: 85, grip: 15, length: 100, tailstock: true };

describe('#716 the map’s read-outs', () => {
  it('the around ruler is mm at the surface with the degrees beside it, every quarter turn', () => {
    const ticks = rotaryRulerTicks(MAP);
    expect(ticks.map((t) => t.deg)).toEqual([0, 90, 180, 270, 360]);
    expect(ticks[0]!.label).toBe('0 mm · 0°');
    expect(ticks[1]!.label).toBe('15.708 · 90°');
    expect(ticks[2]!.label).toBe('31.416 · 180°');
    expect(ticks[3]!.label).toBe('47.124 · 270°');
    expect(ticks[4]!.label).toBe('62.832 · 360°');
    // The arc IS the wrap module's angleToArc — one circumference, not a second.
    expect(ticks[1]!.arc).toBeCloseTo(Math.PI * 5, 9);
  });

  it('reads the diameter and one turn at the surface', () => {
    expect(rotaryReadout(MAP)).toBe('⌀20 · around 62.832 mm');
  });

  it('the bands are the jaws keep-out and the tailstock while it is in', () => {
    expect(rotaryBands(MAP)).toMatchObject([
      { id: 'jaws', from: 0, to: 3, label: 'jaws 0–3 mm' },
      { id: 'tailstock', from: 75, to: 85, label: 'tailstock 75–85 mm' },
    ]);
    expect(rotaryBands({ ...MAP, tailstock: false }).map((b) => b.id)).toEqual(['jaws']);
  });

  it('the seam is 0° at the top edge and one full turn at the bottom', () => {
    expect(rotarySeamLabels()).toEqual({ top: 'seam · 0°', bottom: 'seam · 360°' });
  });

  it('the along ruler runs from the jaws in 20 mm steps and ends on the stick-out', () => {
    expect(rotaryAlongTicks(MAP)).toEqual([0, 20, 40, 60, 80, 85]);
  });
});
