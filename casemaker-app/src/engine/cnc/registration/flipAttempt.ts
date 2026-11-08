/**
 * #1088 — SIDE 2'S REGISTRATION, AS THE APP CAN RUN IT: the flip plan and the frame it runs in.
 *
 * The planner (`planFlipRegistration`, #1073) says what side 2's registration DOES; this module
 * gathers what it does it ON — the flipped setup's own locating pins (`JobSetup.pins`, #723 P2-2,
 * mounted work XY), the bore and the probe tip's diameters, the side-2 frame the executor's
 * touches run in (seek, surface point, mount, probe, settings, stock), and the carried Z0 the
 * corner touches are the CHECK of (`flipChoice.flipZ0`).
 *
 * Null when the job has no flipped setup — every non-flip job keeps its side-1 path untouched. A
 * flip job that cannot state its pins, its probe tip or its carried Z0 is REFUSED by name: none
 * of the three can be assumed without aiming a probe at the wrong place.
 */
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { RegistrationSettings } from './settings';
import { planFlipRegistration, type FlipRegistrationPlan, type RegistrationPlan } from './plan';
import { FLIP_BORE_DIAMETER_MM, type FlipZ0 } from '@/engine/cnc/engrave/flipChoice';
import { flipReflection } from '@/engine/cnc/setups/flip';

export interface FlipAttempt {
  /** The index of the FLIPPED setup in `job.setups`. */
  setupIndex: number;
  plan: FlipRegistrationPlan;
  /** The frame the executor's touches run in (its `scans` are not run). */
  ctx: RegistrationPlan;
  z0: FlipZ0;
  /** The bore the pins seed, mm — the job's own stated bore. */
  boreDiameterMm: number;
}

export type FlipAttemptResult =
  | { kind: 'plan'; attempt: FlipAttempt }
  | { kind: 'refused'; reason: string }
  /** Not a flip job: no setup declares `flip`. */
  | null;

/** How far a stored pin may differ from the reflection before it is a different point, mm. */
export const PIN_REFLECTION_TOLERANCE_MM = 0.05;

/**
 * #1088 — ONE SOURCE FOR THE HOLES. Side 2's pins ARE side 1's posted bore centres seen from the
 * other side — `setups/flip.ts` `flipReflection`'s mapping, the SAME one the flip drawing uses:
 * left-right mirrors X through the length, front-back mirrors Y through the width. A stored pin
 * copy that disagrees with the reflection is refused by name rather than measured on. The
 * planner's `holes` are always these reflected
 * bores; a setup that also stores `pins` may state them, but a stored copy that disagrees with
 * the reflection is refused by name rather than measured on.
 */
