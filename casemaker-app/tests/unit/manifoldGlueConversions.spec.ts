/**
 * #1022 — the manifold glue frees its conversions.
 *
 * #1180 — SPLIT from manifoldGlueLeak.spec.ts: each leak group runs its synchronous 5k/10k loop on
 * its own worker. The bodies are moved verbatim; the rings and the external-memory read are in
 * helpers/manifoldRings.ts.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { RING, externalMb } from './helpers/manifoldRings';

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

