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
 *     stock's offset in the bracket; only the surface, unless Q10's OPTIONAL confirming touch is asked
 *     for (`bracketConfirm`, #427): one scan across the RIGHT edge and one across the BACK — the bracket's
 *     arms are on the left and the front, where a scan would land on the bracket — kept clear of the
 *     clamps. They confirm the stock is pushed into the corner; they never move the origin. While the
 *     bracket's offset from the anchor is a default, not measured, the confirming touch is REQUIRED.
 *     The plan carries the mount's obstacles (`mountObstacles`: the clamps and the arms, as the job
 *     places them): a top that reaches the travel height (machine Z −3) is refused, the surface point
 *     must be clear of them, and the operator confirms the clamps are where the plan puts them before
 *     anything moves sideways (`execute.ts`).
 *     Every XY move on the bracket is sent in MACHINE coordinates (`G53`), from the bracket's origin, so
 *     the touches land on the stock whatever G54 was left in force.
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
  /**
   * What the scan finds, in words, when it is not one of the stock's own edges — "the left wall of the
   * four holes" (#429). The finding's sentences use it; the stock's edge name otherwise.
   */
  label?: string;
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
  bracketOrigin?: BracketOrigin;
  /**
   * Bracket, REQUIRED (#427): the clamps and the bracket's arms as the job places them, work XY, each top
   * in work Z (above the stock's top) — `mounts/bracket.ts`'s `clampObstacles` / `bracketObstacles`.
   * An empty list says "no clamps", and the operator is asked to confirm that too.
   */
  mountObstacles?: PlanObstacle[];
  /**
   * Bracket: Q10's confirming touch (#427) — scans across the right and back edges, each line kept clear
   * of `mountObstacles`. Optional once the bracket's offset is measured; required until then.
   */
  bracketConfirm?: boolean;
}

/** The bracket's origin in machine XY, and whether its offset from the anchor was measured. */
export interface BracketOrigin {
  x: number;
  y: number;
  from: string;
  offsetMeasured: boolean;
}

export interface PlanObstacle {
  kind: 'clamp' | 'bracket';
  label: string;
  min: [number, number];
  max: [number, number];
  /** Its highest point, work Z (the stock's top is 0). */
  topZ: number;
}

export interface RegistrationPlan {
  mount: Mount;
  stock: ExpectedStock;
  surfacePoint: { x: number; y: number };
  /** The surface touch: from machine Z −3, at most this far down; and the band a reading must land in. */
  seek: { fromMachineZ: number; travelMm: number; band: { min: number; max: number } };
  scans: EdgeScan[];
  bracketOrigin: BracketOrigin | null;
  /** Bracket: what stands above the stock, as the operator must confirm it (#427). Empty elsewhere. */
  mountObstacles: PlanObstacle[];
  settings: RegistrationSettings;
  notes: string[];
  /**
   * #429 — a plan that registers on FEATURES cut in an earlier setup: each one's expected centre and
   * which of `scans` read its walls. Present only on such a plan; its outcome is `referenceOutcome`.
   */
  references?: ReferenceEntry[];
  /** #429 — the pair the turn is read between, how far apart, and to what resolution across the stock. */
  referenceRotation?: { between: [string, string]; separation: number; resolutionMm: number } | null;
}

export interface ReferenceEntry {
  itemId: string;
  name: string;
  /** Its expected centre, work XY. */
  centre: { x: number; y: number };
  /** Its expected size across X and Y, mm — what the measured wall separation is checked against. */
  size: { x: number; y: number };
  /** Indices into `scans`: the walls read on each axis (one or two each). */
  xScans: number[];
  yScans: number[];
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
  let mountObstacles: PlanObstacle[] = [];
  if (mount === 'bracket') {
    if (!input.bracketOrigin) return { ok: false, reason: 'the bracket mount needs the origin from the machine’s anchor' };
    if (!input.mountObstacles) {
      return { ok: false, reason: 'the bracket mount needs where the clamps and the bracket’s arms are — the probe travels beside them' };
    }
    bracketOrigin = input.bracketOrigin;
    mountObstacles = input.mountObstacles;
    // Every top must sit below the travel height, with the surface's own tolerance to spare.
    for (const o of mountObstacles) {
      const topMachine = r3(exp + o.topZ);
      if (topMachine >= SEEK_FROM_MACHINE_Z - s.surfaceToleranceMm) {
        return {
          ok: false,
          reason: `${o.label} stands to machine Z ${topMachine}, up to the probe's travel height (machine Z ${SEEK_FROM_MACHINE_Z}): the probe would be driven into it — use lower clamps or thinner stock`,
        };
      }
    }
    // The surface point must not be under (or beside) anything standing above the stock.
    const grow = s.tipRadiusMm + s.cornerClearanceMm;
    const under = mountObstacles.find(
      (o) => surfacePoint.x > o.min[0] - grow && surfacePoint.x < o.max[0] + grow && surfacePoint.y > o.min[1] - grow && surfacePoint.y < o.max[1] + grow,
    );
    if (under) return { ok: false, reason: `the surface touch point is at ${under.label}: move the clamp, or touch the stock somewhere clear of it` };
    if (!input.bracketConfirm && !input.bracketOrigin.offsetMeasured) {
      return {
        ok: false,
        reason: 'the bracket’s offset from the anchor is a default, not measured: the confirming touch is required until it is measured',
      };
    }
    if (!input.bracketConfirm) {
      notes.push(`the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; only the surface is touched`);
    } else {
      const ys = span(stock.yMin, stock.yMax, 'right');
      if (typeof ys === 'string') return { ok: false, reason: ys };
      const xs = span(stock.xMin, stock.xMax, 'back');
      if (typeof xs === 'string') return { ok: false, reason: xs };
      // A line clear of every clamp and arm, grown by the probe's rim and the corner clearance.
      const clearLine = (edge: 'right' | 'back', lo: number, hi: number): number | null => {
        const scan = scanFor(edge, (lo + hi) / 2, stock, s);
        const [a, b] = [Math.min(scan.start, scan.limit), Math.max(scan.start, scan.limit)];
        const mid = (lo + hi) / 2;
        const candidates = Array.from({ length: 9 }, (_, i) => lo + ((hi - lo) * i) / 8).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
        for (const c of [mid, ...candidates]) {
          const hits = mountObstacles.some((r) => {
            const [across, along] = edge === 'right' ? ([0, 1] as const) : ([1, 0] as const);
            return r.max[across] + grow > a && r.min[across] - grow < b && c > r.min[along] - grow && c < r.max[along] + grow;
          });
          if (!hits) return r3(c);
        }
        return null;
      };
      const yRight = clearLine('right', ys.lo, ys.hi);
      const xBack = clearLine('back', xs.lo, xs.hi);
      if (yRight === null || xBack === null) {
        return {
          ok: false,
          reason: `no line across the ${yRight === null ? 'right' : 'back'} edge stays clear of the clamps: move a clamp, or register without the confirming touch`,
        };
      }
      scans.push(scanFor('right', yRight, stock, s), scanFor('back', xBack, stock, s));
      notes.push(
        `the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; the right and back edges are scanned only to confirm the stock is pushed into the corner (they carry its size error too), and never move the origin`,
      );
    }
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
      mountObstacles,
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
