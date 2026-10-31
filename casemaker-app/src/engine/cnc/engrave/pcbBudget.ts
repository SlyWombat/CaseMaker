/**
 * #743 P-6 — THE SURFACE BUDGET A BOARD'S ISOLATION NEEDS (design §3.6).
 *
 * A PCB's isolation is 0.1 mm deep and its copper is 0.035 mm thick, so the cut has to pass the
 * copper's underside by a margin, and the registration's own Z uncertainty spends part of that
 * margin. The plane fit follows a tilt; what it does NOT follow is the residual — the bow a plane
 * cannot explain. The board's top must therefore sit within
 *
 *   depth − copper − the job's Z budget
 *
 * of the fitted plane (0.1 − 0.035 − 0.02 = 0.045 mm with the design's numbers), or the isolation
 * runs out of copper at the high side. This is the same arithmetic as `item-depth-bound` with the
 * MEASURED residual in place of the assumed one, so the design check and the Cut gate cannot
 * disagree.
 *
 * Pure: the job and the job's Z budget in, numbers and words out. The Cut surface reads it with the
 * registration's own `fit.residual`; a plain tolerance question is STATED with its fix, never a
 * refusal (the 2026-10-29 rule).
 */

import type { EngraveJob } from '@/types/engraveJob';

/** The numbers one board's isolation needs, and where each came from. */
export interface PcbSurfaceBudget {
  /** The isolation frame the budget belongs to. */
  frameId: string;
  /** The isolation's cut depth below the top face, mm (the frame's own `depth`). */
  depthMm: number;
  /** The copper cap's thickness, mm (the stock's laminate cap). */
  capMm: number;
  /** The job's Z budget after registration, mm (`margins.zTolerance`). */
  zToleranceMm: number;
  /** `depth − cap − zTolerance` — the largest residual the isolation can take, mm. */
  budgetMm: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The board's isolation budget, or null for every job without a board: no laminate cap, or no
 * enabled isolation frame. With several, the SHALLOWEST frame wins — it is the cut with the least
 * room, and a top flat enough for it is flat enough for the others.
 */
export function pcbSurfaceBudget(job: EngraveJob, zToleranceMm: number): PcbSurfaceBudget | null {
  const colour = job.stock.colour;
  const capMm = colour !== undefined && colour.kind === 'laminate' ? colour.capMm : null;
  if (capMm === null || !(capMm > 0)) return null;
  const frames = (job.combined ?? []).filter(
    (item) => item.kind === 'frame' && item.isolation === true && item.enabled,
  );
  if (frames.length === 0) return null;
  const frame = frames.reduce((a, b) => (b.depth < a.depth ? b : a));
  const depthMm = frame.depth;
  const z = Number.isFinite(zToleranceMm) && zToleranceMm >= 0 ? zToleranceMm : 0;
  return {
    frameId: frame.id,
    depthMm,
    capMm,
    zToleranceMm: z,
    budgetMm: Math.max(0, r3(depthMm - capMm - z)),
  };
}

/**
 * The sentence the Cut surface states when the measured residual is over the budget. The design's
 * own words (§3.6): what the top is uneven by, what the isolation needs, and the physical fix.
 */
export function pcbSurfaceSentence(budget: PcbSurfaceBudget, residualMm: number): string {
  const miss = Math.max(0, r3(residualMm - budget.budgetMm));
  return (
    `The board's top is uneven by ${r3(residualMm)} mm after its tilt is taken out, and the ` +
    `${r3(budget.depthMm)} mm isolation needs it within ${r3(budget.budgetMm)} mm ` +
    `(${r3(budget.capMm)} mm of copper and ${r3(budget.zToleranceMm)} mm of Z budget). ` +
    `It is ${r3(miss)} mm over: tape the board flat over its whole back, then register again.`
  );
}
