/**
 * #1189 — THE PROBE'S SEATING SHIFT, applied to a plan once the probe's `M491` is known.
 *
 * Every stored Z datum is a RAW machine Z: the value the probe triggered at, with the probe seated
 * as it was that day. A touch probe in a collet does not seat to the same depth twice — the bench's
 * 2026-11-10 refit moved it 1.145 mm further out, so every surface triggered 1.145 mm higher and a
 * good blank stopped on the first check. The probe-independent height is `value − probeRefZ`; the
 * raw expectation today is `value + (today's M491 − probeRefZ)`.
 *
 * The plan is built before the probe is measured (the M491 happens in the run), so the correction
 * lives here: the executor calls this once after its `M491` and uses the corrected plan for every
 * Z expectation — the seek band, the cut-blank checks (which follow the band), the derived top, the
 * mount tap's expected reading and the jaw-top ceiling. The probe's own length cancels out of the
 * cutter's Z0 (`surface + cutterRef − probeRef`), which is why the cutter path is unchanged: a
 * correctly corrected run writes the same origin as one before the refit.
 *
 * A datum with no reference (every datum measured before this key existed) is NOT shifted: the
 * Register card refuses to plan on one and asks for the one-touch re-measure, so a plan that
 * reaches here without a reference is a stored pre-upgrade plan and keeps its approved numbers.
 */

import type { RegistrationPlan } from './plan';

/** Below this, the seating difference is the dial's noise and no sentence is written. */
export const PROBE_SHIFT_SILENT_MM = 0.005;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const f = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

/** The shift a datum needs today: `today − datum`, or null when either number is missing. */
export function probeShiftMm(
  todayRefZ: number | null | undefined,
  datumRefZ: number | null | undefined,
): number | null {
  if (todayRefZ === null || todayRefZ === undefined || !Number.isFinite(todayRefZ)) return null;
  if (datumRefZ === null || datumRefZ === undefined || !Number.isFinite(datumRefZ)) return null;
  return r3(todayRefZ - datumRefZ);
}

/**
 * #1179 B4 + #1189 — THE RECORDED TOP, corrected to today's probe seating. The record is a raw
 * machine Z from the run that accepted it; `recordRefZ` is that run's M491. With no reference the
 * record cannot be separated from the probe's seating, so it is NOT trusted: null, and the plan's
 * own seat + thickness arithmetic answers instead.
 */
export function shiftedRecordedTopMachineZ(
  recordedTopMachineZ: number | null | undefined,
  recordRefZ: number | null | undefined,
  todayRefZ: number | null | undefined,
): number | null {
  if (recordedTopMachineZ === null || recordedTopMachineZ === undefined || !Number.isFinite(recordedTopMachineZ)) {
    return null;
  }
  const shift = probeShiftMm(todayRefZ, recordRefZ);
  if (shift === null) return null;
  return r3(recordedTopMachineZ + shift);
}

export interface ProbeCorrectedPlan {
  /** The plan to run: the same plan with every datum-derived Z corrected to today's seating. */
  plan: RegistrationPlan;
  /** The expected surface's shift, or null when its datum carries no reference. */
  shiftMm: number | null;
  /**
   * The sentences to narrate and record — one per datum whose seating differs enough to say:
   * "the probe sits 1.145 mm further out than when the seat was measured (M491 -9.094 today,
   * -10.239 then); the expected top is corrected to -59.643".
   */
  notes: string[];
}

/** One corrected expectation, gathered per datum below. */
interface Correction {
  ref: number;
  label: string;
  /** What it is, in the sentence ("the expected top", "the jaw top", "the tap's expected Z"). */
  what: string;
  corrected: number;
}

/**
 * Correct `plan` for the probe's seating as measured now (`todayRefZ` = the run's M491 reading).
 * Pure: the plan object is not mutated, and nothing to correct returns the plan itself.
 */
