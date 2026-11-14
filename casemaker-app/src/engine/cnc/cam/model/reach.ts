/**
 * #1288 — ONE USABLE-LENGTH FUNCTION for every pick-side read, and the posted depth as the authority.
 *
 * A cutter's usable length is its stated SHOULDER length when that is stated and positive, else its
 * stated FLUTE length (the rule the holder gate (`holderGate`, `sweep.ts`) applies to the deepest
 * posted cut). A length that is absent, zero or negative is UNSTATED. Before this, the pick read
 * `fluteLength` alone in some places and `shoulder ?? flute` in others, and treated an unstated
 * length as "reaches" in one and "reaches nothing" in another.
 *
 * ELIGIBILITY: among cutters of one kind, those with a STATED length that covers the depth are
 * eligible; a cutter with an UNSTATED length is eligible only when no stated cutter reaches (and
 * then the sweep's holder gate carries `holder-unproven` for it, as it does today).
 */
import type { Tool } from '@/engine/cnc/tool';

const positive = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** The stated usable length, mm: shoulder, else flute; null when neither is stated. */
export function usableLengthMm(tool: Tool): number | null {
  return positive(tool.shoulderLength) ?? positive(tool.fluteLength);
}

/** The float slack the reach comparisons have always used. */
export const REACH_EPS_MM = 1e-9;

/** True when the cutter STATES a length and it covers `depthMm` (a depth below the stock top, mm). */
export function statedReach(tool: Tool, depthMm: number): boolean {
  const usable = usableLengthMm(tool);
  return usable !== null && usable + REACH_EPS_MM >= depthMm;
}

/**
 * The cutters eligible for `depthMm`: the stated cutters that reach; when none does, the
 * unstated ones (`unstated: true`, the caller states `holder-unproven`); when neither, none.
 */
export function eligibleByReach<T extends Tool>(tools: readonly T[], depthMm: number): { tools: T[]; unstated: boolean } {
  const stated = tools.filter((tool) => statedReach(tool, depthMm));
  if (stated.length > 0) return { tools: stated, unstated: false };
  const unstated = tools.filter((tool) => usableLengthMm(tool) === null);
  return { tools: unstated, unstated: unstated.length > 0 };
}

/** The deepest posted tip below the stock top (0 when nothing is posted), mm — the authority for a cutter's reach. */
export function postedDepthMm(operations: readonly { moves: readonly { z: number }[] }[]): number {
  let deepest = 0;
  for (const operation of operations) for (const move of operation.moves) deepest = Math.min(deepest, move.z);
  return Number((-deepest).toFixed(1));
}

/** Null when the posted depth is within the cutter's reach (or it states none); else the usable length it exceeds. */
export function postedReachShortfall(tool: Tool, postedMm: number): number | null {
  const usable = usableLengthMm(tool);
  return usable !== null && postedMm - usable > 1e-6 ? usable : null;
}
