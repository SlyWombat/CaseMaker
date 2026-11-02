/**
 * #889 — the packed move store: it reads back as the `CamMove[]` it replaces, merges collinear
 * feeds only within its tolerance, counts without holding, and hands its arrays out and back.
 */
import { describe, expect, it } from 'vitest';

import { GOAL_MERGE_TOLERANCE_MM, MoveStore, PACKED_MOVE_BYTES, storeOf } from '@/engine/cnc/cam/moveStore';
import { estimateCycleSeconds, type CamMove } from '@/engine/cnc/cam/ir';

const sample: CamMove[] = [
  { kind: 'rapid', x: 0, y: 0, z: 1 },
  { kind: 'feed', x: 0, y: 0, z: -1, f: 300 },
  { kind: 'feed', x: 1.25, y: 0.1, z: -1.5, f: 800 },
  { kind: 'rapid', x: 1.25, y: 0.1, z: 1, peck: true },
  { kind: 'rapid', x: 2, y: 2, z: 5 },
];

/** Distance from p to the segment a→b, 3D. */
function toSegment(p: CamMove, a: CamMove, b: CamMove): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const vz = b.z - a.z;
  const len2 = vx * vx + vy * vy + vz * vz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy + (p.z - a.z) * vz) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy), p.z - (a.z + t * vz));
}

