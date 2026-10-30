// #525 — the 3D probe as a second instrument. The pure half: the instrument derived from the
// accessory variant, the planner's refusal of an unmeasured tip, the sideways touch's geometry
// (start, travel, depth, ball offset) and the edge it yields. The bench fixture's numbers are the
// ones the Z-only tests use (the badge blank of Appendix C), so the two strategies describe the
// same stock.

import { describe, it, expect } from 'vitest';
import {
  planRegistration,
  probeInstrument,
  probeInstrumentOf,
  type ExpectedStock,
  type PlanInput,
  type ProbeSpec,
} from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import {
  ballOffsetMm,
  sideCentreWork,
  sideTouchAllowed,
  sideTouchDepthMm,
  sideTouchFor,
  sideTouchSetup,
} from '@/engine/cnc/registration/probe3d';
import { computeOutcome, edgeFrom, type ScanRecord, type RunData } from '@/engine/cnc/registration/outcome';

const BLANK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const G54 = { x: -181.55, y: -184.8 };
const { settings: S } = registrationSettings(null);

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    stock: BLANK,
    mount: 'vise',
    expectedSurface: { machineZ: SURFACE, from: 'the vise top and the blank’s proud height' },
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: 0.72,
    stockThicknessMm: 12,
    ...over,
  };
}

/** The house's 3D probe, once its tip has been measured (a 3 mm ball, 1.5 mm effective offset). */
const PROBE_3D: ProbeSpec = {
  id: 'fx-probe-3d',
  variant: '3d',
  instrument: 'xyz',
  tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 },
};

describe('#525 — the instrument comes from the accessory variant', () => {
  it('variant 3d is the sideways instrument; every other variant (and none) is the wired Z-only probe', () => {
    expect(probeInstrument('3d')).toBe('xyz');
    expect(probeInstrument('3D')).toBe('xyz');
    expect(probeInstrument('wired-touch')).toBe('z-only');
    expect(probeInstrument(null)).toBe('z-only');
    // A plan frozen before #525 carries no instrument; it was planned for the wired probe.
    expect(probeInstrumentOf(undefined)).toBe('z-only');
    expect(probeInstrumentOf({ instrument: 'xyz' })).toBe('xyz');
  });
});

describe('#525 — an unmeasured tip refuses the plan instead of assuming a radius', () => {
  it('refuses with the measuring sentence, naming the 3D probe', () => {
    const r = planRegistration(input({ probe: { ...PROBE_3D, tip: null } }), S);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("measure the 3D probe's tip first");
    expect(r.reason).toContain('Manage › Accessories');
  });

  it('a measured 3D probe plans, and the plan records the instrument and the tip', () => {
    const r = planRegistration(input({ probe: PROBE_3D }), S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.probe).toEqual(PROBE_3D);
  });

  it('no checked-out probe keeps planning exactly as before (the shop fallback)', () => {
    const r = planRegistration(input({ probe: null }), S);
    expect(r.ok).toBe(true);
  });
});

