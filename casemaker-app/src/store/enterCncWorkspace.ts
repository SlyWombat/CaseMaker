/**
 * #1123 item 2 — ENTERING CNC LANDS IN THE CNC WORKSPACE, NOT ON THE DOOR.
 *
 * The wizard is one way in, not the only room: closing it must leave the operator on the Job panel,
 * where Open job…, the last jobs and Start a new job live. Before this, "Start a cutting job" from
 * the door only showed the wizard over the welcome page — ✕ put the operator back on the door, with
 * no CNC screen behind it.
 *
 * THE PROJECT IS KEPT. The door is only ever entered over the store's default placeholder: the
 * initial state is `createDefaultProject()`, and the one action that returns to the door (New)
 * resets the project after its own confirmation (`showWelcome`). Replacing it here would silently
 * discard a real enclosure if any future path ever showed the door over one, so entering CNC flips
 * `welcomeMode` off on the project already in the store and touches nothing else. The wizard's
 * stock step is where a new job's blank project is made, after its own question — as it always was.
 * The engrave section owns the viewport (the job's stock and jaws), so the project behind it is not
 * what the CNC screen draws.
 */

import { useProjectStore } from './projectStore';
import { useViewportStore } from './viewportStore';

/** Enter the CNC workspace: the Job panel, over the project the store already holds. */
export function enterCncWorkspace(): void {
  const projects = useProjectStore.getState();
  // The same project object: this flips welcomeMode off and changes no field of the project.
  if (projects.welcomeMode) projects.setProject(projects.project);
  useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
}
