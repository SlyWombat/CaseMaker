/**
 * THE PACKAGE (#419 §4): what Cut freezes when its gate is all green, and how it is known to be
 * stale afterwards.
 *
 * A package is everything the run needs, frozen at one instant:
 *
 *  - the program texts, one per (setup, tool), each with its FNV key — and each frame file with its
 *    own key, because a frame the operator runs first is part of what was approved;
 *  - the setups as they were (the stored record, or the one implicit setup `jobSetups` derives);
 *  - the job's fingerprint — an FNV over the job's own data, canonically ordered. This is what
 *    makes staleness survive a reload: the package is compared against the CURRENT job by value,
 *    not by object identity, so closing the app and reopening it cannot make a changed job look
 *    unchanged.
 *  - the shelf entry it reserved (`job.stockEntry.shelfId`), if any.
 *
 * THE HASH IS FNV, NOT SHA-256 (decision 3). `programHash` is the run's own key — the run
 * confirmation's, and the one `RunPlanInput.finishedHashes` matches against — so the package hash
 * is derived from the programs' keys rather than being a second kind of identity. The run sheet's
 * `fileHash` and the run record's `ncHash` stay SHA-256: those are the human/printed hash, a
 * different question asked by a different reader.
 *
 * STALENESS IS A COMPARISON, NOT A TIMER (decision 2). A stale package is not deleted: it KEEPS the
 * stock reservation until the job is released or a new package is frozen, because the blank is
 * physically on the bench and the person may be half-way through re-generating. The Cut screen says
 * so in words ("reserved by the package of 14:02, now stale; the blank is still held").
 */

import type { EngraveJob, FrozenPackage, FrozenProgram, JobRunLogEntry } from '@/types/engraveJob';
import { jobSetups } from './jobSetup';
import { programHash } from '@/engine/cnc/programHash';

/**
 * The document's own types (#425): the package block lives in `EngraveJob.package`, so the types
 * are declared beside it and re-exported here, where every existing caller imports them.
 */
export type { FrozenPackage, FrozenProgram } from '@/types/engraveJob';

/** What a freeze needs from a generated program — `EngraveProgram` satisfies it structurally. */
export interface PackageProgramInput {
  setupIndex: number;
  setupId: string;
  toolKey: string;
  nc: string;
  frameNc: string | null;
  programHash: string;
}

/**
 * A stable, order-independent serialisation of a value: object keys sorted, arrays in order, and
 * no whitespace. Two jobs that differ only in key insertion order fingerprint the same; a job that
 * differs in any VALUE does not.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not a JSON value and must not fingerprint as one: a field present-but-undefined
    // and a field absent are the same document, and the schema's optional fields are exactly that.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The part of the document a program depends on (#425): everything except the package block,
 * the run log, and the source files' embedded bytes.
 *
 * The exclusions are what make the block SAFE to store inside the job it describes. A naive
 * fingerprint of the whole document would change the moment the package was written into it, so
 * the freeze would stale itself; appending a run log would stale it again. The embedded bytes are
 * derived provenance, not a program input — their `sha256` is kept, so a CHANGED source still
 * moves the fingerprint while embedding the same file later does not.
 */
function fingerprintView(job: EngraveJob): unknown {
  const view: Record<string, unknown> = { ...job };
  delete view.package;
  delete view.runLog;
  const sourceFiles = view.sourceFiles;
  if (Array.isArray(sourceFiles)) {
    view.sourceFiles = sourceFiles.map((source: { embedded?: unknown } & Record<string, unknown>) => {
      const withoutBytes: Record<string, unknown> = { ...source };
      delete withoutBytes.embedded;
      return withoutBytes;
    });
  }
  return view;
}

/** FNV over the job's program-relevant data — name, stock, items, setups, margins, cutter, facing. */
export function jobFingerprint(job: EngraveJob): string {
  return programHash(canonicalJson(fingerprintView(job)));
}

/** Why a freeze was refused, or the package it made. */
export type FreezeResult = { ok: true; package: FrozenPackage } | { ok: false; reason: string };

/**
 * Freeze `job` (as it is now) around the programs just generated.
 *
 * Refuses an empty program list: a package with no files is not a run, and storing one would let
 * the Cut screen offer a job with nothing to cut.
 */
export function freezePackage(job: EngraveJob, programs: readonly PackageProgramInput[], at: string): FreezeResult {
  if (programs.length === 0) return { ok: false, reason: 'there is no generated program to freeze' };
  const frozen: FrozenProgram[] = programs.map((p) => ({
    setupIndex: p.setupIndex,
    setupId: p.setupId,
    toolKey: p.toolKey,
    nc: p.nc,
    hash: p.programHash,
    frameNc: p.frameNc,
    frameHash: p.frameNc === null ? null : programHash(p.frameNc),
  }));
  const jobHash = jobFingerprint(job);
  return {
    ok: true,
    package: {
      jobId: job.id,
      frozenAt: at,
      hash: packageHash(jobHash, frozen),
      jobHash,
      programs: frozen,
      setups: structuredClone(jobSetups(job)),
      stockEntryId: job.stockEntry?.shelfId ?? null,
    },
  };
}

/** The package's own key: the job's fingerprint plus every program (and frame) key, in order. */
export function packageHash(jobHash: string, programs: readonly FrozenProgram[]): string {
  const parts = [jobHash, ...programs.flatMap((p) => [p.hash, p.frameHash ?? '-'])];
  return programHash(parts.join('|'));
}

