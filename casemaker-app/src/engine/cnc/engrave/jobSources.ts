/**
 * THE FILES A JOB WAS MADE FROM (#425 §4): collect, embed, and verify them.
 *
 * The derived geometry is what the job actually cuts — `vectors[].contours`, a label's laid-out
 * glyphs, the stock's own dimensions. That is why a saved job opens, renders and generates with
 * no original file beside it. The source bytes are PROVENANCE, and the thing a re-import can
 * prove itself against: a file that is identical is the same import, and a file that has changed
 * is refused instead of silently becoming a different design.
 *
 * Records are CONTENT-ADDRESSED by the SHA-256 of the raw bytes, so the same file named twice
 * (an SVG used for two items, or the same 3MF design re-imported) has one record. Embedding is
 * capped PER SOURCE at 4 MiB: a larger file is still recorded, by name, size and hash, with
 * `embedded: null` — the job carries a reference a desktop build can resolve, rather than a
 * document no autosave slot can hold. The cap is a storage rule, never a reason to refuse an
 * import.
 *
 * Nothing here reads a file or a DOM. A caller hands over bytes; the browser's File picker and
 * the desktop path reader stay in their own modules.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '@/engine/import/base64';
import { sha256Hex } from '@/engine/import/meshStock';
import type { EngraveJob, JobSource } from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';

/**
 * The largest source that travels inside the document, bytes (4 MiB — the issue's number, and the
 * design's "up to 4 MB"). Per source, not per document: a job with four small files embeds four
 * small files.
 */
export const MAX_EMBEDDED_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * The exact sentence generate shows when it needs a source's bytes and they are not there —
 * missing, or no longer the file the job was made from. §6 states it verbatim, and a refusal a
 * person has been told once should read the same every time.
 */
export const SOURCE_MISSING_SENTENCE = 'the file this job was made from is missing or changed';

export type SourceKind = JobSource['kind'];

/** The extensions this app imports, by the record kind they make. Case-insensitive. */
const EXTENSION_KINDS: Readonly<Record<string, SourceKind>> = {
  svg: 'svg',
  dxf: 'dxf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  bmp: 'image',
  gif: 'image',
  '3mf': '3mf',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
};

/**
 * The record kind a file name implies, or null for a name with no extension this app imports.
 *
 * A file whose name ends in `.svg` is an SVG here regardless of what its bytes turn out to be:
 * the reader that parsed it has already said what it read, and this function only labels the
 * record. Callers that know better (an imported outline) pass the kind themselves.
 */
export function sourceKindForName(name: string): SourceKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_KINDS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** SHA-256 of a file's raw bytes, lower-case hex — the record's identity. */
export function sha256HexOfBytes(bytes: ArrayBuffer): Promise<string> {
  return sha256Hex(bytes);
}

