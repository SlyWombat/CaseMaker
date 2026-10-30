/**
 * #723 part 2 (P2-1) — the mesh's turns about X, Y and Z, in the stock.
 *
 * One matrix, `rotationMatrix` (Rx·Ry·Rz), is read by the heightfield sampler, the size and fit
 * checks and the viewport. These tests pin it against three.js's own Euler "XYZ" matrix (so the
 * drawn mesh and the cut agree by construction), then pin the placed extents and the sampled
 * surface for a block turned about X, Y and Z, the turn-over that makes a part's other side
 * reachable, and the document round-trip (an unturned document gains no key).
 */
import { afterEach, describe, expect, it } from 'vitest';

const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { Euler, Matrix4 } from 'three';
import { sampleGoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import {
  applyMat,
  fitToStockScale,
  placedSize,
  rotatedExtents,
  rotationMatrix,
  targetTurns,
} from '@/engine/cnc/engrave/targetScale';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

const DEG = Math.PI / 180;

function binaryStl(tris: Tri[]): string {
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

/** A closed box. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const c: V[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const q = (a: number, b: number, d: number, e: number): Tri[] => [
    [c[a]!, c[b]!, c[d]!],
    [c[a]!, c[d]!, c[e]!],
  ];
  return [...q(4, 5, 6, 7), ...q(0, 3, 2, 1), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)];
}

/** A 40 × 20 × 16 block: a 40 × 20 base 10 tall with a 20 × 10 boss to 16, at (10…30, 5…15). */
const BLOCK: Tri[] = [...box(0, 40, 0, 20, 0, 10), ...box(10, 30, 5, 15, 0, 16)];

let n = 0;
function goal(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-turn',
    name: 'block.stl',
    format: 'stl',
    sha256: (n++).toString(16).padStart(64, 'b'),
    data: binaryStl(BLOCK),
    size: { x: 40, y: 20, z: 16 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** The sampled top at a work XY, world Z. */
function at(hf: ReturnType<typeof sampleGoalHeightfield>, x: number, y: number): number {
  const i = Math.round((x - hf.x0) / hf.pitch);
  const j = Math.round((y - hf.y0) / hf.pitch);
  return hf.z[j * hf.nx + i] as number;
}

describe('#723 P2-1 — the turn matrix is the viewport’s', () => {
  it('matches three.js’s Euler "XYZ" matrix for X, Y and Z turns', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [10, 20, 30],
      [-45, 90, 12.5],
      [180, 0, 0],
      [0, 90, 0],
      [30, -60, 180],
    ];
    for (const [x, y, z] of cases) {
      const ours = rotationMatrix({ x, y, z });
      const e = new Matrix4().makeRotationFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'XYZ')).elements;
      // three's elements are column-major; ours are row-major.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          expect(ours[row * 3 + col], `turn ${x},${y},${z} at ${row},${col}`).toBeCloseTo(e[col * 4 + row]!, 12);
        }
      }
    }
  });

  it('turns a point Z first, then Y, then X', () => {
    // A point on +X turned 90 about Z goes to +Y; then 90 about X takes +Y to +Z.
    const m = rotationMatrix({ x: 90, y: 0, z: 90 });
    const p = applyMat(m, { x: 1, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(1, 12);
  });
});

describe('#723 P2-1 — the turned extents and the fitted size', () => {
  it('a 40 × 20 × 16 block turned a quarter about each axis occupies the axis-aligned extents', () => {
    const size = { x: 40, y: 20, z: 16 };
    expect(rotatedExtents(size, { x: 0, y: 0, z: 0 })).toEqual(size);
    expect(rotatedExtents(size, { x: 0, y: 0, z: 90 }).x).toBeCloseTo(20, 12);
    expect(rotatedExtents(size, { x: 0, y: 0, z: 90 }).y).toBeCloseTo(40, 12);
    expect(rotatedExtents(size, { x: 90, y: 0, z: 0 }).y).toBeCloseTo(16, 12);
    expect(rotatedExtents(size, { x: 90, y: 0, z: 0 }).z).toBeCloseTo(20, 12);
    expect(rotatedExtents(size, { x: 0, y: 90, z: 0 }).x).toBeCloseTo(16, 12);
    expect(rotatedExtents(size, { x: 0, y: 90, z: 0 }).z).toBeCloseTo(40, 12);
  });

  it('placedSize is the parsed size × the scale, turned — the same result every reader uses', () => {
    expect(placedSize(goal())).toEqual({ x: 40, y: 20, z: 16 });
    expect(placedSize(goal({ rotationX: 90 }))).toMatchObject({ x: 40 });
    expect(placedSize(goal({ rotationX: 90 })).y).toBeCloseTo(16, 12);
    expect(placedSize(goal({ rotationX: 90 })).z).toBeCloseTo(20, 12);
    expect(placedSize(goal({ rotationY: 90, scale: { x: 2, y: 2, z: 2 } })).x).toBeCloseTo(32, 12);
    expect(placedSize(goal({ rotationY: 90, scale: { x: 2, y: 2, z: 2 } })).z).toBeCloseTo(80, 12);
  });

  it('Fit to the stock reads the turned height too: a block on edge is no taller than its former width', () => {
    const stock = { length: 100, width: 50, thickness: 10 };
    // 40 × 20 × 16 unturned: room 98 × 48 × 10 → height 10/16 binds.
    expect(fitToStockScale({ x: 40, y: 20, z: 16 }, stock, 1, 0)).toBeCloseTo(10 / 16, 12);
    // Turned 90 about X the block is 40 × 16 × 20: the height is now the former Y, 20.
    expect(fitToStockScale({ x: 40, y: 20, z: 16 }, stock, 1, { x: 90, y: 0, z: 0 })).toBeCloseTo(10 / 20, 12);
  });
});

