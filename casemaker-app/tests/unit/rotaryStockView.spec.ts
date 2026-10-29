// #716 — the Stock view is the map wrapped onto the cylinder; both are one geometry.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { wrapMapGeometry, wrapMapPoint } from '@/components/viewport/rotaryStockView';

const R = 10;
const C = 2 * Math.PI * R;

describe('#716 the map wrapped onto the stock', () => {
  it('the seam sits at the top and a quarter turn at the side', () => {
    // θ = 0: the top of the cylinder, where A homes.
    expect(wrapMapPoint(7, 0, 0, R).map((n) => Number(n.toFixed(9)))).toEqual([7, 0, 0]);
    // θ = 90°: the +Y side, one radius below the top.
    const quarter = wrapMapPoint(7, C / 4, 0, R);
    expect(quarter[0]).toBe(7);
    expect(quarter[1]).toBeCloseTo(R, 9);
    expect(quarter[2]).toBeCloseTo(-R, 9);
    // θ = 180°: the bottom of the stock.
    const half = wrapMapPoint(0, C / 2, 0, R);
    expect(half[1]).toBeCloseTo(0, 9);
    expect(half[2]).toBeCloseTo(-2 * R, 9);
  });

  it('a cut at depth d wraps to the radius R − d', () => {
    const [x, y, z] = wrapMapPoint(3, C / 4, -0.5, R);
    expect(x).toBe(3);
    expect(Math.hypot(y, z + R)).toBeCloseTo(R - 0.5, 9);
  });

  it('a point at the axis stays on the axis, and the map geometry is untouched', () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 5, C / 4, 0, 2, 0, -R], 3),
    );
    const wrapped = wrapMapGeometry(geom, R);
    const pos = wrapped.getAttribute('position');
    expect(pos.getX(0)).toBe(0);
    expect(pos.getY(1)).toBeCloseTo(R, 6);
    expect(pos.getZ(2)).toBeCloseTo(-R, 6);
    // The map copy is the Map view's own geometry and must come back unchanged.
    expect(geom.getAttribute('position').getY(1)).toBeCloseTo(C / 4, 3);
    expect(wrapped.getAttribute('normal')).not.toBeNull();

    // Cleanup so the spec does not leak buffer attributes between cases.
    geom.dispose();
    wrapped.dispose();
  });
});
