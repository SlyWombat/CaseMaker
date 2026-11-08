/**
 * #1070 — REGISTER ON THE CUT REGION'S FOOTPRINT for a bed-held job, in the wired V2's Z-only
 * touches, with every planned position checked against the machine's soft limits.
 *
 * The tray case below is the real one: the M1 tray shifted 10 mm right on a 160 × 126 × 25 blank
 * in the bracket (demo location's calibration: anchor 1 at machine (−190.89, −193.83), soft
 * endstop −207 / −206 / −102), region 22…158 × 10…116, the job's 1 mm edge margin.
 *
 * RED at main: the Cut step plans nothing for a bed-held job (the planner refuses a bracket or
 * tape mount by name), so no plan lists these touches at all.
 */
import { describe, expect, it } from 'vitest';

import { planFootprintRegistration, type FootprintInput } from '@/engine/cnc/registration/footprint';
import { planRegistration, type PlanInput } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';

/** The tray, as the job and the demo machine state it. */
const TRAY: FootprintInput = {
  stock: { length: 160, width: 126, thickness: 25 },
  region: { minX: 22, minY: 10, maxX: 158, maxY: 116 },
  marginMm: 1,
  origin: { x: -190.89, y: -193.83, from: 'anchor 1 read from the machine (config-get sd on 192.168.10.43, 2026-10-18) + the bracket’s offset (0, 0)' },
  softLimits: { xMin: -207, yMin: -206, zMin: -102 },
  expectedSurface: { machineZ: -51.69, from: 'the bracket’s seat, one touch beside it' },
  seekFromMachineZ: -3,
  probe: { instrument: 'z-only', tipRadiusMm: 0.7 },
  settings: {
    scanInsideMm: 3,
    scanReachMm: 5,
    coarseStepMm: 1,
    fineStepMm: 0.5,
    cornerClearanceMm: 2,
    parkAboveSurfaceMm: 3,
    surfaceToleranceMm: 0.4,
  },
};

