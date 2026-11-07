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

import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf } from '@/engine/cnc/machine';
import { anchorFrom, bracketDatum, bracketExpectedSurface, bracketObstacles, bracketSettings, clampObstacles, defaultClampPlacements, type BracketSeatDatum } from '@/engine/cnc/mounts/bracket';
import { clampPlacementsFor } from '@/engine/cnc/engrave/jobSetup';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { rotatedExtents, targetTurns } from '@/engine/cnc/engrave/targetScale';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { surfaceSpreadPlan } from '@/engine/cnc/engrave/surfaceSpread';
import type { PlanObstacle, ProbeSpec } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { FootprintBox, FootprintInput, FootprintScanSettings } from '@/engine/cnc/registration/footprint';
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
  const anchor = anchorFrom(calibration, job.machineId);
  if (!anchor.ok) return { ok: false, reason: anchor.reason };
  const datum = bracketDatum(anchor.anchor, sizes);
  // The expected surface is the bracket's seat: the surface beside the mount, measured once.
  const dims = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
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
