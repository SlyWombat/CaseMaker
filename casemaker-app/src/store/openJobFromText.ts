/**
 * #1122 — OPEN A JOB FROM ITS FILE'S TEXT: the one sequence every door uses.
 *
 * `EngraveJobFileBar`'s Open…, the welcome door's Load, Load-drop and Open a job, and the recent-job
 * card all end the same way: the document replaces the open job (only when it parses), the blank
 * project is sized to the job's own stock, and the Design surface opens on the Job panel. This
 * module is that sequence, written once — the door paths and the recent card differed only in the
 * words the file bar shows and whether a reusable handle came with the text.
 *
 * `newJob()` runs first so a handle from the job that was open before this one is released before
 * the document is replaced (its debounced autosave must not write this job over the previous file).
 */

import { parseJobFile, serializeJobFile } from '@/engine/cnc/engrave/jobFile';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { blankProjectForStock } from '@/library/blankProject';
import { rememberSaved, useEngraveJobFileStore } from './engraveJobFileStore';
import { useEngraveJobStore } from './engraveJobStore';
import { clearHistory, useProjectStore } from './projectStore';
import { useViewportStore } from './viewportStore';
import type { ProjectFileHandle } from './persistence';

export type OpenJobResult = { ok: true } | { ok: false; error: string };

export interface OpenJobFileInput {
  /** The document's text, as the file holds it. */
  text: string;
  /** The name the file bar shows for this document. */
  fileName: string;
  /** A reusable handle when a picker gave one; null for an `<input>` read or a recent snapshot. */
  handle: ProjectFileHandle | null;
  /**
   * The file bar's "last written" time: the open's own time for a real file, null for a recent
   * snapshot (whose notice states when the snapshot was taken instead).
   */
  savedAt: number | null;
  /** The first sentence of the bar's notice, e.g. "Opened tray.cutjob.json.". */
  opened: string;
}

/**
 * Parse, replace, build the blank, land on the Job panel. A refused parse changes nothing: the
 * open job, its bound file and its dirty marker are exactly as they were.
 */
export async function openJobFromText(file: OpenJobFileInput): Promise<OpenJobResult> {
  const parsed = await parseJobFile(file.text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.errors[0] ?? 'the file is not a job document' };
  }
  const project = blankProjectForStock(parsed.job.stock);
  if (project === null) {
    return { ok: false, error: 'the blank template is missing from this build' };
  }

  // A previous job's bound file must let go before the document changes, or its debounced autosave
  // would write this job into that file. `newJob` cancels it and clears the handle.
  useEngraveJobFileStore.getState().newJob();
  useEngraveJobStore.getState().replace(parsed.job);
  // The bar's own records for the opened document, as `open()` sets them.
  // #728 — the saved text is the document as opened: a mesh fingerprint corrected on the way in
  // is the one recorded, and the dirty marker compares against it without re-parsing.
  const saved = serializeJobFile(parsed.job);
  rememberSaved(parsed.job, saved);
  useEngraveJobFileStore.setState({
    handle: file.handle,
    fileName: file.fileName,
    savedText: saved,
    savedAt: file.savedAt,
    dirty: false,
    notice:
      parsed.meshNote == null
        ? { kind: 'ok', text: file.opened }
        : { kind: 'warning', text: `${file.opened} ${parsed.meshNote}` },
    packageError: parsed.package !== null && !parsed.package.ok ? parsed.package.reason : null,
    sourceError: parsed.sourceError,
  });

  useProjectStore.getState().setProject(project); // also flips welcomeMode off
  clearHistory();
  useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
  await scheduleImmediate(project);
  return { ok: true };
}