describe('#525 — the sideways touch’s geometry', () => {
  it('runs the ball’s centre one radius below a thick top, half the thickness below a thin one', () => {
    expect(sideTouchDepthMm(1.5, 12)).toBe(1.5); // equator on the wall
    expect(sideTouchDepthMm(1.5, 1.6)).toBe(0.8); // the ball meets the top corner instead
    expect(sideTouchDepthMm(1.5, 0.4)).toBe(0.3); // never above the stock's own thinness floor
  });

  it('the horizontal offset is the radius at the equator, and less when the ball meets the corner', () => {
    expect(ballOffsetMm(1.5, 1.5)).toBe(1.5);
    // sqrt(1.5² − 0.8²) = 1.2689…
    expect(ballOffsetMm(0.8, 1.5)).toBe(1.269);
    expect(ballOffsetMm(0.3, 1.5)).toBe(1.47);
  });

  it('starts at the plan’s outward limit and travels inward across the plan’s span at the touch feed', () => {
    const r = planRegistration(input({ probe: PROBE_3D }), S);
    if (!r.ok) throw new Error(r.reason);
    const left = r.plan.scans.find((s) => s.edge === 'left');
    expect(left).toBeDefined();
    const t = sideTouchFor(left!, S.touchFeed);
    // A left edge's outward is −X: it starts OUTSIDE (smaller X) and travels +X.
    expect(t.x).toBe(left!.limit);
    expect(t.y).toBe(left!.along);
    expect(t.travelMm).toBe(Math.abs(left!.limit - left!.start));
    expect(t.line).toBe(`G38.3 X${t.travelMm} F${S.touchFeed}`);

    const front = r.plan.scans.find((s) => s.edge === 'front')!;
    const f = sideTouchFor(front, S.touchFeed);
    expect(f.axis).toBe('y');
    expect(f.line).toBe(`G38.3 Y${f.travelMm} F${S.touchFeed}`);
  });

  it('places the move below the measured surface, and derives the ball’s centre in work coordinates', () => {
    const r = planRegistration(input({ probe: PROBE_3D }), S);
    if (!r.ok) throw new Error(r.reason);
    const front = r.plan.scans.find((s) => s.edge === 'front')!;
    // The vise's measured jaw top for the bench blank: 1.77 mm below the surface.
    const plan = { ...r.plan, mountDatum: { jawTopZ: SURFACE - 1.77, measuredAt: '2026-10-24T00:00:00.000Z', by: 'test' } };
    const setup = sideTouchSetup(front, plan, S, 1.5, SURFACE);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.zMachine).toBe(-57.672); // the surface 1.5 mm down — above the ledge, so the equator touches
    expect(setup.offsetMm).toBe(1.5);
    // The PRB is machine XYZ; the centre in work coordinates is the same subtraction every touch uses.
    expect(sideCentreWork({ x: G54.x + 3, y: G54.y + 7, z: SURFACE, touched: true }, 'x', G54)).toBe(3);
    expect(sideCentreWork({ x: G54.x + 3, y: G54.y + 7, z: SURFACE, touched: true }, 'y', G54)).toBe(7);
  });
});

describe('#525 — what the VISE allows sideways (the maintainer’s condition)', () => {
  const JAW_TOP = SURFACE - 1.77;

  function visePlan(surfaceZ: number, thickness: number) {
    const r = planRegistration(
      input({
        probe: PROBE_3D,
        stockThicknessMm: thickness,
        expectedSurface: { machineZ: surfaceZ, from: 'test' },
        fixtureBelowSurfaceMm: undefined,
        mountDatum: { jawTopZ: JAW_TOP, measuredAt: '2026-10-24T00:00:00.000Z', by: 'test' },
      }),
      S,
    );
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  }

  it('only the free front/back edges are side-probeable on a vise; the jaws block an X approach', () => {
    expect(sideTouchAllowed('vise', 'front')).toBe(true);
    expect(sideTouchAllowed('vise', 'back')).toBe(true);
    expect(sideTouchAllowed('vise', 'left')).toBe(false);
    expect(sideTouchAllowed('vise', 'right')).toBe(false);
    expect(sideTouchAllowed('bracket', 'left')).toBe(true);
    expect(sideTouchAllowed('tape', 'right')).toBe(true);
  });

  it('refuses a sideways touch on the fixed-jaw edge with the sentence that names why', () => {
    const plan = visePlan(SURFACE, 3.81);
    const left = plan.scans.find((s) => s.edge === 'left')!;
    const setup = sideTouchSetup(left, plan, S, 1.5, SURFACE);
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.reason).toContain('cannot reach the left edge on a vise');
    expect(setup.reason).toContain("frame's own datum");
  });

  it('the bench blank (3.81 thick, 1.77 proud): the ball runs one radius below the top, clear of the ledge', () => {
    const plan = visePlan(SURFACE, 3.81);
    const front = plan.scans.find((s) => s.edge === 'front')!;
    const setup = sideTouchSetup(front, plan, S, 1.5, SURFACE);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    // top − 1.5; the ledge (jawTop − 3.1) would only bind at top − 2.87, which is lower.
    expect(setup.zMachine).toBe(SURFACE - 1.5);
    expect(setup.depthMm).toBe(1.5);
    expect(setup.offsetMm).toBe(1.5);
  });

  it('a stock sitting deep in the jaws has no depth that is both below its top and above the ledge — refused', () => {
    // The stock's top 2.2 mm below the jaw tops (inside the planner's park clearance, so it plans):
    // holding the ball above the ledge puts it ABOVE the top.
    const plan = visePlan(JAW_TOP - 2.2, 1.6);
    const front = plan.scans.find((s) => s.edge === 'front')!;
    const setup = sideTouchSetup(front, plan, S, 1.5, JAW_TOP - 2.2);
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.reason).toContain('no sideways touch is possible');
    expect(setup.reason).toContain('too low in the jaws');
  });

  it('a vise touch without the measured jaw top refuses: the ledge height would be a guess', () => {
    const plan = visePlan(SURFACE, 3.81);
    const front = plan.scans.find((s) => s.edge === 'front')!;
    const setup = sideTouchSetup(front, { ...plan, mountDatum: null }, S, 1.5, SURFACE);
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.reason).toContain('needs the measured jaw top');
  });
});

