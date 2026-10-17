// §5.4/§5.7 — the registration band: the ± strips the preview draws from an approved setup plan,
// or the datum edges a single setup's mount already holds. Pure data in, plain rectangles out; the
// plan planner is run for real so the scans and reference walls are the ones the app would approve.

import { describe, it, expect } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { planRegistration, planReferences } from '@/engine/cnc/registration';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { ANCHOR_BRACKET_RESIDUAL_MM, PROBE_RESIDUAL_MM, VISE_JAW_RESIDUAL_MM, type ProbeResiduals } from '@/engine/cnc/probePlan';
import { registrationBandsFor } from '@/workers/sim/engraveRegistration';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

const S = registrationSettings(null).settings;
const FALLBACKS: ProbeResiduals = {
  probe: PROBE_RESIDUAL_MM,
  wiredProbeZ: 0.001,
  chuckAxis: 0.05,
  anchorBracket: ANCHOR_BRACKET_RESIDUAL_MM,
  viseJaw: VISE_JAW_RESIDUAL_MM,
};

/** The shipped job with a first setup carrying `registration`. */
function withRegistration(job: EngraveJob, plan: RegistrationPlan, setup: JobSetup): EngraveJob {
  return {
    ...job,
    setups: [
      {
        ...setup,
        registration: { method: plan.mount, plan, expected: 'test plan' },
      },
    ],
  };
}

/** A real vise plan over the shipped 100 × 60 blank. */
function visePlan(): RegistrationPlan {
  const r = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 100, yMax: 60, cornerRadius: 0 },
      mount: 'vise',
      expectedSurface: { machineZ: 0, from: 'test' },
      seekFromMachineZ: 20,
      fixtureBelowSurfaceMm: 3,
    },
    S,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

/** The implicit setup the shipped job derives, with the mount a test wants. */
function setup(mount: 'vise' | 'bracket' | 'tape'): JobSetup {
  const job = defaultEngraveJob();
  return { ...jobSetups(job)[0]!, mount: { kind: mount } };
}

