/**
 * #1244 — THE THREE READS THAT CONSUME ONLY MAP-INDEPENDENT FACTS, PINNED BY TEST.
 *
 * Three converted call sites deliberately state `defaults: null` because the fact they take from
 * the part plan is one the rotary branch cannot change:
 *
 *   - the run record's §9 rows — item DEPTHS (`recordDepths`);
 *   - the rest facts' `traceOnly` — item PRESENCE (does the document hold any engrave?);
 *   - the pick's `faceWorkOf` / `planCutters` — a job-decided PREDICATE (holding + section). Since
 *     #1256 the pick passes the shop's real map (the parameter is required); the pin stays, because
 *     the answer must not depend on it.
 *
 * The analyst's ruling: each gets ONE test asserting the result is identical with no map and with
 * a map in which every rotary/face-angle key differs from its recommendation. A callee that later
 * starts reading the map's VALUES (a limit, a band) breaks one of these instead of silently
 * planning on the recommendations.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { faceWorkOf, planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { recordDepths } from '@/engine/cnc/engrave/runSheet';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob, EngraveShape } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every rotary-map key the converted reads travel through, each moved well inside its rule. */
const CHANGED: Record<string, number> = {
  'rotary.jawKeepOutMm': 8,
  'rotary.tailstockBandMm': 20,
  'rotary.turnClearanceMm': 9,
  'rotary.tailstockCentreMm': 30,
  'rotary.tailstockBodyMm': 80,
  'rotary.tailstockHousingRadiusMm': 60,
  'registration.faceAngleBallClearanceMm': 6,
  'registration.faceAngleLevelBandMm': 0.2,
};

/** The fixture map with every one of those keys CHOSEN differently. */
const MOVED: ShopDefaults = (() => {
  const base = ShopDefaultsSchema.parse(
    (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
  );
  const chosen = ShopDefaultsSchema.parse(
    Object.fromEntries(
      Object.entries(CHANGED).map(([key, value]) => [
        key,
        { value, source: 'chosen', setAt: '2026-11-12T00:00:00.000Z', unit: 'mm', note: null },
      ]),
    ),
  );
  return { ...base, ...chosen };
})();

const RECT: EngraveShape = {
  id: 'shp-1',
  kind: 'rect',
  position: { x: 20, y: Math.PI * 5 },
  rotation: 0,
  depth: 0.5,
  enabled: true,
  width: 10,
  height: 6,
  cornerRadius: 0,
};

/** A ⌀10 rod in the chuck with one engraved shape and one indexed face. */
function rod(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'map-independent',
    stock: { length: 60, width: 10, thickness: 10, material: 'pla', shape: 'cylinder', diameter: 10 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [{ ...RECT }],
    faces: [{ kind: 'flat', depth: 1 }],
    toolKey: 'flat-1.0',
  } as unknown as EngraveJob;
}

describe('#1244 the map-independent reads are identical with no map and with every rotary key moved', () => {
  it('the run record’s §9 rows: the same item depths', () => {
    const job = rod();
    expect(recordDepths(toPartPlan(job, { defaults: MOVED }))).toEqual(recordDepths(toPartPlan(job, { defaults: null })));
  });

  it('the rest facts’ presence predicate: the same engraves, and the same traces-only answer', () => {
    const job = rod();
    expect(toPartPlan(job, { defaults: MOVED }).engraves.length).toBe(toPartPlan(job, { defaults: null }).engraves.length);
    // The other half of `traceOnly` is "no engraves": a document with no shapes still reads the
    // same presence with either map.
    const bare: EngraveJob = { ...job, shapes: [] } as EngraveJob;
    expect(toPartPlan(bare, { defaults: MOVED }).engraves.length).toBe(0);
    expect(toPartPlan(bare, { defaults: null }).engraves.length).toBe(0);
  });

  it('the pick’s predicates: the same face work and the same cutter plan', () => {
    const job = rod();
    expect(faceWorkOf(job, MOVED)).toEqual(faceWorkOf(job, null));
    expect(faceWorkOf(job, MOVED)).not.toBeNull();
    expect(planCutters(job, null, [], [], MOVED, undefined, undefined, null, null)).toEqual(
      planCutters(job, null, [], [], null, undefined, undefined, null, null),
    );
  });
});
