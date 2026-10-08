/**
 * The run record (#277, `/Makera-Parity.md` §14.1) — the run sheet's §9 answers as a FILE, written
 * beside the `.nc` it describes.
 *
 * WHY A FILE AND NOT A STORE (the maintainer's decision on #277, 2026-10-07). §14.4 R1 refuses a
 * third home for machine facts, and a run's outcome is a machine fact like any other. So the
 * record lives beside the program, one JSON per run, in the shape #248's coupon record already
 * uses — and `scripts/run-readback.ts` folds a filled one back into the app through the same
 * round trip `scripts/feeds-readback.ts` closes for feeds.
 *
 * THE APP WRITES ONLY WHAT IT CAN KNOW. Job name, the `.nc` it will be cut from (name and the
 * hash the sheet printed), the tool, the cycle estimate, and one blank per §9 row — the file's
 * whole measured half is `null`. The app does not drive the machine (decision 10), so it cannot
 * know a wall clock or a measured floor depth, and nothing here may ever look as though it did:
 * `isMeasuredRun` requires the DATE A PERSON WROTE, and `parseRunRecord` refuses a record that
 * carries readings without one. That is the rule the coupon record follows, applied to a run.
 *
 * The §9 rows come from `recordDepths(plan)` in `runSheet.ts` — the same list the printed sheet
 * prints its blanks from — so a filled record can never answer a row the sheet did not ask.
 *
 * Pure: build, serialize and parse touch no DOM, no store and no wasm.
 */

import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { recordDepths, runSheetFileName, sha256Hex, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/** Magic string that says "this is a Case Maker run record", not some other JSON. */
export const RUN_RECORD_KIND = 'casemaker-run';
/** Bump when the record shape changes incompatibly; a reader refuses unknown versions. */
export const RUN_RECORD_SCHEMA_VERSION = 1;

/** The words §9 offers for the surface, in the sheet's own order (`runSheet.ts` §9). */
export const RUN_FINISHES = ['clean', 'fuzzy', 'burnt'] as const;
export type RunFinish = (typeof RUN_FINISHES)[number];

/** One item's row in §9: the depth the program cut, and the depth the operator measured. */
export interface RunRecordDepth {
  /** The cut item's id on the plan — the same id the sheet's row and the `.nc`'s operation carry. */
  id: string;
  name: string;
  /** The depth the program was posted at, mm. */
  planned: Mm;
  /** What the operator measured, mm. `null` until they say. */
  measured: Mm | null;
}

/**
 * One finished run (#277). Everything above `generatedOn` is the app's; everything below is a
 * person's, and every field of it is `null` in the file Save writes.
 */
export interface RunRecord {
  kind: typeof RUN_RECORD_KIND;
  schemaVersion: number;
  /** The job as it was named when the program was posted. */
  job: string;
  /** The `.nc` this run cut — the file the operator loaded (`runSheetFileName`). */
  ncFile: string;
  /** First 8 hex of SHA-256 of the `.nc` text — the hash the run sheet printed (#207). */
  ncHash: string;
  /** The cutter the job named, and its cutting diameter, mm. */
  tool: string | null;
  cuttingDiameter: number | null;
  /**
   * The cycle estimate the sheet printed, seconds (#242). Carried so the measured wall clock has
   * the planning figure it corrects sitting next to it in the file — the estimate itself is
   * never touched by a measurement.
   */
  estimatedSeconds: number | null;
  /** ISO date (`YYYY-MM-DD`) the record file was written. The app's date, never a measurement. */
  generatedOn: string;
  // ---- the measured half: a person's, blank in the file Save writes ----
  /**
   * ISO date (`YYYY-MM-DD`) the job was CUT. REQUIRED before anything else here counts as a
   * reading: a measurement with no date is a number nobody can place.
   */
  cutOn: string | null;
  /** Wall-clock minutes the cut took, start to finish. */
  minutes: number | null;
  /** The cutter's flute length and stick-out, mm (§9, section 1's blank). */
  cutter: { fluteLengthMm: number | null; stickOutMm: number | null };
  /** The measured stock proud of the jaws, mm (§9, section 3's blank). */
  stockProudMm: number | null;
  /** One row per cut item (§9's measured floor depths), from `recordDepths`. */
  depths: RunRecordDepth[];
  /** Was the text legible? §9's yes/no. */
  legible: boolean | null;
  /** §9's clean / fuzzy / burnt. */
  finish: RunFinish | null;
  /** §9's "anything that went wrong". A note is not a reading — it needs no date. */
  notes: string;
  /** What the app tells the operator to do with this file. Never read back as data. */
  instructions: string;
}

export type RunRecordParseResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: string };

