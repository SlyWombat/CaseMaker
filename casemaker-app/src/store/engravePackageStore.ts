/**
 * The frozen packages this JOB DOCUMENT holds (#419 §4, #425 R8).
 *
 * THE DOCUMENT IS THE OWNER. A package lives in `EngraveJob.package` (`types/engraveJob.ts`) and
 * travels with the job through Save/Open; there is no `localStorage` copy and nothing is migrated
 * from the old `casemaker.packages.v1` cache. A package that only ever existed in a browser was
 * never a document, and the next freeze re-establishes approval.
 *
 * Freezing also takes the job's blank on the shelf, because the moment a person approves a job is
 * the moment its stock stops being available to anything else.
 *
 * TWO RULES THIS STORE OWNS (decision 2):
 *
 *  - A STALE PACKAGE KEEPS ITS RESERVATION. Nothing here releases on staleness: `freeze` writes the
 *    new package, and `release` is the one call that lets the blank go. The blank is physically on
 *    the bench; a job edited mid-session is a job half-way through re-generating, not an abandoned
 *    one.
 *  - A RE-FREEZE MOVES ITS RESERVATION, never doubles it. The hold is keyed to the job id, so
 *    `reserveStock` replaces this job's hold rather than adding a second one; when the job's stock
 *    entry changed, the old entry's hold is released after the new one is taken.
 *
 * The engine half — the hashes, the frozen texts, the staleness and integrity comparisons — is
 * `package.ts`; this is only where that lives and which blank it holds.
 */

import { create } from 'zustand';
import type { EngraveJob } from '@/types/engraveJob';
import { freezePackage, type FrozenPackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { useEngraveJobStore } from './engraveJobStore';
import { useStockStore } from './stockStore';

/** What taking the blank did, in the words the Cut screen can show. */
export type PackageReservation =
  /** The blank is held for this job. */
  | { kind: 'held'; text: string }
  /** The job's stock is not a shelf entry (a file, or "made") — nothing to hold. */
  | { kind: 'none'; text: string }
  /** The shelf refused — none left, or it could not be reached. The package still exists. */
  | { kind: 'refused'; text: string };

export type PackageFreeze =
  | { ok: true; package: FrozenPackage; reservation: PackageReservation }
  | { ok: false; reason: string };

/** The open document's package, when the ids agree. */
function documentPackage(jobId: string): FrozenPackage | null {
  const job = useEngraveJobStore.getState().job;
  return job.id === jobId ? (job.package ?? null) : null;
}

/**
 * The open document's package as a list, for the Cut panel's existing `packages` selector. It is a
 * reactive VIEW, not a second authority: it is rebuilt from the document whenever the block or the
 * job id moves, and nothing persists it.
 */
function documentPackages(): FrozenPackage[] {
  const pkg = useEngraveJobStore.getState().job.package;
  return pkg === undefined ? [] : [pkg];
}

export interface EngravePackageState {
  /** A view of the open document's package (zero or one). Never written to storage. */
  packages: FrozenPackage[];
  /** The package for one job, read from the open document, or null. */
  packageFor: (jobId: string) => FrozenPackage | null;
  /**
   * Freeze `job` as it is now around the programs just generated, write the block into the
   * document, and take its blank.
   *
   * Refuses a job with no program (`freezePackage`'s rule) — an approved Cut screen always has one.
   * A shelf that cannot be written does NOT refuse the freeze: the package is the run, the
   * reservation is the bench's bookkeeping, and the returned `reservation` says which happened.
   * A job that is not the open document is frozen but not written anywhere — there is no document
   * to own it — and the caller sees that in `packageFor`.
   */
  freeze: (job: EngraveJob, programs: readonly PackageProgramInput[]) => Promise<PackageFreeze>;
  /** Let the job's blank go. The package stays in the document (a stale package keeps its text). */
  release: (jobId: string) => Promise<boolean>;
}

export const useEngravePackageStore = create<EngravePackageState>()((set, get) => ({
  packages: documentPackages(),

  packageFor: (jobId) => documentPackage(jobId),

  freeze: async (job, programs) => {
    const made = freezePackage(job, programs, new Date().toISOString());
    if (!made.ok) return made;
    const pkg = made.package;

    const open = useEngraveJobStore.getState();
    const previous = open.job.id === job.id ? (open.job.package ?? null) : null;
    if (open.job.id === job.id) open.setPackage(pkg);

    const reservation = await takeStock(pkg.stockEntryId, job.id);
    // The job's stock entry changed: the old blank is no longer what this job uses. Released only
    // after the new hold is in, so a refusal on the new entry leaves the old one safe.
    if (reservation.kind !== 'refused' && previous !== null && previous.stockEntryId !== pkg.stockEntryId) {
      if (previous.stockEntryId !== null) await useStockStore.getState().release(previous.stockEntryId, job.id);
    }
    return { ok: true, package: pkg, reservation };
  },

  release: async (jobId) => {
    const pkg = get().packageFor(jobId);
    if (pkg === null || pkg.stockEntryId === null) return true;
    return useStockStore.getState().release(pkg.stockEntryId, jobId);
  },
}));

/**
 * Keep the compatibility view in step with the document. Subscribing (rather than reading inside
 * the selector) is what makes the Cut panel re-render when a freeze writes the block; the block
 * itself is still the one stored in `EngraveJob.package`.
 */
useEngraveJobStore.subscribe((state, previous) => {
  if (state.job.package !== previous.job.package || state.job.id !== previous.job.id) {
    useEngravePackageStore.setState({ packages: documentPackages() });
  }
});

/**
 * Take the job's blank, quantity one — a job cuts one blank.
 *
 * The shelf is read before it is written when this browser has not read it yet: `reserveStock`
 * refuses an entry it cannot see, and "not on the shelf" would be said about a shelf that was never
 * loaded.
 */
async function takeStock(stockEntryId: string | null, jobId: string): Promise<PackageReservation> {
  if (stockEntryId === null) {
    return { kind: 'none', text: 'this job’s stock is not a shelf entry, so no blank is held' };
  }
  const stock = useStockStore.getState();
  if (stock.status === 'unknown') await stock.refresh();
  const held = await useStockStore.getState().reserve(stockEntryId, jobId, 1);
  if (held) return { kind: 'held', text: 'blank held for this job' };
  const notice = useStockStore.getState().notice;
  return { kind: 'refused', text: notice?.text ?? 'the shelf refused the blank' };
}

/** Test seam. */
export function resetEngravePackageStore(): void {
  useEngravePackageStore.setState({ packages: [] });
}
