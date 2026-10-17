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

import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import { jobSetups } from './jobSetup';
import { programHash } from '@/engine/cnc/programHash';

/** One frozen program: the text, its FNV key, and its frame file's text and key. */
export interface FrozenProgram {
  setupIndex: number;
  setupId: string;
  toolKey: string;
  nc: string;
  /** FNV of `nc` — exactly `EngraveProgram.programHash`. */
  hash: string;
  frameNc: string | null;
  /** FNV of `frameNc`, or null with it. */
  frameHash: string | null;
}

/** What a freeze needs from a generated program — `EngraveProgram` satisfies it structurally. */
export interface PackageProgramInput {
  setupIndex: number;
  setupId: string;
  toolKey: string;
  nc: string;
  frameNc: string | null;
  programHash: string;
}

export interface FrozenPackage {
  /** The job whose programmes this freezes — a reservation is keyed to the same id. */
  jobId: string;
  /** ISO 8601, for the sentence the Cut screen shows ("the package of 14:02"). */
  frozenAt: string;
  /** FNV over the job's fingerprint and the programs' keys. Decision 3's package hash. */
  hash: string;
  /** FNV over the job's data at freeze time; `packageStaleness` compares against the job now. */
  jobHash: string;
  programs: FrozenProgram[];
  /** The setups as frozen: the stored record, or the derived single setup. */
  setups: JobSetup[];
  /** The shelf entry this freeze reserved, or null when the job's stock is not on the shelf. */
  stockEntryId: string | null;
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

/** FNV over the job's whole data — name, stock, items, setups, margins, cutter, facing. */
export function jobFingerprint(job: EngraveJob): string {
  return programHash(canonicalJson(job));
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