export function correctedPlanForProbe(
  plan: RegistrationPlan,
  todayRefZ: number | null | undefined,
): ProbeCorrectedPlan {
  const expectedShift = probeShiftMm(todayRefZ, plan.probeRefZ ?? null);
  const floorShift = probeShiftMm(todayRefZ, plan.floorProbeRefZ ?? plan.probeRefZ ?? null);
  const jawShift =
    plan.mountDatum === null ? null : probeShiftMm(todayRefZ, plan.mountDatum.probeRefZ ?? null);
  const tapExpect = plan.mountTap?.expectZ ?? null;
  const tapShift =
    plan.mountTap === null
      ? null
      : probeShiftMm(todayRefZ, plan.mountTap.probeRefZ ?? plan.mountDatum?.probeRefZ ?? null);
  const topShift = expectedShift ?? floorShift;

  const band = {
    min: floorShift === null ? plan.seek.band.min : r3(plan.seek.band.min + floorShift),
    max: expectedShift === null ? plan.seek.band.max : r3(plan.seek.band.max + expectedShift),
  };
  const mountDatum =
    plan.mountDatum === null || jawShift === null
      ? plan.mountDatum
      : { ...plan.mountDatum, jawTopZ: r3(plan.mountDatum.jawTopZ + jawShift), probeRefZ: todayRefZ ?? null };
  const mountTap =
    plan.mountTap === null || tapShift === null || tapExpect === null
      ? plan.mountTap
      : { ...plan.mountTap, expectZ: r3(tapExpect + tapShift), probeRefZ: todayRefZ ?? null };

  // One sentence per DATUM (a vise's jaw top anchors both the expected top and the tap): grouped by
  // the reference number, with every expectation it corrected listed.
  const corrections: Correction[] = [];
  if (plan.probeRefZ !== null && plan.probeRefZ !== undefined && expectedShift !== null) {
    corrections.push({
      ref: plan.probeRefZ,
      label: plan.probeRefLabel ?? 'the datum',
      what: 'the expected top',
      corrected: r3(plan.seek.band.max - plan.settings.surfaceToleranceMm + expectedShift),
    });
  }
  if (plan.mountDatum?.probeRefZ !== null && plan.mountDatum?.probeRefZ !== undefined && jawShift !== null) {
    corrections.push({
      ref: plan.mountDatum.probeRefZ,
      label: 'the jaw top',
      what: 'the jaw top',
      corrected: r3(plan.mountDatum.jawTopZ + jawShift),
    });
  }
  const tapRef = plan.mountTap?.probeRefZ ?? plan.mountDatum?.probeRefZ ?? null;
  if (tapRef !== null && tapShift !== null && tapExpect !== null) {
    corrections.push({
      ref: tapRef,
      label: plan.mountTap?.reference === 'bracket-seat' ? 'the seat (the arm’s top)' : 'the jaw top',
      what: plan.mountTap?.reference === 'bracket-seat' ? 'the tap’s expected arm top' : 'the tap’s expected Z',
      corrected: r3(tapExpect + tapShift),
    });
  }

  const notes: string[] = [];
  const groups = new Map<number, { label: string; shift: number; parts: string[] }>();
  for (const c of corrections) {
    const shift = r3(todayRefZ! - c.ref);
    if (Math.abs(shift) < PROBE_SHIFT_SILENT_MM) continue;
    const group = groups.get(c.ref) ?? { label: c.label, shift, parts: [] };
    group.parts.push(`${c.what} to ${f(c.corrected)}`);
    groups.set(c.ref, group);
  }
  for (const [ref, group] of groups) {
    notes.push(
      `the probe sits ${f(Math.abs(group.shift))} mm ${group.shift > 0 ? 'further out' : 'further in'} than when ` +
        `${group.label} was measured (M491 ${f(todayRefZ!)} today, ${f(ref)} then); ${group.parts.join(', ')}`,
    );
  }

  const nothingToShift = expectedShift === null && floorShift === null && jawShift === null && tapShift === null;
  if (nothingToShift) return { plan, shiftMm: null, notes: [] };
  return {
    plan: {
      ...plan,
      seek: { ...plan.seek, band },
      ...(expectedShift === null ? {} : { probeRefZ: todayRefZ ?? null }),
      ...(floorShift === null ? {} : { floorProbeRefZ: todayRefZ ?? null }),
      mountDatum,
      mountTap,
    },
    shiftMm: topShift,
    notes,
  };
}
