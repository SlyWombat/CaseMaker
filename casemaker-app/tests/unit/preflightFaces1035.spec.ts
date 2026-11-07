/**
 * #1035 item 9 — THE CUT GATE MUST NOT REFUSE ON THE PLACEHOLDER BOX.
 *
 * Measured on b2570e1de (cncMode e2e red on gpd-dave, reproduced locally 1-in-4): the Cut preflight
 * computes `preflightHub` on render, and `validateJob`'s jaw check measures the job's labels through
 * `sweptCuts`, which builds its plan with `unparsedFace: 'estimate'`. While the bundled faces are
 * still being fetched and parsed, `inkBoxOf` falls back to its documented UPPER-bound estimate
 * (1.95 em/char) — the fit path's placeholder — and the default job's "CASE" spans 109.2 mm on a
 * 100 mm stock, crossing both jaws. The gate then refused with `vise-jaw-collision` ("comes within
 * 0 mm of the fixed jaw face") on a job that does not touch a jaw at all: measured, the box is
 * 26.9–73.1 mm. The estimate is a placeholder the FIT path accepts; a collision must not be.
 *
 * The fix: `validateJob` skips the collision while the labels' faces are not in, and the hub states
 * that as a PENDING row — never a false refusal, never a silent pass. Run-time paths parse first,
 * so their refusals are unchanged.
 */
import { describe, it, expect, vi } from 'vitest';

const faces = vi.hoisted(() => ({ loaded: false }));

vi.mock('@/engine/fonts/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/fonts/registry')>();
  return {
    ...actual,
    // The cold browser: the face is not parsed yet, so `resolveFont` throws its "not loaded"
    // guard exactly as it does in the app, and `labelGlyphMeasure` catches it into the estimate.
    labelFontsLoaded: () => faces.loaded,
    resolveFont: (...args: Parameters<typeof actual.resolveFont>) => {
      if (!faces.loaded) throw new Error('bundled font is not loaded');
      return actual.resolveFont(...args);
    },
  };
});

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { preflightHub } from '@/engine/cnc/preflight/hub';
import { sweptCuts } from '@/engine/cnc/engrave/partPlan';

function gate(): ReturnType<typeof preflightHub> {
  return preflightHub({
    job: defaultEngraveJob(),
    generated: null,
    staleSince: null,
    package: null,
    calibration: null,
    shelfItem: null,
    reach: null,
    bed: null,
  });
}

describe('#1035 item 9 — a jaw collision is never judged on the ink-box estimate', () => {
  it('with the faces not yet parsed, the gate holds no collision and says the check is pending', () => {
    faces.loaded = false;
    const report = gate();
    expect(report.rows.filter((r) => r.code === 'vise-jaw-collision')).toEqual([]);
    expect(report.rows.some((r) => r.code === 'labels-measuring')).toBe(true);
    // The blocking reason on a fresh job stays the run gate's own row.
    expect(report.firstBlocking?.code).toBe('no-generate');
  });

  it('a rotary job holds no jaw check at all, so no pending row names one (C’s nit)', () => {
    faces.loaded = false;
    const job = defaultEngraveJob();
    job.workholding = {
      kind: 'rotary-chuck',
      rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    };
    const report = preflightHub({
      job,
      generated: null,
      staleSince: null,
      package: null,
      calibration: null,
      shelfItem: null,
      reach: null,
      bed: null,
    });
    expect(report.rows.some((r) => r.code === 'labels-measuring')).toBe(false);
  });

  it('once the faces are in, the gate measures the real boxes and needs no pending row', () => {
    faces.loaded = true;
    const report = gate();
    expect(report.rows.filter((r) => r.code === 'vise-jaw-collision')).toEqual([]);
    expect(report.rows.some((r) => r.code === 'labels-measuring')).toBe(false);
    const caseCut = sweptCuts(defaultEngraveJob()).find((cut) => cut.name.includes('CASE'));
    expect(caseCut).toBeDefined();
    expect(caseCut!.box.minX).toBeCloseTo(26.86, 1);
    expect(caseCut!.box.maxX).toBeCloseTo(73.14, 1);
  });
});