describe('#525 — the edge a sideways reading yields', () => {
  const scan = {
    edge: 'left' as const,
    along: 20,
    expectedAt: 0,
    outward: -1 as const,
    start: 3,
    limit: -7,
    coarseStep: 1,
    fineStep: 0.05,
  };
  const record = (touch: ScanRecord['touches'][number]): ScanRecord => ({ scan, touches: [touch] });

  it('corrects the ball’s centre by its horizontal offset along the outward direction', () => {
    const found = edgeFrom(
      record({ at: 10, prb: { x: G54.x + 11.5, y: G54.y + 20, z: -57.672, touched: true }, kind: 'stock', sideContact: true, edgeOffsetMm: 1.27 }),
      1.5,
    );
    // Left edge: the wall is the centre plus the offset (toward −X).
    expect(found.foundAt).toBe(11.27);
    expect(found.problem).toBeNull();
  });

  it('a sideways miss is a sentence, not an edge', () => {
    const found = edgeFrom(
      record({ at: -7, prb: { x: G54.x - 7, y: G54.y + 20, z: -57.672, touched: false }, kind: 'miss', sideContact: true }),
      1.5,
    );
    expect(found.foundAt).toBeNull();
    expect(found.problem).toContain('the sideways touch on the left edge found nothing');
  });
});

