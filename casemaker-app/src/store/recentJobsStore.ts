/**
 * #680 — the last three `.cutjob` files this app saved or opened, for the welcome door.
 *
 * WHY THERE IS A STORE AT ALL. The app had no recents: `engraveJobFileStore` opens and saves one
 * document at a time through the file picker, and nothing remembered the files before. The door's
 * design (`first-job-flow.md` §3.1) offers the last three on the card, so this is the smallest
 * record that can do it: a name, when, and the document's own text (the file IS the document —
 * `jobFile.ts`), newest first, capped at three.
 *
 * IT IS FED BY THE ONE FILE PATH, NOT A SECOND ONE. `startRecentJobTracking` watches the job file
 * store's own saved state: any transition with a file name and a current saved text — Open, Save,
 * Save as…, the autosave — records that file. A refused open changes neither, so it records
 * nothing. A file too large for the browser's storage budget is not kept; the card simply does not
 * list it (there is no second, partial representation of a job).
 *
 * A SNAPSHOT, NOT A POINTER. The recent entry carries the text read or written at that moment. The
 * welcome card can therefore reopen a job with no file handle at all — the web build, a download, a
 * browser whose File System Access permission was not renewed. The bound file (when there is one)
 * remains the owner of the document; this is the door's copy for the next visit.
 */

import { create } from 'zustand';
import { JOB_FILE_EXTENSION } from '@/engine/cnc/engrave/jobFile';
import { useEngraveJobFileStore } from './engraveJobFileStore';

/** The browser-local key. Versioned: the shape is the door's, not a job document's. */
export const RECENT_JOBS_KEY = 'casemaker.recentJobs.v1';
/** The card's design: the last three. */
export const MAX_RECENT_JOBS = 3;
/**
 * The largest document kept, in characters. A job file carries its package and sources, so this is
 * not a small record; past this the browser's storage budget is the reader's, and a recent that
 * cannot be kept is left out rather than stored truncated.
 */
export const MAX_RECENT_JOB_CHARS = 600_000;

export interface RecentJob {
  /** The file's name (`Zoomba_badge.cutjob.json`), the dedupe key. */
  fileName: string;
  /** The job's own name (`Zoomba badge`), what the card shows. */
  name: string;
  /** When this app last read or wrote it, ISO. */
  at: string;
  /** The document's text at that moment. */
  text: string;
}

function isRecentJob(value: unknown): value is RecentJob {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fileName === 'string' &&
    v.fileName.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.at === 'string' &&
    typeof v.text === 'string' &&
    v.text.length <= MAX_RECENT_JOB_CHARS
  );
}

/** What this browser holds, newest first, refusing anything this build cannot read. */
export function readRecentJobs(): RecentJob[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_JOBS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecentJob).slice(0, MAX_RECENT_JOBS);
  } catch {
    return [];
  }
}

/**
 * Write as many of the newest entries as the browser will take. A quota refusal drops the oldest
 * and tries again, so one large job never costs the card its whole list.
 */
function persist(jobs: RecentJob[]): RecentJob[] {
  if (typeof localStorage === 'undefined') return jobs;
  for (let n = jobs.length; n >= 0; n--) {
    const keep = jobs.slice(0, n);
    try {
      localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(keep));
      return keep;
    } catch {
      // Too large for this browser: try without the oldest one.
    }
  }
  return [];
}

/** The document's own `name`, or the file name with its suffix off — never an empty label. */
export function recentJobName(fileName: string, text: string): string {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw === 'object' && raw !== null) {
      const name = (raw as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    }
  } catch {
    // Not readable JSON: the file name is all this entry can honestly claim.
  }
  const bare = fileName.endsWith(JOB_FILE_EXTENSION)
    ? fileName.slice(0, -JOB_FILE_EXTENSION.length)
    : fileName;
  return bare.replace(/[_-]+/g, ' ').trim() || fileName;
}

export interface RecentJobsState {
  jobs: RecentJob[];
}

export const useRecentJobsStore = create<RecentJobsState>()(() => ({ jobs: readRecentJobs() }));

/**
 * Record one file as the newest recent, replacing any earlier entry for the same file. `now` is
 * for tests; the app uses the clock.
 */
export function recordRecentJob(fileName: string, text: string, now: string = new Date().toISOString()): void {
  if (fileName.trim().length === 0 || text.length > MAX_RECENT_JOB_CHARS) return;
  const entry: RecentJob = { fileName, name: recentJobName(fileName, text), at: now, text };
  const jobs = [entry, ...useRecentJobsStore.getState().jobs.filter((j) => j.fileName !== fileName)]
    .slice(0, MAX_RECENT_JOBS);
  useRecentJobsStore.setState({ jobs: persist(jobs) });
}

let tracking = false;

/**
 * Start recording what the job file store opens and saves. Idempotent, and called once by the
 * shell: the record must be kept whether or not the welcome card is on screen.
 */
export function startRecentJobTracking(): void {
  if (tracking) return;
  tracking = true;
  useEngraveJobFileStore.subscribe((state, previous) => {
    // A busy or dirty file store is mid-action or has unsaved edits; neither is a file's current
    // text. Only a settled, named, written document is a recent.
    if (state.busy || state.dirty) return;
    if (state.fileName === null || state.savedText === null) return;
    if (state.fileName === previous.fileName && state.savedText === previous.savedText) return;
    recordRecentJob(state.fileName, state.savedText);
  });
}

/** Test seam: forget the list and the stored copy. The tracking subscription is left in place. */
export function resetRecentJobs(): void {
  useRecentJobsStore.setState({ jobs: [] });
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(RECENT_JOBS_KEY);
  } catch {
    // Nothing stored, or storage blocked: both are the empty list.
  }
}
