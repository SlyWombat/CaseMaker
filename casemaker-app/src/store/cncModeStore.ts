/**
 * Which half of the CNC surface is up (#419 §3): **Design** or **Cut**.
 *
 * A STORE RATHER THAN COMPONENT STATE, for the same structural reason `manageModeStore` has one:
 * the switch is drawn at the top of `EngravePanel`, but a later slice moves the Cut surface (the
 * package line, the plan, the release step) into its own components, and each of those has to see
 * the same mode without the panel threading a prop through every one. The switch is also the only
 * control that decides whether the Design stack is mounted at all.
 *
 * SESSION-SCOPED AND DELIBERATELY NOT PERSISTED, like the wizard, the manage console and the tool
 * registry. This is a place the operator went, not a fact about the job; a reload that came back in
 * Cut would show a gate for a package the operator may no longer be holding. The frozen package
 * itself IS persisted (`engravePackageStore`), and that is a different thing.
 *
 * `jobId` is here so selecting another job starts at Design. Cut is a statement about THIS job's
 * gate; carrying it across a document switch would show the new job under the old job's mode. The
 * panel calls {@link CncModeState.syncJob} on every job change rather than the store subscribing
 * to the job store, because the panel is where the job id is already read for the panel's own
 * render.
 */

import { create } from 'zustand';

/** The two modes §5.6 names. Design is where the job is written; Cut is where it is approved. */
export type CncMode = 'design' | 'cut';

export interface CncModeState {
  mode: CncMode;
  /** The job this mode was chosen for; null until the panel first syncs it. */
  jobId: string | null;
  /** Enter one mode for the job currently on screen. */
  show: (mode: CncMode) => void;
  /**
   * Keep the mode with its job: a different job id returns to Design. The same id changes nothing,
   * so an edit within a job never pulls the operator out of Cut.
   */
  syncJob: (jobId: string) => void;
}

const INITIAL = { mode: 'design' as CncMode, jobId: null as string | null };

export const useCncModeStore = create<CncModeState>()((set, get) => ({
  ...INITIAL,

  show: (mode) => set({ mode }),

  syncJob: (jobId) => {
    if (get().jobId === jobId) return;
    set({ mode: 'design', jobId });
  },
}));

/** Test seam: back to Design, with no job remembered. */
export function resetCncMode(): void {
  useCncModeStore.setState({ ...INITIAL });
}
