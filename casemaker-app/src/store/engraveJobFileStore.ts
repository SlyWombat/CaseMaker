/**
 * SAVE / OPEN for the job document (#425 §6).
 *
 * THE FILE IS THE OWNER. The store below does not hold a second copy of the job: every write reads
 * `useEngraveJobStore.getState().job` and serializes it; every open parses a file and only then
 * replaces the open document. `localStorage` remains the crash net (the job store's own autosave);
 * a bound file handle is where the same full document is written on a short debounce and on Ctrl-S.
 *
 * THREE PROMISES, each a test:
 *
 *  - A REFUSED OPEN CHANGES NOTHING. Cancel, malformed JSON, a newer schema literal, a bad field —
 *    the open job, its handle and its dirty marker are exactly as they were.
 *  - A HANDLE IS ADOPTED ONLY AFTER A SUCCESSFUL PARSE, so Save can never write the previous job's
 *    text into the newly opened file.
 *  - DIRTY MEANS "the serialized document differs from the last text written to the file", not a
 *    timer and not an edit counter. A job not yet saved is dirty.
 *
 * The package and the run log need no special handling here: they are fields of the document, so
 * they round-trip with it. Opening reports the package's integrity and any missing required source
 * (`parseJobFile`), and those reports are surfaced — never acted on by dropping data.
 */

import { create } from 'zustand';
import {
  JOB_FILE_TYPE,
  jobFileName,
  parseJobFile,
  serializeJobFile,
} from '@/engine/cnc/engrave/jobFile';
import {
  openTextFileViaPicker,
  saveTextFile,
  writeTextToHandle,
  type ProjectFileHandle,
  type SaveTextOutcome,
} from './persistence';
import { useEngraveJobStore } from './engraveJobStore';

/** How long after an edit a bound file is written. Save and Ctrl-S write immediately. */
export const JOB_FILE_AUTOSAVE_MS = 750;

export type JobFileNoticeKind = 'ok' | 'info' | 'warning' | 'error';

export interface JobFileNotice {
  kind: JobFileNoticeKind;
  text: string;
}

/** The side effects Save/Open need. Replaced in specs; the defaults are the real pickers. */
export interface JobFileIO {
  /** Write a full document through an already-bound handle. */
  write: (handle: ProjectFileHandle, text: string) => Promise<void>;
  /** Save as… (or the anchor-download fallback). */
  save: (text: string, suggestedName: string) => Promise<SaveTextOutcome>;
  /** Open…; null on cancel. */
  open: () => Promise<{ text: string; name: string; handle: ProjectFileHandle | null } | null>;
}

const defaultIO: JobFileIO = {
  write: writeTextToHandle,
  save: (text, suggestedName) => saveTextFile(text, suggestedName, JOB_FILE_TYPE),
  open: () => openTextFileViaPicker(JOB_FILE_TYPE),
};

let io: JobFileIO = defaultIO;

/** Test seam: replace the picker/disk side effects. `null` restores the app's. */
export function setJobFileIO(next: JobFileIO | null): void {
  io = next ?? defaultIO;
}

/**
 * #673 — write a SECOND job document through the same Save As… path the open job uses, without
 * touching the open document. The one caller is the inlay pair: the male blank is a derived job
 * file the operator saves and opens as its own job.
 */
export async function saveJobFileText(text: string, suggestedName: string): Promise<SaveTextOutcome> {
  return io.save(text, suggestedName);
}

