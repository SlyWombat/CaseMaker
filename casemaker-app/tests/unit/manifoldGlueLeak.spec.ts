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

const RING: [number, number][] = Array.from({ length: 654 }, (_, i) => {
  const a = (2 * Math.PI * i) / 654;
  return [60 * Math.cos(a), 60 * Math.sin(a)] as [number, number];
});

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
