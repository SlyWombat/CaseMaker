/**
 * #1179 D — THE THICKNESS NOTE. The job states the blank's thickness; the plan's expected top
 * derives from it. A measured top then IMPLIES a thickness — stated + (measured − expected) — and
 * when that disagrees with the job by more than 0.1 mm the Register step says so, with both numbers
 * and the difference.
 *
 * THE JOB IS NEVER EDITED. The stated thickness feeds every program's bytes; changing it to match a
 * measurement would move every toolpath. Instead the measured top is written against the BLANK (the
 * machine's record, F's `finishedRuns` registration: `measuredTopMachineZ`, `impliedThicknessMm`,
 * `measuredAt`, `planExpectedTopMachineZ`), and the derived path (#1166 B4) can use that top rather
 * than the stated thickness.
 *
 * The expected top is the plan's own arithmetic: the surface seek's band is
 * `expectedSurface ± surfaceToleranceMm` (`plan.ts`), so the executor's derived top
 * (`execute.ts`, `band.max − surfaceToleranceMm`) is what this compares against — one expression,
 * no second opinion.
 */

/** How far the measured top may imply a thickness off the job's before the Register step says so. */
export const THICKNESS_NOTE_MM = 0.1;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const finite = (n: number): boolean => Number.isFinite(n);

export interface ThicknessCheckInput {
  /** The job's stated thickness, mm (`plan.stockThicknessMm`). */
  statedThicknessMm: number;
  /** Where the plan expected the top, machine Z: `seek.band.max − settings.surfaceToleranceMm`. */
  expectedTopMachineZ: number;
  /** The registration's measured top, machine Z (`outcome.surfaceZ`). */
  measuredTopMachineZ: number;
  /** How far off counts, mm. Defaults to {@link THICKNESS_NOTE_MM}. */
  thresholdMm?: number;
}

export interface ThicknessCheck {
  statedThicknessMm: number;
  expectedTopMachineZ: number;
  measuredTopMachineZ: number;
  /** measured − expected, to the thousandth: the thickness the measurement adds to the job's. */
  deltaMm: number;
  /** stated + delta: the thickness this blank's top implies. */
  impliedThicknessMm: number;
  /** `|delta|` is MORE than the threshold — the strict reading the issue states. */
  over: boolean;
}

export interface ThicknessNote {
  check: ThicknessCheck;
  /** The Register step's sentence. The job is not changed; the measured top is kept for the blank. */
  text: string;
}

/**
 * The comparison on its own. Null when it cannot be made honestly: no stated thickness (a job that
 * does not carry one, or a plan whose stock has none) or a non-finite reading.
 */
export function thicknessCheck(input: ThicknessCheckInput): ThicknessCheck | null {
  const { statedThicknessMm, expectedTopMachineZ, measuredTopMachineZ } = input;
  const thresholdMm = input.thresholdMm ?? THICKNESS_NOTE_MM;
  if (!finite(statedThicknessMm) || statedThicknessMm <= 0) return null;
  if (!finite(expectedTopMachineZ) || !finite(measuredTopMachineZ)) return null;
  if (!finite(thresholdMm) || thresholdMm <= 0) return null;
  const deltaMm = r3(measuredTopMachineZ - expectedTopMachineZ);
  const impliedThicknessMm = r3(statedThicknessMm + deltaMm);
  return {
    statedThicknessMm,
    expectedTopMachineZ: r3(expectedTopMachineZ),
    measuredTopMachineZ: r3(measuredTopMachineZ),
    deltaMm,
    impliedThicknessMm,
    // "more than 0.1 mm": a difference that rounds ONTO the line is not over it, and the epsilon
    // keeps binary noise (12.4 − 12.3) on the near side.
    over: Math.abs(deltaMm) > thresholdMm + 1e-9,
  };
}

/** The plan's expected top, machine Z — the executor's derived arithmetic, in one place. */
export function expectedTopOf(plan: {
  seek: { band: { max: number } };
  settings: { surfaceToleranceMm: number };
}): number {
  return r3(plan.seek.band.max - plan.settings.surfaceToleranceMm);
}

/** The operator's sentence, when there is one: both numbers, the difference, and the fact the job
 * keeps its own. */
export function thicknessNote(input: ThicknessCheckInput): ThicknessNote | null {
  const check = thicknessCheck(input);
  if (check === null || !check.over) return null;
  const direction = check.deltaMm > 0 ? 'more' : 'less';
  const stated = String(r3(check.statedThicknessMm));
  const text =
    `The job says ${stated} mm; this blank measures ${check.impliedThicknessMm.toFixed(2)} mm — ` +
    `${Math.abs(check.deltaMm).toFixed(2)} mm ${direction}. ` +
    `The job is not changed; this blank's measured top is used.`;
  return { check, text };
}
