// #1200 — THE TIP CHAIN for a top-touch-only unit (analyst's fields, latest comment):
// the refusal is wrong for a plan with no sideways touch and no edge find, and right for any plan
// that corrects a sideways/edge-stepping reading. The top-touch inset takes the ball DIAMETER from
// measured → operator-stated → vendor → the registry floor `registration.probeFootprintShrinkMm`;
// the rim offset (the edge correction) stays MEASURED ONLY.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { planRegistration, type PlanInput, type ProbeSpec } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { summarizePlan } from '@/engine/cnc/registration/summary';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The tray's blank shape: a rectangle on the bracket's corner. */
const BLANK = { xMin: 0, yMin: 0, xMax: 160, yMax: 126, cornerRadius: 0 };
const G54 = { x: -181.55, y: -184.8 };

/** The house's 3D probe as it is RECORDED today: no measured tip fields at all. */
const TIPLESS_3D: ProbeSpec = {
  id: 'fx-probe-3d',
  variant: '3d',
  instrument: 'xyz',
  touches: 'z-only',
  tip: null,
  tipLateralUncertaintyMm: 0,
};

/** The tray's z-only bracket plan: the surface touch only, no scans, no sideways touch. */
const trayInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  stock: BLANK,
  mount: 'bracket',
  expectedSurface: { machineZ: -56.172, from: 'the seat + the stock’s thickness' },
  seekFromMachineZ: -3,
  bracketOrigin: { ...G54, from: 'anchor 1 + (0, 0)', offsetMeasured: true },
  mountObstacles: [],
  holdUncertainty: { xMm: 0.1, yMm: 0.1 },
  probe: TIPLESS_3D,
  cutCentre: { x: 80, y: 63 },
  ...over,
});

describe('#1200 the tip chain — a top-touch-only plan', () => {
  it('the tray’s z-only bracket plan with the 3D probe’s tip fields null PLANS, inset from the registry floor, labelled', () => {
    const r = planRegistration(trayInput(), S);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.scans).toEqual([]);
    // The chain ends at the floor: no ball diameter is known, so the source is the registry floor.
    expect(r.plan.topTouchTip).toEqual({ diameterMm: null, source: 'floor' });
    const summary = summarizePlan(r.plan);
    expect(summary).toContain('Top touches are kept 3 mm inside the edges');
    expect(summary).toContain('tip: registry floor, 3 mm — not measured');
  });

  it('a stated ball diameter is the next source, and the inset follows it', () => {
    const stated = { ...TIPLESS_3D, statedTipDiameterMm: 8 };
    const r = planRegistration(trayInput({ probe: stated, cutCentre: { x: 80, y: 63 } }), S);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.topTouchTip).toEqual({ diameterMm: 8, source: 'stated' });
    const summary = summarizePlan(r.plan);
    // radius 4 + hold 0.1 = 4.1 > the 3 mm floor: the stated diameter is what the inset follows.
    expect(summary).toContain('Top touches are kept 4.1 mm inside the edges');
    expect(summary).toContain('tip: stated ⌀8 mm — not measured');
  });

  it('the stated diameter changes where a touch may be placed: 3.5 mm inside is refused at 8 mm, allowed at the floor', () => {
    const edge = { x: 3.5, y: 63 };
    const atFloor = planRegistration(trayInput({ cutCentre: edge }), S);
    expect(atFloor.ok).toBe(true);
    const stated = planRegistration(trayInput({ probe: { ...TIPLESS_3D, statedTipDiameterMm: 8 }, cutCentre: edge }), S);
    expect(stated.ok).toBe(false);
    if (!stated.ok) expect(stated.reason).toContain('not well inside the stock');
  });

  it('a plan that needs an edge correction still REFUSES for the rim offset — the stated diameter is not one', () => {
    // A vise plan always scans an edge: it needs the measured rim offset, whatever diameter is stated.
    const vise = (probe: ProbeSpec): PlanInput => ({
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      mount: 'vise',
      expectedSurface: { machineZ: -56.172, from: 'the jaw top + the blank’s proud height' },
      seekFromMachineZ: -3,
      fixtureBelowSurfaceMm: 0.72,
      holdUncertainty: { xMm: 0.5, yMm: 5 },
      probe,
    });
    const t = planRegistration(vise(TIPLESS_3D), S);
    expect(t.ok).toBe(false);
    if (!t.ok) {
      // #1200 field 5 — the z-only unit's words name the restriction and the remedy (another probe).
      expect(t.reason).toContain('needs an edge correction');
      expect(t.reason).toContain('restricted to top touches');
      expect(t.reason).not.toContain('measure the 3D probe’s tip first');
    }
    // A stated diameter is not a rim offset: the edge-correction path still refuses.
    const s = planRegistration(vise({ ...TIPLESS_3D, statedTipDiameterMm: 8 }), S);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toContain('needs an edge correction');
  });

  it('an UNRESTRICTED 3D unit with no measured tip keeps the existing “measure the tip first” refusal on an edge plan', () => {
    const probe: ProbeSpec = { ...TIPLESS_3D, touches: 'all' };
    const r = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
        mount: 'vise',
        expectedSurface: { machineZ: -56.172, from: 'the jaw top + the blank’s proud height' },
        seekFromMachineZ: -3,
        fixtureBelowSurfaceMm: 0.72,
        holdUncertainty: { xMm: 0.5, yMm: 5 },
        probe,
      },
      S,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("measure the 3D probe's tip first");
  });
});
