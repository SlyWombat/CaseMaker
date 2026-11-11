/**
 * #1187 — A STOPPED MACHINE ACTION'S OWN REPORT.
 *
 * The 2026-11-10 bench sent the crash banner's report after a Register stop with 'read failed:
 * Connection reset by peer'. That report described the PREVIOUS session's Generate crash — a
 * machine stop is not a crash, so the stop itself wrote nothing. This is that missing record: the
 * operator presses once, and the report carries THIS press's own facts —
 *
 *  - every line the action sent and the reply it got (its session's transcript),
 *  - the failure sentence (the transport or controller error, as the app stated it),
 *  - the machine's last status line in that session, when one was read,
 *  - the build id (version + commit) and whether it was the desktop build,
 *  - the job and the frozen package it was acting for, when there were any.
 *
 * NOTHING HERE CONNECTS, WRITES OR SENDS. The builder is pure; the store is the surface's half, and
 * the only caller is the operator's press on the stop sentence.
 */

export type StopActionKind = 'register' | 'home' | 'upload' | 'run';

/** One line of the action's conversation, exactly as its card shows it. */
export interface StopTranscriptEntry {
  line: string;
  reply: string;
}

export interface MachineStopReportInput {
  action: StopActionKind;
  /** The controller the action was talking to. */
  target: { host: string; port: number };
  /** The action's own failure sentence, in the app's words. */
  error: string;
  transcript: readonly StopTranscriptEntry[];
  /**
   * #1208 — how many `?` status exchanges a run's bounded transcript dropped, so the report says
   * its tail is a tail. Absent (or 0) when the transcript carries the whole run.
   */
  droppedStatusPolls?: number;
  /** The job the action was for, when there was one. */
  job?: { id: string; name: string; packageHash: string | null } | null;
  /** Spec seam: the clock the report's createdAt is stamped with. */
  now?: number;
}

export interface MachineStopReport {
  kind: 'casemaker-machine-stop-report';
  version: 1;
  createdAt: string;
  app: { version: string; commit: string | null; desktop: boolean };
  action: StopActionKind;
  machine: { host: string; port: number };
  error: string;
  /** The last `?` reply that was a status line, or null when the session never read one. */
  lastStatus: string | null;
  job: { id: string; name: string; packageHash: string | null } | null;
  transcript: StopTranscriptEntry[];
  /** #1208 — the status exchanges the transcript no longer carries; absent when there are none. */
  droppedStatusPolls?: number;
}

/** A controller status line: `<Idle|MPos:…>`. Not every `?` reply is one (a kind word is not). */
const STATUS_LINE = /^</;

/** The machine's last status line in this transcript, when one was read; never a guessed one. */
export function lastStatusLine(transcript: readonly StopTranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]!;
    if (entry.line.trim() !== '?' || !STATUS_LINE.test(entry.reply)) continue;
    const first = entry.reply.split('\n')[0];
    return first === undefined || first === '' ? null : first;
  }
  return null;
}

/**
 * #1187 — WHICH STOPPED ACTIONS CAN BE REPORTED. The rule is a transport or controller error: a
 * line that never reached the controller (`error`/`timeout` from the console), a link that failed
 * mid-conversation (the Rust relay's own words), the controller's `error:` reply, or an alarm.
 * A refusal by the app itself (a settings problem, a guard, the operator's Stop, a measurement
 * outside its margin) is NOT a machine fault, and its sentence carries the action already.
 */
export function stopIsReportable(reason: string): boolean {
  if (/\b(?:error|timeout) — /.test(reason)) return true;
  if (
    /could not open a console|read failed|serial read failed|closed the connection|connection was closed|Connection reset|os error \d+|ECONNRESET|ECONNREFUSED|timed out/i.test(
      reason,
    )
  ) {
    return true;
  }
  if (/the controller answered error:/i.test(reason) || /\bALARM\b/.test(reason)) return true;
  return false;
}

/**
 * Build the report. Pure: the caller supplies the action's facts and the app's build facts; nothing
 * here fetches, connects or sends. `createdAt` is the press's time, not the stop's — the transcript
 * and the error carry the stop itself.
 */
export function buildMachineStopReport(
  input: MachineStopReportInput,
  app: { version: string; commit: string | null; desktop: boolean },
): MachineStopReport {
  return {
    kind: 'casemaker-machine-stop-report',
    version: 1,
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    app: { version: app.version, commit: app.commit, desktop: app.desktop },
    action: input.action,
    machine: { host: input.target.host, port: input.target.port },
    error: input.error,
    lastStatus: lastStatusLine(input.transcript),
    job: input.job ?? null,
    // A copy: the report is a document, and the panel's array must not edit it later.
    transcript: input.transcript.map((entry) => ({ line: entry.line, reply: entry.reply })),
    // #1208 — only when there is something to say: a report that carries the run's whole
    // conversation keeps the field out, so its absence means "nothing was dropped".
    ...(input.droppedStatusPolls !== undefined && input.droppedStatusPolls > 0
      ? { droppedStatusPolls: input.droppedStatusPolls }
      : {}),
  };
}
