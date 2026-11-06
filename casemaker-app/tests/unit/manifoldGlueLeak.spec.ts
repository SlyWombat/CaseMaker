/**
 * #1022 — THE GLUE FREES WHAT IT CONVERTS. manifold-3d 3.5.4's embind glue leaks ~25 B per polygon
 * vertex on every polygons→CrossSection conversion and every `toPolygons`: `polygons2vec` pushes
 * each ring into the outer vector BY COPY and never deletes the inner vector, and `vec2polygons`
 * reads `vec.get(i)` (a copy) and never deletes it. Upstream master carries both deletes; the
 * latest release does not, so `patches/manifold-3d+3.5.4.patch` applies them at `postinstall`.
 *
 * This line holds the patch in place. RED at the unpatched 3.5.4: +269 MB over the 10,000
 * conversions (#1022's stamping table, `ofPolygons + toPolygons`); the wasm heap only grows and
 * the growth survives forced GC, which is how it aborted the per-cell Clipper form of #1020.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { Polygons } from '@/engine/cnc/cam/pocket';

const RING: [number, number][] = Array.from({ length: 654 }, (_, i) => {
  const a = (2 * Math.PI * i) / 654;
  return [60 * Math.cos(a), 60 * Math.sin(a)] as [number, number];
});

/** A second 654-vertex ring, shifted so the two operands differ (the leak does not need it to). */
const RING_B: [number, number][] = RING.map(([x, y]) => [x + 5, y] as [number, number]);
const REGION: Polygons = [RING];
const REGION_B: Polygons = [RING_B];

const externalMb = (): number => process.memoryUsage().external / 1e6;

describe('#1022 — the manifold glue frees its conversions', () => {
  it('10,000 × ofPolygons(654-vertex ring) + toPolygons + delete grows external memory by < 5 MB', () => {
    const CS = tl.CrossSection;
    // Warm-up: get the wasm heap to its steady size so the first allocations' memory.grow is not
    // counted as the conversion leak.
    for (let i = 0; i < 100; i++) {
      const cs = CS.ofPolygons([RING]);
      cs.toPolygons();
      cs.delete();
    }
    const before = externalMb();
    for (let i = 0; i < 10_000; i++) {
      const cs = CS.ofPolygons([RING]);
      cs.toPolygons();
      cs.delete();
    }
    const after = externalMb();
    writeFileSync(join(tmpdir(), '1022-leak.json'), JSON.stringify({ before, after, growthMb: after - before }));
    expect(after - before, `external memory grew ${(after - before).toFixed(1)} MB over 10,000 conversions`).toBeLessThan(5);
  }, 300_000);
});

/**
 * #1024 — THE SECOND GLUE LEAK: `cross(other)`. A CrossSection boolean whose operand is a POLYGON
 * LIST goes through the glue's `cross`, which builds a temporary CrossSection and never deletes
 * it (`subtract`/`add`/`intersect` and the static batch all do). #1022 freed the vectors inside a
 * conversion, not that object. A 4-vertex cell hides it (~0.1 KB, below the heap's grow steps) —
 * the per-cell form of #1020 leaked one PER CELL and drove the wasm into its 4,096 MB cap; these
 * cases use a 654-vertex operand so the leak is the thing being measured.
 *
 * RED before the wrapper fix, measured 2026-11-06: 10.86 KB per subtract, 18.28 KB per union and
 * 22.92 KB per `A \ (A \ B)` call. GREEN: our wrappers convert both operands to handles they own
 * and delete them, so the growth is allocator noise (0.00 KB per call).
 */
