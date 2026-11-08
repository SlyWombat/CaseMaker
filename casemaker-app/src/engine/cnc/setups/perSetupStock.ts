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
import { cutRegionOf } from '@/engine/cnc/registration/footprintJob';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The freed part's box, from side 1's cut extents; null when the job states no cut region. */
export function derivedSetupStock(job: EngraveJob, measuredThicknessMm: number | null): SetupStock | null {
  const region = cutRegionOf(job);
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
  return derivedSetupStock(job, measuredThicknessMm);
}
