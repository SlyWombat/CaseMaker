// #629 — the ramp threshold the run store derives for the column engine: half the smallest gap
// between the predicted items' distinct depths, so a ramp that can cross a level is named and a
// thread's ~0.01 mm per chord stays silent. Pure: the derivation is just depths and a tool shape.
import { describe, expect, it } from 'vitest';
import { rampThresholdMm } from '@/store/engraveRunStore';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { OraclePredicted } from '@/engine/cnc/engrave/oracle';

const engraver: Tool = flatEndMill(0.5, { shape: 'engraving', tipDiameter: 0.5, diameter: 3.175, halfAngle: 15 });
const flat: Tool = flatEndMill(1);

const predicted = (depths: number[]): OraclePredicted[] => depths.map((depth) => ({ depth, polygons: [] }));

describe('#629 the ramp threshold', () => {
  it('is half the smallest gap between distinct depths, for a column-engine tool', () => {
    expect(rampThresholdMm(predicted([1, 2, 3]), engraver)).toBeCloseTo(0.5);
    expect(rampThresholdMm(predicted([0.5, 1.5]), engraver)).toBeCloseTo(0.5);
    // Duplicate depths collapse: the levels are distinct floors, not item counts.
    expect(rampThresholdMm(predicted([1, 1, 2]), engraver)).toBeCloseTo(0.5);
  });

  it('is null for a single level, and for a tool the column engine does not sweep', () => {
    expect(rampThresholdMm(predicted([1, 1]), engraver)).toBeNull();
    expect(rampThresholdMm(predicted([2]), engraver)).toBeNull();
    expect(rampThresholdMm([], engraver)).toBeNull();
    // A flat end mill routes to the exact engine, which raises ramp-over-removed itself.
    expect(rampThresholdMm(predicted([1, 2, 3]), flat)).toBeNull();
  });
});
