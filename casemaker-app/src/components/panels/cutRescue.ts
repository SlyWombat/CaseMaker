/**
 * #1123 items 9/10 — THE CUT STEP'S RESCUE CARDS, and the one place that knows when one is up.
 *
 * While the machine is WAITING (its firmware `Tool` state) or the run STOPPED, one card owns the
 * recovery: the status strip renders the state in words with no buttons, and the run card offers no
 * Start/Pause/Stop of its own. The card's "End the job here" dismissal is UI state only — the issue
 * leaves the run record untouched — so it lives here, in its own small store, not on the record.
 */
import { create } from 'zustand';

interface CutRescueState {
  /** Targets whose STOPPED card the operator dismissed (“End the job here”). */
  dismissedStopped: Record<string, boolean>;
  dismissStopped: (machine: string) => void;
  clearDismissed: (machine: string) => void;
}

export const useCutRescueStore = create<CutRescueState>()((set) => ({
  dismissedStopped: {},
  dismissStopped: (machine) =>
    set((s) => ({ dismissedStopped: { ...s.dismissedStopped, [machine]: true } })),
  clearDismissed: (machine) =>
    set((s) => {
      if (s.dismissedStopped[machine] !== true) return s;
      const next = { ...s.dismissedStopped };
      delete next[machine];
      return { dismissedStopped: next };
    }),
}));

/** The firmware's tool wait: the machine is parked and the waiting card is up. */
export function waitingCardUp(entry: { running?: boolean; toolWaiting?: unknown } | undefined | null): boolean {
  return entry?.running === true && entry?.toolWaiting != null;
}

/** The release is in a stopped/failed phase — the stopped card's own state. */
export function stoppedPhase(release: { phase?: string } | undefined | null): boolean {
  return release?.phase === 'failed' || release?.phase === 'stopped';
}
