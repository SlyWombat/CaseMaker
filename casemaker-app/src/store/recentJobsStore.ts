/**
 * #680 — the last three `.cutjob` files this app saved or opened, for the welcome door.
 *
 * WHY THERE IS A STORE AT ALL. The app had no recents: `engraveJobFileStore` opens and saves one
 * document at a time through the file picker, and nothing remembered the files before. The door's
 * design (`first-job-flow.md` §3.1) offers the last three on the card, so this is the smallest
 * record that can do it.
 *
 * STORAGE IS SPLIT, AND THE SPLIT IS THE POINT. `localStorage` on this origin already holds the
 * OPEN job's own persistence (`engraveJobStore`) plus settings, machine and library state. A job
 * document carries its package and sources and can be hundreds of kilobytes, so putting three
 * snapshots there would starve the open job's autosave on a quota refusal — a convenience must
 * never cost the job. So `localStorage` holds ONLY the metadata list ({fileName, name, at}, a few
 * hundred bytes); each document's text lives in IndexedDB (`casemaker-recents` / `texts`, keyed by
 * file name). An entry that falls off the three loses its text with it.
 *
 * A SNAPSHOT, NOT A POINTER. The entry carries the text read or written at that moment, so the card
 * can reopen a job with no file handle at all — the web build, a download, a lapsed File System
 * Access permission. The bound file (when there is one) remains the owner; this is the door's copy
 * for the next visit, and `openRecentJob` says when it was saved.
 *
 * IT IS FED BY THE ONE FILE PATH, NOT A SECOND ONE. `startRecentJobTracking` watches the job file
 * store's own saved state: any transition with a file name and a current saved text — Open, Save,
 * Save as…, the autosave — records that file. A refused open changes neither, so it records
 * nothing. A text store that cannot take the document means the entry is not offered (there is no
 * second, partial representation of a job).
 */

import { create } from 'zustand';
import { JOB_FILE_EXTENSION } from '@/engine/cnc/engrave/jobFile';
import { useEngraveJobFileStore } from './engraveJobFileStore';

/** The browser-local metadata key. Versioned: the shape is the door's, not a job document's. */
export const RECENT_JOBS_KEY = 'casemaker.recentJobs.v1';
/** The card's design: the last three. */
export const MAX_RECENT_JOBS = 3;
/**
 * The largest document kept, in characters. IndexedDB has no tight budget, but a bound this size
 * still keeps one pathological file from making every read slow; past it the job is not offered.
 */
export const MAX_RECENT_JOB_CHARS = 600_000;

/** The IndexedDB database and store the snapshot texts live in. */
export const RECENT_TEXTS_DB = 'casemaker-recents';
export const RECENT_TEXTS_STORE = 'texts';

/** One entry on the card: everything `localStorage` keeps. The text is fetched from the text store. */
export interface RecentJob {
  /** The file's name (`Zoomba_badge.cutjob.json`), the dedupe key and the text's key. */
  fileName: string;
  /** The job's own name (`Zoomba badge`), what the card shows. */
  name: string;
  /** When this app last read or wrote it, ISO. */
  at: string;
}

/**
 * The snapshot texts, as the one side effect this store needs. The default is IndexedDB; a test
 * injects an in-memory double rather than depending on a database fake the repo does not ship.
 */
export interface RecentJobTexts {
  put: (fileName: string, text: string) => Promise<void>;
  get: (fileName: string) => Promise<string | null>;
  delete: (fileName: string) => Promise<void>;
}

function metadataOf(value: unknown): RecentJob | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.fileName !== 'string' || v.fileName.length === 0) return null;
  if (typeof v.name !== 'string' || typeof v.at !== 'string') return null;
  return { fileName: v.fileName, name: v.name, at: v.at };
}

/** What this browser holds, newest first, refusing anything this build cannot read. */
export function readRecentJobs(): RecentJob[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_JOBS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .map(metadataOf)
      .filter((j): j is RecentJob => j !== null)
      .slice(0, MAX_RECENT_JOBS);
  } catch {
    return [];
  }
}

/** Write as many metadata entries as the browser will take; they are tiny, but never assume. */
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

