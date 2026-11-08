/**
 * #919 baseline — `planRegistrationAttempt`, moved out of `EngraveSetupsSection.tsx` so that file
 * exports only its component (react-refresh/only-export-components). The logic is unchanged.
 *
 * Plan one setup's registration, or say why it cannot be planned.
 *
 * No number is invented here. The vise surface comes from the MEASURED jaw-top datum when the machine
 * has one (the normal path); the typed seat remains only as the expert override, and the bracket's
 * surface comes from the measured `bracket.seatMachineZ`. The bracket's datum, clamps and arms come
 * from the machine's own anchor and the shop defaults — `anchorFrom` / `bracketExpectedSurface`
 * refuse when the machine has not supplied them.
 */

import { jobMachine } from '@/engine/cnc/calibration';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { clearanceZOf } from '@/engine/cnc/machine';
import { clampPlacementsFor } from '@/engine/cnc/engrave/jobSetup';
import {
  anchorFrom,
  bracketDatum,
  bracketExpectedSurface,
  bracketObstacles,
  bracketSettings,
  clampObstacles,
  defaultClampPlacements,
  type BracketSeatDatum,
} from '@/engine/cnc/mounts/bracket';
import { planRegistration, type MountDatum, type PlanObstacle, type ProbeSpec, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import { cutRegionOf, mountObstaclesFor, seatSeekFor, softLimitsOf } from '@/engine/cnc/registration/footprintJob';
import { bracketTapFor } from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { summarizePlan } from '@/engine/cnc/registration/summary';
import {
  machineSize,
  referenceOpenings,
  registrationFor,
  type MountSpec,
  type Setup,
} from '@/engine/cnc/setups';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';
import type { RegistrationAttempt } from './EngraveSetupRow';

/**
 * The stock the app models is a rectangular prism: its corners are square. The job carries no
 * corner radius, and the registration planner needs one, so this states the geometry rather than
 * inventing a measurement (decision 28).
 */
const STOCK_CORNER_RADIUS_MM = 0;

function expectedWords(plan: RegistrationPlan): string {
  const z = `Z from the surface touch, within ±${plan.settings.surfaceToleranceMm} mm`;
  if (plan.bracketOrigin !== null) return `XY from the bracket (${plan.bracketOrigin.from}); ${z}`;
  if (plan.references !== undefined) return `X/Y from the earlier features; ${z}`;
  // #743 — a disc's four rim touches set the centre and read the diameter, so the word is not a
  // list of edges.
  if (plan.disc !== undefined) return `X/Y from the rim's four centre-line touches (centre, and the diameter checked); ${z}`;
  const edges = plan.scans.map((s) => s.edge);
  if (edges.length === 0) return z;
  return `X/Y re-checked on the ${edges.join(' and ')} edge${edges.length === 1 ? '' : 's'}; ${z}`;
}

export function planRegistrationAttempt(args: {
  job: EngraveJob;
  setup: Setup;
  mount: MountSpec;
  mountDatum: MountDatum | null;
  /** #611 — the datum's `by` when it names a probe other than the one checked out (null otherwise). */
  mountDatumMismatch: string | null;
  /** #640 — the same probe, by NAME, for the sentence (the id stays for the wiring). */
  mountDatumMismatchName: string | null;
  /** #619 — the measured surface-top datum; when present the plan expects the found top, not the ledge estimate. */
  surfaceTopZ: { value: number } | null;
  /** #509 — the active bed profile's seat beside the bracket (its bracket seat, else its surface top). */
  bracketSeat: BracketSeatDatum | null;
  /**
   * #1070 (C8) — the active bed profile's PLACEMENT SEED for a placed bracket (its inside corner,
   * machine XY, and where the statement came from), or null when the profile states none. Read
   * with `bracketPlacementSeedFor`; ignored by the anchored path.
   */
  placedSeed?: { x: number; y: number; by: 'grid' | 'touch'; measuredAt: string; at: [number, number] | null; probe: string | null } | null;
  probe: ProbeSpec | null;
  /** #603 — the checked-out probe's display name (its product), or null when none is checked out. */
  probeName: string | null;
  /** #599 — the mount tap point (machine XY), or null when the fixed jaw's frame is unknown. */
  mountTap: { x: number; y: number; fromMachineZ: number; label: string } | null;
  defaults: ShopDefaults | null;
  calibration: MachineCalibration | undefined;
  settings: ReturnType<typeof registrationSettings>['settings'];
}): RegistrationAttempt {
  const { job, setup, mount, defaults, calibration } = args;
  // #934 — REGISTRATION FROM EARLIER FEATURES is one of the branches the bench has not run; it is
  // refused by name, not crashed on and not planned as if it were the datum path.
  if (referenceOpenings(setup).openings.length > 0) {
    return {
      kind: 'refused',
      reason: 'registration from earlier features has not been run on this machine yet — register from the fixed jaw and the front edge instead',
    };
  }
  // #934 — THE BRANCHES THE BENCH HAS NOT RUN are refused HERE, at the operator seam, not inside
  // the pure planner: the engine's own specs are the regression suite for the code we keep, and
  // the operator path cannot reach these inputs once this refuses them.
  if (args.probe?.instrument === 'xyz') {
    return {
      kind: 'refused',
      reason: 'the 3D probe is not a registration instrument on this machine yet — fit the wired V2 probe and register again',
    };
  }
  if (job.stock.shape === 'disc') {
    return {
      kind: 'refused',
      reason: 'a disc’s rim registration has not been run on this machine yet — use a rectangular blank',
    };
  }
  // tape registration is hidden (refused by name); a BRACKET job registers on its cut region's
  // footprint (#1070 — the maintainer's rule: find the edges of where it will cut, not the blank's).
  const mountKind: MountSpec['kind'] = mount.kind;
  if (mountKind !== 'vise') {
    if (mountKind === 'tape') {
      return { kind: 'refused', reason: 'registration on tape has not been run on this machine yet — hold the blank in the vise' };
    }
    // #1070 — THE FOOTPRINT PLAN, from the job: two touches per bounding edge at the cut region's
    // extents, the far edges once each, one Z touch per region corner, every position in machine
    // coordinates checked against the soft endstop before a line is sent. The seed places the
    // machine coordinates; the touches derive the origin.
    //
    // A PLACED bracket (6b's ruling, C8) takes its seed from the ACTIVE BED PROFILE's placement of
    // the bracket — a fact of the bench, shared by every job until someone moves it — never from
    // the anchor it is not on. A profile that states none refuses by name, pointing at where the
    // statement lives. The field lives on land7's BracketHold; read it defensively.
    const placed = job.workholding.kind === 'bracket' && (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement === 'placed';
    const sizes = bracketSettings(defaults);
    let datum: { x: number; y: number; from: string; offsetMeasured: boolean };
    if (placed) {
      const seed = args.placedSeed ?? null;
      if (seed === null) {
        return {
          kind: 'refused',
          reason:
            'this bracket is screwed down where you put it, and the active bed profile does not state where — ' +
            'measure the bracket’s position into the bed profile’s placement (its five holes on the bed’s hole grid, or one confirmed touch), ' +
            'or put it on the anchor-1 pins',
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
      if (!anchor.ok) return { kind: 'refused', reason: anchor.reason };
      datum = bracketDatum(anchor.anchor, sizes);
    }
    const obstacles = mountObstaclesFor(job, mount, sizes);
    // 6b's ruling (#1070) — THE FIRST BRACKET SEAT IS MEASURED BY THE PROGRAM: when the house has
    // no seat datum (and no legacy default), the press plans ONE bounded Z seek with the wired V2
    // on the wasteboard beside the front arm; its reading is written as the bed profile's
    // `bracketSeatZ` and mirrored to the shop default. The band is the 2026-11-07-derived seat,
    // VERIFIED by the seek.
    const dims0 = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
    const under0 = mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
    const expected0 = bracketExpectedSurface(defaults, dims0.z, under0, args.bracketSeat);
    if (!expected0.ok) {
      // The seat point is measured from the plan's own seed — a placed bracket's placement, else the anchor.
      const seat = seatSeekFor({ job, calibration, defaults, probe: args.probe, origin: datum });
      if (!seat.ok) return { kind: 'refused', reason: seat.reason };
      const plan: RegistrationPlan = {
        mount: 'bracket',
        stock: { xMin: 0, yMin: 0, xMax: dims0.x, yMax: dims0.y, cornerRadius: 0 },
        stockThicknessMm: dims0.z,
        surfacePoint: { x: seat.seek.workX, y: seat.seek.workY },
        seek: {
          fromMachineZ: seat.seek.fromMachineZ,
          travelMm: Math.round((seat.seek.fromMachineZ - (seat.seek.band.min - args.settings.scanReachMm)) * 1000) / 1000,
          band: seat.seek.band,
        },
        mountDatum: null,
        probe: args.probe,
        mountTap: {
          x: seat.seek.x,
          y: seat.seek.y,
          fromMachineZ: seat.seek.fromMachineZ,
          label: 'the wasteboard beside the bracket’s front arm (the seat)',
          reference: 'bracket-seat',
          expectZ: seat.seek.expectZ,
          // The reading IS the seat: the touch is on the wasteboard, not the arm.
          datumOffsetMm: 0,
        },
        scans: [],
        bracketOrigin: { x: datum.x, y: datum.y, from: datum.from, offsetMeasured: datum.offsetMeasured },
        mountObstacles: obstacles,
        settings: args.settings,
        notes: seat.seek.notes,
      };
      return {
        kind: 'plan',
        method: 'bracket',
        plan,
        summary: 'Measure the bracket seat — one Z seek on the wasteboard beside the front arm',
        expected: 'the seat from the seek, inside ±1.5 mm of the derived value',
      };
    }
    // A's planner (1070-footprint-reg) owns the footprint plan now: ONE planRegistration call with
    // the region and the soft limits. The seed places the machine coordinates, the #525 corner
    // derivation gives the origin, and the obstacle check and the soft-limit refusal are its own.
    const region = cutRegionOf(job);
    if (region === null) {
      return { kind: 'refused', reason: 'this job states no cut region to register on — add the part to cut, or register by hand' };
    }
    const result = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: dims0.x, yMax: dims0.y, cornerRadius: 0 },
        mount: 'bracket',
        expectedSurface: expected0.expectedSurface,
        seekFromMachineZ: clearanceZOf(jobMachine(job, calibration)) ?? 0,
        mountDatum: null,
        probe: args.probe,
        mountTap: null,
        stockThicknessMm: dims0.z,
        bracketOrigin: datum,
        mountObstacles: obstacles,
        bracketConfirm: !datum.offsetMeasured,
        region: { min: [region.minX, region.minY], max: [region.maxX, region.maxY], marginMm: job.edgeMargin },
        softLimits: softLimitsOf(calibration),
      },
      args.settings,
    );
    if (!result.ok) return { kind: 'refused', reason: result.reason };
    return {
      kind: 'plan',
      method: 'bracket',
      plan: result.plan,
      summary: summarizePlan(result.plan),
      expected: expectedWords(result.plan),
    };
  }
  // #845 — a stated machine has no clearance to seek from; the preview it places a tap with is
  // only run where a connected Makera machine exists, and the 0 is never used to place a touch.
  const seekFromMachineZ = clearanceZOf(jobMachine(job, calibration)) ?? 0;
  let input: Parameters<typeof registrationFor>[2];

  if (mount.kind === 'bracket') {
    const sizes = bracketSettings(defaults);
    const anchor = anchorFrom(calibration, job.machineId);
    if (!anchor.ok) return { kind: 'refused', reason: anchor.reason };
    const datum = bracketDatum(anchor.anchor, sizes);
    const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
    const under = mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
    // #607 — the bracket's tap: its front arm's top, and the seat the reading measures back. The
    // expected top comes from the measured seat, so it is null until the seat has been tapped once.
    const tap = bracketTapFor({ calibration, machineId: job.machineId, seekFromMachineZ, defaults, bedSeat: args.bracketSeat });
    // The engine's expected-surface read also carries the refusal when the seat was never measured.
    // #607 — the tap cannot stand in for that first seat: `bracketTapFor` has no point until the
    // seat AND the arm's own top are measured, so an unmeasured seat keeps the sentence that says
    // how to measure it (one touch on the surface beside the bracket).
    const expected = bracketExpectedSurface(defaults, dims.z, under, args.bracketSeat);
    if (!expected.ok) return { kind: 'refused', reason: expected.reason };
    const stock = { x: dims.x, y: dims.y, z: dims.z };
    // #707 BM-1 — the registration's confirm scans are planned around the JOB's clamps (the default
    // pair only when the job states none), so the taps it offers match the clamps on the machine.
    const placementFor = clampPlacementsFor(job);
    const obstacles: PlanObstacle[] = [
      ...clampObstacles(stock, placementFor ?? defaultClampPlacements(stock, sizes.settings), sizes.settings),
      ...bracketObstacles(stock, sizes.settings, under),
    ].map((o) => ({ kind: o.kind, label: o.label, min: o.min, max: o.max, topZ: o.topZ }));
    input = {
      // `registrationFor` adds the stock's height this way up to the seat; take it back off the
      // expected surface so the two statements cannot drift.
      seatMachineZ: expected.expectedSurface.machineZ - dims.z,
      seekFromMachineZ,
      cornerRadius: STOCK_CORNER_RADIUS_MM,
      bracketOrigin: datum,
      mountObstacles: obstacles,
      bracketConfirm: !datum.offsetMeasured,
      // #607 — confirm the bracket on its own arm before the stock is found (a no-op per the
      // executor until the tap has an expected top).
      mountTap: tap,
    };
  } else if (mount.kind === 'vise' && args.mountDatum !== null) {
    // #598 — the datum path: no seat input; the surface is the measured jaw top + the stock's proud
    // height (`registrationFor` works it out), and the probe is carried for the record. #599 — the
    // mount tap needs the fixed jaw's machine XY; without a frame there is nothing to tap.
    if (args.mountTap === null) {
      return { kind: 'refused', reason: 'place the vise, or register once from the fixed jaw, so the app knows where it is' };
    }
    input = { seekFromMachineZ, cornerRadius: STOCK_CORNER_RADIUS_MM, mountDatum: args.mountDatum, surfaceTopZ: args.surfaceTopZ, probe: args.probe, mountTap: args.mountTap };
  } else {
    // The vise with no measured jaw-top datum: THE TAP IS THE PROCEDURE (#934 hides the typed-seat
    // override, so there is no other path to a seat here).
    // #611 — a datum tapped by a probe other than the one now checked out names which probe tapped
    // it and offers the tap with the current probe; an absent datum keeps the plain ask.
    if (args.mountDatumMismatch !== null) {
      const current = args.probeName !== null ? `the ${args.probeName} now checked out` : 'the probe now checked out';
      return {
        kind: 'need-datum',
        message: `the jaw top was tapped by ${args.mountDatumMismatchName}, not ${current} — tap the fixed jaw with the current probe first`,
        mountTap: args.mountTap,
      };
    }
    return {
      kind: 'need-datum',
      message: 'tap the jaw first — run the registration: its first touch is that tap',
      mountTap: args.mountTap,
    };
  }

  // #743 D-2 — the disc wiring stays in the planner; #934 refuses a disc at the top of this
  // function, so the operator path never reaches the rim routine.

  const result = registrationFor(setup, mount, input, args.settings).plan;
  if (!result.ok) return { kind: 'refused', reason: result.reason };
  return {
    kind: 'plan',
    method: mount.kind,
    plan: result.plan,
    summary: summarizePlan(result.plan),
    expected: expectedWords(result.plan),
  };
}