export interface PackageStaleness {
  stale: boolean;
  /** Why, in the words the Cut screen can show; null while the package still matches the job. */
  reason: string | null;
}

/**
 * Does the package still describe `job`? Compared BY VALUE, so it survives a reload (decision 2).
 *
 * One comparison answers it: the job's fingerprint. Every program is a pure function of the job, so
 * a changed job is a changed program — and re-posting the programs to compare their texts would need
 * the worker and wasm, which a store cannot do. The frozen texts and keys stay in the package, so
 * the machine still runs exactly what was approved until the person freezes again.
 */
export function packageStaleness(pkg: FrozenPackage, job: EngraveJob): PackageStaleness {
  if (pkg.jobId !== job.id) {
    return { stale: true, reason: `the package belongs to job ${pkg.jobId}, not ${job.id}` };
  }
  if (pkg.programs.length === 0) return { stale: true, reason: 'the package holds no program' };
  if (jobFingerprint(job) !== pkg.jobHash) {
    return { stale: true, reason: 'the job changed since the package was frozen' };
  }
  return { stale: false, reason: null };
}

/** Why a stored package cannot be trusted, or null when every saved text is the approved one. */
export interface PackageIntegrity {
  ok: boolean;
  /** The sentence the Cut surface shows; null when `ok`. */
  reason: string | null;
}

/**
 * The sentence a package's saved texts get when they are not the ones that were approved. It is
 * deliberately different from staleness: a stale package is a job that changed, while an unusable
 * one is a file whose bytes were edited after the freeze (or a package whose own record is
 * inconsistent). Neither ever causes the text to be dropped or the job to fail to open.
 */
const PACKAGE_TAMPERED_SENTENCE =
  'the saved program text does not match its hash; the package will not be offered for a run';

/**
 * Is this package INTERNALLY the one it says it is? Recompute every text's FNV key, the frame keys,
 * and the package's own key, and check that each program still names a setup the package carries.
 *
 * This is NOT staleness (`packageStaleness`): a package can be perfectly intact and stale, or
 * current and tampered with. Save/Open runs this on load, because the document is the only copy of
 * the approved texts now; a mismatch keeps the job and the block, but marks the package unusable so
 * Cut refuses until a re-freeze. Program texts are the one thing a package cannot re-derive from
 * the job (that needs the worker), so the hashes are the whole guarantee.
 */
export function validatePackage(pkg: FrozenPackage): PackageIntegrity {
  if (pkg.programs.length === 0) {
    return { ok: false, reason: 'the package holds no program' };
  }
  const setups = new Set(pkg.setups.map((setup) => setup.id));
  for (const program of pkg.programs) {
    if (programHash(program.nc) !== program.hash) {
      return { ok: false, reason: PACKAGE_TAMPERED_SENTENCE };
    }
    if (program.frameNc !== null && programHash(program.frameNc) !== program.frameHash) {
      return { ok: false, reason: PACKAGE_TAMPERED_SENTENCE };
    }
    if (program.frameNc === null && program.frameHash !== null) {
      return { ok: false, reason: PACKAGE_TAMPERED_SENTENCE };
    }
    if (!setups.has(program.setupId)) {
      return {
        ok: false,
        reason: `the package names setup ${program.setupId}, which it does not carry`,
      };
    }
  }
  if (packageHash(pkg.jobHash, pkg.programs) !== pkg.hash) {
    return { ok: false, reason: 'the package does not match its own hash' };
  }
  return { ok: true, reason: null };
}

/**
 * Keep only the run-log entries that still describe a program the package carries.
 *
 * A re-freeze can add, remove or re-post a program. An outcome whose `programHash` is no longer in
 * the new package is history of a program this job no longer has — keeping it would let
 * `resumeAtSetup` think a setup is done when its current program has never run. Matching entries
 * survive, so a re-freeze does not throw away progress on the programs that did not change.
 */
export function pruneRunLog(
  runLog: readonly JobRunLogEntry[] | undefined,
  programs: readonly FrozenProgram[],
): JobRunLogEntry[] | undefined {
  if (runLog === undefined) return undefined;
  const hashes = new Set(programs.map((program) => program.hash));
  return runLog.filter((entry) => hashes.has(entry.programHash));
}

/** Where a reloaded job picks up: the first frozen program that has not finished. */
export interface ResumePoint {
  setupIndex: number;
  setupId: string;
  programHash: string;
}

/**
 * The program a reopened job resumes at — the first in the frozen package with no `finished` entry
 * in the run log. A `stopped` or `failed` program is NOT done (the same rule
 * `finishedProgramsFor` follows): a partially cut file has no honest continuation, so it is played
 * again from its beginning. Null when every program finished or the job has no package.
 */
export function resumeAtSetup(job: EngraveJob): ResumePoint | null {
  const programs = job.package?.programs;
  if (programs === undefined || programs.length === 0) return null;
  const finished = new Set(
    (job.runLog ?? []).filter((entry) => entry.outcome === 'finished').map((entry) => entry.programHash),
  );
  const next = programs.find((program) => !finished.has(program.hash));
  return next === undefined
    ? null
    : { setupIndex: next.setupIndex, setupId: next.setupId, programHash: next.hash };
}
