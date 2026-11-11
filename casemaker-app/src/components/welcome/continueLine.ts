/**
 * #1123-48 — THE WORDS OF THE CONTINUE LINE (the analyst's ruling on the land18 walk, row 2a).
 *
 * `<name> · <what> · changed <when>`, plus ` · not saved to a file yet` for a job that was never
 * saved to a file. `<when>` is relative to now: under a minute "just now"; under an hour
 * "N min ago"; under a day "N h ago"; the previous calendar day "yesterday"; older "9 Nov" (day and
 * short month). The checks run in that order, so 20 hours ago across midnight reads "20 h ago".
 *
 * Pure: `now` is a parameter, so the rule is testable without a clock. The unit constants below
 * are the clock's own, not chosen values.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The local calendar day of a timestamp, as a number that orders and differences by whole days. */
function dayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** `changedAt` (epoch ms) relative to `now` (epoch ms). A clock that ran backwards reads "just now". */
export function relativeWhen(changedAt: number, now: number): string {
  const age = now - changedAt;
  if (age < MINUTE_MS) return 'just now';
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} h ago`;
  if (dayNumber(now) - dayNumber(changedAt) === 1) return 'yesterday';
  const d = new Date(changedAt);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export interface ContinueLineInput {
  readonly name: string;
  /** "a CNC job", "a project". */
  readonly what: string;
  /** Epoch ms of the workspace's last persisted change; null when unknown (the clause is left out). */
  readonly changedAt: number | null;
  /** A CNC job: has it ever been saved to a file? `null` for a thing that has no such notion. */
  readonly savedToFile: boolean | null;
  readonly now: number;
}

export function continueLine(i: ContinueLineInput): string {
  const parts = [i.name, i.what];
  if (i.changedAt !== null) parts.push(`changed ${relativeWhen(i.changedAt, i.now)}`);
  if (i.savedToFile === false) parts.push('not saved to a file yet');
  return parts.join(' · ');
}