describe('#1070 footprint registration', () => {
  it('the shifted tray: two touches per bounding edge at the region’s extents, far edges once, Z per corner', () => {
    const r = planFootprintRegistration(TRAY);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    const { plan } = r;
    // The four extent touches, AT the region's extents — not the blank's corners.
    expect(plan.scans.filter((s) => s.purpose === 'extent').map((s) => [s.edge, s.along])).toEqual([
      ['front', 22],
      ['front', 158],
      ['left', 10],
      ['left', 116],
    ]);
    // The far edges, once each, as material-exists proofs.
    expect(plan.scans.filter((s) => s.purpose === 'presence').map((s) => [s.edge, s.along])).toEqual([
      ['right', 116],
      ['back', 158],
    ]);
    // One Z touch at each region corner.
    expect(plan.corners.map((c) => [c.x, c.y])).toEqual([
      [22, 10],
      [158, 10],
      [22, 116],
      [158, 116],
    ]);
    // The origin the touches derive, and the margin the region keeps.
    expect(plan.origin).toMatchObject({ x: -190.89, y: -193.83 });
    expect(plan.origin.derivedFrom).toContain('intersected');
    expect(plan.marginMm).toBe(1);
    expect(plan.notes.join('\n')).toContain('keeps 1 mm from the material it is registered on');
  });

  it('every planned position is in machine coordinates, inside the soft limits', () => {
    const r = planFootprintRegistration(TRAY);
    if (!r.ok) throw new Error(r.reason);
    // The left-edge scan's outer limit: work X −5 → machine X −195.89; the front's: Y −198.83.
    expect(r.plan.bounds).toEqual({ minX: -195.89, minY: -198.83, maxX: -25.89, maxY: -62.83, minZ: -52.09 });
    expect(r.plan.bounds.minX).toBeGreaterThan(-207);
    expect(r.plan.bounds.minY).toBeGreaterThan(-206);
    expect(r.plan.bounds.minZ).toBeGreaterThan(-102);
    // The machine values are the sent ones: origin + work.
    const leftAt10 = r.plan.scans.find((s) => s.edge === 'left' && s.along === 10)!;
    expect(leftAt10.machineLimit).toEqual([-195.89, -183.83]);
  });

  it('a planned move past the soft endstop is refused by name and number, before any line', () => {
    const r = planFootprintRegistration({ ...TRAY, origin: { ...TRAY.origin, x: -204 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // work X −5 + origin −204 = machine −209, past x_min −207.
    expect(r.reason).toContain('machine X -209');
    expect(r.reason).toContain('soft endstop X -207');
  });

  it('a region closer to an edge than the job’s margin is refused with the millimetres', () => {
    const r = planFootprintRegistration({ ...TRAY, region: { ...TRAY.region, minX: 0.5 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('within 0.5 mm of the left edge');
    expect(r.reason).toContain('keeps 1 mm');
  });

  it('a tight-but-legal region still plans: a rough edge is a reading, not a refusal', () => {
    // The region 2 mm from the left edge clears the 1 mm margin; the plan is unchanged — the
    // touched material position and the roughness between the two touches are the executor's
    // readings, and neither refuses the plan.
    const r = planFootprintRegistration({ ...TRAY, region: { ...TRAY.region, minX: 2 } });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.plan.scans.find((s) => s.edge === 'front')!.along).toBe(2);
    expect(r.plan.notes.join('\n')).toContain('never refused for its roughness alone');
  });

  it('the 3D probe is not the instrument — the wired V2 only', () => {
    const r = planFootprintRegistration({ ...TRAY, probe: { instrument: 'xyz', tipRadiusMm: 0.7 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('fit the wired V2 probe');
  });

  it('an obstacle under a planned touch is refused, naming it', () => {
    const r = planFootprintRegistration({
      ...TRAY,
      obstacles: [{ label: 'the clamp on the back edge', min: [0, 90], max: [30, 126] }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('the clamp on the back edge');
  });
});

describe('#1070 the planner routes an anchored bed-held job to the footprint', () => {
  /** The tray as the planner sees it: the stock's box, the anchor seed, no obstacles. */
  const plannerInput: PlanInput = {
    stock: { xMin: 0, yMin: 0, xMax: 160, yMax: 126, cornerRadius: 0 },
    mount: 'bracket',
    expectedSurface: { machineZ: -51.69, from: 'the bracket’s seat, one touch beside it' },
    seekFromMachineZ: -3,
    stockThicknessMm: 25,
    bracketOrigin: { x: -190.89, y: -193.83, from: 'anchor 1 read from the machine', uncertainty: 0.1, offsetMeasured: false },
    mountObstacles: [],
    region: { min: [22, 10], max: [158, 116], marginMm: 1 },
    softLimits: { xMin: -207, yMin: -206, zMin: -102 },
  };
  const settings = registrationSettings(null).settings;

  it('the plan’s scans are the region-extent touches, with the corner origin derivation', () => {
    const r = planRegistration(plannerInput, settings);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.plan.scans.map((sc) => [sc.edge, sc.along])).toEqual([
      ['front', 22],
      ['front', 158],
      ['left', 10],
      ['left', 116],
      ['right', 116],
      ['back', 158],
    ]);
    // The origin comes from the touched front/left lines (#525's corner path), not from the seed.
    expect(r.plan.corner).toEqual({ id: 'front-left', xEdge: 'left', yEdge: 'front' });
    // The seed is still the machine datum the moves are sent from.
    expect(r.plan.bracketOrigin).toMatchObject({ x: -190.89, y: -193.83 });
    expect(r.plan.surfacePoint).toEqual({ x: 90, y: 63 });
  });

  it('a seed that would put a planned touch past the soft endstop is refused, not planned', () => {
    const r = planRegistration({ ...plannerInput, bracketOrigin: { ...plannerInput.bracketOrigin!, x: -204 } }, settings);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('soft endstop X -207');
  });
});