export function reflectedPins(
  bores: readonly { x: number; y: number }[],
  axis: 'left-right' | 'front-back',
  stock: { xMax: number; yMax: number },
): { x: number; y: number }[] {
  return bores.map((b) => {
    const r = flipReflection(b, { axis }, stock.xMax, stock.yMax);
    return { x: r3(r.x), y: r3(r.y) };
  });
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface FlipAttemptInput {
  /** Side 1's posted bore centres, mounted work XY — the ONE source of the holes. */
  sideOneBores: readonly { x: number; y: number }[] | null;
  settings: RegistrationSettings;
  /** The checked-out probe's measured tip, mm; null when none is resolved. */
  probeTipDiameterMm: number | null;
  /** The machine's travel clearance, machine Z. */
  seekFromMachineZ: number;
  /** The carried Z0 — `flipChoice.flipZ0`'s record for this job. */
  z0: FlipZ0 | null;
}

/** The flipped setup, or null. Exactly the setup a flip job registers side 2 on. */
export function flippedSetup(job: EngraveJob): { index: number; setup: JobSetup } | null {
  const setups = job.setups ?? [];
  for (let i = 0; i < setups.length; i++) {
    const setup = setups[i]!;
    if (setup.flip !== undefined) return { index: i, setup };
  }
  return null;
}

export function planFlipAttempt(job: EngraveJob, input: FlipAttemptInput): FlipAttemptResult {
  const flipped = flippedSetup(job);
  if (flipped === null) return null;
  const { setup, index } = flipped;
  if (input.sideOneBores === null || input.sideOneBores.length !== 2) {
    return { kind: 'refused', reason: 'side 2 registers on the two bores side 1 cut, and this job has no posted pair of bores to reflect — cut side 1’s bores first, then register side 2.' };
  }
  const length0 = setup.stock?.length ?? job.stock.length;
  const width0 = setup.stock?.width ?? job.stock.width;
  const pins = reflectedPins(input.sideOneBores, setup.flip!.axis, { xMax: length0, yMax: width0 });
  const stored = setup.pins?.at;
  if (
    stored !== undefined &&
    stored.some((p, i) => Math.hypot(p.x - pins[i]!.x, p.y - pins[i]!.y) > PIN_REFLECTION_TOLERANCE_MM)
  ) {
    return {
      kind: 'refused',
      reason:
        `the setup’s stored pins (${stored.map((p) => `(${p.x}, ${p.y})`).join(' and ')}) disagree with side 1’s bores reflected by the flip ` +
        `(${pins.map((p) => `(${p.x}, ${p.y})`).join(' and ')}) — one of the two is wrong, and a probe aimed at the wrong one misses. Correct them in Design → Setups.`,
    };
  }
  if (input.probeTipDiameterMm === null || !(input.probeTipDiameterMm > 0)) {
    return { kind: 'refused', reason: 'side 2’s bores are read with the probe’s measured tip, and no probe tip is measured on this machine — measure it in Manage › Accessories, then register side 2.' };
  }
  if (input.z0 === null) {
    return { kind: 'refused', reason: 'side 2’s top is carried from side 1 (Z0₁ − the measured thickness), and this job has no carried Z0 yet — register side 1 first, then register side 2.' };
  }
  // The side-2 stock: the setup's own stated box when it has one, else the job's blank.
  const length = length0;
  const width = width0;
  const plan = planFlipRegistration({
    method: setup.flip!.method,
    stock: { xMin: 0, yMin: 0, xMax: length, yMax: width, cornerRadius: 0 },
    holes: pins,
    boreDiameterMm: FLIP_BORE_DIAMETER_MM,
    probeTipDiameterMm: input.probeTipDiameterMm,
    settings: input.settings,
  });
  if (!plan.ok) return { kind: 'refused', reason: plan.reason };
  if (plan.plan.method !== 'tabs-in-blank' && plan.plan.crossCheck === null) {
    // The frame method's bores are the whole point; a vendor plan here would register on the
    // part's edge, which is not what a job with stated pins asked for.
    return { kind: 'refused', reason: 'this setup’s flip method registers on the part’s own edge — the pins it states belong to the frame method. Change the method in Design → Setups, or remove the pins.' };
  }
  // The seek point: clear of both bore mouths, so the surface touch lands on stock.
  const clearance = FLIP_BORE_DIAMETER_MM / 2 + 3;
  const corners = [
    { x: 6, y: 6 },
    { x: length - 6, y: 6 },
    { x: length - 6, y: width - 6 },
    { x: 6, y: width - 6 },
  ];
  const point = corners.find((c) => pins.every((p) => Math.hypot(c.x - p.x, c.y - p.y) > clearance)) ?? { x: length / 2, y: width / 2 };
  const top = input.z0.topMachineZ;
  const band = input.z0.checkBand ?? { minMm: top - 0.5, maxMm: top + 0.5 };
  const ctx = {
    mount: setup.mount?.kind === 'bracket' ? 'bracket' : setup.mount?.kind === 'tape' ? 'tape' : 'vise',
    stock: { xMin: 0, yMin: 0, xMax: length, yMax: width, cornerRadius: 0 },
    surfacePoint: point,
    seek: { fromMachineZ: input.seekFromMachineZ, travelMm: Math.max(0, input.seekFromMachineZ - band.minMm), band: { min: band.minMm, max: band.maxMm } },
    mountDatum: null,
    probe: null,
    mountTap: null,
    scans: [],
    bracketOrigin: null,
    mountObstacles: [],
    settings: input.settings,
    notes: [],
  } as unknown as RegistrationPlan;
  return { kind: 'plan', attempt: { setupIndex: index, plan: plan.plan, ctx, z0: input.z0, boreDiameterMm: FLIP_BORE_DIAMETER_MM } };
}
