/**
 * #680 — open a recent job from the welcome door.
 *
 * A recent is a SNAPSHOT: the text it carries, not a live file handle. The open sequence is the
 * door's own (`openJobFromText`, #1122), so this module only says where the text comes from and
 * what the file bar's notice says: the bound file is not known here, so the bar shows the recent's
 * file name with no handle — Save asks for a file (Save as…), exactly as it does for a downloaded
 * job. The notice says WHEN the snapshot was taken, so an operator saving over a file another
 * session has moved on since knows what they are overwriting.
 */

import { openJobFromText, type OpenJobResult } from './openJobFromText';
import { recentJobText, recentSavedAtWords, type RecentJob } from './recentJobsStore';

export type OpenRecentResult = OpenJobResult;

/** Reopen one recent job: fetch its snapshot, then the door's job-open sequence. */
export async function openRecentJob(recent: RecentJob): Promise<OpenRecentResult> {
  const text = await recentJobText(recent.fileName);
  if (text === null) {
    return {
      ok: false,
      error: 'the saved copy of this job is no longer available — open it from its file',
    };
  }
  return openJobFromText({
    text,
    fileName: recent.fileName,
    handle: null,
    savedAt: null,
    opened: `Opened ${recent.name}${recentSavedAtWords(recent.at)}.`,
  });
}