/** `2026-10-05`, exactly. */
function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * The record file's name (#277): the job's own program name with `-run.json` where `.nc` was, so
 * it sits beside the program and cannot be confused with it. Shares `runSheetFileName`, so the
 * record, the program and the sheet can never disagree about what the job is called.
 */
export function runRecordFileName(jobName: string): string {
  return `${runSheetFileName(jobName).slice(0, -'.nc'.length)}-run.json`;
}

/** The line every record file carries, telling the operator what to fill and what to do next. */
export const RUN_RECORD_INSTRUCTIONS =
  'Fill the measured half after the cut: cutOn (YYYY-MM-DD) and minutes are the wall clock, ' +
  'depths[].measured is what you measured, plus legible, finish and notes. Nothing here is a ' +
  'measurement until cutOn is dated. Then run scripts/run-readback.ts on this file — that is what ' +
  'brings it back into the app, beside the cycle estimate it corrects.';

/**
 * The record the app can write for a job it has just posted. Everything a person must supply is
 * `null`/empty; the only values filled in are the ones the app actually knows (#277's decision).
 */
export function buildRunRecord(
  job: EngraveJob,
  generated: RunSheetGenerated,
  now: Date = new Date(),
): RunRecord {
  const tool = jobTool(job);
  const nc = generated.nc;
  return {
    kind: RUN_RECORD_KIND,
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    job: job.name,
    ncFile: runSheetFileName(job.name),
    ncHash: nc === null ? '' : sha256Hex(nc).slice(0, 8),
    tool: tool?.name ?? null,
    cuttingDiameter: tool ? (tool.tipDiameter ?? tool.diameter) : null,
    estimatedSeconds: generated.cam?.estimatedSeconds ?? null,
    generatedOn: now.toISOString().slice(0, 10),
    cutOn: null,
    minutes: null,
    cutter: { fluteLengthMm: null, stickOutMm: null },
    stockProudMm: null,
    depths: recordDepths(toPartPlan(job)).map((d) => ({
      id: d.id,
      name: d.name,
      planned: d.depth,
      measured: null,
    })),
    legible: null,
    finish: null,
    notes: '',
    instructions: RUN_RECORD_INSTRUCTIONS,
  };
}

/** The file's text: pretty JSON with a trailing newline, like the "my machine" file (#247). */
export function serializeRunRecord(run: RunRecord): string {
  return JSON.stringify(run, null, 2) + '\n';
}

/**
 * A record counts as MEASURED only when a person dated the cut. This is the one gate the estimate's
 * "last measured" line and the readback both go through, so a blank file the app wrote — or a
 * record whose date someone deleted — can never present itself as a bench result.
 */
export function isMeasuredRun(run: RunRecord): boolean {
  return isIsoDate(run.cutOn);
}

/**
 * A dated record that also carries a wall-clock time — what can honestly be shown beside a cycle
 * estimate. A dated record with no `minutes` has no number to put there.
 */
export function isTimedRun(run: RunRecord): boolean {
  return isMeasuredRun(run) && typeof run.minutes === 'number' && run.minutes > 0;
}

/** A `null`, or a finite number greater than zero. */
function positiveOrNull(v: unknown): number | null | false {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return false;
  return v;
}

/** A `null`, or a finite number (any sign — a stock-proud reading may legitimately be 0). */
function finiteOrNull(v: unknown): number | null | false {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return v;
}

/** The same, with a wrong type read as "absent" rather than as a refusal — for the app's own half. */
function numberOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n === false ? null : n;
}

/** Every reading a person could have taken, so the "dated?" rule can be enforced over all of them. */
function hasReadings(r: RunRecord): boolean {
  return (
    r.minutes !== null ||
    r.stockProudMm !== null ||
    r.legible !== null ||
    r.finish !== null ||
    r.cutter.fluteLengthMm !== null ||
    r.cutter.stickOutMm !== null ||
    r.depths.some((d) => d.measured !== null)
  );
}

/**
 * Validate a parsed record (#277). Strict and whole-or-nothing, like the "my machine" record: a
 * field that is the wrong type, or a reading with no date, refuses the whole file with a reason
 * the UI can show. Nothing is coerced and nothing is defaulted — a record is either the run that
 * happened or it is not a record.
 */
