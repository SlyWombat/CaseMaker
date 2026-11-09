/**
 * #1123 item 2 — ENTERING CNC LANDS IN THE CNC WORKSPACE, NOT ON THE DOOR.
 *
 * The wizard is one way in, not the only room: closing it must leave the operator on the Job panel,
 * where Open job…, the last jobs and Start a new job live. Before this, "Start a cutting job" from
 * the door only showed the wizard over the welcome page — ✕ put the operator back on the door, with
 * no CNC screen behind it.
 *
 * The workspace lands on the job the store already holds (the last one, or the shipped default) on
 * a blank project sized to its stock — the same blank `blankProjectForStock` makes for the wizard's
 * own stock step and the recent-job door. Nothing about the job changes here; the wizard may replace
 * project, stock and items as its steps are answered.
 */

import { blankProjectForStock } from '@/library/blankProject';
import { useEngraveJobStore } from './engraveJobStore';
import { clearHistory, useProjectStore } from './projectStore';
import { useViewportStore } from './viewportStore';

/** Enter the CNC workspace: the Job panel, on a blank sized to the job the store holds. */
export function enterCncWorkspace(): void {
  const projects = useProjectStore.getState();
  if (projects.welcomeMode) {
    const job = useEngraveJobStore.getState().job;
    const blank = blankProjectForStock(job.stock);
    // A stripped build can lack the blank template; the default project still flips the door away.
    projects.setProject(blank ?? projects.project); // also flips welcomeMode off
    clearHistory();
  }
  useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
}
