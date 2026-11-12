/**
 * #1241 — THE FOUR READERS TAKE THE SHOP'S SETTINGS AS ARGUMENTS.
 *
 * #1237 moved the planner's seven settings onto `ModelPlanInput`; four other engine readers still
 * reached the ambient source through a default argument. #1241 makes the map (or the values read
 * from it) an explicit parameter at each boundary, so a caller that forgets fails to compile:
 *
 *   - `rotaryMapOf(job, defaults)` — the rotary limits;
 *   - `probeResiduals(defaults)` / `registrationBandsFor(job, residuals)` — the five residuals;
 *   - `probeColletWords(shank, tolerance)` — the collet words (its own test: `probeShank1203`);
 *   - `runBitChangeRule(defaults)` — the run total's bit-change rule.
 *
 * The MANAGER's rule for each reader: a location with a changed value changes the result, and the
 * recommended value gives today's result byte for byte. The location fixture is at every
 * recommendation (#1237's scan), so it stands for the recommended map here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bitChangePriceSeconds } from '@/engine/cnc/cam/model/bitChange';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { runBitChangeRule, runCycleOf } from '@/engine/cnc/engrave/runTotals';
import { probeResiduals } from '@/engine/cnc/probePlan';
import { rotaryFreeSpan, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { PLANNER_DEFAULTS_KEYS, plannerDefaultsProvenance } from '@/platform/plannerDefaults';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { registrationBandsFor } from '@/workers/sim/engraveRegistration';
import type { EngraveJob } from '@/types/engraveJob';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = dirname(fileURLToPath(import.meta.url));

/** The location fixture's defaults: every value at its recommendation. */
const RECOMMENDED: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

/** A location copy that CHOSE these values — what a shop's own number looks like in the map. */
function located(values: Record<string, number>): ShopDefaults {
  const entries = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, source: 'chosen' as const, setAt: '2026-11-11T00:00:00.000Z', unit: 'mm', note: null },
    ]),
  );
  return { ...RECOMMENDED, ...ShopDefaultsSchema.parse(entries) };
}

/** A ⌀10 rod in the chuck, tailstock in — the shape `rotaryMapOf` is written for. */
function rod(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'rod',
    stock: { length: 60, width: 10, thickness: 10, material: 'pla', shape: 'cylinder', diameter: 10 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
  };
}

describe('#1241 the rotary limits are the caller’s map', () => {
  it('a located limit moves the free span; the recommendations give today’s map byte for byte', () => {
    const job = rod();
    // Byte for byte: the recommended location and no location at all build the same map.
    expect(JSON.stringify(rotaryMapOf(job, RECOMMENDED))).toBe(JSON.stringify(rotaryMapOf(job, null)));
    const today = rotaryMapOf(job, null)!;
    expect(rotaryFreeSpan(today)).toEqual({ from: 3, to: 40, centre: 21.5 });

    const moved = rotaryMapOf(job, located({ 'rotary.jawKeepOutMm': 8, 'rotary.tailstockBandMm': 20 }))!;
    expect(moved.limits?.jawKeepOutMm).toBe(8);
    expect(moved.limits?.tailstockBandMm).toBe(20);
    expect(rotaryFreeSpan(moved)).toEqual({ from: 8, to: 30, centre: 19 });
  });
});

describe('#1241 the probe residuals are the caller’s map', () => {
  it('a located residual moves the worker’s band; the recommendations draw today’s bands byte for byte', () => {
    const job = defaultEngraveJob(); // vise-held: the left edge is the fixed jaw's datum
    expect(probeResiduals(RECOMMENDED)).toEqual(probeResiduals(null));
    const today = registrationBandsFor(job, probeResiduals(null));
    expect(JSON.stringify(registrationBandsFor(job, probeResiduals(RECOMMENDED)))).toBe(JSON.stringify(today));
    expect(today.map((b) => b.uncertainty)).toEqual([0.05]);

    const moved = registrationBandsFor(job, probeResiduals(located({ 'registration.viseJawResidualMm': 0.3 })));
    expect(moved.map((b) => b.uncertainty)).toEqual([0.3]);
  });
});

describe('#1241 the run total’s bit-change rule is the caller’s map', () => {
  it('a located price moves the change by exactly its delta; the recommendations give today’s total byte for byte', () => {
    // A cutter change after a 300 s (5 min) program: attended, so the change costs exactly
    // `bitChange.attendedChangeSeconds`. One change.
    const programs = [
      { seconds: 300, cutterKey: 'a', setupIndex: 1 },
      { seconds: 200, cutterKey: 'b', setupIndex: 1 },
    ];
    expect(runBitChangeRule(RECOMMENDED)).toEqual(runBitChangeRule(null));
    const today = runCycleOf(programs, runBitChangeRule(RECOMMENDED), { setupCount: 1, flip: false })!;
    expect(today).toEqual(runCycleOf(programs, runBitChangeRule(null), { setupCount: 1, flip: false })!);
    expect(bitChangePriceSeconds(runBitChangeRule(null), 300)).toBe(120);
    expect(today.totalSeconds).toBe(500 + 120);

    const movedRule = runBitChangeRule(located({ 'bitChange.attendedChangeSeconds': 180 }));
    const moved = runCycleOf(programs, movedRule, { setupCount: 1, flip: false })!;
    expect(moved.changes).toBe(1);
    expect(moved.totalSeconds - today.totalSeconds).toBe(180 - 120);
    expect(moved.cuttingSeconds).toBe(today.cuttingSeconds);
  });
});

describe('#1241 the receipt names these settings when they differ', () => {
  it('the four readers’ keys are in the planner-key list and reach the receipt’s provenance', () => {
    const keys = [
      'rotary.jawKeepOutMm',
      'rotary.tailstockBandMm',
      'rotary.turnClearanceMm',
      'rotary.tailstockCentreMm',
      'rotary.tailstockBodyMm',
      'rotary.tailstockHousingRadiusMm',
      'registration.faceAngleBallClearanceMm',
      'registration.faceAngleLevelBandMm',
      'registration.probeResidualMm',
      'registration.wiredProbeZResidualMm',
      'registration.chuckAxisResidualMm',
      'registration.viseJawResidualMm',
      'bracket.repeatMm',
      'probe.colletMatchMm',
      'bitChange.attendedMinutes',
      'bitChange.attendedChangeSeconds',
      'bitChange.walkAwayMinutes',
      'bitChange.returnMinutes',
    ];
    expect([...PLANNER_DEFAULTS_KEYS].sort()).toEqual(expect.arrayContaining([...keys].sort()));
    const provenance = plannerDefaultsProvenance(located({ 'rotary.jawKeepOutMm': 8, 'probe.colletMatchMm': 0.2 }), {
      withLocation: true,
    });
    expect(provenance.map((p) => p.name).sort()).toEqual(['probe.colletMatchMm', 'rotary.jawKeepOutMm']);
    expect(provenance.every((p) => p.source === 'located')).toBe(true);
  });

  it('none of the four reader modules reads the ambient source', () => {
    // The pin #1241 leaves behind: the readers take a map, so the module must not import or call
    // `liveShopDefaults` — a reintroduced ambient read fails here before it can hide in a realm.
    for (const file of [
      'src/engine/cnc/rotary/wrap.ts',
      'src/engine/cnc/probePlan.ts',
      'src/engine/cnc/probeFitWords.ts',
      'src/engine/cnc/engrave/runTotals.ts',
    ]) {
      expect(readFileSync(join(APP, file), 'utf8'), file).not.toMatch(/liveShopDefaults/);
    }
  });
});