describe('#889 — MoveStore', () => {
  it('reads back exactly the moves pushed, through the array view', () => {
    const store = new MoveStore({ capacity: 2 });
    for (const m of sample) store.push(m);
    const view = store.view();
    expect(Array.isArray(view)).toBe(true);
    expect(view.length).toBe(sample.length);
    expect(view).toEqual(sample);
    expect([...view]).toEqual(sample);
    expect(view[1]).toEqual(sample[1]);
    expect(view.filter((m) => m.kind === 'feed')).toHaveLength(2);
    expect(view.map((m) => m.x)).toEqual(sample.map((m) => m.x));
    expect(storeOf(view)).toBe(store);
    expect(storeOf(sample)).toBeNull();
    expect(estimateCycleSeconds(view, { feedMmPerMin: 1000, accelMmPerS2: 500 } as never)).toBe(
      estimateCycleSeconds(sample, { feedMmPerMin: 1000, accelMmPerS2: 500 } as never),
    );
    expect(() => {
      (view as CamMove[]).push(sample[0]!);
    }).toThrow(/read-only/);
  });

  it('carries the rotary A word when a move has one', () => {
    const store = new MoveStore();
    store.push({ kind: 'rapid', x: 0, y: 0, z: 5, a: 0 });
    store.push({ kind: 'feed', x: 1, y: 0, z: 4, f: 500, a: 370 });
    expect(store.view()).toEqual([
      { kind: 'rapid', x: 0, y: 0, z: 5, a: 0 },
      { kind: 'feed', x: 1, y: 0, z: 4, f: 500, a: 370 },
    ]);
  });

  it('merges collinear feeds of one rate, and every dropped point stays within the tolerance', () => {
    const tol = GOAL_MERGE_TOLERANCE_MM;
    const raw: CamMove[] = [{ kind: 'rapid', x: 0, y: 5, z: 1 }, { kind: 'feed', x: 0, y: 5, z: -2, f: 300 }];
    // A row level for 90 samples, then bending away.
    for (let i = 1; i <= 120; i++) {
      const x = i * 0.1;
      const wobble = 0;
      const bend = i > 90 ? 0.02 * (i - 90) ** 1.5 * 0.01 : 0;
      raw.push({ kind: 'feed', x, y: 5, z: -2 + wobble + bend, f: 800 });
    }
    const store = new MoveStore({ mergeToleranceMm: tol });
    for (const m of raw) store.push(m);
    const merged = store.view();
    expect(merged.length).toBeLessThan(raw.length / 2);
    expect(store.merged).toBe(raw.length - merged.length);
    // Ends and rates are kept.
    expect(merged[0]).toEqual(raw[0]);
    expect(merged[1]).toEqual(raw[1]);
    expect(merged[merged.length - 1]).toEqual(raw[raw.length - 1]);
    // Every original feed point lies within `tol` of the merged polyline.
    const feeds = merged.filter((m) => m.kind === 'feed').slice(1);
    let seg = 0;
    for (const p of raw.slice(2)) {
      while (seg < feeds.length - 1 && p.x > feeds[seg]!.x + 1e-12) seg++;
      const a = seg === 0 ? merged[1]! : feeds[seg - 1]!;
      expect(toSegment(p, a, feeds[seg]!)).toBeLessThanOrEqual(tol + 1e-12);
    }
  });

  it('merges only level lines: a straight slope keeps every sample (the sweep reads long slopes high)', () => {
    const store = new MoveStore({ mergeToleranceMm: 0.002 });
    store.push({ kind: 'rapid', x: 0, y: 0, z: 1 });
    store.push({ kind: 'feed', x: 0, y: 0, z: 0, f: 300 });
    for (let i = 1; i <= 50; i++) store.push({ kind: 'feed', x: i * 0.1, y: 0, z: -i * 0.05, f: 800 });
    expect(store.length).toBe(52);
  });

  it('never merges across a rate change, a rapid, a turn back, or with merging off', () => {
    const line = (f2: number): CamMove[] => [
      { kind: 'rapid', x: 0, y: 0, z: 1 },
      { kind: 'feed', x: 0, y: 0, z: 0, f: 300 },
      { kind: 'feed', x: 1, y: 0, z: 0, f: 800 },
      { kind: 'feed', x: 2, y: 0, z: 0, f: f2 },
    ];
    const merged = new MoveStore({ mergeToleranceMm: 0.002 });
    for (const m of line(800)) merged.push(m);
    expect(merged.length).toBe(3);
    const rate = new MoveStore({ mergeToleranceMm: 0.002 });
    for (const m of line(900)) rate.push(m);
    expect(rate.length).toBe(4);
    const off = new MoveStore();
    for (const m of line(800)) off.push(m);
    expect(off.length).toBe(4);
    const back = new MoveStore({ mergeToleranceMm: 0.002 });
    for (const m of [...line(800).slice(0, 3), { kind: 'feed', x: 0.5, y: 0, z: 0, f: 800 } as CamMove]) back.push(m);
    expect(back.length).toBe(4);
  });

  it('counts without holding: the same length as the full store, and no moves to read', () => {
    const full = new MoveStore({ mergeToleranceMm: 0.002 });
    const count = new MoveStore({ mergeToleranceMm: 0.002, countOnly: true, capacity: 16 });
    for (let i = 0; i < 5000; i++) {
      const m: CamMove = i % 7 === 0 ? { kind: 'rapid', x: i, y: 0, z: 1 } : { kind: 'feed', x: i, y: (i % 3) * 0.5, z: -1, f: 800 };
      full.push(m);
      count.push(m);
    }
    expect(count.length).toBe(full.length);
    expect(count.byteLength).toBeLessThan(full.byteLength);
    expect(() => count.view()).toThrow();
  });

  it('hands its arrays out and takes them back, and appends store to store', () => {
    const a = new MoveStore();
    for (const m of sample) a.push(m);
    const buffers = a.buffers();
    expect(buffers.x).toBeInstanceOf(Float64Array);
    expect(buffers.kind.length).toBe(sample.length);
    const b = MoveStore.fromBuffers(buffers);
    expect(b.view()).toEqual(sample);
    const joined = new MoveStore();
    joined.append(a);
    joined.append(b.view());
    joined.append(sample);
    expect(joined.view()).toEqual([...sample, ...sample, ...sample]);
    expect(joined.byteLength).toBeGreaterThanOrEqual(joined.length * PACKED_MOVE_BYTES);
  });
});