export function parseRunRecord(raw: unknown): RunRecordParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'this is not a Case Maker run record' };
  }
  const r = raw as Record<string, unknown>;
  if (r.kind !== RUN_RECORD_KIND) {
    return { ok: false, reason: 'this is not a Case Maker run record' };
  }
  if (r.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) {
    const v = typeof r.schemaVersion === 'number' ? r.schemaVersion : 'missing';
    return {
      ok: false,
      reason: `unsupported file version ${v}; this build reads version ${RUN_RECORD_SCHEMA_VERSION}`,
    };
  }
  if (typeof r.job !== 'string' || r.job.trim() === '') {
    return { ok: false, reason: 'the record does not name the job it was cut for' };
  }
  if (typeof r.ncFile !== 'string' || r.ncFile.trim() === '') {
    return { ok: false, reason: 'the record does not name the .nc it describes' };
  }
  if (r.cutOn !== null && !isIsoDate(r.cutOn)) {
    return { ok: false, reason: 'cutOn must be a YYYY-MM-DD date, or null if the job has not been cut' };
  }
  const minutes = positiveOrNull(r.minutes);
  if (minutes === false) return { ok: false, reason: 'minutes must be a positive number, or null' };
  const stockProud = finiteOrNull(r.stockProudMm);
  if (stockProud === false) {
    return { ok: false, reason: 'stockProudMm must be a number, or null' };
  }
  if (r.legible !== null && typeof r.legible !== 'boolean') {
    return { ok: false, reason: 'legible must be true, false, or null' };
  }
  if (r.finish !== null && !RUN_FINISHES.includes(r.finish as RunFinish)) {
    return { ok: false, reason: `finish must be one of ${RUN_FINISHES.join(' / ')}, or null` };
  }
  if (typeof r.notes !== 'string') {
    return { ok: false, reason: 'notes must be a string (empty when there is nothing to say)' };
  }
  const cutter = r.cutter as Record<string, unknown> | null | undefined;
  if (typeof cutter !== 'object' || cutter === null) {
    return { ok: false, reason: 'the record has no cutter section' };
  }
  const flute = finiteOrNull(cutter.fluteLengthMm);
  const stickOut = finiteOrNull(cutter.stickOutMm);
  if (flute === false || stickOut === false) {
    return { ok: false, reason: 'cutter.fluteLengthMm and cutter.stickOutMm must be numbers, or null' };
  }
  if (!Array.isArray(r.depths)) {
    return { ok: false, reason: 'the record has no depths array' };
  }
  const depths: RunRecordDepth[] = [];
  for (const [i, d] of r.depths.entries()) {
    if (typeof d !== 'object' || d === null) {
      return { ok: false, reason: `depths[${i}] is not a row` };
    }
    const row = d as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') {
      return { ok: false, reason: `depths[${i}] needs a string id and name` };
    }
    if (typeof row.planned !== 'number' || !Number.isFinite(row.planned)) {
      return { ok: false, reason: `depths[${i}].planned must be a number` };
    }
    const measured = positiveOrNull(row.measured);
    if (measured === false) {
      return { ok: false, reason: `depths[${i}].measured must be a positive number, or null` };
    }
    depths.push({ id: row.id, name: row.name, planned: row.planned, measured });
  }

  const run: RunRecord = {
    kind: RUN_RECORD_KIND,
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    job: r.job,
    ncFile: r.ncFile,
    ncHash: typeof r.ncHash === 'string' ? r.ncHash : '',
    tool: typeof r.tool === 'string' ? r.tool : null,
    cuttingDiameter: numberOrNull(r.cuttingDiameter),
    estimatedSeconds: numberOrNull(r.estimatedSeconds),
    generatedOn: typeof r.generatedOn === 'string' ? r.generatedOn : '',
    cutOn: isIsoDate(r.cutOn) ? r.cutOn : null,
    minutes,
    cutter: { fluteLengthMm: flute, stickOutMm: stickOut },
    stockProudMm: stockProud,
    depths,
    legible: (r.legible as boolean | null) ?? null,
    finish: (r.finish as RunFinish | null) ?? null,
    notes: r.notes,
    instructions: typeof r.instructions === 'string' ? r.instructions : RUN_RECORD_INSTRUCTIONS,
  };

  // #277's acceptance rule, the coupon record's rule applied to a run: a person records a result,
  // the app does not invent one. A file with readings in it and no date is exactly the hand-edit
  // that would smuggle an unmeasured number into the app looking measured, so it is refused
  // rather than quietly dropped and reread later as blank.
  if (hasReadings(run) && !isMeasuredRun(run)) {
    return {
      ok: false,
      reason:
        'the record carries bench readings but no cutOn date — a measurement must carry the date ' +
        'it was taken (YYYY-MM-DD). A record with no date is not a result.',
    };
  }

  return { ok: true, run };
}

/** Parse the file's text. Non-JSON is refused with a reason rather than thrown. */
export function parseRunRecordText(text: string): RunRecordParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the file is not valid JSON' };
  }
  return parseRunRecord(raw);
}
