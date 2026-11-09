/**
 * #1123 item 4 — THE RUN LOG: every stage tick with a timestamp and a duration, kept for the run.
 *
 * The maintainer's bench note (2026-11-09): Generate on the tray job runs 11–12 minutes behind one
 * line ("planning: rest — setup 1, 40 %…") and "Working…", with "no log file, or a window with
 * what is being done for long running jobs". This module is the pure half: the ticks arrive as the
 * worker's and the store's own stage reports, each appended with the time since the previous tick,
 * and the fold/file are built from the same list. It touches no store and no DOM.
 *
 * ONE ENTRY PER STAGE LINE. A planner tick carries a percentage that climbs within one op
 * ("planning: rest — setup 1, 10 %" … "40 %"); those are one stage, so the log's key drops a
 * trailing percentage and a repeat of the same key appends nothing. A different op, or the same op
 * after another, is a new stage line and does append.
 */

/** One stage tick as the operator reads it. */
export interface RunLogEntry {
  /** Epoch ms the tick was recorded. */
  at: number;
  /** Ms since the previous tick (the first: since the run started). */
  ms: number;
  /** The stage line, in the progress line's own words. */
  label: string;
}

/**
 * The stage's identity: the label with a trailing `, NN %` fraction dropped, so the percentage
 * ticks of one stage are one entry. Nothing else is rewritten — the log prints the first label it
 * saw, verbatim.
 */
export function runLogKey(label: string): string {
  return label.replace(/,\s*\d+(?:\.\d+)?\s*%\s*$/, '').trim();
}

/**
 * Append one tick. Returns the SAME array when the label is another percentage of the last
 * stage's line (nothing new happened); otherwise a new array with the tick, its duration measured
 * from the previous tick (or from the run's start for the first).
 */
export function appendRunLog(
  log: readonly RunLogEntry[],
  label: string,
  at: number,
  startedAt: number,
): RunLogEntry[] {
  const key = runLogKey(label);
  const last = log[log.length - 1];
  if (last !== undefined && runLogKey(last.label) === key) return log as RunLogEntry[];
  const from = last === undefined ? startedAt : last.at;
  return [...log, { at, ms: Math.max(0, at - from), label }];
}

/** A duration the operator reads: `12.3 s`, `1 m 5 s`, `1 m`. */
export function formatRunLogDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes} m` : `${minutes} m ${rest} s`;
}

/** One folded line: clock time · duration since the previous tick · the stage's words. */
export function formatRunLogEntry(entry: RunLogEntry): string {
  const t = new Date(entry.at);
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  return `${clock} · +${formatRunLogDuration(entry.ms)} · ${entry.label}`;
}

/**
 * The file the run writes beside its record (`<job>-run.log`): a header line, then one line per
 * tick with its ISO time and duration. The same entries the fold shows, in the same order.
 */
export function serializeRunLog(entries: readonly RunLogEntry[], header: string): string {
  const lines = [`# ${header}`];
  for (const entry of entries) {
    lines.push(`${new Date(entry.at).toISOString()} +${formatRunLogDuration(entry.ms)} ${entry.label}`);
  }
  return `${lines.join('\n')}\n`;
}
