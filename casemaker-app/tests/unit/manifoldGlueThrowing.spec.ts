/**
 * #1024 — a throwing boolean leaves no handle behind.
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
import { REGION, externalMb } from './helpers/manifoldRings';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
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

