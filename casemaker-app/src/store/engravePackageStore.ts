/**
 * The frozen packages this browser holds (#419 §4).
 *
 * One package per job, persisted to `localStorage` beside the settings: the package IS the run's
 * identity, and an identity that a reload forgets is not one. Freezing also takes the job's blank
 * on the shelf, because the moment a person approves a job is the moment its stock stops being
 * available to anything else.
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
 * The engine half — the hashes, the frozen texts, the staleness comparison — is `package.ts`; this
 * is only where that lives and which blank it holds.
 */

import { create } from 'zustand';
import type { EngraveJob } from '@/types/engraveJob';
import { freezePackage, type FrozenPackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { useStockStore } from './stockStore';

const PACKAGES_KEY = 'casemaker.packages.v1';

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

/** A stored package is one this build can still read: the fields the run depends on are present. */
function isPackage(value: unknown): value is FrozenPackage {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Partial<FrozenPackage>;
  return (
    typeof p.jobId === 'string' &&
    typeof p.frozenAt === 'string' &&
    typeof p.hash === 'string' &&
    typeof p.jobHash === 'string' &&
    (p.stockEntryId === null || typeof p.stockEntryId === 'string') &&
    Array.isArray(p.setups) &&
    Array.isArray(p.programs) &&
    p.programs.every(
      (pr) =>
        typeof pr?.setupId === 'string' &&
        typeof pr?.toolKey === 'string' &&
        typeof pr?.nc === 'string' &&
        typeof pr?.hash === 'string' &&
        (pr?.frameNc === null || typeof pr?.frameNc === 'string') &&
        (pr?.frameHash === null || typeof pr?.frameHash === 'string'),
    )
  );
}

/** Read the stored packages back, dropping anything this build cannot read in full. */
function loadPackages(): FrozenPackage[] {
  if (typeof localStorage === 'undefined') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(PACKAGES_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPackage);
}

function persist(packages: readonly FrozenPackage[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PACKAGES_KEY, JSON.stringify(packages));
  } catch {
    // ignore quota errors — a program's text is large, and losing the package is not losing the job
  }
}

export interface EngravePackageState {
  /** Every frozen package in this browser, newest freeze last. */
  packages: FrozenPackage[];
  /** The package for one job, or null. */
  packageFor: (jobId: string) => FrozenPackage | null;
  /**
   * Freeze `job` as it is now around the programs just generated, and take its blank.
   *
   * Refuses a job with no program (`freezePackage`'s rule) — an approved Cut screen always has one.
   * A shelf that cannot be written does NOT refuse the freeze: the package is the run, the
   * reservation is the bench's bookkeeping, and the returned `reservation` says which happened.
   */
  freeze: (job: EngraveJob, programs: readonly PackageProgramInput[]) => Promise<PackageFreeze>;
  /** Let the job's blank go. The package stays (stale packages keep their text either way). */
  release: (jobId: string) => Promise<boolean>;
}

export const useEngravePackageStore = create<EngravePackageState>()((set, get) => ({
  packages: loadPackages(),

  packageFor: (jobId) => get().packages.find((p) => p.jobId === jobId) ?? null,

  freeze: async (job, programs) => {
    const made = freezePackage(job, programs, new Date().toISOString());
    if (!made.ok) return made;
    const pkg = made.package;

    const previous = get().packageFor(job.id);
    const packages = [...get().packages.filter((p) => p.jobId !== job.id), pkg];
    set({ packages });
    persist(packages);

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
