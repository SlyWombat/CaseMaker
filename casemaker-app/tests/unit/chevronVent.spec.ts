import { describe, it, expect } from 'vitest';
import { buildVentilationCutouts } from '@/engine/compiler/ventilation';
import { aabbOfOp } from '@/engine/compiler/buildPlan';
import type { BoardProfile, CaseParameters } from '@/types';

function makeBoard(): BoardProfile {
  return {
    id: 'test-board',
    name: 'Test board',
    manufacturer: 'Test',
    pcb: { size: { x: 60, y: 60, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 4,
    recommendedZClearance: 20,
    builtin: false,
  };
}

function makeParams(surfaces: CaseParameters['ventilation']['surfaces']): CaseParameters {
  return {
    wallThickness: 2,
    floorThickness: 2,
    lidThickness: 2,
    cornerRadius: 2,
    internalClearance: 2,
    zClearance: 20,
    joint: 'flat-lid',
    ventilation: { enabled: true, pattern: 'chevron', coverage: 0.8, surfaces },
    bosses: { enabled: false, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
  } as CaseParameters;
}

/** Unwrap translate(rotate(cube)) and return the rotation degrees. */
function rotationOf(op: ReturnType<typeof buildVentilationCutouts>['shellCuts'][number]) {
  expect(op.kind).toBe('translate');
  const child = (op as { child: { kind: string; degrees?: [number, number, number] } }).child;
  expect(child.kind).toBe('rotate');
  return child.degrees!;
}

describe('chevron ventilation — herringbone V-slots (not louvers)', () => {
  it('back wall: arms rotate about the face NORMAL (y), ±45°, in pairs', () => {
    const cuts = buildVentilationCutouts(makeBoard(), makeParams(['back'])).shellCuts;
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.length % 2).toBe(0); // two arms per chevron
    let plus = 0;
    let minus = 0;
    for (const op of cuts) {
      const [rx, ry, rz] = rotationOf(op);
      // In-plane chevron = rotation about the +y normal ONLY. The old louver
      // implementation rotated about x here — that renders as plain slots.
      expect(rx).toBe(0);
      expect(rz).toBe(0);
      expect(Math.abs(ry)).toBe(45);
      if (ry > 0) plus++;
      else minus++;
    }
    expect(plus).toBe(minus); // symmetric V arms
  });

  it('cutters actually span the wall material on cutDir=-1 faces (back wall)', () => {
    // outer = pcb 60 + 2×(wall 2 + clearance 2) = 68 → back wall y ∈ [66, 68].
    // Regression: centered arm cutters were shifted by cutDir·cutThru/2,
    // placing them OUTSIDE the material on back/right/top faces — vents
    // silently vanished there while the front wall looked fine.
    const cuts = buildVentilationCutouts(makeBoard(), makeParams(['back'])).shellCuts;
    for (const op of cuts) {
      const b = aabbOfOp(op)!;
      expect(b.min[1]).toBeLessThanOrEqual(66);
      expect(b.max[1]).toBeGreaterThanOrEqual(68);
    }
  });

  it('lid cutters span the lid plate (lid-local z 0..lidThickness)', () => {
    const cuts = buildVentilationCutouts(makeBoard(), makeParams(['top'])).lidCuts;
    expect(cuts.length).toBeGreaterThan(0);
    for (const op of cuts) {
      const b = aabbOfOp(op)!;
      expect(b.min[2]).toBeLessThanOrEqual(0);
      expect(b.max[2]).toBeGreaterThanOrEqual(2);
    }
  });

  it('lid: arms rotate about the z normal', () => {
    const cuts = buildVentilationCutouts(makeBoard(), makeParams(['top'])).lidCuts;
    expect(cuts.length).toBeGreaterThan(0);
    for (const op of cuts) {
      const [rx, ry, rz] = rotationOf(op);
      expect(rx).toBe(0);
      expect(ry).toBe(0);
      expect(Math.abs(rz)).toBe(45);
    }
  });

  it('side wall: arms rotate about the x normal', () => {
    const cuts = buildVentilationCutouts(makeBoard(), makeParams(['left'])).shellCuts;
    expect(cuts.length).toBeGreaterThan(0);
    for (const op of cuts) {
      const [rx, ry, rz] = rotationOf(op);
      expect(Math.abs(rx)).toBe(45);
      expect(ry).toBe(0);
      expect(rz).toBe(0);
    }
  });
});
