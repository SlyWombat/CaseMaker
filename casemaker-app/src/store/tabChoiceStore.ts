/**
 * #1258 — WHAT THE TAB QUESTION LAST ASKED. The planner returns the question only while it is
 * unanswered; once the operator answers, a generate succeeds and carries no numbers. The card's
 * answered summary and its "Change…" need the question's numbers, so the last question is kept here,
 * with whether the card has been collapsed to its bar. Display state only: the ANSWER lives on the
 * job (`EngraveJob.tabChoice`).
 */
import { create } from 'zustand';

import type { TabChoiceNeeded } from '@/engine/cnc/cam/model/plan';

interface TabChoiceUiState {
  asked: TabChoiceNeeded | null;
  /** The last question was marked stale (the answer on the job was for another outline or tab settings). */
  stale: boolean;
  /** After Cancel: the card is a one-line bar. */
  collapsed: boolean;
  /** After "Change…": the answered summary is reopened as the question. */
  reopened: boolean;
  ask(needed: TabChoiceNeeded, stale: boolean): void;
  collapse(): void;
  expand(): void;
  reopen(): void;
  settle(): void;
  reset(): void;
}

export const useTabChoiceStore = create<TabChoiceUiState>((set) => ({
  asked: null,
  stale: false,
  collapsed: false,
  reopened: false,
  ask: (needed, stale) =>
    set((s) => ({
      asked: needed,
      stale,
      // A NEW question (another fingerprint) opens expanded; the same one keeps the bar if it was collapsed.
      collapsed: s.asked?.fingerprint === needed.fingerprint ? s.collapsed : false,
    })),
  collapse: () => set({ collapsed: true }),
  expand: () => set({ collapsed: false }),
  reopen: () => set({ reopened: true, collapsed: false }),
  settle: () => set({ reopened: false, collapsed: false }),
  reset: () => set({ asked: null, stale: false, collapsed: false, reopened: false }),
}));
