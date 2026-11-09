/**
 * #1123-40 — THE REGISTRATION MEMO. `engraveRegistrationStore` is session state: a reload forgets
 * the measurement, and the release gate then refuses a faced job until it is registered again. That
 * is honest — but the measurement itself is a fact about THIS machine and THIS blank, and the
 * machine's G54 is the one thing that can still say the frame it was written into is in force.
 *
 * So the record is kept on the house, inside the machine record it belongs to
 * (`machines[].registrations`), and restored on the next load only while the machine's G54 X/Y —
 * `MPos − WPos`, the #933 read — still equals the X/Y the origin write left in the controller.
 * If G54 moved, nothing is restored and the card says both pairs: register again.
 *
 * THE KEY IS THE SETUP, NOT THE JOB. Side 1 and side 2 of a flip job are two registrations against
 * two G54s. A memo is found by (jobId, setupId) — #1088's per-setup key — and carries the setup's
 * 1-based index as well, so a reordered setup list cannot make one side answer for the other.
 *
 * THE CHECK IS X/Y ONLY, AND SAYS SO. The written G54's Z is `surface + (cutter PRB − probe PRB)`
 * at the write, and the live work offset's Z carries the tool-length offset (see `workOffset`), so
 * Z cannot be compared honestly. The restored card states the scope in one line: "G54 X/Y verified
 * at <time>; Z as written then".
 *
 * A memo is a CONVENIENCE, never a truth: an unreadable one is ignored exactly like an unreadable
 * machine row (`unreadableMachines`), and the job simply needs registering again.
 */

import { z } from 'zod';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { FirstRegistration } from '@/store/engraveRegistrationStore';
import type { MachineRecord } from './locationClient';

/** How many registrations one machine record keeps; the oldest fall off first. */
export const REGISTRATION_MEMO_LIMIT = 10;

/**
 * How far the machine's live G54 X/Y may sit from the written one and still count as the same
 * origin, mm. The G10 line writes three decimals and the status line reads four; a hundredth of a
 * millimetre is already a hand on the controller, not readback noise.
 */
export const G54_RESTORE_TOLERANCE_MM = 0.01;

/** #608's fitted surface, as a record carries it. */
export interface RegisteredSurface {
  plane: { offset: number; slopeX: number; slopeY: number };
  z0: number;
}

/** One job setup's registration, as the house keeps it on the machine's record. */
export interface RegistrationMemo {
  jobId: string;
  /** #1088's per-setup key: the setup's stable id, never its position. */
  setupId: string;
  /** The setup's 1-based position when the origin was written, as the Cut screen names it. */
  setupIndex: number;
  /** The G54 X and Y the `G10 L2 P1` line wrote — the values a restore is checked against. */
  writtenG54: { x: number; y: number };
  /** When that line was written, ISO 8601. */
  writtenAt: string;
  /** The measurement, exactly as `engraveRegistrationStore` held it. */
  registration: {
    plan: RegistrationPlan;
    outcome: RegistrationOutcome;
    surface: RegisteredSurface | null;
    measuredAt: string;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether a value read from the house is a memo this build can use. Anything else is ignored: a
 * half-written or hand-edited entry is never handed to a restore.
 */
export function isRegistrationMemo(value: unknown): value is RegistrationMemo {
  if (!isObject(value)) return false;
  if (!isText(value.jobId) || !isText(value.setupId)) return false;
  if (!isFinite(value.setupIndex) || !Number.isInteger(value.setupIndex) || value.setupIndex < 1) return false;
  if (!isText(value.writtenAt)) return false;
  const g54 = value.writtenG54;
  if (!isObject(g54) || !isFinite(g54.x) || !isFinite(g54.y)) return false;
  const reg = value.registration;
  if (!isObject(reg) || !isText(reg.measuredAt)) return false;
  if (!isObject(reg.plan) || !isObject(reg.outcome)) return false;
  if (!isObject(reg.surface) && reg.surface !== null) return false;
  // The release gate and the post-facing re-touch read the outcome's corrected G54; without it the
  // record has nothing to say.
  const corrected = reg.outcome.correctedG54;
  if (!isObject(corrected) || !isFinite(corrected.x) || !isFinite(corrected.y)) return false;
  return true;
}

/**
 * The machine record's `registrations` section as this side parses it: every entry is validated,
 * and an unreadable one is DROPPED rather than failing the whole machine record — a bad memo must
 * cost a re-register, never make the machine unreadable.
 */
export const RegistrationsSchema = z
  .array(z.unknown())
  .transform((list) => list.filter(isRegistrationMemo))
  .optional();

/**
 * The machine record with `memo` added or replacing the memo for its (job, setup). Newest first,
 * pruned to {@link REGISTRATION_MEMO_LIMIT}. Every other field is left exactly as it was.
 */
export function withRegistrationMemo(record: MachineRecord, memo: RegistrationMemo): MachineRecord {
  const existing = Array.isArray(record.registrations) ? record.registrations.filter(isRegistrationMemo) : [];
  const next = [memo, ...existing.filter((m) => !(m.jobId === memo.jobId && m.setupId === memo.setupId))]
    .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt))
    .slice(0, REGISTRATION_MEMO_LIMIT);
  return { ...record, registrations: next };
}

/** The memo this machine holds for one setup of one job, or null. */
export function registrationMemoFor(
  record: MachineRecord | null | undefined,
  jobId: string,
  setupId: string,
): RegistrationMemo | null {
  const list = record?.registrations;
  if (!Array.isArray(list)) return null;
  return list.find((m) => isRegistrationMemo(m) && m.jobId === jobId && m.setupId === setupId) ?? null;
}

