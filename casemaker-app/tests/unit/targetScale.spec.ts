/**
 * #722 — a goal mesh's scale: one transform that the heightfield, the job's size check and the
 * document all read. Fixtures from the issue: a 200 mm mesh fitted to a 76 × 38 stock, a 50 % scale,
 * and the aspect unlocked to stretch Z only.
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

import { sampleGoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import {
  fitToStockScale,
  isUniform,
  placedSize,
  scaleForAxisSize,
  targetScale,
} from '@/engine/cnc/engrave/targetScale';
import { validateGoalObject } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

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

/** A closed box; its top face is at `z1`. */
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

/** A 200 × 100 × 40 mm stepped block: a 200 × 100 base 20 tall with a 100 × 50 boss on top. */
function stepped(): Tri[] {
  return [...box(0, 200, 0, 100, 0, 20), ...box(50, 150, 25, 75, 0, 40)];
}

let n = 0;
function goal(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-1',
    name: 'big.stl',
    format: 'stl',
    sha256: (n++).toString(16).padStart(64, 'a'),
    data: binaryStl(stepped()),
    size: { x: 200, y: 100, z: 40 },
    position: { x: 38, y: 19, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

const STOCK = { length: 76, width: 38, thickness: 10 };

describe('#722 — the scale helpers', () => {
  it('absent is 1 on every axis, and a picture ignores any scale', () => {
    expect(targetScale(goal())).toEqual({ x: 1, y: 1, z: 1 });
    expect(targetScale({ format: 'png', scale: { x: 2, y: 2, z: 2 } })).toEqual({ x: 1, y: 1, z: 1 });
    expect(placedSize(goal({ scale: { x: 0.5, y: 0.5, z: 0.5 } }))).toEqual({ x: 100, y: 50, z: 20 });
  });

  it('fits a 200 mm mesh inside a 76 × 38 blank less a 1 mm margin, no taller than the blank', () => {
    // room 74 × 36 × 10: X 74/200 = 0.37, Y 36/100 = 0.36, Z 10/40 = 0.25 — height binds.
    expect(fitToStockScale({ x: 200, y: 100, z: 40 }, STOCK, 1)).toBeCloseTo(0.25, 12);
    // A flat mesh: the footprint binds instead.
    expect(fitToStockScale({ x: 200, y: 100, z: 2 }, STOCK, 1)).toBeCloseTo(0.36, 12);
    // Margins that eat the blank leave no room.
    expect(fitToStockScale({ x: 200, y: 100, z: 40 }, STOCK, 19)).toBeNull();
  });

  it('a size field keeps the aspect when locked and stretches one axis when unlocked', () => {
    const size = { x: 200, y: 100, z: 40 };
    expect(scaleForAxisSize({ x: 1, y: 1, z: 1 }, size, 'x', 50, true)).toEqual({ x: 0.25, y: 0.25, z: 0.25 });
    const z = scaleForAxisSize({ x: 0.25, y: 0.25, z: 0.25 }, size, 'z', 20, false)!;
    expect(z).toEqual({ x: 0.25, y: 0.25, z: 0.5 });
    expect(isUniform(z)).toBe(false);
    expect(scaleForAxisSize({ x: 1, y: 1, z: 1 }, size, 'x', 0, true)).toBeNull();
  });
});

describe('#722 — every reader applies the one scale', () => {
  it('the heightfield samples the fitted mesh at its placed size, centred, top at position.z', () => {
    const f = fitToStockScale({ x: 200, y: 100, z: 40 }, STOCK, 1)!;
    const hf = sampleGoalHeightfield(goal({ scale: { x: f, y: f, z: f } }), { pitchMm: 0.25, stockTopZ: 0 });
    // Footprint 50 × 25 centred on (38, 19).
    expect(hf.x0).toBeCloseTo(13, 6);
    expect(hf.y0).toBeCloseTo(6.5, 6);
    expect((hf.nx - 1) * hf.pitch).toBeGreaterThanOrEqual(50 - 1e-9);
    // The boss top is at 0 (position.z), the base top 20 × 0.25 = 5 mm lower, the bottom at −10.
    const at = (x: number, y: number): number => {
      const i = Math.round((x - hf.x0) / hf.pitch);
      const j = Math.round((y - hf.y0) / hf.pitch);
      return hf.z[j * hf.nx + i] as number;
    };
    expect(at(38, 19)).toBeCloseTo(0, 4); // on the boss
    expect(at(16, 9)).toBeCloseTo(-5, 4); // on the base, outside the boss
    expect(hf.minZ).toBeCloseTo(-5, 4);
  });

  it('a 50 % scale halves the footprint and the step', () => {
    const hf = sampleGoalHeightfield(goal({ scale: { x: 0.5, y: 0.5, z: 0.5 }, position: { x: 60, y: 30, z: 0 } }), {
      pitchMm: 0.5,
    });
    expect(hf.x0).toBeCloseTo(10, 6); // 60 − 100/2
    expect(hf.y0).toBeCloseTo(5, 6); //  30 − 50/2
    expect(hf.minZ).toBeCloseTo(-10, 4); // the 20 mm step, halved
  });

  it('a Z-only stretch deepens the step without moving the footprint', () => {
    const flat = sampleGoalHeightfield(goal({ scale: { x: 0.25, y: 0.25, z: 0.25 } }), { pitchMm: 0.25 });
    const tall = sampleGoalHeightfield(goal({ scale: { x: 0.25, y: 0.25, z: 0.4 } }), { pitchMm: 0.25 });
    expect(tall.x0).toBeCloseTo(flat.x0, 9);
    expect(tall.nx).toBe(flat.nx);
    expect(flat.minZ).toBeCloseTo(-5, 4);
    expect(tall.minZ).toBeCloseTo(-8, 4); // 20 × 0.4
  });

  it('the job size check reads the placed size: oversize at 100 %, fits once fitted', () => {
    const big = validateGoalObject(goal(), STOCK);
    expect(big.map((f) => f.code)).toContain('goal-object-oversize');
    expect(big.find((f) => f.code === 'goal-object-oversize')!.message).toContain('200×100×40 mm');
    const f = fitToStockScale({ x: 200, y: 100, z: 40 }, STOCK, 1)!;
    const fitted = validateGoalObject(goal({ scale: { x: f, y: f, z: f } }), STOCK);
    expect(fitted.map((x) => x.code)).not.toContain('goal-object-oversize');
  });
});

describe('#722 — the document', () => {
  it('a scaled target round-trips; an absent scale stays absent', () => {
    const base = defaultEngraveJob();
    const scaled = { ...base, targetObject: goal({ scale: { x: 0.25, y: 0.25, z: 0.4 } }) };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(scaled)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.targetObject?.scale).toEqual({ x: 0.25, y: 0.25, z: 0.4 });
    const plain = parseEngraveJob(JSON.parse(JSON.stringify({ ...base, targetObject: goal() })));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect('scale' in (plain.job.targetObject ?? {})).toBe(false);
  });

  it('refuses a zero or negative scale', () => {
    const bad = { ...defaultEngraveJob(), targetObject: goal({ scale: { x: 0, y: 1, z: 1 } }) };
    expect(parseEngraveJob(JSON.parse(JSON.stringify(bad))).ok).toBe(false);
  });
});

describe('#722 — the store writes the scale', () => {
  it('sets a scale, and null or 100 % removes the key', async () => {
    const { useEngraveJobStore } = await import('@/store/engraveJobStore');
    const store = useEngraveJobStore.getState();
    store.setTargetObject(goal({ data: undefined }));
    useEngraveJobStore.getState().updateTargetObject({ scale: { x: 0.25, y: 0.25, z: 0.4 } });
    expect(useEngraveJobStore.getState().job.targetObject?.scale).toEqual({ x: 0.25, y: 0.25, z: 0.4 });
    useEngraveJobStore.getState().updateTargetObject({ scale: { x: 1, y: 1, z: 1 } });
    expect('scale' in (useEngraveJobStore.getState().job.targetObject ?? {})).toBe(false);
    useEngraveJobStore.getState().updateTargetObject({ scale: { x: 0.5, y: 0.5, z: 0.5 } });
    useEngraveJobStore.getState().updateTargetObject({ scale: null });
    expect('scale' in (useEngraveJobStore.getState().job.targetObject ?? {})).toBe(false);
  });
});
