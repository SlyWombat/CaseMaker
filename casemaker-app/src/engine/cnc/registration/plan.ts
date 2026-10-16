/**
 * The registration planner (#430 phase 1): where the stock is, found with the wired probe's Z-only
 * touches, as the 2026-10-15 bench found it (`docs/bench/traces/2026-10-15-console.log`).
 *
 * WHAT THE PLAN IS. The surface touch at a clean point — the centre of the CUT AREA (§5.9), else the
 * stock's — then one EDGE SCAN per edge the mount leaves to be found. A scan is a line across one
 * edge: it starts `scanInsideMm` inside where the job expects the edge and steps OUTWARD — coarse
 * until one coarse step short of the expected edge, then fine — and STOPS at the first touch off the
 * stock ({@link scanPositions}). The executor then refines that last gap with one touch INWARD of the
 * miss, never further out (`execute.ts`).
 *
 * THE SURFACE TOUCH IS BOUNDED (#430 review). The job says where it expects the stock's top (machine
 * Z — from the stock's thickness, the mount and G54 Z); the seek travels only to that surface −
 * `surfaceToleranceMm`, and a reading outside expected ± tolerance is refused. One unchecked touch
 * would otherwise set the surface, the park height and every cap after it.
 *
 * WHICH EDGES, BY MOUNT (§5.9's table):
 *   - bracket — XY is the anchor bracket's (machine-known): the work origin comes from anchor1 and the
 *     stock's offset in the bracket; no scan, only the surface.
 *   - vise — the left edge (a confirm against the fixed jaw) and the front edge (Y — Appendix C). The
 *     jaw tops must sit clear BELOW the park height and below the surface band, or a scan could not
 *     tell a jaw from the stock — or would move sideways into one.
 *   - tape — the left edge at TWO points (position and rotation) and the front edge.
 *
 * THE CORNERS ARE ROUNDED. A scan line is kept `cornerRadius + cornerClearanceMm` from both corners of
 * its edge, because a touch on the roll-off reads lower than the top and would look like the edge.
 *
 * Pure: work coordinates in, a plan out. No machine, no store.
 */

import { settingsProblem, type RegistrationSettings } from './settings';

export type Mount = 'vise' | 'bracket' | 'tape';

/** The stock as the job expects it, in WORK XY (mm). */
export interface ExpectedStock {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  /** The radius of its rounded corners (a printed blank's), 0 for sharp ones. */
  cornerRadius: number;
}

export type Edge = 'left' | 'right' | 'front' | 'back';

export interface EdgeScan {
  edge: Edge;
  along: number;
  expectedAt: number;
  outward: 1 | -1;
  start: number;
  limit: number;
  coarseStep: number;
  fineStep: number;
}

export interface PlanInput {
  stock: ExpectedStock;
  mount: Mount;
  /**
   * REQUIRED, and the CALLER's to supply: where the job expects the stock's top, in MACHINE Z, and what
   * that is from — the stock's thickness on the mount's known top (the vise's jaw top − proud, the
   * wasteboard + thickness). **Not G54 Z**: G54 Z is the CUTTER's zero (#387 — `G10 L2` writes it with
   * the cutter fitted, and it carries that tool's length), so it is not where a probe will touch the
   * stock, and using it would offset the whole seek band by the difference between the two tools.
   */
  expectedSurface: { machineZ: number; from: string };
  /** The centre of the cut area, work XY — the clean point the surface is touched at. Default: the stock's centre. */
  cutCentre?: { x: number; y: number };
  /** Vise: how far the jaw tops sit BELOW the stock's top (the stock's proud height), mm. */
  fixtureBelowSurfaceMm?: number;
  /** Bracket: the work origin in MACHINE XY, from anchor1 and the stock's offset in the bracket. */
  bracketOrigin?: { x: number; y: number; from: string };
}

export interface RegistrationPlan {
  mount: Mount;
  stock: ExpectedStock;
  surfacePoint: { x: number; y: number };
  /** The surface touch: from machine Z −3, at most this far down; and the band a reading must land in. */
  seek: { fromMachineZ: number; travelMm: number; band: { min: number; max: number } };
  scans: EdgeScan[];
  bracketOrigin: { x: number; y: number; from: string } | null;
  settings: RegistrationSettings;
  notes: string[];
}

export type PlanResult = { ok: true; plan: RegistrationPlan } | { ok: false; reason: string };

/** Where the probe starts the surface seek: high, at machine Z −3, as every bench run did. */
export const SEEK_FROM_MACHINE_Z = -3;

