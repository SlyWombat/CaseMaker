/**
 * #1203 — THE PROBE'S SHANK IS A SWAPPABLE POST, and the fit-probe sentences name its collet.
 *
 * The bench, 2026-11-10: the wired V2's sensor and tip are one unit; the shank is a threaded post
 * (1/8" = 6.35 mm, or 6 mm). The 1/8" post was bent and is broken; the maintainer fitted the 6 mm
 * post. With a 3.175 mm collet in the spindle from the last cutter, a 6 mm-shank probe does not
 * fit, and the app used to say nothing about it.
 *
 * Red first: these assertions fail before the shank exists on the unit, the plan and the probes'
 * sentences.
 */
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { colletMatchToleranceMm, probeColletClause, probeColletWords } from '@/engine/cnc/probeFitWords';
import { planRegistration, registrationSettings } from '@/engine/cnc/registration';
import { summarizePlan } from '@/engine/cnc/registration/summary';

const BLANK = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const PROBE_6MM = {
  id: 'fx-probe-1',
  variant: 'wired-touch',
  instrument: 'z-only' as const,
  touches: 'z-only' as const,
  shankMm: 6,
  tip: { diameterMm: 2, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
};
const PROBE_NO_SHANK = { ...PROBE_6MM, shankMm: null };
/** The shop's recommended tolerance — what this bench's house has always carried (#1241 pins it). */
const COLET_MM = colletMatchToleranceMm(null);

/** A location whose defaults chose one key (#1241 — the settings the plan must carry). */
function locationDefaults(values: Record<string, number>): ShopDefaults {
  return ShopDefaultsSchema.parse(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { value, source: 'chosen', setAt: '2026-11-11T00:00:00.000Z', unit: 'mm', note: null },
      ]),
    ),
  );
}

function planFor(probe: typeof PROBE_6MM | typeof PROBE_NO_SHANK, defaults: ShopDefaults | null = null) {
  const r = planRegistration(
    {
      stock: BLANK,
      mount: 'tape',
      expectedSurface: { machineZ: -56.172, from: 'test' },
      seekFromMachineZ: -3,
      probe,
    },
    registrationSettings(defaults, probe).settings,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

describe('#1203 the collet in words', () => {
  it('names the post’s collet, and says to check it when the shank is unrecorded', () => {
    expect(probeColletWords(6, COLET_MM)).toBe('6 mm collet');
    expect(probeColletWords(6.35, COLET_MM)).toBe('1/8" collet');
    expect(probeColletWords(5, COLET_MM)).toBe('5 mm collet');
    expect(probeColletWords(null, COLET_MM)).toBe('check the collet');
    expect(probeColletWords(undefined, COLET_MM)).toBe('check the collet');
    expect(probeColletClause(6, COLET_MM)).toBe(' — 6 mm collet');
  });
});

describe('#1241 the tolerance is stated, never ambient', () => {
  it('a located tolerance moves the collet words; the recommendation gives today’s result byte for byte', () => {
    expect(COLET_MM).toBe(0.05);
    // 6.5 mm is 0.15 from the 1/8" post: inside a 0.2 mm location tolerance, outside the 0.05 seed.
    expect(probeColletWords(6.5, 0.2)).toBe('1/8" collet');
    expect(probeColletWords(6.5, COLET_MM)).toBe('6.5 mm collet');
    // The card's own sentence, from the plan's settings: the located value, then the recommendation.
    const probe = { ...PROBE_6MM, shankMm: 6.5 };
    expect(planFor(probe, locationDefaults({ 'probe.colletMatchMm': 0.2 })).settings.colletMatchMm).toBe(0.2);
    expect(summarizePlan(planFor(probe, locationDefaults({ 'probe.colletMatchMm': 0.2 })))).toContain(
      'fit the wired probe (1/8" collet) and measure it',
    );
    expect(summarizePlan(planFor(probe))).toContain('fit the wired probe (6.5 mm collet) and measure it');
  });
});

describe('#1203 the plan and the Register card name the collet', () => {
  it('the plan carries the fitted shank, and the card’s words name its collet', () => {
    const plan = planFor(PROBE_6MM);
    expect(plan.probe?.shankMm).toBe(6);
    expect(summarizePlan(plan)).toContain('fit the wired probe (6 mm collet) and measure it');
  });

  it('a probe with no shank recorded says to check the collet', () => {
    const plan = planFor(PROBE_NO_SHANK);
    expect(summarizePlan(plan)).toContain('fit the wired probe (check the collet)');
  });
});
