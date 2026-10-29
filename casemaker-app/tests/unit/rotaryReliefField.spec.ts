/**
 * #723 R-1 — THE RADIAL HEIGHTFIELD, pinned.
 *
 * The field is the rotary analogue of the flat goal's top-Z: a radius per (x, φ) on the map. The
 * fixtures are meshes whose radius is known in closed form — a cylinder, a cone, a half shell —
 * so the sampler is judged against the shape, not against itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sampleGoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

let serial = 0;
function goal(tris: Tri[], size: { x: number; y: number; z: number }, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'part',
    name: 'part.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'a'),
    data: stl(tris),
    size,
    position: { x: 50, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

const TAU = Math.PI * 2;

/** A solid of revolution's SIDE surface: r(x) over x ∈ [−L/2, L/2], angles 0…span. */
function sideTris(
  radiusAt: (x: number) => number,
  length: number,
  span = TAU,
  seg = 180,
): Tri[] {
  const tris: Tri[] = [];
  const at = (x: number, a: number): V => [x, radiusAt(x) * Math.sin(a), radiusAt(x) * Math.cos(a)];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * span;
    const a1 = ((i + 1) / seg) * span;
    const x0 = -length / 2;
    const x1 = length / 2;
    tris.push([at(x0, a0), at(x1, a0), at(x1, a1)], [at(x0, a0), at(x1, a1), at(x0, a1)]);
  }
  return tris;
}

/** The field's cell for a map (x, arc). */
function cell(f: ReturnType<typeof sampleGoalRadialField>, x: number, arc: number): number {
  const i = Math.round((x - f.x0) / f.pitch);
  const j = ((Math.round((arc - f.y0) / f.pitch) % f.ny) + f.ny) % f.ny;
  return j * f.nx + i;
}

describe('#723 R-1 — a solid of revolution reads back as its own radius', () => {
  const R = 10; // ⌀20 stock

  it('a ⌀16 cylinder over 30 mm is radius 8 everywhere covered', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), R, { pitchMm: 0.5 });
    expect(f.coveredCount).toBeGreaterThan(0);
    expect(f.minRadius).toBeCloseTo(8, 1);
    expect(f.maxRadius).toBeCloseTo(8, 1);
    expect(f.x0).toBeCloseTo(35, 5);
    expect(f.nx * f.pitch).toBeGreaterThanOrEqual(30 - f.pitch);
    // Every covered cell's height is the same: the part is 2 mm inside the stock.
    for (let k = 0; k < f.z.length; k++) {
      if (f.covered[k] !== 1) continue;
      expect(f.z[k]!).toBeCloseTo(8 - R, 1);
    }
    expect(f.resolutionNote).toContain('⌀20 mm rod');
  });

  it('a cone follows its own radius along the rod', () => {
    // r = 4 at x = −15, 9 at x = +15.
    const f = sampleGoalRadialField(goal(sideTris((x) => 4 + ((x + 15) / 30) * 5, 30), { x: 30, y: 18, z: 18 }), R, {
      pitchMm: 0.5,
    });
    const left = f.z[cell(f, 37, 0)]! + R;
    const right = f.z[cell(f, 63, 0)]! + R;
    expect(left).toBeCloseTo(4 + (2 / 30) * 5, 1);
    expect(right).toBeCloseTo(4 + (28 / 30) * 5, 1);
    expect(f.minRadius).toBeCloseTo(4, 1);
    expect(f.maxRadius).toBeCloseTo(9, 1);
  });

  it('a cell no triangle covers keeps the stock’s surface (the sentinel)', () => {
    // A half shell: angles 0…π. The other half has no surface, so those rays hit nothing.
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30, Math.PI), { x: 30, y: 16, z: 16 }), R, { pitchMm: 0.5 });
    const covered = f.z[cell(f, 50, Math.PI / 2)]!;
    expect(covered).toBeCloseTo(8 - R, 1);
    const k = cell(f, 50, (3 * Math.PI) / 2 * R);
    expect(f.covered[k]).toBe(0);
    expect(f.z[k]).toBe(0);
  });

  it('position.y turns the part about the rod: the half shell’s band moves with the seam', () => {
    const seamShift = Math.PI * R; // half a turn in map millimetres
    const f = sampleGoalRadialField(
      goal(sideTris(() => 8, 30, Math.PI), { x: 30, y: 16, z: 16 }, { position: { x: 50, y: seamShift, z: 0 } }),
      R,
      { pitchMm: 0.5 },
    );
    // The shell now covers the second half of the circumference.
    expect(f.z[cell(f, 50, (3 * Math.PI) / 2 * R)]!).toBeCloseTo(8 - R, 1);
    const k = cell(f, 50, Math.PI / 2);
    expect(f.covered[k]).toBe(0);
  });

  it('a mesh larger than the stock still samples: maxRadius says it does not fit', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 12, 20), { x: 20, y: 24, z: 24 }), R, { pitchMm: 0.5 });
    expect(f.maxRadius).toBeCloseTo(12, 1);
    expect(f.minRadius).toBeCloseTo(12, 1);
  });

  it('the cap coarsens the pitch and says so rather than refusing', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), R, {
      pitchMm: 0.1,
      maxCells: 2000,
    });
    expect(f.pitch).toBeGreaterThan(0.1);
    expect(f.resolutionNote).toContain('coarsened');
    // The cell counts are derived from the coarsened pitch with a ceil, so a few cells over the
    // cap is expected; the pitch itself was raised, which is the contract.
    expect(f.nx * f.ny).toBeLessThanOrEqual(2200);
  });

  it('a picture is refused by name — a rotary relief needs a mesh', () => {
    expect(() =>
      sampleGoalRadialField(
        { sha256: 'x', format: 'png', data: undefined, position: { x: 0, y: 0, z: 0 }, scale: undefined },
        R,
      ),
    ).toThrow(/picture relief is a flat heightfield/);
  });

  it('a non-positive stock radius is refused before any geometry', () => {
    expect(() => sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), 0)).toThrow(
      /positive stock radius/,
    );
  });
});

afterEach(() => clearTargetObjectMeshCache());