describe('the registration band (§5.4/§5.7)', () => {
  it('draws the fixed jaw’s datum edge for a single-setup vise job', () => {
    const bands = registrationBandsFor(defaultEngraveJob(), FALLBACKS);

    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      id: 'registration-datum-left',
      edge: 'left',
      source: 'datum',
      uncertainty: VISE_JAW_RESIDUAL_MM,
      label: 'the left edge',
    });
    // The strip straddles x = 0 and runs the blank's full width; that half outside the stock is
    // the tolerance the band exists to show.
    expect(bands[0]!.min[0]).toBeCloseTo(-VISE_JAW_RESIDUAL_MM, 9);
    expect(bands[0]!.max[0]).toBeCloseTo(VISE_JAW_RESIDUAL_MM, 9);
    expect(bands[0]!.min[1]).toBe(0);
    expect(bands[0]!.max[1]).toBe(60);
  });

  it('uses the caller’s residuals, not the fallbacks, for the datum band', () => {
    const residuals = { ...FALLBACKS, viseJaw: 0.12 };
    const [band] = registrationBandsFor(defaultEngraveJob(), residuals);
    expect(band!.uncertainty).toBe(0.12);
    expect(band!.min[0]).toBeCloseTo(-0.12, 9);
    expect(band!.max[0]).toBeCloseTo(0.12, 9);
  });

  it('draws the datum edges a single-setup bracket holds, and none for tape', () => {
    const bracket = registrationBandsFor({ ...defaultEngraveJob(), setups: [setup('bracket')] }, FALLBACKS);
    expect(bracket.map((b) => [b.edge, b.source, b.uncertainty])).toEqual([
      ['left', 'datum', ANCHOR_BRACKET_RESIDUAL_MM],
      ['front', 'datum', ANCHOR_BRACKET_RESIDUAL_MM],
    ]);

    const tape = registrationBandsFor({ ...defaultEngraveJob(), setups: [setup('tape')] }, FALLBACKS);
    expect(tape).toEqual([]);
  });

  it('draws an approved vise plan’s scanned edges: the fixed jaw’s and the front edge’s', () => {
    const job = defaultEngraveJob();
    const plan = visePlan();
    const bands = registrationBandsFor(withRegistration(job, plan, setup('vise')), FALLBACKS);

    expect(bands.map((b) => [b.edge, b.source, b.uncertainty])).toEqual([
      ['left', 'plan', VISE_JAW_RESIDUAL_MM],
      ['front', 'plan', PROBE_RESIDUAL_MM],
    ]);
    // The plan's own stock rectangle, not a re-derived one.
    expect(bands[0]!.min[1]).toBe(0);
    expect(bands[0]!.max[1]).toBe(60);
    expect(bands[1]!.min[0]).toBe(0);
    expect(bands[1]!.max[0]).toBe(100);
  });

  it('draws a frame of scanned walls around an approved reference feature (#429)', () => {
    const job = defaultEngraveJob();
    const r = planReferences(
      {
        stock: { xMin: 0, yMin: 0, xMax: 100, yMax: 60, cornerRadius: 0 },
        mount: 'vise',
        expectedSurface: { machineZ: 0, from: 'test' },
        seekFromMachineZ: 20,
        fixtureBelowSurfaceMm: 3,
        openings: [{ itemId: 'bore', name: 'the bore', min: [30, 20], max: [50, 40], depth: 5 }],
      },
      S,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.references).toHaveLength(1);

    const bands = registrationBandsFor(withRegistration(job, r.plan, setup('vise')), FALLBACKS);
    const feature = bands.filter((b) => b.source === 'feature');
    // Two axes × two opposite walls: each scan is a strip along one wall of the opening.
    expect(feature).toHaveLength(4);
    expect(feature.every((b) => b.edge === null && b.itemId === 'bore')).toBe(true);
    expect(feature.every((b) => b.uncertainty === PROBE_RESIDUAL_MM)).toBe(true);
    // One label for the feature, at its centre; the other three strips carry none.
    expect(feature.filter((b) => b.label !== null)).toHaveLength(1);
    expect(feature.find((b) => b.label !== null)!.label).toBe('the bore');
    expect(feature.find((b) => b.label !== null)!.labelAt).toEqual([40, 30]);
    // A wall strip follows the feature's extent ALONG the wall, not the whole stock, and is only
    // the residual wide ACROSS it.
    expect(Math.max(...feature.map((b) => b.max[0] - b.min[0]))).toBeCloseTo(20, 9);
    expect(Math.max(...feature.map((b) => b.max[1] - b.min[1]))).toBeCloseTo(20, 9);
    expect(Math.min(...feature.map((b) => b.max[0] - b.min[0]))).toBeCloseTo(2 * PROBE_RESIDUAL_MM, 9);
    expect(Math.min(...feature.map((b) => b.max[1] - b.min[1]))).toBeCloseTo(2 * PROBE_RESIDUAL_MM, 9);
  });

  it('shows the mount datum, not a plan drawn in another footprint’s frame', () => {
    const r = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: 80, yMax: 50, cornerRadius: 0 },
        mount: 'vise',
        expectedSurface: { machineZ: 0, from: 'test' },
        seekFromMachineZ: 20,
        fixtureBelowSurfaceMm: 3,
      },
      S,
    );
    if (!r.ok) throw new Error(r.reason);
    const bands = registrationBandsFor(withRegistration(defaultEngraveJob(), r.plan, setup('vise')), FALLBACKS);
    expect(bands.map((b) => [b.edge, b.source])).toEqual([['left', 'datum']]);
  });

  it('is empty when there is no mount datum and no approved plan', () => {
    const job = { ...defaultEngraveJob(), setups: [setup('tape')] };
    expect(registrationBandsFor(job, FALLBACKS)).toEqual([]);
  });
});