/** `5.0 MB` — the size as the person who picked the file thinks of it. */
function sizeInMb(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why the bytes did not travel with the job, when they were too large. Names the file and its
 * size, because a silent downgrade from "embedded" to "referenced" is exactly the kind of change
 * a person discovers at the worst moment.
 */
export function embeddingSkippedSentence(name: string, size: number): string {
  return (
    `${name} is ${sizeInMb(size)} — larger than the ${MAX_EMBEDDED_SOURCE_BYTES / (1024 * 1024)} MiB ` +
    'limit for embedding, so the job carries its name and SHA-256 instead of its bytes.'
  );
}

/** What a caller has in hand when a file is imported. */
export interface SourceInput {
  kind: SourceKind;
  /** The file's own name, or a 3MF project's Title. */
  name: string;
  /** The raw bytes — exactly what the import read. */
  bytes: ArrayBuffer;
  /** A path when one is known (CLI/desktop); null in the browser. */
  path?: string | null;
  /**
   * The digest, when the caller already computed it (the 3MF stock route hashes to compare a
   * re-import before it ever gets here). Omitted, it is computed from `bytes`.
   */
  sha256?: string;
}

/** A source record, and the sentence to show when its bytes did not fit. */
export interface EmbeddedSource {
  source: JobSource;
  /** Null when the bytes are embedded; otherwise `embeddingSkippedSentence`. */
  skipped: string | null;
}

/**
 * Turn a picked file into a document record, embedding its bytes when they fit the 4 MiB cap.
 *
 * The SHA-256 is computed over the RAW bytes, before any encoding, so it is the same number the
 * import and the stock record already carry. `size` is the byte length, and is kept for a file
 * that was not embedded so the record can say how large the file it names is.
 */
export async function embedSource(input: SourceInput): Promise<EmbeddedSource> {
  const size = input.bytes.byteLength;
  const sha256 = input.sha256 ?? (await sha256HexOfBytes(input.bytes));
  const common = {
    sha256,
    kind: input.kind,
    name: input.name,
    size,
    path: input.path ?? null,
  } as const;
  if (size > MAX_EMBEDDED_SOURCE_BYTES) {
    return {
      source: { ...common, embedded: null },
      skipped: embeddingSkippedSentence(input.name, size),
    };
  }
  return {
    source: {
      ...common,
      embedded: { encoding: 'base64', data: arrayBufferToBase64(input.bytes) },
    },
    skipped: null,
  };
}

/**
 * The record for a custom font. The font's bytes already live in `customFonts[].data`, so the
 * record carries its HASH and size rather than a second copy of the base64 — the two would be
 * megabytes of duplication, and one of them would eventually be stale. Verification matches the
 * record back to its font by name.
 */
export async function sourceForFont(font: CustomFont): Promise<JobSource> {
  const bytes = base64ToArrayBuffer(font.data);
  return {
    sha256: await sha256HexOfBytes(bytes),
    kind: 'font',
    name: font.name,
    embedded: null,
    size: bytes.byteLength,
    path: null,
  };
}

/**
 * Add `source` to a list, keeping one record per SHA-256.
 *
 * An existing record beats a new one when they disagree about the BYTES: a file already embedded
 * stays embedded when a later header-only record for the same content arrives, and a header-only
 * record is upgraded if the bytes later become available. The name and size are refreshed from
 * the new record, since they are what a person sees.
 */
export function withSource(
  existing: readonly JobSource[] | undefined,
  source: JobSource,
): JobSource[] {
  const list = existing ?? [];
  const at = list.findIndex((s) => s.sha256 === source.sha256);
  if (at < 0) return [...list, source];
  const current = list[at]!;
  const merged: JobSource = {
    ...source,
    embedded: current.embedded ?? source.embedded,
    path: current.path ?? source.path,
  };
  return list.map((s, i) => (i === at ? merged : s));
}

/** One record's verdict. `missing` also covers a record that carries no bytes and no source. */
export type SourceStatus = 'ok' | 'changed' | 'missing';

/** The verification inputs a caller can supply for records that do not carry their bytes. */
export interface SourceVerifyOptions {
  /**
   * The bytes for a record whose `embedded` is null — a desktop build reading the recorded path,
   * or a test handing over the file it knows. Returning null/undefined means the file was not
   * reachable, which is `missing`.
   */
  bytesFor?: (source: JobSource) => ArrayBuffer | null | undefined;
  /** The job's own embedded fonts, for `kind: 'font'` records. Matched by name. */
  fonts?: readonly CustomFont[];
}

/**
 * Verify one record against its recorded SHA-256.
 *
 * Embedded bytes are authoritative: a byte that changed after Save is `changed`, and a record
 * that cannot produce any bytes is `missing`. Font records are special only in WHERE their bytes
 * live — `customFonts[].data` — and a font the job no longer carries is missing.
 */
export async function verifySource(
  source: JobSource,
  options: SourceVerifyOptions = {},
): Promise<SourceStatus> {
  let bytes: ArrayBuffer | null;
  if (source.embedded !== null) {
    bytes = base64ToArrayBuffer(source.embedded.data);
  } else if (source.kind === 'font') {
    const font = options.fonts?.find((f) => f.name === source.name);
    bytes = font === undefined ? null : base64ToArrayBuffer(font.data);
  } else {
    bytes = options.bytesFor?.(source) ?? null;
  }
  if (bytes === null) return 'missing';
  return (await sha256HexOfBytes(bytes)) === source.sha256 ? 'ok' : 'changed';
}

/** One record and its verdict. */
export interface SourceCheck {
  source: JobSource;
  status: SourceStatus;
}

/** Verify every source the document carries, in the document's own order. */
export async function verifySources(
  sources: readonly JobSource[] | undefined,
  options: SourceVerifyOptions = {},
): Promise<SourceCheck[]> {
  const list = sources ?? [];
  return Promise.all(
    list.map(async (source) => ({ source, status: await verifySource(source, options) })),
  );
}

/** The same check for a whole job, reading its `customFonts` for font records. */
export function verifyJobSources(job: EngraveJob): Promise<SourceCheck[]> {
  return verifySources(job.sourceFiles, { fonts: job.customFonts });
}

/**
 * The SHA-256s of the source records the job cannot generate without.
 *
 * The normal case is derived geometry: every imported vector stores the contours it was reduced
 * to, so a missing source is a note and the job still generates. An item that names a source but
 * carries NO geometry is the case the source is required for — a vector whose contours were not
 * stored (or were lost to a bad edit) still says which file it came from, and that file is the
 * only way to rebuild it.
 */
export function requiredSourceHashes(job: EngraveJob): ReadonlySet<string> {
  const required = new Set<string>();
  for (const vector of job.vectors ?? []) {
    if (vector.importedFrom !== undefined && vector.contours.length === 0) {
      required.add(vector.importedFrom.sha256);
    }
  }
  return required;
}

/**
 * The refusal generate shows for a required source that is missing or changed, or null when every
 * required source verifies (or no source is required). The sentence is §6's, verbatim.
 */
export function sourceRefusal(
  checks: readonly SourceCheck[],
  required: ReadonlySet<string>,
): string | null {
  for (const check of checks) {
    if (required.has(check.source.sha256) && check.status !== 'ok') return SOURCE_MISSING_SENTENCE;
  }
  return null;
}

/** One call for a generate gate: verify the job's sources and refuse if a required one is gone. */
export async function jobSourceRefusal(job: EngraveJob): Promise<string | null> {
  const checks = await verifyJobSources(job);
  return sourceRefusal(checks, requiredSourceHashes(job));
}
