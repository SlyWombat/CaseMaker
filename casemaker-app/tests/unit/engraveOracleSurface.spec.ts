// The surface-frame oracle (#623, the 2026-10-24 bench failure).
//
// #608's "Re-post against the measured tilt" lifts every FEED move by the fitted plane's lift at
// its XY. The simulation used to cut that file into a FLAT stock and the oracle compared it with
// the flat prediction at flat levels, so a CORRECT tilt-following post read as a 301 mm² under-cut
// over the whole 26 × 67 mm pattern and Upload stayed disabled. The frame is the defect; the file
// was right.
//
// What this file pins, on both engines the engrave run can sweep:
//
//   * a job with a known tilt gives the SAME verdict flat and lifted — the lifted program, loaded
//     with the frame it was posted against, reproduces the flat post's numbers rather than the
//     whole-pattern under-cut;
//   * the frame is RECORDED: `OracleReport.frame` says which frame judged it, and the package
//     carries the surface it was posted against (`EngraveGenerated.surface`);
//   * the control that proves the test has teeth — the SAME lifted text judged in the work frame
//     still fails, exactly as the bench saw. Without this, a change that quietly stopped lifting
//     feeds would pass every assertion above.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { maxSurfaceLift, type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import { ORACLE_AREA_FLOOR, type OracleReport } from '@/engine/cnc/engrave/oracle';
import { oracleSentence, uploadBlocker, type EngraveRunView } from '@/store/engraveRunGate';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { Z1 } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';

/** The bench class of bit: a 30° engraver with a 0.3 mm flat, swept by the COLUMN engine. */
const bit30 = (): Tool => ({
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.3',
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

/** A 30 mm straight V trace along +X at y = 20, 1 mm deep — the groove oracle's own job shape. */
function line(over: Partial<EngraveTraceItem> = {}): EngraveTraceItem {
  return {
    kind: 'line',
    id: 'tr',
    position: { x: 0, y: 0 },
    rotation: 0,
    points: [
      [10, 20],
      [40, 20],
    ],
    closed: false,
    depth: 1,
    enabled: true,
    ...over,
  } as EngraveTraceItem;
}

/** A plain 60 × 60 × 12 PLA blank with one V-bit trace as its only item. */
function traceJob(trace: EngraveTraceItem = line()): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'surface frame oracle',
    stock: { length: 60, width: 60, thickness: 12, material: 'pla' },
    labels: [],
    shapes: [],
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
    minFloor: 1,
    edgeMargin: 1,
    traces: [trace],
  };
}

/**
 * The measured tilt, in the readings' frame: 0.36 mm of lift across the blank's X and 0.24 mm across
 * its Y — the bench's 0.336/0.354 mm tilt class, both positive so the stock seat is exercised too.
 * `z0 = 0`: the reference touch is the plane at the origin, which is what Z0 being the LOWEST touch
 * means for a plane rising toward +X/+Y.
 */
const TILT: SurfaceFrame = { plane: { offset: 0, slopeX: 0.006, slopeY: 0.004 }, z0: 0 };

/**
 * A gentler tilt for the FLAT-REGION job on the default 100 × 60 blank. `postZ1` still refuses a
 * FEED above the work Z0 ("a cut in the air") and knows nothing about the fitted plane — a lift
 * that exceeds the shallowest floor refuses at the POST, before the oracle is ever asked. That
 * flat-top assumption in the post is #608's own gap and is filed separately from this issue; here
 * the tilt is chosen to reach the oracle, which is what #623 is about.
 */
const TILT_SMALL: SurfaceFrame = { plane: { offset: 0, slopeX: 0.002, slopeY: 0.0015 }, z0: 0 };

/** A plain 20 × 10 × 1 pocket on the default blank — flat regions, swept by the EXACT engine. */
function pocketJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'surface frame pocket',
    labels: [],
    shapes: [
      {
        id: 'r',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1,
        enabled: true,
        width: 20,
        height: 10,
        cornerRadius: 0,
      },
    ],
    toolKey: 'flat-1.0',
  };
}

function load(job: EngraveJob, nc: string, tool: Tool, surface: SurfaceFrame | null = null): SimSession {
  const session = createSimSession(tl);
  const r = session.load(nc, toSetup(job, Z1), tool, Z1.id, surface === null ? undefined : { surface });
  if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
  return session;
}

/** Generate flat, generate against the tilt, judge both — the package, the sweep and the verdict. */
function verdicts(job: EngraveJob, tilt: SurfaceFrame = TILT): {
  flatGen: EngraveGenerated;
  liftGen: EngraveGenerated;
  flat: OracleReport;
  lifted: OracleReport;
  blind: OracleReport;
} {
  const tool = jobTool(job)!;
  const flatGen = generate(tl, job);
  const liftGen = generate(tl, job, null, [], undefined, { surface: tilt });
  if (flatGen.nc === null || liftGen.nc === null) {
    const why = (g: EngraveGenerated): string => `${g.stage}: ${g.errors.map((e) => e.message).join('; ')}`;
    throw new Error(`generate refused — flat ${why(flatGen)} | lifted ${why(liftGen)}`);
  }
  expect(flatGen.surface ?? null).toBeNull();
  expect(liftGen.surface).toEqual(tilt);
  // The lift really is in the text: a package that says it followed the tilt must have done it.
  expect(liftGen.nc).not.toBe(flatGen.nc);

  const flatSession = load(job, flatGen.nc, tool);
  const liftSession = load(job, liftGen.nc, tool, tilt);
  // The control: the SAME lifted text judged in the work frame — the bench's failure.
  const blindSession = load(job, liftGen.nc, tool);
  try {
    return {
      flatGen,
      liftGen,
      flat: flatSession.oracle(flatGen.predicted),
      lifted: liftSession.oracle(liftGen.predicted),
      blind: blindSession.oracle(liftGen.predicted),
    };
  } finally {
    flatSession.dispose();
    liftSession.dispose();
    blindSession.dispose();
  }
}

