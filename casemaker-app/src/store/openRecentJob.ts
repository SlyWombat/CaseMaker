/**
 * #680 — open a recent job from the welcome door.
 *
 * The same three moves the wizard makes when it creates a project, from the other direction: the
 * document replaces the open job (only when it parses), the blank project is sized to the job's own
 * stock, and the Design surface opens on the job. There is no file picker and no bound handle: the
 * recent carries the document's text, so the job opens in any build.
 *
 * THE FILE BAR IS TOLD THE TRUTH. The bound file is not known here — the entry is a snapshot, not a
 * live handle — so the bar shows the recent's file name with no handle: Save asks for a file (Save
 * as…), exactly as it does for a downloaded job. `newJob()` runs first so a handle from the job that
 * was open before this one is released before the document is replaced (its autosave must not write
 * this job over the previous file).
 */

import { parseJobFile } from '@/engine/cnc/engrave/jobFile';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { blankProjectForStock } from '@/library/blankProject';
import { useEngraveJobFileStore } from './engraveJobFileStore';
import { useEngraveJobStore } from './engraveJobStore';
import { clearHistory, useProjectStore } from './projectStore';
import { useViewportStore } from './viewportStore';
import type { RecentJob } from './recentJobsStore';

export type OpenRecentResult = { ok: true } | { ok: false; error: string };

/** Reopen one recent job: parse, replace, build its blank, land in Design. */
export async function openRecentJob(recent: RecentJob): Promise<OpenRecentResult> {
  const parsed = await parseJobFile(recent.text);
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
  // The bar's own records for the opened document, as `open()` sets them — minus the handle.
  useEngraveJobFileStore.setState({
    handle: null,
    fileName: recent.fileName,
    savedText: recent.text,
    dirty: false,
    notice: { kind: 'ok', text: `Opened ${recent.name}.` },
    packageError: parsed.package !== null && !parsed.package.ok ? parsed.package.reason : null,
    sourceError: parsed.sourceError,
  });

  useProjectStore.getState().setProject(project); // also flips welcomeMode off
  clearHistory();
  useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
  await scheduleImmediate(project);
  return { ok: true };
}
