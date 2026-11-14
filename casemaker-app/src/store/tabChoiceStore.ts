/**
 * #1258 — THE TAB CARD'S DISPLAY STATE: whether the question is collapsed to its bar after Cancel,
 * and whether the answered summary has been reopened by "Change…". Nothing else lives here: the
 * question and its numbers come from the run's result (`tabChoiceNeeded` while it asks,
 * `plan.tabChoiceApplied` once answered, so a saved job reopened with an answer still shows its
 * summary), and the ANSWER is on the job (`EngraveJob.tabChoice`).
 */
import { create } from 'zustand';

interface TabChoiceUiState {
  /** After Cancel: the card is a one-line bar. */
  collapsed: boolean;
  /** After "Change…": the answered summary is reopened as the question. */
  reopened: boolean;
  collapse(): void;
  expand(): void;
  reopen(): void;
  settle(): void;
  reset(): void;
}

export const useTabChoiceStore = create<TabChoiceUiState>((set) => ({
  collapsed: false,
  reopened: false,
  collapse: () => set({ collapsed: true }),
  expand: () => set({ collapsed: false }),
  reopen: () => set({ reopened: true, collapsed: false }),
  settle: () => set({ reopened: false, collapsed: false }),
  reset: () => set({ collapsed: false, reopened: false }),
}));