function scanFor(edge: Edge, along: number, stock: ExpectedStock, s: RegistrationSettings): EdgeScan {
  const outward: 1 | -1 = edge === 'right' || edge === 'back' ? 1 : -1;
  const expectedAt = edge === 'left' ? stock.xMin : edge === 'right' ? stock.xMax : edge === 'front' ? stock.yMin : stock.yMax;
  return {
    edge,
    along,
    expectedAt,
    outward,
    start: expectedAt - outward * s.scanInsideMm,
    limit: expectedAt + outward * s.scanReachMm,
    coarseStep: s.coarseStepMm,
    fineStep: s.fineStepMm,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function planRegistration(input: PlanInput, s: RegistrationSettings): PlanResult {
  const { stock, mount } = input;
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: bad };
  const width = stock.xMax - stock.xMin;
  const depth = stock.yMax - stock.yMin;
  if (!(width > 0 && depth > 0) || !(stock.cornerRadius >= 0)) {
    return { ok: false, reason: 'the stock has no size to register' };
  }
  if (s.scanInsideMm * 2 >= Math.min(width, depth)) {
    return { ok: false, reason: `the stock is too small for a scan that starts ${s.scanInsideMm} mm inside its edges` };
  }

  // The surface seek: bounded to the expected surface ± tolerance.
  const exp = input.expectedSurface.machineZ;
  if (!Number.isFinite(exp)) return { ok: false, reason: 'the job does not say where it expects the stock’s top' };
  const band = { min: r3(exp - s.surfaceToleranceMm), max: r3(exp + s.surfaceToleranceMm) };
  if (band.max + s.parkAboveSurfaceMm > SEEK_FROM_MACHINE_Z) {
    return { ok: false, reason: `the stock's top is expected at machine Z ${exp}: too high to park ${s.parkAboveSurfaceMm} mm above it` };
  }
  const travel = r3(SEEK_FROM_MACHINE_Z - band.min);
  if (travel > s.surfaceSeekMm) {
    return {
      ok: false,
      reason: `the stock's top is expected ${r3(SEEK_FROM_MACHINE_Z - exp)} mm below the start, more than the ${s.surfaceSeekMm} mm the surface touch may travel`,
    };
  }

  const surfacePoint = input.cutCentre ?? { x: (stock.xMin + stock.xMax) / 2, y: (stock.yMin + stock.yMax) / 2 };
  const inset = Math.max(1, stock.cornerRadius);
  if (
    surfacePoint.x < stock.xMin + inset ||
    surfacePoint.x > stock.xMax - inset ||
    surfacePoint.y < stock.yMin + inset ||
    surfacePoint.y > stock.yMax - inset
  ) {
    return { ok: false, reason: 'the surface point is not well inside the stock' };
  }

  const notes: string[] = [];
  const keepOff = stock.cornerRadius + s.cornerClearanceMm;
  const span = (lo: number, hi: number, name: string): { lo: number; hi: number } | string =>
    hi - lo > 2 * keepOff
      ? { lo: lo + keepOff, hi: hi - keepOff }
      : `the ${name} edge is ${r3(hi - lo)} mm long — too short to keep a scan ${keepOff} mm clear of its rounded corners`;

  const scans: EdgeScan[] = [];
  const midY = (stock.yMin + stock.yMax) / 2;
  const midX = (stock.xMin + stock.xMax) / 2;
  let bracketOrigin: RegistrationPlan['bracketOrigin'] = null;
  if (mount === 'bracket') {
    if (!input.bracketOrigin) return { ok: false, reason: 'the bracket mount needs the origin from the machine’s anchor' };
    bracketOrigin = input.bracketOrigin;
    notes.push(`the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; only the surface is touched`);
  } else {
    if (mount === 'vise') {
      const proud = input.fixtureBelowSurfaceMm;
      if (proud === undefined || !Number.isFinite(proud)) {
        return { ok: false, reason: 'the vise mount needs how far the jaw tops sit below the stock’s top' };
      }
      // A jaw within the surface band reads as the stock: the scan could not see the edge.
      if (proud <= s.surfaceBandMm) {
        return { ok: false, reason: `the jaw tops sit only ${proud} mm below the stock — within the ${s.surfaceBandMm} mm surface band, so a jaw touch would read as the stock` };
      }
      // A surface seek that misses the stock must not land on a jaw and call it the stock.
      if (s.surfaceToleranceMm >= proud) {
        return { ok: false, reason: `the surface tolerance (${s.surfaceToleranceMm} mm) reaches the jaw tops ${proud} mm below the stock — a seek onto a jaw would read as the surface` };
      }
      notes.push('the fixed jaw fixes X and rotation: the left-edge scan confirms it, the front-edge scan finds Y');
    }
    const ys = span(stock.yMin, stock.yMax, 'left');
    if (typeof ys === 'string') return { ok: false, reason: ys };
    const xs = span(stock.xMin, stock.xMax, 'front');
    if (typeof xs === 'string') return { ok: false, reason: xs };
    if (mount === 'tape') scans.push(scanFor('left', ys.lo, stock, s), scanFor('left', ys.hi, stock, s));
    else scans.push(scanFor('left', midY, stock, s));
    scans.push(scanFor('front', midX, stock, s));
  }

  notes.push(
    `the surface is expected at machine Z ${exp} (${input.expectedSurface.from}); a reading outside ${band.min} to ${band.max} stops the run`,
    `every touch stops at the surface − ${s.capBelowSurfaceMm} mm: a touch that finds nothing by then is a miss, not a dive`,
    `the probe reads the stock until its centre is ${s.tipRadiusMm} mm past the edge (the measured effective rim offset); the edges are corrected by it`,
  );
  return {
    ok: true,
    plan: {
      mount,
      stock,
      surfacePoint,
      seek: { fromMachineZ: SEEK_FROM_MACHINE_Z, travelMm: travel, band },
      scans,
      bracketOrigin,
      settings: s,
      notes,
    },
  };
}

/**
 * The positions a scan touches, in order, as the bench stepped them on 2026-10-15: COARSE from the
 * start until one coarse step short of the expected edge, then FINE from there out to the limit. The
 * executor stops at the first touch off the stock.
 */
export function scanPositions(scan: EdgeScan): number[] {
  const out: number[] = [];
  const r = (p: number) => Math.round(p * 1000) / 1000;
  const fineFrom = scan.expectedAt - scan.outward * scan.coarseStep;
  let p = scan.start;
  for (; scan.outward * (fineFrom - p) > 1e-9; p += scan.outward * scan.coarseStep) out.push(r(p));
  for (p = out.length > 0 ? fineFrom : scan.start; scan.outward * (scan.limit - p) >= -1e-9; p += scan.outward * scan.fineStep) {
    out.push(r(p));
  }
  return out;
}
