/**
 * #919 baseline — the crash banner's sentence and its words, moved out of `CrashRecoveryBanner.tsx`
 * so that file exports only its component (react-refresh/only-export-components). The logic is
 * unchanged.
 *
 * #1187 — A REPORT NAMES ITS EVENT. The sentence says WHAT stopped and WHEN, and when the stop is
 * not today's it says how long ago it was: the 2026-11-10 complaint was a yesterday's report offered
 * under today's Register stop, and a bare date was not enough to stop the two being read as one.
 */

import type { CrashMoment } from '@/platform/flightRecorder';

const WORK_WORDS: Record<string, string> = {
  generate: 'generating',
  simulate: 'simulating',
  'smart-pick': 'measuring cutters',
  preview: 'drawing the preview',
  import: 'importing a model',
};

const MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * #1072 — the stop as a DATE AND TIME, in local words: "3 Nov at 17:58", with the year when it is
 * not the current one. A bare clock time let the 3 Nov 22:58 Z marker read as tonight's crash; a
 * reported event carries its date like any other fact, so it is never dropped.
 */
function whenWords(at: number | null, now = Date.now()): string | null {
  if (at === null) return null;
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTH_WORDS[d.getMonth()]}${year} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The event's time in words, for the confirmations that repeat it ("the report of 9 Nov at 16:16"). */
export function reportWhenWords(at: number | null, now = Date.now()): string {
  return whenWords(at, now) ?? 'an unrecorded time';
}

/**
 * #1187 — HOW OLD THE STOP IS, in days, when it is not today's. Null on the same local day (the
 * ordinary crash-and-reopen case, where the date alone is unambiguous).
 */
function ageWords(at: number | null, now: number): string | null {
  if (at === null) return null;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return null;
  return days === 1 ? 'a day earlier' : `${days} days earlier`;
}

function heapWords(mb: number | null): string | null {
  if (mb === null) return null;
  return mb >= 1024 ? `heap ${(mb / 1024).toFixed(1)} GB` : `heap ${Math.round(mb)} MB`;
}

export interface CrashBannerWords {
  /** The clock the age is judged against; specs pin it, the banner uses now. */
  now?: number | null;
  /** Whether a house service answered — the sentence asks to SEND only where something can receive. */
  canSend?: boolean;
}

/** The banner's sentence, from what the recorder left. Exported so its words are testable. */
export function crashBannerSentence(moment: CrashMoment, words: CrashBannerWords = {}): string {
  const now = words.now ?? Date.now();
  const at = whenWords(moment.stoppedAt, now);
  const doing = moment.work === null ? null : (WORK_WORDS[moment.work] ?? moment.work);
  const facts = [moment.label, heapWords(moment.heapMb)].filter((w): w is string => w !== null);
  const when = at === null ? 'Case Maker stopped unexpectedly' : `Case Maker stopped unexpectedly on ${at}`;
  const whileDoing = doing === null ? '' : ` while ${doing}`;
  const detail = facts.length === 0 ? '' : ` (${facts.join(', ')})`;
  // #1187 — a report older than today says so, in words, beside the event it names.
  const age = ageWords(moment.stoppedAt, now);
  const aged = age === null ? '' : ` — that was ${age}`;
  const ask = words.canSend === true ? 'Send the report of that?' : 'Save a crash report?';
  return `${when}${whileDoing}${detail}${aged}. ${ask}`;
}