describe('#723 P2-1 — the sampled surface follows the turn', () => {
  it('unturned, the boss top is at the stock top and the base 6 mm below', () => {
    const hf = sampleGoalHeightfield(goal(), { pitchMm: 0.5 });
    expect(at(hf, 50, 30)).toBeCloseTo(0, 3); // on the boss
    expect(at(hf, 32, 30)).toBeCloseTo(-6, 3); // on the base
  });

  it('turned 90 about X, the block’s former +Y face is the top — its side, not its crown', () => {
    const hf = sampleGoalHeightfield(goal({ rotationX: 90 }), { pitchMm: 0.5 });
    // Turned bbox: X 30…70, Y 22…38 (40 × 16), top at Z 0.
    expect((hf.nx - 1) * hf.pitch).toBeGreaterThanOrEqual(40 - hf.pitch - 1e-9);
    expect((hf.ny - 1) * hf.pitch).toBeGreaterThanOrEqual(16 - hf.pitch - 1e-9);
    // The former +Y face (the base's whole Y=20 plane) is at the stock top…
    expect(at(hf, 50, 33)).toBeCloseTo(0, 3);
    // …and where only the boss's former z = 10…16 band remains (its Y=15 face), 5 mm lower.
    expect(at(hf, 50, 24)).toBeCloseTo(-5, 3);
    expect(hf.minZ).toBeCloseTo(-5, 3);
  });

  it('turned 90 about Y, the block’s former −X face is up, and the boss stands 10 mm proud of it', () => {
    const hf = sampleGoalHeightfield(goal({ rotationY: 90 }), { pitchMm: 0.5 });
    // The top is the former x = 0 face (world z 0); past the base's former z = 10 band only the
    // boss remains, whose former x = 10 face sits 10 mm lower.
    expect(at(hf, 47, 30)).toBeCloseTo(0, 3);
    expect(at(hf, 55, 30)).toBeCloseTo(-10, 3);
    expect(hf.minZ).toBeCloseTo(-10, 3);
  });

  it('a 180 turn about X puts the block’s flat BOTTOM up: the top-Z field is flat, and the boss is hidden under it', () => {
    // The top-only field cannot see the boss after the flip — exactly why the carried-stock slice
    // needs the remaining SOLID (meshes), not a heightfield, to hand to the second setup.
    const hf = sampleGoalHeightfield(goal({ rotationX: 180 }), { pitchMm: 0.5 });
    expect(hf.minZ).toBeCloseTo(0, 6);
    expect(at(hf, 50, 30)).toBeCloseTo(0, 6);
  });

  it('a Z turn keeps the old footprint and top contract', () => {
    const hf = sampleGoalHeightfield(goal({ rotation: 90 }), { pitchMm: 0.5 });
    // 40 × 20 turned about Z occupies 20 × 40, centred on (50, 30).
    expect((hf.nx - 1) * hf.pitch).toBeGreaterThanOrEqual(20 - hf.pitch - 1e-9);
    expect((hf.ny - 1) * hf.pitch).toBeGreaterThanOrEqual(40 - hf.pitch - 1e-9);
    expect(at(hf, 50, 30)).toBeCloseTo(0, 3);
  });
});

describe('#723 P2-1 — the document', () => {
  it('the X and Y turns round-trip; an unturned object gains no key', () => {
    const base = defaultEngraveJob();
    const turned = { ...base, targetObject: goal({ rotationX: 180, rotationY: 90 }) };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(turned)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.job.targetObject?.rotationX).toBe(180);
      expect(parsed.job.targetObject?.rotationY).toBe(90);
    }
    const plain = parseEngraveJob(JSON.parse(JSON.stringify({ ...base, targetObject: goal() })));
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect('rotationX' in (plain.job.targetObject ?? {})).toBe(false);
      expect('rotationY' in (plain.job.targetObject ?? {})).toBe(false);
    }
  });

  it('the store writes a turn, and 0 removes the key again', async () => {
    const { useEngraveJobStore } = await import('@/store/engraveJobStore');
    useEngraveJobStore.getState().setTargetObject(goal({ data: undefined }));
    useEngraveJobStore.getState().updateTargetObject({ rotationX: 180 });
    expect(useEngraveJobStore.getState().job.targetObject?.rotationX).toBe(180);
    expect(targetTurns(useEngraveJobStore.getState().job.targetObject!)).toMatchObject({ x: 180, y: 0, z: 0 });
    useEngraveJobStore.getState().updateTargetObject({ rotationX: undefined });
    expect('rotationX' in (useEngraveJobStore.getState().job.targetObject ?? {})).toBe(false);
  });
});