/**
 * The memo for a record this session has just made: the record's own measurement (its `measuredAt`,
 * its plan and outcome), the setup it was filed under, and the X/Y the origin write left in G54.
 * Built from the STORE's record so the session and the house cannot disagree about what was measured.
 */
export function memoFromRecord(
  record: FirstRegistration,
  setupId: string,
  setupIndex: number,
  writtenAt: string,
): RegistrationMemo {
  return {
    jobId: record.jobId,
    setupId,
    setupIndex,
    writtenG54: { x: record.outcome.correctedG54.x, y: record.outcome.correctedG54.y },
    writtenAt,
    registration: {
      plan: record.plan,
      outcome: record.outcome,
      surface: record.surface ?? null,
      measuredAt: record.measuredAt,
    },
  };
}

/** What the machine's live work offset says; an axis is null when the status line did not state it. */
export interface LiveG54 {
  x: number | null;
  y: number | null;
}

/** Whether the live X/Y is still the G54 the origin was written at, within {@link G54_RESTORE_TOLERANCE_MM}. */
export function g54Matches(
  written: { x: number; y: number },
  read: LiveG54 | null,
  toleranceMm = G54_RESTORE_TOLERANCE_MM,
): boolean {
  if (read === null || read.x === null || read.y === null) return false;
  return Math.abs(written.x - read.x) <= toleranceMm && Math.abs(written.y - read.y) <= toleranceMm;
}

/**
 * What answered for the machine: no heartbeat yet this session, one that could not reach it, one
 * from the machine this job names, or one from another machine (whose G54 is not this job's).
 */
export type RegistrationAnswer = 'unknown' | 'unreachable' | 'elsewhere' | 'target';

export type RegistrationMemoVerdictKind =
  | 'none'
  | 'waiting'
  | 'unreachable'
  | 'elsewhere'
  | 'unverifiable'
  | 'mismatch'
  | 'restored';

export interface RegistrationMemoVerdict {
  kind: RegistrationMemoVerdictKind;
  memo: RegistrationMemo | null;
  /** The live G54 as read, when both axes were present (null otherwise). */
  g54Read: { x: number; y: number } | null;
  /** The clock reading the check was made at, ISO 8601. */
  checkedAt: string;
  /** One sentence for the card; null when there is nothing to say (no memo). */
  words: string | null;
}

const n3 = (v: number): string => v.toFixed(3);
/** The status line's own reading resolution: MPos and WPos are reported to four decimals. */
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Judge a stored memo against what the machine told us. Pure: the caller supplies the heartbeat's
 * answer and the live work offset. Nothing is restored from a memo that could not be checked.
 */
export function assessRegistrationMemo(input: {
  memo: RegistrationMemo | null;
  answer: RegistrationAnswer;
  liveG54: LiveG54 | null;
  now: string;
}): RegistrationMemoVerdict {
  const { memo, answer, liveG54, now } = input;
  const base = { memo, g54Read: null, checkedAt: now } as const;
  if (memo === null) return { kind: 'none', memo: null, g54Read: null, checkedAt: now, words: null };
  const measured = memo.registration.measuredAt;
  if (answer === 'unknown') {
    return {
      ...base,
      kind: 'waiting',
      words: `A registration for this setup is stored on the house (measured ${measured}); it will be checked against the machine's G54 when the machine answers.`,
    };
  }
  if (answer === 'unreachable') {
    return {
      ...base,
      kind: 'unreachable',
      words: `A registration for this setup is stored on the house (measured ${measured}), but the machine is not answering, so it cannot be checked: connect the machine, or register again.`,
    };
  }
  if (answer === 'elsewhere') {
    return {
      ...base,
      kind: 'elsewhere',
      words: `A registration for this setup is stored on the house (measured ${measured}), but the machine answering is a different machine, whose G54 is not this job's: register again.`,
    };
  }
  if (liveG54 === null || liveG54.x === null || liveG54.y === null) {
    return {
      ...base,
      kind: 'unverifiable',
      words: `A registration for this setup is stored on the house (measured ${measured}), but the machine's answer did not state both positions, so it cannot be checked: register again.`,
    };
  }
  const g54Read = { x: r4(liveG54.x), y: r4(liveG54.y) };
  if (g54Matches(memo.writtenG54, g54Read)) {
    return {
      kind: 'restored',
      memo,
      g54Read,
      checkedAt: now,
      words: `Registration restored: G54 X/Y verified at ${now}; Z as written then (measured ${measured}).`,
    };
  }
  return {
    kind: 'mismatch',
    memo,
    g54Read,
    checkedAt: now,
    words: `A registration for this setup is stored on the house — written at G54 X ${n3(memo.writtenG54.x)} Y ${n3(memo.writtenG54.y)} (measured ${measured}) — but the machine's G54 now reads X ${n3(g54Read.x)} Y ${n3(g54Read.y)}: register again.`,
  };
}

/**
 * The session record a verified memo restores: the measurement exactly as it was taken (its own
 * `measuredAt`), with provenance saying how it got here.
 */
export function restoredRegistration(
  verdict: RegistrationMemoVerdict,
  target: { host: string; port: number },
): FirstRegistration {
  if (verdict.kind !== 'restored' || verdict.memo === null || verdict.g54Read === null) {
    throw new Error('only a verified memo restores a registration record');
  }
  const m = verdict.memo;
  return {
    jobId: m.jobId,
    setupId: m.setupId,
    target: { host: target.host, port: target.port },
    plan: m.registration.plan,
    outcome: m.registration.outcome,
    surface: m.registration.surface,
    measuredAt: m.registration.measuredAt,
    restored: { checkedAt: verdict.checkedAt, g54: verdict.g54Read, setupIndex: m.setupIndex },
  };
}
