// #604 — the found-position scene transform: the offset translates the stock, the rotation rotates it.
import { describe, expect, it } from 'vitest';
import { foundTransform } from '@/components/viewport/foundTransform';

describe('#604 the found-position transform', () => {
  it('translates by the offset and rotates by the registration rotation', () => {
    const t = foundTransform({ offset: { x: 0.3, y: 5.6 }, rotationDeg: 0.4 });
    expect(t.position).toEqual([0.3, 5.6, 0]);
    expect(t.rotation[0]).toBe(0);
    expect(t.rotation[1]).toBe(0);
    expect(t.rotation[2]).toBeCloseTo(0.4 * (Math.PI / 180));
  });

  it('is the identity with no record, and ignores a null rotation', () => {
    expect(foundTransform(null)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
    expect(foundTransform({ offset: { x: 0, y: 0 }, rotationDeg: null }).rotation).toEqual([0, 0, 0]);
  });
});