function expectSameVerdict(flat: OracleReport, lifted: OracleReport): void {
  expect(flat.frame).toBe('work');
  expect(lifted.frame).toBe('surface');
  // The acceptance: the SAME R, not "the whole area". The residual difference is float32 heights
  // and — on the column engine — a grid padded by the seat (a cone's reach grows with the stock
  // top, so one cell width of staircase can land differently). That is bounded by the report's own
  // area floor, which is the smallest disagreement its resolution can represent; the bench's
  // flat-frame comparison read 301 mm² over the whole pattern, four orders of magnitude past it.
  expect(lifted.ok).toBe(flat.ok);
  expect(lifted.ok).toBe(true);
  const floor = lifted.areaFloor ?? ORACLE_AREA_FLOOR;
  expect(Math.abs(lifted.worst.underCut - flat.worst.underCut)).toBeLessThanOrEqual(floor);
  expect(Math.abs(lifted.worst.overCut - flat.worst.overCut)).toBeLessThanOrEqual(floor);
}

describe('the surface-frame oracle (#623)', () => {
  it('judges a lifted V-trace post exactly as the flat one — same numbers, surface frame', () => {
    const job = traceJob();
    const { flat, lifted, blind } = verdicts(job);

    // Both posts pass, and a groove job's shallow level is the one the seat exists for: with the
    // stock left flat, the mouth's outer flank is cut out of air the flat stock does not have.
    expect(flat.ok).toBe(true);
    expectSameVerdict(flat, lifted);
    expect(lifted.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

    // The control: the verifier run the bench saw — the same bytes, the FLAT frame, the whole
    // groove's flank read as material the file did not remove.
    expect(blind.frame).toBe('work');
    expect(blind.ok).toBe(false);
    expect(blind.worst.underCut).toBeGreaterThan(1);
  });

  it('seats the swept stock on the plane, so a shallow level is cut through real material', () => {
    const job = traceJob();
    const tool = jobTool(job)!;
    const liftGen = generate(tl, job, null, [], undefined, { surface: TILT });
    if (liftGen.nc === null) throw new Error('generate refused');

    const flat = createSimSession(tl);
    const flatLoad = flat.load(liftGen.nc, toSetup(job, Z1), tool, Z1.id);
    expect(flatLoad.ok).toBe(true);
    expect(flatLoad.ok && flatLoad.stockTopZ).toBe(0); // the unseated stock top

    const seated = createSimSession(tl);
    const seatedLoad = seated.load(liftGen.nc, toSetup(job, Z1), tool, Z1.id, { surface: TILT });
    expect(seatedLoad.ok).toBe(true);
    // Lifted by the plane's highest point over the blank: 0.006 × 60 + 0.004 × 60 = 0.6 mm.
    expect(seatedLoad.ok && seatedLoad.stockTopZ).toBeCloseTo(0.6, 6);
    flat.dispose();
    seated.dispose();
  });

  it('judges a lifted FLAT-REGION post exactly as the flat one — the exact sweeper, sheared', () => {
    // A pocket on a flat end mill stays on the EXACT sweeper when lifted (its run count is well
    // under the 2.5D cap), so this is the shear's own case: the removal is a union of 2.5D tool
    // columns, and a shear of it is the surface-frame removal — the numbers agree to ~1e-6 mm².
    const { flat, lifted, blind } = verdicts(pocketJob(), TILT_SMALL);

    expect(flat.ok).toBe(true);
    expectSameVerdict(flat, lifted);
    expect(blind.ok).toBe(false);
    expect(blind.worst.underCut).toBeGreaterThan(1);
  });

  it('reports the frame on the run view: Upload enables, and the row says which frame judged it', () => {
    const job = traceJob();
    const { flatGen, liftGen, flat, lifted } = verdicts(job);
    const view = (generated: EngraveGenerated, oracle: OracleReport): EngraveRunView => ({
      generated,
      oracle,
      simDiagnostics: [],
      simStatus: 'ready',
      phase: oracle.ok ? 'ready' : 'blocked',
      acknowledged: true,
      staleSince: null,
      error: null,
    });
    // Both frames enable Upload on a package that matches — the tilt is not a blocker by itself.
    expect(uploadBlocker(view(flatGen, flat))).toBeNull();
    expect(uploadBlocker(view(liftGen, lifted))).toBeNull();
    expect(oracleSentence(view(flatGen, flat))).not.toContain('surface frame');
    expect(oracleSentence(view(liftGen, lifted))).toContain("in the blank's fitted surface frame");
  });
});

describe('maxSurfaceLift (#623)', () => {
  it('is the plane lift at the rectangle’s highest corner, never below zero', () => {
    const rect = { x0: 0, y0: 0, x1: 60, y1: 40 };
    expect(maxSurfaceLift(TILT, rect)).toBeCloseTo(0.006 * 60 + 0.004 * 40, 9);
    // A plane that DROPS toward +X/+Y: the maximum is at the origin, and a corner below the
    // reference never turns into negative seating.
    const down: SurfaceFrame = { plane: { offset: 0, slopeX: -0.01, slopeY: -0.01 }, z0: 0 };
    expect(maxSurfaceLift(down, rect)).toBe(0);
    // A flat fit asks for no seat at all.
    expect(maxSurfaceLift({ plane: { offset: 0, slopeX: 0, slopeY: 0 }, z0: 0 }, rect)).toBe(0);
  });
});