describe('#1024 — a boolean on a polygon operand leaves no temporary CrossSection behind', () => {
  const subtract = makeClipperSubtract(tl);
  const union = makeClipperUnion(tl);
  const CASES: { name: string; calls: number; call: () => unknown }[] = [
    {
      name: 'makeClipperSubtract(654-vertex, 654-vertex)',
      calls: 10_000,
      call: () => subtract(REGION, REGION_B),
    },
    {
      name: 'makeClipperUnion(654-vertex, 654-vertex)',
      calls: 5_000,
      call: () => union(REGION, REGION_B),
    },
    {
      // `intersectWithRegion`'s own shape (`ops/pocket.ts`): A \ (A \ B), the inner result a
      // 654-vertex polygon list fed to the outer call.
      name: 'intersectWithRegion’s A \\ (A \\ B)',
      calls: 5_000,
      call: () => subtract(REGION, subtract(REGION, REGION_B)),
    },
  ];

  for (const c of CASES) {
    it(`${c.calls.toLocaleString('en-US')} × ${c.name} grows external memory by < 5 MB`, () => {
      // Warm-up: the first calls' memory.grow is the heap reaching its steady size, not the leak.
      for (let i = 0; i < 100; i++) c.call();
      const before = externalMb();
      for (let i = 0; i < c.calls; i++) c.call();
      const after = externalMb();
      const perCallKb = ((after - before) / c.calls) * 1000;
      const slug = c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      writeFileSync(
        join(tmpdir(), `1024-leak-${slug}.json`),
        JSON.stringify({ name: c.name, calls: c.calls, before, after, growthMb: after - before, perCallKb }),
      );
      expect(
        after - before,
        `${c.name}: external memory grew ${(after - before).toFixed(1)} MB over ${c.calls.toLocaleString('en-US')} calls (${perCallKb.toFixed(2)} KB per call)`,
      ).toBeLessThan(5);
    }, 300_000);
  }
});

/**
 * #1024 (E's review) — A BOOLEAN THAT THROWS STILL FREES WHAT IT MADE. The second operand's
 * conversion throws in the glue (`ofPolygons` reads the ring before the C++ call, so a non-ring
 * operand throws a JS TypeError) — AFTER the first handle exists. Without try/finally that first
 * handle leaks on every throw (~10 KB per call here, measured +200 MB over 20,000); the wrappers
 * nest the conversions and the result so every handle is freed on both paths, the same shape
 * `intersectionArea` uses.
 *
 * NOT an Infinity coordinate: 6b's table called that a C++ exception, but on this build it is a
 * wasm TRAP (`memory access out of bounds` inside polygons2vec) and the instance is dead after the
 * first one — a loop over it measures nothing.
 */
describe('#1024 — a throwing boolean leaves no handle behind', () => {
  const subtract = makeClipperSubtract(tl);
  const union = makeClipperUnion(tl);
  // The first operand converts cleanly; the second passes the wrappers' empty-length guard and
  // throws in the glue's own conversion (not iterable) — after the first handle exists.
  const BAD = { length: 1 } as unknown as Polygons;
  const CASES: { name: string; calls: number; call: () => unknown }[] = [
    { name: 'makeClipperSubtract, throwing second operand', calls: 10_000, call: () => subtract(REGION, BAD) },
    { name: 'makeClipperUnion, throwing second operand', calls: 5_000, call: () => union(REGION, BAD) },
  ];
  for (const c of CASES) {
    it(`${c.calls.toLocaleString('en-US')} × ${c.name} grows external memory by < 5 MB`, () => {
      const attempt = (): boolean => {
        try {
          c.call();
          return false;
        } catch {
          return true;
        }
      };
      for (let i = 0; i < 100; i++) attempt();
      const before = externalMb();
      let threw = 0;
      for (let i = 0; i < c.calls; i++) if (attempt()) threw++;
      const after = externalMb();
      const perCallKb = ((after - before) / c.calls) * 1000;
      const slug = c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      writeFileSync(
        join(tmpdir(), `1024-leak-throw-${slug}.json`),
        JSON.stringify({ name: c.name, calls: c.calls, threw, before, after, growthMb: after - before, perCallKb }),
      );
      // The case must be the THROW path — a silent pass would prove nothing.
      expect(threw, 'the bad operand must throw on every call').toBe(c.calls);
      expect(
        after - before,
        `${c.name}: external memory grew ${(after - before).toFixed(1)} MB over ${c.calls.toLocaleString('en-US')} throws (${perCallKb.toFixed(2)} KB per call)`,
      ).toBeLessThan(5);
    }, 300_000);
  }
});
