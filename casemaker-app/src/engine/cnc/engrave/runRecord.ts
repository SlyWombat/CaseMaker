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
import { programFiles } from '@/engine/cnc/engrave/programFiles';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { cutterNameForKey } from '@/engine/cnc/toolDisplay';
import { distinctCutterKeys, settledCutterEntry } from '@/engine/cnc/engrave/cutterChecklist';
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
 * #926 — the efficiency measure the sheet printed for this program, as the record carries it. The
 * program-level figures only: the per-operation split is the sheet's to print, and the record is
 * the file that outlives the sheet.
 */
export interface RunRecordEfficiency {
  cycleSeconds: number;
  rapidSeconds: number;
  feedSeconds: number;
  airFraction: number;
  hopCount: number;
  hopSeconds: number;
  feedUtilisation: number | null;
  rapidCutRatio: number | null;
  sweptAreaMm2: number | null;
  deepestCutMm: number;
  tourBoundMm: number | null;
  tourExcess: number | null;
}

/** #1093 R4 — one program of the run, as the record lists it: its file, its hash, its frame. */
export interface RunRecordProgram {
  /** 1-based cut order (`releaseFileName`'s index). */
  index: number;
  /** 1-based setup the program cuts. */
  setupIndex: number;
  ncFile: string;
  /** First 8 hex of SHA-256 of this program's `.nc`. */
  ncHash: string;
  /** `<ncFile stem>-frame.nc` when this program produced one; null where it has none. */
  frameFile: string | null;
}

/**
 * One finished run (#277). Everything above `generatedOn` is the app's; everything below is a
 * person's, and every field of it is `null` in the file Save writes.
 */
/** #1127 — one cutter's state in the run record. */
export interface RunRecordCutter {
  key: string;
  name: string;
  /** 1-based program numbers this cutter serves. */
  programs: number[];
  state: 'located' | 'replaced';
  /** The replacement's display name, when replaced. */
  replacedWith?: string;
  at: string;
}