// ── IndexedDB, the app's one small database ─────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this build'));
  }
  if (dbPromise === null) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(RECENT_TEXTS_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECENT_TEXTS_STORE)) db.createObjectStore(RECENT_TEXTS_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('the recents database did not open'));
      request.onblocked = () => reject(new Error('the recents database is blocked by another tab'));
    });
    // A failed open is retried by the next call rather than cached forever.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function runText<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(RECENT_TEXTS_STORE, mode);
        const request = act(tx.objectStore(RECENT_TEXTS_STORE));
        tx.oncomplete = () => resolve(request.result as T);
        tx.onerror = () => reject(tx.error ?? new Error('the recents database refused the write'));
        tx.onabort = () => reject(tx.error ?? new Error('the recents database aborted the write'));
      }),
  );
}

/** The real text store: one object store, the text keyed by the file's name. */
export const indexedDbRecentTexts: RecentJobTexts = {
  put: (fileName, text) =>
    runText<void>('readwrite', (store) => store.put(text, fileName)).then(() => undefined),
  get: (fileName) =>
    runText<string | undefined>('readonly', (store) => store.get(fileName)).then((text) =>
      typeof text === 'string' ? text : null,
    ),
  delete: (fileName) => runText<void>('readwrite', (store) => store.delete(fileName)).then(() => undefined),
};

let textStore: RecentJobTexts = indexedDbRecentTexts;

/** Test seam: replace the snapshot store (the app never calls this). `null` restores IndexedDB. */
export function setRecentJobTextStore(next: RecentJobTexts | null): void {
  textStore = next ?? indexedDbRecentTexts;
}

/** The snapshot text for one entry, or null when the store has none to offer. */
export async function recentJobText(fileName: string): Promise<string | null> {
  try {
    return await textStore.get(fileName);
  } catch {
    return null;
  }
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

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * When the snapshot was taken, in the operator's own words: "at 09:14" today, the date too when it
 * is not. Empty for an unreadable stamp (the notice then says only what opened).
 */
export function recentSavedAtWords(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? ` as it was saved at ${clock}` : ` as it was saved on ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${clock}`;
}

export interface RecentJobsState {
  jobs: RecentJob[];
}

export const useRecentJobsStore = create<RecentJobsState>()(() => ({ jobs: readRecentJobs() }));

/**
 * Record one file as the newest recent, replacing any earlier entry for the same file. The text is
 * written first: an entry is offered only when its snapshot can be read back. Entries that fall off
 * the list lose their text in the same call.
 */
export async function recordRecentJob(
  fileName: string,
  text: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  if (fileName.trim().length === 0 || text.length > MAX_RECENT_JOB_CHARS) return;
  try {
    await textStore.put(fileName, text);
  } catch {
    // No snapshot, no entry: a recent that cannot be reopened is worse than one not shown. An
    // older entry for the same file would offer stale text under a fresh save, so it goes too.
    const before = useRecentJobsStore.getState().jobs;
    if (before.some((j) => j.fileName === fileName)) {
      useRecentJobsStore.setState({ jobs: persist(before.filter((j) => j.fileName !== fileName)) });
      void textStore.delete(fileName).catch(() => undefined);
    }
    return;
  }
  const entry: RecentJob = { fileName, name: recentJobName(fileName, text), at: now };
  const before = useRecentJobsStore.getState().jobs;
  const next = [entry, ...before.filter((j) => j.fileName !== fileName)].slice(0, MAX_RECENT_JOBS);
  const kept = persist(next);
  useRecentJobsStore.setState({ jobs: kept });
  const keptNames = new Set(kept.map((j) => j.fileName));
  for (const fallen of [...before, entry]) {
    if (!keptNames.has(fallen.fileName)) void textStore.delete(fallen.fileName).catch(() => undefined);
  }
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
    void recordRecentJob(state.fileName, state.savedText);
  });
}

/** Test seam: forget the metadata list and the stored copy. The tracking subscription stays. */
export function resetRecentJobs(): void {
  useRecentJobsStore.setState({ jobs: [] });
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(RECENT_JOBS_KEY);
  } catch {
    // Nothing stored, or storage blocked: both are the empty list.
  }
}
