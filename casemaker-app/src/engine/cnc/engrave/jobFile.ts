/**
 * THE JOB FILE (#425 §6): `<name>.cutjob.json` as text, and what a reader must know before it
 * replaces the open document.
 *
 * The serialized form IS the document (`EngraveJob`, schema version 3). There is no wrapper and no
 * second copy of the program texts: the package block, the run log and the sources live inside it.
 *
 * PARSING IS TWO QUESTIONS, and they are deliberately separate:
 *
 *  - SCHEMA — `parseEngraveJob` decides whether this build can read the document at all. A newer
 *    literal, an unknown key inside an owned block, or a bad field is refused by path and the
 *    caller leaves the open job exactly as it was.
 *  - INTEGRITY — once it parses, the package's texts are re-hashed (`validatePackage`) and every
 *    source record is verified (`verifyJobSources`). Neither is a reason to refuse the file: the
 *    job opens, the package is reported unusable, and a required source that is gone is reported
 *    with §6's sentence. Generate/Cut refuse later, from those reports.
 */

import {
  validatePackage,
  type PackageIntegrity,
} from '@/engine/cnc/engrave/package';
import {
  requiredSourceHashes,
  sourceRefusal,
  verifyJobSources,
  type SourceCheck,
} from '@/engine/cnc/engrave/jobSources';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { sha256Hex } from '@/engine/import/meshStock';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

/** The suffix every saved job carries. */
export const JOB_FILE_EXTENSION = '.cutjob.json';

/** The picker's description of a job file — one place, so Save and Open cannot disagree. */
export const JOB_FILE_TYPE: { description: string; accept: Record<string, string[]> } = {
  description: 'Case Maker job',
  accept: { 'application/json': [JOB_FILE_EXTENSION, '.json'] },
};

/** The document as the text a file holds: pretty JSON, the same document the app autosaves. */
export function serializeJobFile(job: EngraveJob): string {
  return JSON.stringify(job, null, 2);
}

/**
 * `<name>.cutjob.json`, with the same character rule the project's pickers use. The name is for a
 * person and a filesystem; it is never an identity (the job's `id` is).
 */
export function jobFileName(name: string): string {
  const safe = name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
  return `${safe.length > 0 ? safe : 'job'}${JOB_FILE_EXTENSION}`;
}

/** What opening a job file learned beyond the document itself. */
export interface JobFileReport {
  /** The saved package's integrity, or null when the document has no package. */
  package: PackageIntegrity | null;
  /** Every source record and its verdict, in document order. */
  sources: SourceCheck[];
  /**
   * §6's exact refusal when a source the job cannot generate without is missing or changed;
   * null when nothing is required or every required source verified.
   */
  sourceError: string | null;
  /**
   * #728 — set when the embedded target mesh's bytes do not hash to the SHA-256 the document
   * states. The hash is the mesh's identity (the blob store's key, the parse cache's key), so a
   * wrong one would overwrite another model's stored bytes; the job opens with the hash of the
   * bytes it actually carries, and this says so.
   */
  meshNote?: string | null;
}

export type JobFileParseResult =
  | ({ ok: true; job: EngraveJob } & JobFileReport)
  | { ok: false; errors: string[] };

/**
 * Parse a `.cutjob.json` and report what the document says about its own integrity.
 *
 * A schema refusal keeps the named errors (`labels[0].depth: …`, the newer-build sentence) and
 * returns no job. An integrity failure still returns the job: the document is the owner, and a
 * tampered package or a gone source is a state the Cut/generate gates refuse, not a reason to
 * throw away the rest of a person's work.
 */
export async function parseJobFile(text: string): Promise<JobFileParseResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`the file is not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = parseEngraveJob(raw);
  if (!parsed.ok) return parsed;
  let job = parsed.job;
  const sources = await verifyJobSources(job);
  let meshNote: string | null = null;
  const target = job.targetObject;
  if (target?.data !== undefined) {
    // Undecodable bytes are not judged here: the mesh parser refuses them with its own sentence.
    const data = target.data;
    const actual = await Promise.resolve()
      .then(() => sha256Hex(base64ToArrayBuffer(data)))
      .catch(() => null);
    if (actual !== null && actual !== target.sha256) {
      job = { ...job, targetObject: { ...target, sha256: actual } };
      meshNote =
        `The mesh “${target.name}” in this file does not match the fingerprint the file gives it; ` +
        `it opens as the mesh the file carries. Save the job to write the right fingerprint.`;
    }
  }
  return {
    ok: true,
    job,
    meshNote,
    package: job.package === undefined ? null : validatePackage(job.package),
    sources,
    sourceError: sourceRefusal(sources, requiredSourceHashes(job)),
  };
}
