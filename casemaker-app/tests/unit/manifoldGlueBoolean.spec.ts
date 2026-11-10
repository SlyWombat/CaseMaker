/**
 * #1024 — a boolean on a polygon operand leaves no temporary CrossSection behind.
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
import { REGION, REGION_B, externalMb } from './helpers/manifoldRings';
import { makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
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

