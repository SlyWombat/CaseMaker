/**
 * #919 baseline — the crash banner's sentence and its words, moved out of `CrashRecoveryBanner.tsx`
 * so that file exports only its component (react-refresh/only-export-components). The logic is
 * unchanged.
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

function heapWords(mb: number | null): string | null {
  if (mb === null) return null;
  return mb >= 1024 ? `heap ${(mb / 1024).toFixed(1)} GB` : `heap ${Math.round(mb)} MB`;
}

/** The banner's sentence, from what the recorder left. Exported so its words are testable. */
export function crashBannerSentence(moment: CrashMoment): string {
  const at = whenWords(moment.stoppedAt);
  const doing = moment.work === null ? null : (WORK_WORDS[moment.work] ?? moment.work);
  const facts = [moment.label, heapWords(moment.heapMb)].filter((w): w is string => w !== null);
  const when = at === null ? 'Case Maker stopped unexpectedly' : `Case Maker stopped unexpectedly on ${at}`;
  const whileDoing = doing === null ? '' : ` while ${doing}`;
  const detail = facts.length === 0 ? '' : ` (${facts.join(', ')})`;
  return `${when}${whileDoing}${detail}. Save a crash report?`;
}
