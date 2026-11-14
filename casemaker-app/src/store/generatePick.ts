/**
 * #1270 — THE MEASURED CUTTER PICK, UNDER THE RUN'S PROGRESS. A Generate with no cutter chosen first
 * measures candidate plans over the whole inventory (minutes, in a browser, with 50 bits). That work
 * used to run before the run existed: no progress line, a live button, a press that looked ignored.
 * This runs the pick INSIDE the press: the run is `generating` from the first moment (button
 * disabled, a second press refused), the pick's own count rides on the run's progress line, and a
 * Cancel pressed meanwhile is honoured when the pick returns.
 */
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';

export type PickOutcome<T> =
  /** A run was already in flight: nothing started. */
  | { started: false }
  /** The pick ran; `cancelled` says the press is over — stopped by the operator, or the pick threw (the value is then not to be applied). */
  | { started: true; cancelled: boolean; value: T };

export async function pickUnderProgress<T>(measure: () => Promise<T>): Promise<PickOutcome<T>> {
  const run = useEngraveRunStore.getState();
  const token = run.beginPick();
  if (token === null) return { started: false };
  // The pick reports "candidate k of n" on the preview store; mirror it onto the run's own line.
  const unsubscribe = useEngravePreviewStore.subscribe((state, prev) => {
    const p = state.measuredProgress;
    if (p === prev.measuredProgress || p === null) return;
    useEngraveRunStore.getState().pickProgress(`choosing the cutter — candidate ${p.done} of ${p.total}`, p.done, p.total);
  });
  try {
    const value = await measure();
    return { started: true, cancelled: !useEngraveRunStore.getState().pickIsCurrent(token), value };
  } catch (e) {
    // A pick that throws must not leave the run `generating` for ever (the button dead, the line
    // frozen): the press ends, and the error is said where a failed Generate says it.
    useEngraveRunStore.getState().failPick(token, e);
    return { started: true, cancelled: true, value: undefined as T };
  } finally {
    unsubscribe();
  }
}
