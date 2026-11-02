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
import type { MountDatum, PlanObstacle, ProbeSpec, RegistrationPlan } from '@/engine/cnc/registration/plan';
import { bracketTapFor } from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { summarizePlan } from '@/engine/cnc/registration/summary';
import {
  machineSize,
  referenceOpenings,
  referenceRegistrationFor,
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
  seatZ: string;
  /** The expert override: use the typed seat even when a datum is present. */
  useTypedSeat: boolean;
  mountDatum: MountDatum | null;
  /** #611 — the datum's `by` when it names a probe other than the one checked out (null otherwise). */
  mountDatumMismatch: string | null;
  /** #640 — the same probe, by NAME, for the sentence (the id stays for the wiring). */
  mountDatumMismatchName: string | null;
  /** #619 — the measured surface-top datum; when present the plan expects the found top, not the ledge estimate. */
  surfaceTopZ: { value: number } | null;
  /** #509 — the active bed profile's seat beside the bracket (its bracket seat, else its surface top). */
  bracketSeat: BracketSeatDatum | null;
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
  } else if (mount.kind === 'vise' && args.mountDatum !== null && !args.useTypedSeat) {
    // #598 — the datum path: no seat input; the surface is the measured jaw top + the stock's proud
    // height (`registrationFor` works it out), and the probe is carried for the record. #599 — the
    // mount tap needs the fixed jaw's machine XY; without a frame there is nothing to tap.
    if (args.mountTap === null) {
      return { kind: 'refused', reason: 'place the vise, or register once with the typed seat, so the app knows where the fixed jaw is' };
    }
    input = { seekFromMachineZ, cornerRadius: STOCK_CORNER_RADIUS_MM, mountDatum: args.mountDatum, surfaceTopZ: args.surfaceTopZ, probe: args.probe, mountTap: args.mountTap };
  } else {
    // The seat path: tape always; a vise without a datum, or with the expert override, types the seat.
    const seat = Number(args.seatZ);
    if (args.seatZ.trim() === '' || !Number.isFinite(seat)) {
      if (mount.kind === 'vise' && args.mountDatum === null && !args.useTypedSeat) {
        // #611 — a datum tapped by a probe other than the one now checked out names which probe
        // tapped it and offers the tap with the current probe; an absent datum keeps the plain ask.
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
          message: 'tap the jaw first — Measure… on the machine card, or run the registration: its first touch is that tap',
          mountTap: args.mountTap,
        };
      }
      return {
        kind: 'need-seat',
        message:
          'Enter the seat’s machine Z first — the surface the stock sits on, measured with one probe touch. The section has no stored vise seat and will not invent one.',
      };
    }
    input = { seatMachineZ: seat, seekFromMachineZ, cornerRadius: STOCK_CORNER_RADIUS_MM, probe: args.probe };
  }

  // #743 D-2 — A DISC REGISTERS ON ITS RIM. The plan scans all four edges through the
  // centre-lines (opposite pairs give the centre, the span gives the diameter); the stated
  // diameter is the job's own, which the schema keeps equal to the box.
  if (job.stock.shape === 'disc') {
    input = { ...input, disc: { diameterMm: job.stock.diameter ?? job.stock.length } };
  }

  const result =
    referenceOpenings(setup).openings.length > 0
      ? referenceRegistrationFor(setup, mount, input, args.settings)
      : registrationFor(setup, mount, input, args.settings).plan;
  if (!result.ok) return { kind: 'refused', reason: result.reason };
  return {
    kind: 'plan',
    method: mount.kind,
    plan: result.plan,
    summary: summarizePlan(result.plan),
    expected: expectedWords(result.plan),
  };
}
