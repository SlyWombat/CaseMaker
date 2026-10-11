// #359 — the arithmetic that keeps a scene-anchored label inside the canvas, and the projection
// it replaces. Both are pure, so this runs in milliseconds with no canvas, no camera store and no
// WebGL: the positioning itself is checked where it can actually be seen, in
// `tests/e2e/engraveLabels.spec.ts`.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { clampLabelBox, LABEL_PAD, projectToCanvas } from '@/components/viewport/projectedLabel';

const SIZE = { width: 344, height: 624 };
const BOX = { width: 133, height: 14 };

describe('#359 — clamping a label box into the canvas', () => {
  it('leaves a box that is already inside exactly where it is', () => {
    expect(clampLabelBox(172, 300, BOX, SIZE)).toEqual([172, 300]);
  });

  it('moves a box in from each edge, to the pad and no further', () => {
    // Off the left: the box's left edge lands ON the pad, so its centre is pad + w/2 away.
    expect(clampLabelBox(-55, 300, BOX, SIZE)[0]).toBeCloseTo(LABEL_PAD + BOX.width / 2, 6);
    // Off the right, the top and the bottom, symmetric.
    expect(clampLabelBox(400, 300, BOX, SIZE)[0]).toBeCloseTo(SIZE.width - LABEL_PAD - BOX.width / 2, 6);
    expect(clampLabelBox(172, -20, BOX, SIZE)[1]).toBeCloseTo(LABEL_PAD + BOX.height / 2, 6);
    expect(clampLabelBox(172, 900, BOX, SIZE)[1]).toBeCloseTo(SIZE.height - LABEL_PAD - BOX.height / 2, 6);
  });

  it('centres a box that cannot fit, rather than pushing it past the edge it defends', () => {
    const huge = { width: SIZE.width + 40, height: 10 };
    // `min(max(v, near), far)` would return `far`, which is left of `near` — the box would be
    // placed 20 px past the right edge by the code meant to keep it off the edge.
    expect(clampLabelBox(-40, 100, huge, SIZE)[0]).toBe(SIZE.width / 2);
    expect(clampLabelBox(SIZE.width + 40, 100, huge, SIZE)[0]).toBe(SIZE.width / 2);
  });

  it('still contains its anchor whenever the anchor is on the canvas (the reason there is no leader line)', () => {
    const pad = LABEL_PAD;
    // Every anchor from the pad inward, at 1 px steps: the clamped box must span it. This is the
    // property the issue's option 1 offers in place of a leader line, so it is asserted, not
    // assumed — including at the far edge, where the clamp runs the other way.
    for (const x of Array.from({ length: SIZE.width - 2 * pad + 1 }, (_, i) => pad + i)) {
      const [cx] = clampLabelBox(x, 0, BOX, SIZE);
      expect(cx - BOX.width / 2, `anchor ${x} left of box`).toBeLessThanOrEqual(x);
      expect(cx + BOX.width / 2, `anchor ${x} right of box`).toBeGreaterThanOrEqual(x);
    }
    for (const y of Array.from({ length: SIZE.height - 2 * pad + 1 }, (_, i) => pad + i)) {
      const [, cy] = clampLabelBox(0, y, BOX, SIZE);
      expect(cy - BOX.height / 2, `anchor ${y} above box`).toBeLessThanOrEqual(y);
      expect(cy + BOX.height / 2, `anchor ${y} below box`).toBeGreaterThanOrEqual(y);
    }
  });
});

describe('projectToCanvas — drei defaultCalculatePosition, restated', () => {
  /** The app's own z-up perspective camera, aimed at the viewport's default target. */
  function camera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, SIZE.width / SIZE.height, 0.1, 10_000);
    cam.up.set(0, 0, 1);
    cam.position.set(120, -160, 90);
    cam.lookAt(40, 30, 10);
    cam.updateMatrixWorld(true);
    return cam;
  }

  function objectAt(v: THREE.Vector3): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.copy(v);
    o.updateMatrixWorld(true);
    return o;
  }

  it('puts a point on the camera axis at the canvas centre', () => {
    const [x, y] = projectToCanvas(objectAt(new THREE.Vector3(40, 30, 10)), camera(), SIZE);
    expect(x).toBeCloseTo(SIZE.width / 2, 6);
    expect(y).toBeCloseTo(SIZE.height / 2, 6);
  });

  it('puts a point to the camera’s right to the right, level with it', () => {
    const cam = camera();
    // The camera's own +x column is screen-right by definition, so this cannot be got backwards
    // by reasoning about which world axis faces which way.
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const [x, y] = projectToCanvas(objectAt(new THREE.Vector3(40, 30, 10).addScaledVector(right, 20)), cam, SIZE);
    expect(x).toBeGreaterThan(SIZE.width / 2);
    expect(y).toBeCloseTo(SIZE.height / 2, 6);
  });
});
