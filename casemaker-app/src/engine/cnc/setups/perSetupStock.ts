/**
 * #1082 — A SETUP'S OWN STOCK, resolved (the manager's ruling: DERIVED, operator-confirmed).
 *
 * The vendor flip's side 2 cuts the FREED PART, not the blank: `free-then-flip` frees the part on
 * side 1, then side 2 re-mounts it with a carried Z0 (#1073). With one stock per job that side was
 * planned and swept against material that no longer exists — the two-job shape the sheet stated.
 *
 * The box is DERIVED from side 1's freed extents — the design silhouette the plan cut, the same
 * extents the registration and the flip drawing already read — with the blank's measured thickness
 * (T_measured when the house has it, else the stated thickness). The operator confirms it in the
 * Setups step and may override it; a stated box wins, and `provenance` says which it is.
 */
import type { EngraveJob, JobSetup, SetupStock } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { cutRegionOf } from '@/engine/cnc/registration/footprintJob';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The freed part's box, from side 1's cut extents; null when the job states no cut region. */
export function derivedSetupStock(
  job: EngraveJob,
  measuredThicknessMm: number | null,
  // #1244 — the map from the caller's edge; null: no location, the recommendations.
  defaults: ShopDefaults | null,
): SetupStock | null {
  const region = cutRegionOf(job, defaults);
  if (region === null) return null;
  return {
    length: r3(region.maxX - region.minX),
    width: r3(region.maxY - region.minY),
    thickness: r3(measuredThicknessMm ?? job.stock.thickness),
    provenance: 'derived',
  };
}

/**
 * THE STOCK THIS SETUP IS CUT FROM: the operator's stated box when it has one, else — for a
 * FLIPPED setup (the vendor method's side 2) — the derived freed part, else null (the job's blank,
 * the caller's default).
 */
export function setupStockFor(
  job: EngraveJob,
  setup: Pick<JobSetup, 'stock' | 'flip'> | undefined,
  measuredThicknessMm: number | null,
): SetupStock | null {
  if (setup === undefined) return null;
  if (setup.stock !== undefined) return setup.stock;
  if (setup.flip === undefined) return null;
  return derivedSetupStock(job, measuredThicknessMm, null);
}

/**
 * #1082 stage 2 — THE BOX A SETUP IS CUT FROM, resolved for a caller that knows the setup: the
 * setup's stated box, else its derived freed part, else the JOB'S BLANK — so every pre-#1082
 * caller gets exactly the three numbers it read before.
 */
export function stockForSetup(
  job: EngraveJob,
  setupIndex: number | undefined,
): { length: number; width: number; thickness: number } {
  const setups = job.setups ?? [];
  const setup = setupIndex === undefined ? undefined : setups[setupIndex];
  // #1082 — STATED ONLY. The derived freed part is an OFFER the operator confirms in the flip row;
  // a reader that derived it here would silently re-plan every existing vendor-flip job (the
  // delivered tray NCs are byte-identical precisely because nothing was confirmed on them).
  const own = setup?.stock ?? null;
  return own === null
    ? { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness }
    : { length: own.length, width: own.width, thickness: own.thickness };
}

/**
 * #1082 — THE BLANK'S MEASURED THICKNESS, from the bed profile: the registration's measured
 * top-surface touch less the measured bracket seat — the SAME two datums #1073's side-2 Z0 reads
 * (`flipChoice.flipZ0`), so the number is reused, never re-derived here. Null unless the house has
 * both (then the box uses the stated thickness and says so).
 */
export function measuredBlankThickness(
  profile: { datums?: { surfaceTopZ?: { value: number } | null; bracketSeatZ?: { value: number } | null } } | null | undefined,
): number | null {
  const top = profile?.datums?.surfaceTopZ ?? null;
  const seat = profile?.datums?.bracketSeatZ ?? null;
  if (top === null || seat === null) return null;
  const t = top.value - seat.value;
  return Number.isFinite(t) && t > 0 ? Math.round(t * 1000) / 1000 : null;
}
