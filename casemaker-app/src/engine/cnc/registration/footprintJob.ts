/**
 * #1070 — A BED-HELD JOB'S FOOTPRINT PLAN, from the JOB (the Cut step's side of the seam).
 *
 * `registration/footprint.ts` plans the touches from plain numbers; this module derives those
 * numbers from the document the operator is holding:
 *
 *   - the CUT REGION: the goal mesh's placed footprint when the job cuts a goal (the tray), else
 *     the union of the item pipeline's cut extents (`surfaceSpreadPlan`, the same statement the
 *     sheet's surface band runs on);
 *   - the MARGIN: the job's own `edgeMargin`;
 *   - the SEED: the machine's anchor-1 bracket datum (`bracketDatum(anchorFrom(calibration))`) —
 *     the anchor places the machine coordinates, the touches derive the origin;
 *   - the SURFACE: the bracket's expected seat (`bracketExpectedSurface`);
 *   - the SOFT LIMITS: the machine's soft endstop when they are enabled and read;
 *   - the probe, scan settings and obstacles: the shop defaults, the checked-out probe, and the
 *     job's own clamps and bracket arms.
 *
 * PURE. No store, no machine: the same call from the Cut step, the Design → Setups row and the run
 * sheet, so all three read one plan.
 */

import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, headEnvelopeOf } from '@/engine/cnc/machine';
import { anchorFrom, bracketDatum, bracketExpectedSurface, bracketObstacles, bracketSettings, bracketTapPoint, clampObstacles, defaultClampPlacements, type BracketSeatDatum } from '@/engine/cnc/mounts/bracket';
import { clampPlacementsFor } from '@/engine/cnc/engrave/jobSetup';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { rotatedExtents, targetTurns } from '@/engine/cnc/engrave/targetScale';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { surfaceSpreadPlan } from '@/engine/cnc/engrave/surfaceSpread';
import type { PlanObstacle, ProbeSpec } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { planFootprintRegistration, type FootprintBox, type FootprintInput, type FootprintPlan, type FootprintScanSettings } from '@/engine/cnc/registration/footprint';
import { jobMount } from '@/engine/cnc/engrave/jobSetup';
import type { MountSpec } from '@/engine/cnc/setups';
import type { ShopDefaults } from '@/platform/defaultsClient';

/** The stock the app models is a rectangular prism: its corners are square (decision 28). */
const STOCK_CORNER_RADIUS_MM = 0;

/** The goal's placed footprint in the work frame, or null when the job has no enabled goal. */
function goalRegion(job: EngraveJob): FootprintBox | null {
  const targets = job.targetObjects ?? (job.targetObject === undefined ? [] : [job.targetObject]);
  const goal: EngraveTargetObject | undefined = targets.find(
    (t) => (t.role ?? 'reference') === 'goal' && t.enabled,
  );
  if (goal === undefined) return null;
  let mesh;
  try {
    mesh = targetObjectMesh(goal);
  } catch {
    return null; // the mesh's own load refusal is the row's finding, not this module's
  }
  if (mesh.triangleCount === 0) return null;
  const placed = placeTarget(goal, mesh);
  const turned = rotatedExtents(placed.size, targetTurns(goal));
  return {
    minX: goal.position.x - turned.x / 2,
    maxX: goal.position.x + turned.x / 2,
    minY: goal.position.y - turned.y / 2,
    maxY: goal.position.y + turned.y / 2,
  };
}

