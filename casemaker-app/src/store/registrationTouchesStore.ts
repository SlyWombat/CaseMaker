/**
 * #519 item 1 — the registration run's readings AS THEY LAND, in app state.
 *
 * The executor hands each touch to `ExecDeps.onTouch`; the registration step writes it here, so the
 * dock's Touches tab and the viewport's `touches` layer can show a reading the moment it lands
 * instead of waiting for the run to end and `RunResult` to come back. The same store carries the
 * runner's latest step (#587's narration), which the status strip prints while a registration owns
 * the machine — "what the machine is doing now" has one home beside the readings it belongs to.
 *
 * SESSION STATE, deliberately not persisted: a touch is a measurement on one blank in one run, and
 * a reload has no run. `reset()` is called when a new run starts (and on "run it again"), so the
 * markers and the table always describe the run that is on screen.
 */

import { create } from 'zustand';
import type { LiveTouch } from '@/engine/cnc/registration/liveTouch';

export interface RegistrationTouchesState {
  /** Every reading of the current run, in the order they landed. */
  touches: LiveTouch[];
  /** The job the readings belong to, so a layer left from another job is not drawn as this one's. */
  jobId: string | null;
  /** The spread assessment's verdict sentence once the run assessed it, else null. */
  spreadSentence: string | null;
  /** The runner's latest narration (#587), for the strip; null when no run is going. */
  step: string | null;
  /** Start a new run for `jobId`: nothing from the last one survives. */
  reset: (jobId?: string | null) => void;
  /** One reading, as it landed. */
  add: (touch: LiveTouch) => void;
  /** The spread sentence, when the run's assessment landed. */
  setSpreadSentence: (sentence: string | null) => void;
  /** The runner's latest step sentence, or null when it is not running. */
  setStep: (sentence: string | null) => void;
}

export const useRegistrationTouchesStore = create<RegistrationTouchesState>()((set) => ({
  touches: [],
  jobId: null,
  spreadSentence: null,
  step: null,
  reset: (jobId = null) => set({ touches: [], jobId, spreadSentence: null, step: null }),
  add: (touch) => set((s) => ({ touches: [...s.touches, touch] })),
  setSpreadSentence: (spreadSentence) => set({ spreadSentence }),
  setStep: (step) => set({ step }),
}));

/** Test seam: empty the store without touching anything else. */
export function resetRegistrationTouchesStore(): void {
  useRegistrationTouchesStore.setState({ touches: [], jobId: null, spreadSentence: null, step: null });
}
