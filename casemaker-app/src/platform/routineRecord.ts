/**
 * #1202 — WHAT THIS MACHINE HAS ACTUALLY RUN.
 *
 * The completion record for motion routines, kept ON THE MACHINE (the house's machine record, beside
 * `registrations` and `finishedPrograms`): a routine that has completed on THIS controller, in THIS
 * shape, with the date and the build it did so. A routine whose identity is absent is marked on its
 * card before the press — and that is the whole point: the 2026-11-10 seat press had never moved
 * this controller, and nothing said so.
 *
 * The entry is written ONLY on a completed run (field 3): a stop leaves no record, so a routine
 * that has never finished is never claimed to have. An unreadable entry is DROPPED rather than
 * failing the machine record — the same rule `registrations` follows, and for the same reason.
 */

import type { MachineRecord } from '@/platform/locationClient';
import type { MotionRoutineId, RoutineIdentity } from '@/engine/cnc/registration/routineIdentity';
import { z } from 'zod';

/** One completed run of one routine shape on one machine. */
export interface RoutineCompletion {
  routine: MotionRoutineId;
  /** The line sequence's shape hash (`routineIdentityOf(...).shape`). */
  shape: string;
  /** When it completed, ISO 8601. */
  at: string;
  /** The build that ran it — a shape may be the same across builds, the record still says which. */
  build: { version: string; commit: string | null };
}

/** How many completions one machine record keeps; the oldest fall off first. */
export const ROUTINE_RECORD_LIMIT = 60;

const ROUTINE_IDS: ReadonlySet<string> = new Set<MotionRoutineId>([
  'registration',
  'seat-press',
  'mount-tap',
  'surface-seek',
  'edge-scan',
  'centre-find',
  'flip-registration',
  'rotary-tap',
  'face-angle',
  'clean-walk',
  'air-walk',
  'tool-change',
]);

function isCompletion(value: unknown): value is RoutineCompletion {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<RoutineCompletion>;
  if (typeof c.routine !== 'string' || !ROUTINE_IDS.has(c.routine)) return false;
  if (typeof c.shape !== 'string' || c.shape.length === 0) return false;
  if (typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at))) return false;
  const build = c.build as Partial<RoutineCompletion['build']> | undefined;
  if (typeof build !== 'object' || build === null || typeof build.version !== 'string') return false;
  if (!(build.commit === null || typeof build.commit === 'string')) return false;
  return true;
}

/**
 * The machine record's `completedRoutines` section: every readable entry, bad ones dropped.
 * OPTIONAL like `registrations` — a record written before the section existed parses without it,
 * and a record built by hand in a spec need not carry an empty array.
 */
export const RoutineCompletionsSchema = z
  .array(z.unknown())
  .transform((list) => list.filter(isCompletion))
  .optional();

/** Whether this machine has completed this exact routine shape. */
export function routineCompleted(record: MachineRecord | null | undefined, identity: RoutineIdentity): boolean {
  return routineCompletionFor(record, identity) !== null;
}

/** The entry for this routine shape, or null when it has not completed here. */
export function routineCompletionFor(
  record: MachineRecord | null | undefined,
  identity: RoutineIdentity,
): RoutineCompletion | null {
  const list = record?.completedRoutines;
  if (!Array.isArray(list)) return null;
  return list.find((c) => isCompletion(c) && c.routine === identity.routine && c.shape === identity.shape) ?? null;
}

/**
 * The machine record with this completion added (replacing the same routine shape's earlier entry:
 * one entry per shape, the newest date and build say when it last ran). Every other field is left
 * exactly as it was.
 */
export function withRoutineCompletion(record: MachineRecord, completion: RoutineCompletion): MachineRecord {
  const existing = Array.isArray(record.completedRoutines) ? record.completedRoutines.filter(isCompletion) : [];
  const next = [
    completion,
    ...existing.filter((c) => !(c.routine === completion.routine && c.shape === completion.shape)),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, ROUTINE_RECORD_LIMIT);
  return { ...record, completedRoutines: next };
}

/** The build facts a completion is stamped with. */
export function buildStamp(): RoutineCompletion['build'] {
  return {
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
  };
}