// #525 (the second half) — CORNER FINDING: Studio's "Set Origin with 3D Probe" corner mode takes
// two sideways lines on each of the two edges that meet at a corner. Their intersection is the
// corner; the angle they make is the stock's rotation, and an out-of-square beyond the scan's
// resolution is STATED, never refused.
describe('#525 — corner finding: the plan', () => {
  const cornerPlan = (corner: 'front-left' | 'front-right' | 'back-left' | 'back-right' = 'front-left', over: Partial<PlanInput> = {}) => {
    const r = planRegistration(input({ mount: 'tape', probe: PROBE_3D, stockThicknessMm: 12, corner, ...over }), S);
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  };

  it('takes two lines on each edge that meets at the corner, at the ends of their usable spans', () => {
    const p = cornerPlan('front-left');
    expect(p.corner).toEqual({ id: 'front-left', xEdge: 'left', yEdge: 'front' });
    expect(p.scans).toHaveLength(4);
    expect(p.scans.filter((s) => s.edge === 'left').map((s) => s.along)).toEqual([5, 71.2]);
    expect(p.scans.filter((s) => s.edge === 'front').map((s) => s.along)).toEqual([5, 33.1]);
    expect(p.notes.join(' ')).toContain('corner mode');
  });

  it('names the corner’s own edges on every corner', () => {
    expect(cornerPlan('front-right').corner).toEqual({ id: 'front-right', xEdge: 'right', yEdge: 'front' });
    expect(cornerPlan('back-left').corner).toEqual({ id: 'back-left', xEdge: 'left', yEdge: 'back' });
    expect(cornerPlan('back-right').corner).toEqual({ id: 'back-right', xEdge: 'right', yEdge: 'back' });
  });

  it('refuses a corner the mount cannot give: the vise’s jaws, the bracket’s own origin', () => {
    const vise = planRegistration(input({ probe: PROBE_3D, corner: 'front-left' }), S);
    expect(vise.ok).toBe(false);
    if (!vise.ok) expect(vise.reason).toContain('jaws');
    const bracket = planRegistration(
      input({ mount: 'bracket', probe: PROBE_3D, bracketOrigin: { x: -181.55, y: -184.8, from: 'anchor1', offsetMeasured: true }, mountObstacles: [], corner: 'front-left' }),
      S,
    );
    expect(bracket.ok).toBe(false);
    if (!bracket.ok) expect(bracket.reason).toContain('bracket fixes X and Y');
  });

  it('refuses without the 3D probe — the wired probe cannot see the angle between two edges', () => {
    const r = planRegistration(input({ mount: 'tape', probe: null, stockThicknessMm: 12, corner: 'front-left' }), S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('needs the 3D probe');
  });

  it('refuses a disc — it has no corner to find', () => {
    const r = planRegistration(input({ mount: 'tape', probe: PROBE_3D, stockThicknessMm: 12, disc: { diameterMm: 30 }, corner: 'front-left' }), S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('disc has no corner');
  });
});

describe('#525 — corner finding: the measured corner', () => {
  const plan = (() => {
    const r = planRegistration(input({ mount: 'tape', probe: PROBE_3D, stockThicknessMm: 12, corner: 'front-left' }), S);
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  })();

  /** A side reading whose corrected edge lands at `foundAt` on the scan's own axis. */
  const scanAt = (edge: 'left' | 'front', along: number, foundAt: number): ScanRecord => {
    const rec = plan.scans.find((s) => s.edge === edge && s.along === along)!;
    // foundAt = at − outward × offset, so at = foundAt + outward × offset.
    const at = foundAt + rec.outward * 1.5;
    const prb = { x: rec.edge === 'left' ? at : along, y: rec.edge === 'left' ? along : at, z: SURFACE, touched: true };
    return { scan: rec, touches: [{ at, prb, kind: 'stock', sideContact: true, edgeOffsetMm: 1.5 }] };
  };
  const run = (scans: ScanRecord[]): RunData => ({
    probeRefZ: SURFACE,
    // sentFrom = surface − surfacePoint; a surface reading at the expected point keeps it zero.
    surface: { x: plan.surfacePoint.x, y: plan.surfacePoint.y, z: SURFACE, touched: true },
    scans,
  });

  it('intersects the two edges for the corner, and reads zero out-of-square when they are square', () => {
    const scans = [scanAt('left', 5, 1.2), scanAt('left', 71.2, 1.2), scanAt('front', 5, 0.8), scanAt('front', 33.1, 0.8)];
    const o = computeOutcome(plan, run(scans));
    expect(o.problems).toEqual([]);
    expect(o.corner).toMatchObject({ x: 1.2, y: 0.8, angleDeg: 90, outOfSquareDeg: 0, beyondResolution: false });
    // The origin is the corner: the offset from the expected corner, on both axes.
    expect(o.offset).toEqual({ x: 1.2, y: 0.8 });
    expect(o.notes.join(' ')).toContain('reads as square');
  });

  it('states an out-of-square beyond the scan’s resolution and never refuses it', () => {
    // The left edge leans 1° (Δx over the 66.2 mm baseline); the front edge leans the other way, so
    // the edges meet at about 92° — about twice what the 0.5 mm scan resolves over 28 mm.
    const lean = Math.tan((1 * Math.PI) / 180);
    const scans = [
      scanAt('left', 5, 1.2 - (66.2 / 2) * lean),
      scanAt('left', 71.2, 1.2 + (66.2 / 2) * lean),
      scanAt('front', 5, 0.8 + (28.1 / 2) * lean),
      scanAt('front', 33.1, 0.8 - (28.1 / 2) * lean),
    ];
    const o = computeOutcome(plan, run(scans));
    expect(o.problems).toEqual([]);
    expect(o.corner).toBeDefined();
    expect(o.corner!.outOfSquareDeg).toBeCloseTo(2, 0);
    expect(o.corner!.beyondResolution).toBe(true);
    expect(o.notes.join(' ')).toContain('out of square');
    expect(o.notes.join(' ')).toContain('the job is not refused');
    // The origin stays the measured intersection, not the mean of the edges' distances.
    expect(o.offset.x).not.toBeCloseTo(1.2, 6);
  });

  it('a missing second line is a problem that names the edge', () => {
    const scans = [scanAt('left', 5, 1.2), scanAt('front', 5, 0.8), scanAt('front', 33.1, 0.8)];
    const o = computeOutcome(plan, run(scans));
    expect(o.corner).toBeUndefined();
    expect(o.problems.join(' ')).toContain('two found lines on the left edge');
  });
});