export interface RunRecord {
  kind: typeof RUN_RECORD_KIND;
  schemaVersion: number;
  /** The job as it was named when the program was posted. */
  job: string;
  /** The `.nc` this run cut — the file the operator loaded (`runSheetFileName`). */
  ncFile: string;
  /** First 8 hex of SHA-256 of the `.nc` text — the hash the run sheet printed (#207). */
  ncHash: string;
  /**
   * #1093 R4 — EVERY PROGRAM'S FILE AND HASH, in cut order. The top-level `ncFile`/`ncHash` above
   * stay as program 1's, kept for every record written before this field and for the readers that
   * only want the first file; a record of one program carries the same pair here. Absent on an old
   * record, which is read as the one program its top-level pair describes.
   */
  programs?: RunRecordProgram[];
  /**
   * #1127 — THE BITS LAID OUT, at the moment the record was written: per distinct cutter in program
   * order, whether the operator had it located or had replaced it with another owned cutter. A
   * non-byte record of the checklist (the state itself lives on the job, keyed by the package).
   */
  cutterChecklist?: RunRecordCutter[];
  /** The cutter the job named, and its cutting diameter, mm. */
  tool: string | null;
  cuttingDiameter: number | null;
  /**
   * The cycle estimate the sheet printed, seconds (#242). Carried so the measured wall clock has
   * the planning figure it corrects sitting next to it in the file — the estimate itself is
   * never touched by a measurement.
   */
  estimatedSeconds: number | null;
  /**
   * #926 — the efficiency measure that estimate was taken with (air fraction, hops, feed
   * utilisation, the swept strip, the tour bound). Null on a result stored from before the
   * measure; the record then carries the estimate alone, as it always did.
   */
  efficiency: RunRecordEfficiency | null;
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
  /**
   * #927 — the MACHINE's own elapsed time for the run, seconds, from `P:`'s third field. It is the
   * actual the estimate is checked against: the machine starts its clock at play, so it includes
   * the spindle ramp and the rapids, and it is not a person's reading. Null when the run was not
   * played from the app, or the machine reported none. `minutes` above stays the operator's own
   * wall clock and is never overwritten by this.
   */
  actualSeconds: number | null;
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
  /**
   * #927 — the machine's elapsed seconds for this program's last clean run, when the caller has
   * one. A file written AFTER a run can carry the actual the estimate is checked against; a file
   * written before it passes null and the operator's `minutes` is the only clock the file holds.
   */
  actualSeconds: number | null = null,
): RunRecord {
  const tool = jobTool(job);
  const nc = generated.nc;
  // #1093 R4 — the run's files, named once (`programFiles`) so the record, Save and the release
  // cannot disagree about what a program's file is called.
  const runPrograms = generated.programs ?? [];
  // #1127 — the checklist as it stood: the job's state for THIS package, one row per distinct
  // cutter in program order. Absent when the job has no checklist for the run.
  const checklistEntries =
    job.package === undefined ? undefined : job.cutterChecklist?.[job.package.hash];
  const checklistKeys = distinctCutterKeys(runPrograms).map((key) => {
    const programs = runPrograms.flatMap((program, index) => (program.toolKey === key ? [index + 1] : []));
    return { key, programs };
  });
  const cutterChecklist: RunRecordCutter[] | undefined =
    checklistEntries === undefined
      ? undefined
      : checklistKeys
          .map((row): RunRecordCutter | null => {
            // Settled by the row's own entry, or by the replacement that stands in for it after
            // the whole-run regenerate (#1127's gate must not forget a replacement it asked for).
            const entry = settledCutterEntry(checklistEntries, row.key);
            if (entry === undefined) return null;
            const replacedWith =
              entry.state === 'replaced' && entry.replacedWith !== undefined && entry.replacedWith !== row.key
                ? cutterNameForKey(entry.replacedWith)
                : undefined;
            return {
              key: row.key,
              name: cutterNameForKey(row.key),
              programs: row.programs,
              state: entry.state,
              ...(replacedWith === undefined ? {} : { replacedWith }),
              at: entry.at,
            };
          })
          .filter((row): row is RunRecordCutter => row !== null);
  const files = programFiles(runPrograms, job.name);
  const frameOf = new Map(files.filter((f) => f.kind === 'frame').map((f) => [f.index, f.name] as const));
  return {
    kind: RUN_RECORD_KIND,
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    job: job.name,
    ncFile: runSheetFileName(job.name),
    ncHash: nc === null ? '' : sha256Hex(nc).slice(0, 8),
    programs: files
      // #473/#1093 — every program of the run, the blank's skim included: it is a file the operator
      // loads, so the record names it and hashes it like the rest.
      .filter((f) => f.kind === 'nc' || f.kind === 'facing')
      .map((f) => ({
        index: f.index,
        setupIndex: runPrograms[f.index - 1]?.setupIndex ?? 1,
        ncFile: f.name,
        ncHash: sha256Hex(f.bytes).slice(0, 8),
        frameFile: frameOf.get(f.index) ?? null,
      })),
    ...(cutterChecklist === undefined ? {} : { cutterChecklist }),
    tool: tool?.name ?? null,
    cuttingDiameter: tool ? cuttingDiameter(tool) : null,
    estimatedSeconds: generated.cam?.estimatedSeconds ?? null,
    efficiency:
      generated.cam?.efficiency === undefined
        ? null
        : {
            cycleSeconds: generated.cam.efficiency.cycleSeconds,
            rapidSeconds: generated.cam.efficiency.rapidSeconds,
            feedSeconds: generated.cam.efficiency.feedSeconds,
            airFraction: generated.cam.efficiency.airFraction,
            hopCount: generated.cam.efficiency.hopCount,
            hopSeconds: generated.cam.efficiency.hopSeconds,
            feedUtilisation: generated.cam.efficiency.feedUtilisation,
            rapidCutRatio: generated.cam.efficiency.rapidCutRatio,
            sweptAreaMm2: generated.cam.efficiency.sweptAreaMm2,
            deepestCutMm: generated.cam.efficiency.deepestCutMm,
            tourBoundMm: generated.cam.efficiency.tourBoundMm,
            tourExcess: generated.cam.efficiency.tourExcess,
          },
    generatedOn: now.toISOString().slice(0, 10),
    cutOn: null,
    minutes: null,
    actualSeconds: actualSeconds !== null && actualSeconds > 0 ? actualSeconds : null,
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
  return (
    isMeasuredRun(run) &&
    ((typeof run.minutes === 'number' && run.minutes > 0) ||
      (typeof run.actualSeconds === 'number' && run.actualSeconds > 0))
  );
}

/**
 * #927 — the record with the machine's elapsed time attached. The date is the machine's, written
 * with the time: a timed run with no date is exactly the undated result `isMeasuredRun` exists to
 * refuse, and the machine can date its own finish. Nothing a person wrote is touched.
 */
export function withActualSeconds(run: RunRecord, seconds: number, now: Date = new Date()): RunRecord {
  if (!(seconds > 0)) return run;
  return { ...run, actualSeconds: seconds, cutOn: run.cutOn ?? now.toISOString().slice(0, 10) };
}

/** The run's wall clock in seconds, from the machine's elapsed or a person's minutes; null with neither. */
export function runSeconds(run: RunRecord): number | null {
  if (typeof run.actualSeconds === 'number' && run.actualSeconds > 0) return run.actualSeconds;
  if (typeof run.minutes === 'number' && run.minutes > 0) return run.minutes * 60;
  return null;
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

/**
 * #926 — the record's efficiency block, read leniently. It is the APP's half of the file, not a
 * measurement: a block with a missing or mistyped number reads as "not recorded" (null) rather
 * than refusing the whole run, exactly as `estimatedSeconds` does.
 */
function parseEfficiency(raw: unknown): RunRecordEfficiency | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = e[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const cycle = num('cycleSeconds');
  const rapid = num('rapidSeconds');
  const feed = num('feedSeconds');
  const air = num('airFraction');
  const hops = num('hopCount');
  const hopSeconds = num('hopSeconds');
  const deepest = num('deepestCutMm');
  if (cycle === null || rapid === null || feed === null || air === null || hops === null || hopSeconds === null || deepest === null) {
    return null;
  }
  return {
    cycleSeconds: cycle,
    rapidSeconds: rapid,
    feedSeconds: feed,
    airFraction: air,
    hopCount: hops,
    hopSeconds,
    feedUtilisation: num('feedUtilisation'),
    rapidCutRatio: num('rapidCutRatio'),
    sweptAreaMm2: num('sweptAreaMm2'),
    deepestCutMm: deepest,
    tourBoundMm: num('tourBoundMm'),
    tourExcess: num('tourExcess'),
  };
}

/** Every reading a person could have taken, so the "dated?" rule can be enforced over all of them. */function hasReadings(r: RunRecord): boolean {
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

  // #1127 — the bits-laid-out rows, read back as written. Tolerant like the other derived
  // sections: a row that is not a cutter record is dropped, never a reason to refuse the file (the
  // record's own content is the person's readings; this is history).
  const cutterChecklist: RunRecordCutter[] | undefined = Array.isArray(r.cutterChecklist)
    ? (r.cutterChecklist as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .filter(
          (x) =>
            typeof x.key === 'string' &&
            typeof x.name === 'string' &&
            typeof x.at === 'string' &&
            (x.state === 'located' || x.state === 'replaced'),
        )
        .map((x) => ({
          key: x.key as string,
          name: x.name as string,
          programs: Array.isArray(x.programs)
            ? (x.programs as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
            : [],
          state: x.state as 'located' | 'replaced',
          ...(typeof x.replacedWith === 'string' ? { replacedWith: x.replacedWith } : {}),
          at: x.at as string,
        }))
    : undefined;

  const run: RunRecord = {
    kind: RUN_RECORD_KIND,
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    job: r.job,
    ncFile: r.ncFile,
    ncHash: typeof r.ncHash === 'string' ? r.ncHash : '',
    // #1093 R4 — absent on a record written before the field: read as the one program the
    // top-level pair describes, so an old file never fails to open.
    ...(Array.isArray(r.programs)
      ? {
          programs: (r.programs as unknown[])
            .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
            .map((x) => ({
              index: numberOrNull(x.index) ?? 0,
              setupIndex: numberOrNull(x.setupIndex) ?? 1,
              ncFile: typeof x.ncFile === 'string' ? x.ncFile : '',
              ncHash: typeof x.ncHash === 'string' ? x.ncHash : '',
              frameFile: typeof x.frameFile === 'string' ? x.frameFile : null,
            })),
        }
      : {}),
    ...(cutterChecklist === undefined ? {} : { cutterChecklist }),
    tool: typeof r.tool === 'string' ? r.tool : null,
    cuttingDiameter: numberOrNull(r.cuttingDiameter),
    estimatedSeconds: numberOrNull(r.estimatedSeconds),
    efficiency: parseEfficiency(r.efficiency),
    generatedOn: typeof r.generatedOn === 'string' ? r.generatedOn : '',
    cutOn: isIsoDate(r.cutOn) ? r.cutOn : null,
    minutes,
    actualSeconds: numberOrNull(r.actualSeconds),
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
