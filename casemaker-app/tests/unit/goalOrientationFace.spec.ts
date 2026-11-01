/**
 * #876 — PLACE ON FACE'S TURN.
 *
 * The operator picks a face; that face must end up exactly on the stock's −Z (down: the part's
 * bottom) or +Z (up: the face machined first). The six faces of a box are the exactness pin; a
 * non-uniform scale is the inverse-transpose pin (a squashed part's normal is not R·n); and the
 * composition pin proves a choice made on an already-turned part lands on the target too.
 */
import { describe, expect, it } from 'vitest';

import { turnsFacing } from '@/engine/cnc/engrave/goalOrientation';
import { rotationMatrix, type TargetTurns } from '@/engine/cnc/engrave/targetScale';

interface Vec {
  x: number;
  y: number;
  z: number;
}

function unit(v: Vec): Vec {
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** The matrix applied to a direction: the placed normal of a mesh normal under `turns`. */
function placed(turns: TargetTurns, n: Vec): Vec {
  const m = rotationMatrix(turns);
  return {
    x: m[0]! * n.x + m[1]! * n.y + m[2]! * n.z,
    y: m[3]! * n.x + m[4]! * n.y + m[5]! * n.z,
    z: m[6]! * n.x + m[7]! * n.y + m[8]! * n.z,
  };
}

const SIDES: Vec[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const UNIT_SCALE = { x: 1, y: 1, z: 1 };

describe('#876 — a chosen face lands on ±Z', () => {
  it('every face of a box maps exactly to −Z (down) or +Z (up)', () => {
    for (const n of SIDES) {
      for (const direction of ['down', 'up'] as const) {
        const turns = turnsFacing({ x: 0, y: 0, z: 0 }, n, UNIT_SCALE, direction);
        const w = placed(turns, n);
        const z = direction === 'down' ? -1 : 1;
        expect(w.x).toBeCloseTo(0, 9);
        expect(w.y).toBeCloseTo(0, 9);
        expect(w.z).toBeCloseTo(z, 9);
      }
    }
  });

  it('leaves a face already facing the chosen way exactly as it is', () => {
    expect(turnsFacing({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, UNIT_SCALE, 'down')).toEqual({ x: 0, y: 0, z: 0 });
    // A turned part, with a normal that its own turns already put at −Z: Rᵀ·(0,0,−1) = −(row 2).
    const turns: TargetTurns = { x: 12.5, y: -40, z: 7 };
    const m = rotationMatrix(turns);
    const n = { x: -m[6]!, y: -m[7]!, z: -m[8]! };
    expect(turnsFacing(turns, n, UNIT_SCALE, 'down')).toEqual(turns);
  });

  it('uses the inverse transpose under a non-uniform scale', () => {
    // A normal that is not an axis: scaling Y by 2 turns it toward X, and the placed direction
    // must carry S⁻¹·n — not n — to +Z. The Euler round-trip is good to ~1e-8.
    const n = unit({ x: 1, y: 1, z: 0 });
    const scale = { x: 1, y: 2, z: 0.5 };
    const turns = turnsFacing({ x: 0, y: 0, z: 0 }, n, scale, 'up');
    const w = placed(turns, unit({ x: 1, y: 0.5, z: 0 }));
    expect(w.x).toBeCloseTo(0, 7);
    expect(w.y).toBeCloseTo(0, 7);
    expect(w.z).toBeCloseTo(1, 7);
    // And the naive R·n reading would have been a different direction (sanity: the test bites).
    expect(placed(turns, n).z).toBeLessThan(0.999);
  });

  it('composes on top of turns the part already has', () => {
    const turns: TargetTurns = { x: 30, y: 10, z: 20 };
    const n = unit({ x: 0.3, y: -0.2, z: 0.9 });
    const out = turnsFacing(turns, n, UNIT_SCALE, 'down');
    const w = placed(out, n);
    expect(w.x).toBeCloseTo(0, 7);
    expect(w.y).toBeCloseTo(0, 7);
    expect(w.z).toBeCloseTo(-1, 7);
  });
});
