// #779 — the drawn Z1 low-profile vise as ONE model: the base with its X rails, the fixed jaw at
// the base's left end, the moving jaw on its carrier at the stock's own length, and the clamping
// screw along X. Every picture (the bed scene, the engrave preview, the Holding step's top view)
// reads these parts, so these tests pin the model itself rather than any one drawing.

import { describe, expect, it } from 'vitest';
import {
  VISE_BASE_LEFT_X,
  VISE_BASE_RIGHT_X,
  VISE_CARRIER_WIDTH,
  VISE_FACE_FROM_LEFT_PIN_X,
  drawnVise,
  viseFrameFromPins,
  type DrawnVisePart,
} from '@/engine/cnc/drawnVise';
import { LEDGE_STEP, LEDGE_WIDTH, VISE_BAR_HEIGHT, Z1_VISE } from '@/engine/cnc/fixture';

const find = (parts: DrawnVisePart[], id: string): DrawnVisePart => parts.find((p) => p.id === id)!;

describe('#779 the drawn vise', () => {
  it('puts the fixed jaw face on X = 0 and the moving jaw face at the opening', () => {
    const parts = drawnVise({ openingMm: 42 });
    const fixed = find(parts, 'vise-fixed-jaw');
    const moving = find(parts, 'vise-moving-jaw');
    // The face the stock's left edge rests against — and the one the moving jaw closes on.
    expect(fixed.max[0]).toBe(0);
    expect(fixed.max[0] - fixed.min[0]).toBe(Z1_VISE.fixedJawThickness);
    expect(moving.min[0]).toBe(42);
    expect(moving.max[0] - moving.min[0]).toBe(Z1_VISE.movingJawThickness);
    // Both bars hang from the jaw-top plane by the PROVISIONAL bar height.
    expect(fixed.max[2]).toBe(0);
    expect(fixed.max[2] - fixed.min[2]).toBe(VISE_BAR_HEIGHT);
    expect(moving.max[2]).toBe(0);
  });

  it('draws each soft jaw ledge 1.9 mm in and 3.1 mm down, facing the stock', () => {
    const parts = drawnVise({ openingMm: 42 });
    const fixed = find(parts, 'vise-fixed-ledge');
    const moving = find(parts, 'vise-moving-ledge');
    expect(fixed.min[0]).toBe(0);
    expect(fixed.max[0] - fixed.min[0]).toBe(LEDGE_WIDTH);
    expect(fixed.max[2]).toBe(-LEDGE_STEP);
    expect(moving.max[0]).toBe(42);
    expect(moving.max[0] - moving.min[0]).toBeCloseTo(LEDGE_WIDTH, 9);
    expect(moving.max[2]).toBe(-LEDGE_STEP);
  });

  it('spans the bed with the base plate, its rails running along X across it', () => {
    const parts = drawnVise({ openingMm: 42 });
    const base = find(parts, 'vise-base');
    // 200 mm across — the table's own width (figure 1.5) — with the fixed jaw at its left end.
    expect(base.max[0] - base.min[0]).toBe(200);
    expect(base.min[0]).toBe(VISE_BASE_LEFT_X);
    expect(base.max[0]).toBe(VISE_BASE_RIGHT_X);
    // The base's top IS the floor the bars stand on, and it runs one base thickness below.
    expect(base.max[2]).toBe(-VISE_BAR_HEIGHT);

    const rails = parts.filter((p) => p.role === 'rail');
    expect(rails).toHaveLength(3);
    for (const rail of rails) {
      // A rail is long along X and narrow along Y.
      expect(rail.max[0] - rail.min[0]).toBeGreaterThan(150);
      expect(rail.max[1] - rail.min[1]).toBeLessThan(rail.max[0] - rail.min[0]!);
      expect(rail.min[0]).toBeGreaterThanOrEqual(base.min[0]!);
      expect(rail.max[0]).toBeLessThanOrEqual(base.max[0]!);
    }
  });

  it('seats the carrier behind the moving jaw, inside the base\'s run', () => {
    const parts = drawnVise({ openingMm: 42 });
    const carrier = find(parts, 'vise-carrier');
    const jaw = find(parts, 'vise-moving-jaw');
    expect(carrier.min[0]).toBe(jaw.max[0]);
    expect(carrier.max[0] - carrier.min[0]).toBe(VISE_CARRIER_WIDTH);
    expect(carrier.max[0]).toBeLessThanOrEqual(VISE_BASE_RIGHT_X);
    // It rides the rails: its Y span covers every rail's centre line.
    const rails = parts.filter((p) => p.role === 'rail');
    for (const rail of rails) {
      const centre = (rail.min[1]! + rail.max[1]!) / 2;
      expect(centre).toBeGreaterThanOrEqual(carrier.min[1]!);
      expect(centre).toBeLessThanOrEqual(carrier.max[1]!);
    }
  });

  it('runs the clamping screw along X at the carrier\'s front, out past the base', () => {
    const parts = drawnVise({ openingMm: 42 });
    const screw = find(parts, 'vise-clamp-screw');
    expect(screw.max[0] - screw.min[0]).toBeGreaterThan(40);
    // Square in the other two axes: a shaft, not a plate.
    expect(screw.max[1] - screw.min[1]).toBeCloseTo(screw.max[2] - screw.min[2], 9);
    expect(screw.max[0]).toBeGreaterThan(VISE_BASE_RIGHT_X);
    // At the front of the bar (small Y), clear of the stock's own line.
    expect(screw.min[1]!).toBeLessThan(Z1_VISE.jawLength / 4);
  });

  it('marks a parked opening provisional, and the jaws measured when both place and opening are known', () => {
    const parked = drawnVise({ openingMm: 60, openingKnown: false, placementKnown: true });
    expect(find(parked, 'vise-fixed-jaw').provenance).toBe('measured');
    expect(find(parked, 'vise-moving-jaw').provenance).toBe('provisional');
    // The base and its fittings are unmeasured figures whatever the placement says.
    expect(find(parked, 'vise-base').provenance).toBe('provisional');
    expect(find(parked, 'vise-rail-1').provenance).toBe('provisional');

    const measured = drawnVise({ openingMm: 42, openingKnown: true, placementKnown: true });
    expect(find(measured, 'vise-moving-jaw').provenance).toBe('measured');

    const unplaced = drawnVise({ openingMm: 42, openingKnown: true, placementKnown: false });
    expect(find(unplaced, 'vise-fixed-jaw').provenance).toBe('provisional');
    expect(find(unplaced, 'vise-moving-jaw').provenance).toBe('provisional');
  });

  it('takes the unmeasured position from the LEFT locating pin', () => {
    // One pin near the table's left edge, one near its right — the base covers both.
    const pin = [-195, -165] as const;
    const frame = viseFrameFromPins(pin);
    expect(frame.fixedJawFaceX).toBe(pin[0] + VISE_FACE_FROM_LEFT_PIN_X);
    expect(frame.jawStartY).toBe(pin[1]);
    // The base's left edge is the pin less the margin it sits at — inside the table.
    expect(frame.fixedJawFaceX + VISE_BASE_LEFT_X).toBeGreaterThanOrEqual(-200);
  });
});
