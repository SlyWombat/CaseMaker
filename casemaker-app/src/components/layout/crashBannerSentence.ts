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

function clockWords(at: number | null): string | null {
  if (at === null) return null;
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function heapWords(mb: number | null): string | null {
  if (mb === null) return null;
  return mb >= 1024 ? `heap ${(mb / 1024).toFixed(1)} GB` : `heap ${Math.round(mb)} MB`;
}

/** The banner's sentence, from what the recorder left. Exported so its words are testable. */
export function crashBannerSentence(moment: CrashMoment): string {
  const at = clockWords(moment.stoppedAt);
  const doing = moment.work === null ? null : (WORK_WORDS[moment.work] ?? moment.work);
  const facts = [moment.label, heapWords(moment.heapMb)].filter((w): w is string => w !== null);
  const when = at === null ? 'Case Maker stopped unexpectedly' : `Case Maker stopped unexpectedly at ${at}`;
  const whileDoing = doing === null ? '' : ` while ${doing}`;
  const detail = facts.length === 0 ? '' : ` (${facts.join(', ')})`;
  return `${when}${whileDoing}${detail}. Save a crash report?`;
}