/** A handle's own file name when the platform exposes one. */
function handleName(handle: ProjectFileHandle, fallback: string): string {
  const name = (handle as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EngraveJobFileState {
  /** The bound file, or null when the job has never been saved through a picker. */
  handle: ProjectFileHandle | null;
  /** The bound file's name, or the suggested one after a download. */
  fileName: string | null;
  /** The text last written to the file; null until the first save/open. */
  savedText: string | null;
  /** When the text was last written or opened, epoch ms (#686's file bar prints it as HH:MM). */
  savedAt: number | null;
  /** The serialized document differs from `savedText` (or nothing has been saved yet). */
  dirty: boolean;
  /** A user-initiated save/open is in flight. */
  busy: boolean;
  notice: JobFileNotice | null;
  /** Why the opened document's package cannot be offered for a run, or null. */
  packageError: string | null;
  /** §6's sentence when a required source is missing/changed, or null. */
  sourceError: string | null;
  /** Save in place when a handle is bound, else Save as…. */
  save: () => Promise<void>;
  /** Always pick a new file. */
  saveAs: () => Promise<void>;
  /** Pick and parse a file; replace the open document only on success. */
  open: () => Promise<void>;
  /** A fresh job with no bound file. */
  newJob: () => void;
  dismissNotice: () => void;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveWriting = false;
/** True while Open/New replaces the document: the replacement is not an edit to autosave. */
let adopting = false;

function cancelAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

/** Write the current document to the bound file, if there is one. Never blocks a user action. */
async function autosaveNow(): Promise<void> {
  const { handle, busy } = useEngraveJobFileStore.getState();
  if (handle === null || busy || autosaveWriting) return;
  const text = serializeJobFile(useEngraveJobStore.getState().job);
  autosaveWriting = true;
  try {
    await io.write(handle, text);
    const current = serializeJobFile(useEngraveJobStore.getState().job);
    useEngraveJobFileStore.setState({
      savedText: text,
      savedAt: Date.now(),
      dirty: current !== text,
      notice: { kind: 'ok', text: `Saved ${useEngraveJobFileStore.getState().fileName ?? 'the job'}` },
    });
  } catch (error) {
    useEngraveJobFileStore.setState({
      dirty: true,
      notice: { kind: 'error', text: `the job file was not written: ${errorText(error)}` },
    });
  } finally {
    autosaveWriting = false;
  }
}

function scheduleAutosave(): void {
  cancelAutosave();
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void autosaveNow();
  }, JOB_FILE_AUTOSAVE_MS);
}

/** Test seam: run a pending autosave now (or do nothing). */
export async function flushJobFileAutosave(): Promise<void> {
  if (autosaveTimer === null) return;
  cancelAutosave();
  await autosaveNow();
}

const INITIAL = {
  handle: null as ProjectFileHandle | null,
  fileName: null as string | null,
  savedText: null as string | null,
  savedAt: null as number | null,
  dirty: true,
  busy: false,
  notice: null as JobFileNotice | null,
  packageError: null as string | null,
  sourceError: null as string | null,
};

export const useEngraveJobFileStore = create<EngraveJobFileState>()((set, get) => ({
  ...INITIAL,

  save: async () => {
    const state = get();
    if (state.busy) return;
    if (state.handle === null) {
      await get().saveAs();
      return;
    }
    const text = serializeJobFile(useEngraveJobStore.getState().job);
    cancelAutosave();
    set({ busy: true, notice: null });
    try {
      await io.write(state.handle, text);
      const current = serializeJobFile(useEngraveJobStore.getState().job);
      set({
        busy: false,
        savedText: text,
        savedAt: Date.now(),
        dirty: current !== text,
        notice: { kind: 'ok', text: `Saved ${state.fileName ?? 'the job'}` },
      });
    } catch (error) {
      set({ busy: false, dirty: true, notice: { kind: 'error', text: `the job was not saved: ${errorText(error)}` } });
    }
  },

  saveAs: async () => {
    if (get().busy) return;
    const job = useEngraveJobStore.getState().job;
    const text = serializeJobFile(job);
    const suggested = jobFileName(job.name);
    cancelAutosave();
    set({ busy: true, notice: null });
    try {
      const outcome = await io.save(text, suggested);
      if (outcome.kind === 'cancelled') {
        set({ busy: false, notice: { kind: 'info', text: 'Save cancelled — the job was not written.' } });
        return;
      }
      const current = serializeJobFile(useEngraveJobStore.getState().job);
      if (outcome.kind === 'downloaded') {
        // No reusable handle: the browser put the file in Downloads, and the next Save asks again.
        set({
          busy: false,
          handle: null,
          fileName: suggested,
          savedText: text,
          savedAt: Date.now(),
          dirty: current !== text,
          notice: { kind: 'info', text: `Downloaded ${suggested}.` },
        });
        return;
      }
      set({
        busy: false,
        handle: outcome.handle,
        fileName: handleName(outcome.handle, suggested),
        savedText: text,
        savedAt: Date.now(),
        dirty: current !== text,
        notice: { kind: 'ok', text: `Saved ${handleName(outcome.handle, suggested)}` },
      });
    } catch (error) {
      set({ busy: false, dirty: true, notice: { kind: 'error', text: `the job was not saved: ${errorText(error)}` } });
    }
  },

  open: async () => {
    if (get().busy) return;
    set({ busy: true, notice: null });
    let picked: { text: string; name: string; handle: ProjectFileHandle | null } | null;
    try {
      picked = await io.open();
    } catch (error) {
      set({ busy: false, notice: { kind: 'error', text: `the job file could not be read: ${errorText(error)}` } });
      return;
    }
    if (picked === null) {
      set({ busy: false, notice: { kind: 'info', text: 'Open cancelled — the job is unchanged.' } });
      return;
    }

    const parsed = await parseJobFile(picked.text);
    if (!parsed.ok) {
      // The open document, its file and its dirty marker are untouched.
      set({
        busy: false,
        notice: {
          kind: 'error',
          text: `${picked.name} was not opened: ${parsed.errors[0] ?? 'the file is not a job document'}`,
        },
      });
      return;
    }

    // Replace ONLY now: a parse refusal above never reaches this line.
    cancelAutosave();
    adopting = true;
    try {
      useEngraveJobStore.getState().replace(parsed.job);
    } finally {
      adopting = false;
    }
    const saved = serializeJobFile(parsed.job);
    const packageError = parsed.package !== null && !parsed.package.ok ? parsed.package.reason : null;
    const problems = [packageError, parsed.sourceError].filter((line): line is string => line !== null);
    set({
      busy: false,
      handle: picked.handle,
      fileName: picked.name,
      savedText: saved,
      savedAt: Date.now(),
      dirty: false,
      packageError,
      sourceError: parsed.sourceError,
      notice: {
        kind: problems.length === 0 ? 'ok' : 'warning',
        text: [`Opened ${picked.name}.`, ...problems].join(' '),
      },
    });
  },

  newJob: () => {
    cancelAutosave();
    adopting = true;
    try {
      useEngraveJobStore.getState().reset();
    } finally {
      adopting = false;
    }
    set({
      handle: null,
      fileName: null,
      savedText: null,
      savedAt: null,
      dirty: true,
      notice: { kind: 'info', text: 'A new job — not saved to a file yet.' },
      packageError: null,
      sourceError: null,
    });
  },

  dismissNotice: () => set({ notice: null }),
}));

/**
 * Keep the marker honest as the document changes, and autosave a bound file on the same debounce
 * every edit lands on. The comparison is against the text last written, so a change and its undo
 * end clean rather than leaving a phantom dot.
 */
useEngraveJobStore.subscribe((state, previous) => {
  if (state.job === previous.job) return;
  const file = useEngraveJobFileStore.getState();
  const text = serializeJobFile(state.job);
  useEngraveJobFileStore.setState({
    dirty: file.savedText === null ? true : text !== file.savedText,
    // A document that is no longer the opened one has not had its integrity/problem report
    // re-derived; clearing is honest (the reports describe the file that was opened).
    packageError: null,
    sourceError: null,
  });
  // An editor edit is saved on the debounce; replacing the document (Open/New) is not an edit.
  if (!adopting && useEngraveJobFileStore.getState().handle !== null) scheduleAutosave();
});

/** Test seam: forget the bound file, the pending autosave and every notice. */
export function resetEngraveJobFileStore(): void {
  cancelAutosave();
  autosaveWriting = false;
  adopting = false;
  useEngraveJobFileStore.setState({ ...INITIAL });
}
