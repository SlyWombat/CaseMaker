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

import { probeColletClause, probeColletWords } from '@/engine/cnc/probeFitWords';
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

function planFor(probe: typeof PROBE_6MM | typeof PROBE_NO_SHANK) {
  const r = planRegistration(
    {
      stock: BLANK,
      mount: 'tape',
      expectedSurface: { machineZ: -56.172, from: 'test' },
      seekFromMachineZ: -3,
      probe,
    },
    registrationSettings(null, probe).settings,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

describe('#1203 the collet in words', () => {
  it('names the post’s collet, and says to check it when the shank is unrecorded', () => {
    expect(probeColletWords(6)).toBe('6 mm collet');
    expect(probeColletWords(6.35)).toBe('1/8" collet');
    expect(probeColletWords(5)).toBe('5 mm collet');
    expect(probeColletWords(null)).toBe('check the collet');
    expect(probeColletWords(undefined)).toBe('check the collet');
    expect(probeColletClause(6)).toBe(' — 6 mm collet');
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
