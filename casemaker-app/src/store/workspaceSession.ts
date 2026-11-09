/**
 * #1123 item 10 — WHERE THE OPERATOR WAS, so a reload comes back to it.
 *
 * The bench's report: with a job open (project created, job saved), Ctrl+Shift+R landed on the
 * welcome door; the job store already persists the job, but nothing recorded that the CNC
 * workspace was the open place. This module keeps ONE small localStorage record while the CNC
 * workspace is active — the job id, the CNC half (Design/Cut), the section, and the project text —
 * and restores it after the first render.
 *
 * ONE RECORD, SHARED (#1122): the door's own work reads the same record rather than inventing a
 * second notion of "the last thing the operator had open". `readWorkspaceSession` is the API.
 *
 * It is deliberately NOT a general project autosave: the record exists only while the CNC Job
 * panel is the open section, and it is removed the moment the operator returns to the door or
 * leaves CNC, so a reload never hijacks the case editor.
 */

import { useProjectStore } from './projectStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useViewportStore } from './viewportStore';
import { useCncModeStore, type CncMode } from './cncModeStore';
import { serializeProject, parseProject } from './projectFile';

/** One key, one record. The version guards a future shape; an unknown version reads as absent. */
export const WORKSPACE_KEY = 'casemaker.workspace.v1';

export interface WorkspaceSession {
  v: 1;
  /** The job the workspace was on. Restored only when it is still the open job. */
  jobId: string;
  /** Which half of the CNC surface was up (#419 §3). */
  mode: CncMode;
  /** The only section this record describes. */
  section: 'cnc-engrave';
  /** `serializeProject`'s text. Empty when the document was too big to store (quota). */
  projectText: string;
  savedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored record, or null when there is none (or it is not a record this build accepts). */
export function readWorkspaceSession(): WorkspaceSession | null {
  const store = storage();
  if (store === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(WORKSPACE_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Partial<WorkspaceSession>;
  if (record.v !== 1) return null;
  if (typeof record.jobId !== 'string' || record.jobId === '') return null;
  if (record.mode !== 'design' && record.mode !== 'cut') return null;
  if (record.section !== 'cnc-engrave') return null;
  if (typeof record.projectText !== 'string') return null;
  if (typeof record.savedAt !== 'string') return null;
  return record as WorkspaceSession;
}

/** Write the record for the stores as they stand — only while the CNC workspace is open. */
export function writeWorkspaceSession(): void {
  const store = storage();
  if (store === null) return;
  const project = useProjectStore.getState();
  const section = useViewportStore.getState().activeSidebarSection;
  if (project.welcomeMode || section !== 'cnc-engrave') return;
  const job = useEngraveJobStore.getState().job;
  const mode = useCncModeStore.getState();
  const record: WorkspaceSession = {
    v: 1,
    jobId: job.id,
    // The mode store remembers which job it was chosen for; a different job is Design's.
    mode: mode.jobId === job.id ? mode.mode : 'design',
    section: 'cnc-engrave',
    projectText: '',
    savedAt: new Date().toISOString(),
  };
  try {
    record.projectText = serializeProject(project.project);
  } catch {
    record.projectText = ''; // a document that cannot serialise restores the workspace without it
  }
  try {
    store.setItem(WORKSPACE_KEY, JSON.stringify(record));
  } catch {
    // Quota: keep the record without the project — the job and the place are the important half.
    try {
      store.setItem(WORKSPACE_KEY, JSON.stringify({ ...record, projectText: '' }));
    } catch {
      // Nothing to do: a reload lands on the door, as it did before this record existed.
    }
  }
}

export function clearWorkspaceSession(): void {
  storage()?.removeItem(WORKSPACE_KEY);
}

/**
 * Apply the record to the stores, after the first render. True when a safe record was applied —
 * the job id must still be the open job, or the record is for a document the page no longer has.
 * A project that does not parse is left alone; the job and the place still restore.
 */
export function restoreWorkspaceSession(): boolean {
  const record = readWorkspaceSession();
  if (record === null) return false;
  if (useEngraveJobStore.getState().job.id !== record.jobId) return false;
  if (record.projectText !== '') {
    try {
      useProjectStore.setState({ project: parseProject(record.projectText), welcomeMode: false });
    } catch {
      useProjectStore.setState({ welcomeMode: false });
    }
  } else {
    useProjectStore.setState({ welcomeMode: false });
  }
  useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
  useCncModeStore.setState({ mode: record.mode, jobId: record.jobId });
  return true;
}

/**
 * Keep the record in step with the stores. Every relevant change either writes (CNC is open) or
 * clears (the door is back, or the operator left CNC). Returns the unsubscribe.
 */
export function startWorkspaceSession(): () => void {
  const onStoreChange = (): void => {
    const project = useProjectStore.getState();
    if (project.welcomeMode || useViewportStore.getState().activeSidebarSection !== 'cnc-engrave') {
      clearWorkspaceSession();
      return;
    }
    writeWorkspaceSession();
  };
  const unsubscribers = [
    useEngraveJobStore.subscribe(onStoreChange),
    useCncModeStore.subscribe(onStoreChange),
    useViewportStore.subscribe(onStoreChange),
    useProjectStore.subscribe(onStoreChange),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
