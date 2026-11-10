/**
 * #1154 — THE RUN'S OWN HEARTBEAT, KEPT (the maintainer's ruling, 2026-11-10).
 *
 * The app already asks the controller `?` every `run.pollMs` during a run (#423). Those status
 * lines — the state word, the `P:` fields, WPos — are the only record of how the program actually
 * ran: line/percent over time, which lets a post-mortem, a line-vs-tip analysis (#1145) or a
 * P:-field check read the app's OWN data, with no second poller at the machine and no hand-taken
 * bench traces. This module keeps them.
 *
 * THE THINNING IS CODE, NOT A SHOP DEFAULT (the manager's ruling): a program can run for hours and
 * a line every 2 s would bloat the record — so keep every poll for the first five minutes, then
 * one line per 10 s, plus every line whose STATE WORD changes (Run/Hold/Tool/Alarm/Idle: a state
 * change is the fact a later reading wants, whatever the gap). A hard cap of 5,000 lines per
 * program stops a pathological run, and the file SAYS it was thinned and why.
 *
 * ONE LINE PER SAMPLE, in the operator's order: ISO time, state, the `P:` fields raw, WPos raw —
 * raw because a later reading must see the controller's own text, not this app's parse of it.
 *
 * EXPORT ONLY (no on-screen viewer yet, the canvas review is open): the text is kept with the
 * run-log entry (the house copy of the finished-program record, `JobRunLogEntry.statusLog`) and
 * written beside the run record by Save / Save all, under the program's own name:
 * `<program>-status.log` — `A-job-p02-status.log` beside `A-job-p02.nc`.
 */

/** How long every poll is kept at the start of a program: the interesting part of a run. */
export const STATUS_FULL_FIRST_MS = 5 * 60_000;
/** After that, at most one line per this many milliseconds... */
export const STATUS_SAMPLE_EVERY_MS = 10_000;
/** ...plus every state change, and never more than this many lines per program. */
export const STATUS_LOG_MAX_LINES = 5_000;

/** One `?` reply, as the log keeps it: the clock, the state word, and the raw P/WPos fields. */
export interface StatusSample {
  /** Wall clock at the reply, epoch ms (the app's clock; see the header line's ISO form). */
  atMs: number;
  state: string | null;
  /** The `P:` field's text exactly as the controller wrote it (`120,45,30`), or null. */
  p: string | null;
  /** The `WPos:` field's text exactly as the controller wrote it, or null. */
  wpos: string | null;
}

export interface StatusLogRules {
  fullFirstMs?: number;
  everyMs?: number;
  maxLines?: number;
}

export interface StatusLogHeader {
  jobName: string;
  /** 1-based, the operator's "program N". */
  programIndex: number;
  programTotal: number;
}

export interface StatusLog {
  /** Every reply the run saw; the keeper decides. */
  push(sample: StatusSample): void;
  /** Replies seen, lines kept, and replies that were not kept. */
  readonly seen: number;
  readonly kept: readonly StatusSample[];
  readonly dropped: number;
  /** The cap stopped it: later replies are not in this log. */
  readonly capped: boolean;
  /** The file's text: two comment lines, then one line per kept sample. Always ends with `\n`. */
  text(header: StatusLogHeader): string;
}

/** The state word and the raw fields a status line carries — no motion, no guess. */
export function readStatusFields(text: string): Pick<StatusSample, 'state' | 'p' | 'wpos'> {
  const trimmed = text.trim();
  const state = /^<([A-Za-z]+)/.exec(trimmed);
  const field = (name: string): string | null => {
    const m = new RegExp(`(?:^|\\|)${name}:([^|>]*)`).exec(text);
    const raw = m?.[1]?.trim();
    return raw === undefined || raw === '' ? null : raw;
  };
  return { state: state === null ? null : state[1]!, p: field('P'), wpos: field('WPos') };
}

const COMMAS = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * A program's status collector. `startedAtMs` is the run's start: "the first 5 min" is measured
 * from the program beginning to run, not from the first reply.
 */
export function createStatusLog(startedAtMs: number, rules: StatusLogRules = {}): StatusLog {
  const fullFirstMs = rules.fullFirstMs ?? STATUS_FULL_FIRST_MS;
  const everyMs = rules.everyMs ?? STATUS_SAMPLE_EVERY_MS;
  const maxLines = rules.maxLines ?? STATUS_LOG_MAX_LINES;
  const kept: StatusSample[] = [];
  let seen = 0;
  let dropped = 0;
  let capped = false;
  return {
    push(sample) {
      seen += 1;
      if (kept.length >= maxLines) {
        capped = true;
        dropped += 1;
        return;
      }
      const last = kept.at(-1);
      const keep =
        last === undefined ||
        sample.atMs - startedAtMs <= fullFirstMs ||
        sample.state !== last.state ||
        sample.atMs - last.atMs >= everyMs;
      if (keep) kept.push(sample);
      else dropped += 1;
    },
    get seen() {
      return seen;
    },
    get kept() {
      return kept;
    },
    get dropped() {
      return dropped;
    },
    get capped() {
      return capped;
    },
    text(header) {
      const lines = [
        `# ${header.jobName} — program ${header.programIndex} of ${header.programTotal}; status lines from the run’s own ? polls`,
      ];
      const keptCount = `kept ${COMMAS(kept.length)} of ${COMMAS(seen)} polls`;
      if (dropped === 0 && !capped) lines.push(`# ${keptCount} — no thinning`);
      else {
        lines.push(
          `# ${keptCount} — thinned: every poll for the first 5 min, then one per 10 s and every state change; ` +
            `cap ${COMMAS(maxLines)} lines${capped ? ' (the cap stopped it, later polls are not here)' : ''}`,
        );
      }
      for (const s of kept) {
        lines.push(
          `${new Date(s.atMs).toISOString()}  ${s.state ?? '-'}  P:${s.p ?? '-'}  WPos:${s.wpos ?? '-'}`,
        );
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

/** The log's file name: the program's own name with `-status.log` where `.nc` was. */
export function statusLogFileName(ncFile: string): string {
  return `${ncFile.replace(/\.nc$/i, '')}-status.log`;
}
