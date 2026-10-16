// #417 — the wasteboard's warning logic (pure: the plan calls it later), and the shop's defaults
// section that carries its depth limit (and #416's power-on wait), with the shared fixture.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WasteboardSchema,
  markResurfaced,
  recordScar,
  wasteboardFindings,
  type Wasteboard,
} from '@/engine/cnc/wasteboard';
import { ShopDefaultsSchema, readDefault } from '@/platform/defaultsClient';
import { LocationDocSchema } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: Array<{ wasteboard: unknown }>;
  defaults: Record<string, unknown>;
};
const BOARD: Wasteboard = WasteboardSchema.parse(DOC.machines[0]!.wasteboard);
// The fixture's scar is at x -150..-110, y -150..-130 (machine XY).
const CLEAR = { x: -60, y: -60, width: 30, height: 30 };
const ON_SCAR = { x: -120, y: -140, width: 30, height: 30 };

describe('#417 the wasteboard warnings', () => {
  it('says nothing about depth for a job that does not reach the board — but a scar under it, at any depth (#417 review)', () => {
    expect(wasteboardFindings({ board: BOARD, footprint: CLEAR, depthIntoBoard: 0, limit: 0.5 })).toEqual([]);
    const f = wasteboardFindings({ board: BOARD, footprint: ON_SCAR, depthIntoBoard: 0, limit: 0.5 });
    expect(f.map((x) => x.kind)).toEqual(['crosses-scar']);
  });

  it('names every job that left a scar under the footprint', () => {
    const two = recordScar(BOARD, ON_SCAR, '2026-10-16T00:00:00.000Z', 'job-7');
    const f = wasteboardFindings({ board: two, footprint: ON_SCAR, depthIntoBoard: 0, limit: 0.5 });
    expect(f[0]!.text).toContain('(from job-1, job-7)');
  });

  it('says nothing for a cut within the limit on clean board', () => {
    expect(wasteboardFindings({ board: BOARD, footprint: CLEAR, depthIntoBoard: 0.3, limit: 0.5 })).toEqual([]);
  });

  it('warns past the limit — the limit passed in, not a constant', () => {
    const f = wasteboardFindings({ board: BOARD, footprint: CLEAR, depthIntoBoard: 0.8, limit: 0.5 });
    expect(f.map((x) => x.kind)).toEqual(['beyond-limit']);
    expect(wasteboardFindings({ board: BOARD, footprint: CLEAR, depthIntoBoard: 0.8, limit: 1 })).toEqual([]);
  });

  it('warns a cut through the whole board, and one crossing a recorded scar', () => {
    const f = wasteboardFindings({ board: BOARD, footprint: ON_SCAR, depthIntoBoard: 12, limit: 0.5 });
    expect(f.map((x) => x.kind)).toEqual(['through-board', 'crosses-scar']);
    expect(f[1]!.text).toContain('job-1');
  });

  it('says no board is recorded rather than guessing a thickness', () => {
    const f = wasteboardFindings({ board: null, footprint: CLEAR, depthIntoBoard: 0.2, limit: 0.5 });
    expect(f.map((x) => x.kind)).toEqual(['no-board']);
  });

  it('records a scar, and resurfacing clears them with the new thickness', () => {
    const scarred = recordScar(BOARD, CLEAR, '2026-10-16T00:00:00.000Z', 'job-2');
    expect(scarred.scars).toHaveLength(2);
    expect(wasteboardFindings({ board: scarred, footprint: CLEAR, depthIntoBoard: 0.2, limit: 0.5 })[0]?.kind).toBe('crosses-scar');
    const fresh = markResurfaced(scarred, 9.4, 'measured', '2026-10-17T00:00:00.000Z');
    expect([fresh.scars.length, fresh.thickness, fresh.lastResurfacedAt]).toEqual([0, 9.4, '2026-10-17T00:00:00.000Z']);
    expect(WasteboardSchema.safeParse(fresh).success).toBe(true);
  });
});

describe('the shop defaults (location.json `defaults`)', () => {
  it('parses the fixture’s section — a seeded key, a chosen one, and a key this build never named', () => {
    const parsed = ShopDefaultsSchema.safeParse(DOC.defaults);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(LocationDocSchema.safeParse(DOC).success).toBe(true);
    expect(parsed.data!['rest.overlapMm']?.source).toBe('chosen');
  });

  it('reads the location’s value with its source, and the fallback only with no location — labelled', () => {
    const map = ShopDefaultsSchema.parse(DOC.defaults);
    expect(readDefault(map, 'power.onWaitSeconds')).toEqual({ value: 180, source: 'seeded' });
    expect(readDefault(null, 'wasteboard.depthLimitMm')).toEqual({ value: 0.5, source: 'fallback' });
  });

  it('refuses a malformed key, a structured value, an undated choice, and a known key out of bounds', () => {
    const chosen = { source: 'chosen', setAt: '2026-10-15T00:00:00.000Z' };
    for (const bad of [
      { 'Rest.overlap': { value: 1, ...chosen } },
      { overlap: { value: 1, ...chosen } },
      { 'rest.overlapMm': { value: { a: 1 }, ...chosen } },
      { 'rest.overlapMm': { value: 1, source: 'chosen' } },
      { 'power.onWaitSeconds': { value: 5, ...chosen } },
      { 'wasteboard.depthLimitMm': { value: -1, ...chosen } },
      { 'rest.overlapMm': { value: 1, ...chosen, note: 'unknown field' } },
      { 'rest.overlapMm': { value: 1, ...chosen, unit: 'millimetres-per-minute' } },
    ]) {
      expect(ShopDefaultsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
