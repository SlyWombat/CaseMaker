/**
 * #895 — A STALL IS A FAULT, AND A FAULT GETS A REPORT. The simulation stops only when no progress
 * checkpoint arrives inside the stall window, and that means the worker (or the shape it was
 * sweeping) stopped making progress the app can see — not that the program is slow to cut. So the
 * sentence says "this is a fault", and beside it is the same kind of report the crash banner
 * offers: one JSON file with the moment, the program and the recorder's recent crumbs, written
 * only on the person's press.
 *
 * CRASH-STYLE, NOT A CRASH: the app is still running and the recorder is still alive, so the
 * crumbs are the CURRENT session's ring (`flightCrumbs`), not a previous session's leftovers. The
 * shape mirrors `buildCrashReport`'s where it can, so a reader of one can read the other.
 */

import type { Crumb } from '@/platform/flightRecorder';
import type { SimDiagnostic } from '@/workers/sim/session';

export interface SimStallFacts {
  /** When the press was made, ms since the epoch. */
  at: number;
  jobName: string;
  /** The sentence the Cut panel showed. */
  message: string;
  progress: { done: number; total: number } | null;
  program: { index: number; count: number } | null;
  engine: 'exact' | 'column' | null;
  /** The run's own diagnostics, as the gate read them. */
  diagnostics: readonly SimDiagnostic[];
  /** The flight recorder's recent crumbs — where the session was and what it had done. */
  crumbs: readonly Crumb[];
}

/** The report's whole shape. Pure, so its fields can be pinned without a file picker. */
export function buildSimStallReport(facts: SimStallFacts): Record<string, unknown> {
  return {
    kind: 'casemaker-sim-stall-report',
    schemaVersion: 1,
    at: new Date(facts.at).toISOString(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
    jobName: facts.jobName,
    stall: {
      message: facts.message,
      progress: facts.progress,
      program: facts.program,
      engine: facts.engine,
    },
    diagnostics: facts.diagnostics.map((d) => ({ ...d })),
    crumbs: facts.crumbs.map((c) => ({ ...c })),
  };
}

/** `casemaker-sim-stall-2026-11-01-1612.json` — a name that sorts by the moment it happened. */
export function simStallReportFileName(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `casemaker-sim-stall-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}