/** The union of the item pipeline's cut extents, or null when the job cuts nothing it can measure. */
function itemRegion(job: EngraveJob): FootprintBox | null {
  const spread = surfaceSpreadPlan(job);
  if (spread === null || spread.regions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of spread.regions) {
    minX = Math.min(minX, r.extent.minX);
    minY = Math.min(minY, r.extent.minY);
    maxX = Math.max(maxX, r.extent.maxX);
    maxY = Math.max(maxY, r.extent.maxY);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Where this job's cut will land, work XY: the goal's footprint, else the items' extents. */
export function cutRegionOf(job: EngraveJob): FootprintBox | null {
  return goalRegion(job) ?? itemRegion(job);
}

export interface FootprintJobArgs {
  job: EngraveJob;
  mount: MountSpec;
  calibration: MachineCalibration | undefined;
  defaults: ShopDefaults | null;
  probe: ProbeSpec | null;
  /** What stands above the stock, as the job places it (the Cut step's plan carries these). */
  mountObstacles?: readonly PlanObstacle[];
  /** #509 — the active bed profile's seat beside the bracket. */
  bracketSeat: BracketSeatDatum | null;
  /** #1070 (C8) — the active bed profile's placement seed for a placed bracket (see registrationAttempt). */
  placedSeed?: { x: number; y: number; by: 'grid' | 'touch'; measuredAt: string; at: [number, number] | null; probe: string | null } | null;
  /**
   * #1082 — WHICH SETUP'S STOCK THIS REGISTRATION IS ON. The vendor flip's side 2 is the freed
   * part; a caller that knows the setup passes its index, and the dims/seat read that box. Absent
   * = the job's blank, exactly as every pre-#1082 caller.
   */
  setupIndex?: number;
}

export type FootprintJobResult = { ok: true; input: FootprintInput } | { ok: false; reason: string };

/** What stands above the stock, as the JOB places it — the same boxes the sweep reads. */
export function mountObstaclesFor(job: EngraveJob, mount: MountSpec, sizes: ReturnType<typeof bracketSettings>): PlanObstacle[] {
  const stock = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const placements = clampPlacementsFor(job) ?? defaultClampPlacements(stock, sizes.settings);
  const under = mount.kind === 'bracket' && mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
  return [
    ...clampObstacles(stock, placements, sizes.settings),
    ...bracketObstacles(stock, sizes.settings, under),
  ].map((o) => ({ kind: o.kind, label: o.label, min: o.min, max: o.max, topZ: o.topZ }));
}

/** The footprint plan's numbers, read off the job and the machine. */
export function footprintInputFor(args: FootprintJobArgs): FootprintJobResult {
  const { job, calibration, defaults } = args;
  if (job.stock.shape === 'disc') {
    return { ok: false, reason: 'a disc’s rim registration has not been run on this machine yet — use a rectangular blank' };
  }
  const region = cutRegionOf(job);
  if (region === null) {
    return { ok: false, reason: 'this job states no cut region to register on — add the part to cut, or register by hand' };
  }
  const sizes = bracketSettings(defaults);
  // #1070 (C8) — the seed is the ANCHOR for an anchored bracket and the BED PROFILE'S PLACEMENT
  // for a placed one (the same rule the Cut step plans by; one seam, no second derivation). A
  // placed job whose profile states no position cannot be seeded.
  const placed = job.workholding.kind === 'bracket' && (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement === 'placed';
  let datum: { x: number; y: number; from: string; offsetMeasured: boolean };
  if (placed) {
    const seed = args.placedSeed ?? null;
    if (seed === null) {
      return {
        ok: false,
        reason:
          'this bracket is screwed down where you put it, and the active bed profile does not state where — ' +
          'measure the bracket’s position into the bed profile’s placement (its five holes on the bed’s hole grid, or one confirmed touch), or put it on the anchor-1 pins',
      };
    }
    datum = {
      x: seed.x,
      y: seed.y,
      from: seed.by === 'grid' ? 'the bed’s hole grid at the bracket’s five holes — the one position the grid admits' : 'the position measured and confirmed in the bed profile’s placement',
      offsetMeasured: seed.by === 'touch',
    };
  } else {
    const anchor = anchorFrom(calibration, job.machineId);
    if (!anchor.ok) return { ok: false, reason: anchor.reason };
    datum = bracketDatum(anchor.anchor, sizes);
  }
  // The expected surface is the bracket's seat: the surface beside the mount, measured once.
  // #1082 — the box this registration stands on: the setup's own stock, else the job's blank.
  const own = stockForSetup(job, args.setupIndex);
  const dims = { x: own.length, y: own.width, z: own.thickness };
  const under = args.mount.kind === 'bracket' && args.mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
  const expected = bracketExpectedSurface(defaults, dims.z, under, args.bracketSeat);
  if (!expected.ok) return { ok: false, reason: expected.reason };

  const settings = registrationSettings(defaults, args.probe).settings;
  const scanSettings: FootprintScanSettings = {
    scanInsideMm: settings.scanInsideMm,
    scanReachMm: settings.scanReachMm,
    coarseStepMm: settings.coarseStepMm,
    fineStepMm: settings.fineStepMm,
    cornerClearanceMm: settings.cornerClearanceMm,
    parkAboveSurfaceMm: settings.parkAboveSurfaceMm,
    surfaceToleranceMm: settings.surfaceToleranceMm,
  };
  const endstop = calibration === undefined ? null : calibration.softEndstop;
  const softLimits =
    endstop !== undefined && endstop !== null && endstop.enabled
      ? { xMin: endstop.xMin, yMin: endstop.yMin, zMin: endstop.zMin }
      : null;

  return {
    ok: true,
    input: {
      stock: { length: dims.x, width: dims.y, thickness: dims.z, cornerRadius: STOCK_CORNER_RADIUS_MM },
      region,
      marginMm: job.edgeMargin,
      origin: { x: datum.x, y: datum.y, from: datum.from },
      softLimits,
      expectedSurface: { machineZ: expected.expectedSurface.machineZ, from: expected.expectedSurface.from },
      // #845 — a stated machine has no clearance to seek from; the surface seek starts where the
      // head is parked, never at an invented 0.
      seekFromMachineZ: clearanceZOf(jobMachine(job, calibration)) ?? 0,
      probe: {
        instrument: args.probe?.instrument === 'xyz' ? 'xyz' : 'z-only',
        tipRadiusMm: settings.tipRadiusMm,
      },
      settings: scanSettings,
      obstacles: (args.mountObstacles ?? (args.mount.kind === 'bracket' ? mountObstaclesFor(job, args.mount, sizes) : [])).map((o) => ({
        label: o.label,
        min: [o.min[0], o.min[1]] as [number, number],
        max: [o.max[0], o.max[1]] as [number, number],
      })),
    },
  };
}

// -------------------------------------------------------------------------------------------------
// #1070, 6b's ruling — THE FIRST BRACKET SEAT IS A BOUNDED Z SEEK, planned here.

/**
 * The seat the 2026-11-07 wiring left behind, mm machine Z: the wired-V2 blank top (−60.75 at
 * TLO −14.068) less the 25 mm blank. The seek VERIFIES it; the number only bounds the band.
 */
/** The modelled probe head's widest body when a machine states no head envelope (#554's nut stub). */
const PROBE_HEAD_RADIUS_MM = 4;

/** #1133 — the margin the seat point leaves beyond the head envelope (the ruling's 2 mm). */
const SEAT_HEAD_MARGIN_MM = 2;

export const SEAT_DERIVED = {
  machineZ: -85.75,
  toleranceMm: 1.5,
  from: 'derived from the 2026-11-07 touch (wired-V2 blank top −60.75, TLO −14.068, less the 25 mm blank), verified by the seek',
  /** The bracket's arm-top figure the ledger holds (measured 2026-10-18) — recorded, not used in the seek. */
  armTopMm: 15.0,
} as const;

export interface SeatSeek {
  /** The touch point, machine XY: the nearest spot on the seat plane whose head envelope clears everything. */
  x: number;
  y: number;
  /** The same point, work XY (for the sheet's "where it is" words). */
  workX: number;
  workY: number;
  fromMachineZ: number;
  expectZ: number;
  band: { min: number; max: number };
  notes: string[];
}

export type SeatSeekResult = { ok: true; seek: SeatSeek } | { ok: false; reason: string };

/**
 * #1070/#1133 — the seat seek: ONE bounded Z touch with the wired V2 on the wasteboard beside
 * the blank — the nearest spot on the seat plane where the HEAD's envelope clears the stock and
 * every fixture by 2 mm (the bench refused the old point 5–7.5 mm in front of the blank: the head,
 * not the tip, would have hit the taller wood). It starts `parkAboveSurfaceMm` above the band's
 * top, expects the derived seat, and its bound is the band's floor less the scan reach; the
 * executor's own G38.3/G38.5 line and the registration's touch feed are what send it, under the
 * machine's soft endstop like every touch.
 *
 * The reading IS the seat (the touch is on the wasteboard, not the arm), so the datum is written
 * without an offset — and it is valid only for the probe fitting the run measured it with.
 */
export function seatSeekFor(args: {
  job: EngraveJob;
  calibration: MachineCalibration | undefined;
  defaults: ShopDefaults | null;
  probe: ProbeSpec | null;
  /**
   * #1070 (C8) — the origin the seat point is measured from: a PLACED bracket's comes from the bed
   * profile's placement, an anchored one's from the anchor datum (the default here).
   */
  origin?: { x: number; y: number } | null;
}): SeatSeekResult {
  const sizes = bracketSettings(args.defaults);
  let datum: { x: number; y: number };
  if (args.origin !== undefined && args.origin !== null) {
    datum = args.origin;
  } else {
    const anchor = anchorFrom(args.calibration, args.job.machineId);
    if (!anchor.ok) return { ok: false, reason: anchor.reason };
    datum = bracketDatum(anchor.anchor, sizes);
  }
  const settings = registrationSettings(args.defaults, args.probe).settings;
  // #1133 — THE SEAT POINT IS CHOSEN, NOT OFFSET. The old point sat armWidth/2 (5–7.5 mm) in
  // front of the blank; the bench refused it because the HEAD — not the probe tip — would hit the
  // taller stock. The point is now the nearest spot on the seat plane beside the bracket where the
  // head's envelope clears the stock AND every fixture footprint by a 2 mm margin, inside the
  // machine's soft limits.
  const head = headEnvelopeOf(jobMachine(args.job, args.calibration));
  const headRadius = head?.radiusMm ?? PROBE_HEAD_RADIUS_MM;
  const need = Math.round((headRadius + SEAT_HEAD_MARGIN_MM) * 1000) / 1000;
  const own = stockForSetup(args.job, undefined);
  const mount: MountSpec = { kind: 'bracket', board: args.job.sacrificial.under !== null };
  const obstacles = mountObstaclesFor(args.job, mount, sizes);
  const stockBox = { min: [0, 0] as [number, number], max: [own.length, own.width] as [number, number] };
  const clearOf = (px: number, py: number, box: { min: [number, number]; max: [number, number] }): number =>
    Math.hypot(Math.max(box.min[0] - px, 0, px - box.max[0]), Math.max(box.min[1] - py, 0, py - box.max[1]));
  // The nearest point to the blank, then the one nearest the arm's old aim — a deterministic
  // choice, so the plan and the sheet cannot disagree about where the touch is.
  const aimX = sizes.settings.armLengthX + settings.tipRadiusMm + 5;
  const aimY = -sizes.settings.armWidth / 2;
  const endstopOf = args.calibration?.softEndstop;
  const limitsOn = endstopOf !== undefined && endstopOf !== null && endstopOf.enabled;
  let best: { workX: number; workY: number; fromStock: number; fromAim: number } | null = null;
  for (let wy = 0; wy <= own.width + need * 2; wy += 1) {
    for (let wx = 0; wx <= own.length + need * 2; wx += 1) {
      const fromStock = clearOf(wx, wy, stockBox);
      if (fromStock + 1e-9 < need) continue;
      if (obstacles.some((o) => clearOf(wx, wy, o) + 1e-9 < need)) continue;
      if (limitsOn && (datum.x + wx < endstopOf.xMin || datum.y + wy < endstopOf.yMin)) continue;
      const fromAim = Math.hypot(wx - aimX, wy - aimY);
      if (
        best === null ||
        fromStock < best.fromStock - 1e-9 ||
        (Math.abs(fromStock - best.fromStock) <= 1e-9 && fromAim < best.fromAim)
      ) {
        best = { workX: wx, workY: wy, fromStock, fromAim };
      }
    }
  }
  if (best === null) {
    return {
      ok: false,
      reason: `no point on the seat plane beside the bracket clears the head envelope (${headRadius} mm${head === null ? ', the modelled probe head' : ''}) by ${SEAT_HEAD_MARGIN_MM} mm within the machine's reach — measure the seat by hand and enter it, or move the blank`,
    };
  }
  const workX = best.workX;
  const workY = best.workY;
  const x = Math.round((datum.x + workX) * 1000) / 1000;
  const y = Math.round((datum.y + workY) * 1000) / 1000;
  // #1133 — THE ARM CHECK. It is offered only when a point on the arm clears by the same rule;
  // with a real head on the 10 mm arm it usually cannot, and the plan says so in one line.
  const armPoint = bracketTapPoint(datum, sizes.settings);
  const armWork = { x: armPoint.x - datum.x, y: armPoint.y - datum.y };
  const armClear =
    clearOf(armWork.x, armWork.y, stockBox) + 1e-9 >= need &&
    obstacles.every((o) => clearOf(armWork.x, armWork.y, o) + 1e-9 >= need);
  const armLine = armClear
    ? null
    : 'the arm is too narrow for the head to touch it beside this stock';
  const band = {
    min: Math.round((SEAT_DERIVED.machineZ - SEAT_DERIVED.toleranceMm) * 1000) / 1000,
    max: Math.round((SEAT_DERIVED.machineZ + SEAT_DERIVED.toleranceMm) * 1000) / 1000,
  };
  const fromMachineZ = Math.round((band.max + settings.parkAboveSurfaceMm) * 1000) / 1000;
  const endstop = args.calibration?.softEndstop;
  if (endstop !== undefined && endstop !== null && endstop.enabled) {
    if (x < endstop.xMin || y < endstop.yMin) {
      return { ok: false, reason: `the seat touch at machine X ${x} Y ${y} is past the machine's soft endstop (${endstop.xMin}, ${endstop.yMin}) — move the blank's corner, or measure the seat by hand` };
    }
    if (band.min - settings.scanReachMm < endstop.zMin) {
      return { ok: false, reason: `the seat seek could reach machine Z ${band.min - settings.scanReachMm}, past the machine's soft endstop Z ${endstop.zMin}` };
    }
  }
  return {
    ok: true,
    seek: {
      x,
      y,
      workX: Math.round(workX * 1000) / 1000,
      workY: Math.round(workY * 1000) / 1000,
      fromMachineZ,
      expectZ: SEAT_DERIVED.machineZ,
      band,
      notes: [
        `the seat point (work ${Math.round(workX * 1000) / 1000}, ${Math.round(workY * 1000) / 1000}) clears the stock and every fixture by ${need} mm — the head's ${headRadius} mm envelope${head === null ? ' (the modelled probe head; the machine states none)' : ` (${head.source})`} plus ${SEAT_HEAD_MARGIN_MM} mm`,
        ...(armLine === null ? [] : [armLine]),
        `the seat is expected at machine Z ${SEAT_DERIVED.machineZ} ± ${SEAT_DERIVED.toleranceMm} — ${SEAT_DERIVED.from}`,
        `the seek starts at machine Z ${fromMachineZ} (above the band) and goes no further than ${Math.round((band.min - settings.scanReachMm) * 1000) / 1000} (the band's floor less the ${settings.scanReachMm} mm scan reach)`,
        `the reading is the seat itself — the touch is on open wasteboard beside the blank (arm top ${SEAT_DERIVED.armTopMm} mm, the ledger's 2026-10-18 measurement, is recorded and not used here)`,
        'the seat is valid only for the probe fitting this run measures it with: the press measures every session, and the stored value is only the next session’s expected band',
      ],
    },
  };
}

/** The machine's soft endstop as the planner's check takes it — null when it has not been read. */
export function softLimitsOf(calibration: MachineCalibration | undefined): { xMin: number; yMin: number; zMin: number } | null {
  const endstop = calibration?.softEndstop;
  return endstop !== undefined && endstop !== null && endstop.enabled ? { xMin: endstop.xMin, yMin: endstop.yMin, zMin: endstop.zMin } : null;
}

// -------------------------------------------------------------------------------------------------
// #1070, 6b's ruling (C8): THE SHEET'S REGISTRATION IS ONE SEAM.

/**
 * The footprint plan (or, with no seat datum, the first seat seek) a bed-held job's sheet prints.
 *
 * ONE derivation, two callers: the app's File ▸ Run sheet hands `buildRunSheet` exactly this, and
 * the CLI's `sheetRegistrationFor` resolves its `LoadedLocation` into the same arguments and calls
 * it — so the sheet cannot disagree with the Cut card, which plans through the same footprint code.
 * PURE: the caller resolves the calibration, probe, defaults and seat (the store, or the boot).
 */
export function sheetRegistrationPlan(args: {
  job: EngraveJob;
  calibration: MachineCalibration | undefined;
  defaults: ShopDefaults | null;
  probe: ProbeSpec | null;
  bracketSeat: BracketSeatDatum | null;
  /** #1070 (C8) — the bed profile's placement seed for a placed bracket. */
  placedSeed?: { x: number; y: number; by: 'grid' | 'touch'; measuredAt: string; at: [number, number] | null; probe: string | null } | null;
}): { footprint?: FootprintPlan; seatSeek?: SeatSeek } {
  const { job, calibration, defaults, probe, bracketSeat, placedSeed } = args;
  if (jobMount(job) !== 'bracket') return {};
  const mount: MountSpec = { kind: 'bracket', board: job.sacrificial.under !== null };
  const input = footprintInputFor({ job, mount, calibration, defaults, probe, bracketSeat, placedSeed });
  if (input.ok) {
    const planned = planFootprintRegistration(input.input);
    if (planned.ok) return { footprint: planned.plan };
  }
  // No seat datum (or nothing to plan on it): the sheet's first touch is the seat seek, when the
  // house can back one. Its point is measured from the plan's seed — a placed bracket's own.
  const placed = job.workholding.kind === 'bracket' && (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement === 'placed';
  // #1070 (C8) — a PLACED bracket with no stated position prints NO registration block at all:
  // neither a footprint plan nor a seat point can be placed without the bracket's position, and a
  // block seeded from the anchor it is not on is the contradiction this replaced.
  if (placed && (placedSeed === null || placedSeed === undefined)) return {};
  const origin = placed && placedSeed !== null && placedSeed !== undefined ? { x: placedSeed.x, y: placedSeed.y } : null;
  const seatSeek = seatSeekFor({ job, calibration, defaults, probe, origin });
  return seatSeek.ok ? { seatSeek: seatSeek.seek } : {};
}
