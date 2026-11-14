/**
 * #1256 — WHAT THE PICK NEWLY READS, IT READS FROM THE SHOP THE CUT READS FROM.
 *
 * The measured pick and `recommendTool` used to plan on the recommendations for `kindedWork` and
 * `rotaryMapOf` (their map was an optional parameter that defaulted to null); the map is now a
 * required parameter all the way down. This pins the property that matters: every `rotaryMapOf`
 * read made inside the pick's chain (`planCutters`, `candidatePlans`, `candidateRefusals`,
 * `kindOnlyPick`, `faceCutterOptions`, `goalRoughOptions`, `kindedWork`, `faceWorkOf`) receives the
 * very map the caller holds — the one the cut passes `rotaryMapOf` from `shop.defaults` — and the
 * setting those reads would take from it really does differ from the recommendation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  candidatePlans,
  candidateRefusals,
} from '@/engine/cnc/engrave/smartPick';
import {
  faceCutterOptions,
  faceWorkOf,
  goalRoughOptions,
  kindedWork,
  kindOnlyPick,
  planCutters,
} from '@/engine/cnc/engrave/cutterPlan';
import { rotaryMapOf as realRotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';

const seen: Array<ShopDefaults | null> = [];
vi.mock('@/engine/cnc/rotary/wrap', async (original) => {
  const real = await original<typeof import('@/engine/cnc/rotary/wrap')>();
  return {
    ...real,
    rotaryMapOf: (job: EngraveJob, defaults: ShopDefaults | null) => {
      seen.push(defaults);
      return real.rotaryMapOf(job, defaults);
    },
  };
});

afterEach(() => {
  seen.length = 0;
});

const HERE = dirname(fileURLToPath(import.meta.url));
const MOVED: ShopDefaults = (() => {
  const base = ShopDefaultsSchema.parse(
    (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
  );
  const chosen = ShopDefaultsSchema.parse({
    'rotary.jawKeepOutMm': { value: 8, source: 'chosen', setAt: '2026-11-12T00:00:00.000Z', unit: 'mm', note: null },
    'rotary.tailstockBandMm': { value: 20, source: 'chosen', setAt: '2026-11-12T00:00:00.000Z', unit: 'mm', note: null },
  });
  return { ...base, ...chosen };
})();

/** A ⌀10 rod in the chuck with one engraved shape and one indexed face. */
function rod(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'pick-reads-shop',
    stock: { length: 60, width: 10, thickness: 10, material: 'pla', shape: 'cylinder', diameter: 10 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [
      { id: 'shp-1', kind: 'rect', position: { x: 20, y: Math.PI * 5 }, rotation: 0, depth: 0.5, enabled: true, width: 10, height: 6, cornerRadius: 0 },
    ],
    faces: [{ kind: 'flat', depth: 1 }],
    toolKey: 'flat-1.0',
  } as unknown as EngraveJob;
}

/** Every pick-chain entry that reads the job's rotary map, given one settings map. */
function runChain(job: EngraveJob, map: ShopDefaults | null): void {
  planCutters(job, null, [], [], map);
  candidatePlans(job, [], [], map);
  candidateRefusals(job, [], [], map);
  kindOnlyPick(job, [], [], map);
  faceCutterOptions(job, [], [], map);
  goalRoughOptions(job, [], [], map);
  kindedWork(job, map);
  faceWorkOf(job, map);
}

describe('#1256 the pick’s chain reads the map it is handed', () => {
  it('a moved shop: every rotary-map read in the chain gets that map, and the limits it yields are the shop’s', () => {
    const job = rod();
    runChain(job, MOVED);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m === MOVED)).toBe(true);
    // The values those reads take from the map are the shop's, not the recommendation's.
    const shopLimits = realRotaryMapOf(job, MOVED)!.limits!;
    const recommended = realRotaryMapOf(job, null)!.limits!;
    expect(shopLimits).not.toEqual(recommended);
    expect(shopLimits.jawKeepOutMm).toBe(8);
  });

  it('no location: the same chain reads null — the recommendations, stated at the call', () => {
    runChain(rod(), null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m === null)).toBe(true);
  });
});
