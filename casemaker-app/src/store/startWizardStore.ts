/**
 * Whether the cutting-job wizard (#280, #681) is up, and which step it opens on.
 *
 * One boolean, in a store rather than in `AppShell`'s state, for a structural reason: the wizard
 * has to OUTLIVE the welcome overlay. The stock step creates the project, which flips
 * `welcomeMode` off and unmounts `WelcomeOverlay` — and the wizard's own entry button lives inside
 * that overlay. Mounting the wizard from `AppShell` and driving it from here keeps it up across
 * that flip. It is also what lets the Design panel re-open the SAME wizard at a step (#681): the
 * panel is not the wizard's parent, so it asks this store.
 *
 * Only the OPENING step (and the opening starter, #680) lives here. From the moment it mounts, the
 * step index has ONE owner — `StartWizard` — so the counter cannot disagree with the screen. Opening
 * with no argument starts at step 1, a check rather than a remembered step.
 *
 * Session-scoped and deliberately NOT persisted: the wizard is a thing you open, not a mode the app
 * restores. Reopening it is one click, and a wizard that reappears on every launch would be the
 * onboarding gate the field's examples all warn against (UI-PATTERNS §1: MillMage's is skippable,
 * Bantam's does not block).
 */

import { create } from 'zustand';
import type { WizardStepId } from '@/components/welcome/wizardSteps';

export interface StartWizardState {
  open: boolean;
  /** The step the mounted wizard starts on; `machine` unless a caller names another. */
  initialStep: WizardStepId;
  /**
   * #680 — a starter template the welcome door asked for (`badge-blank`, `blank`). The wizard's
   * first act is the step 2 template path with this id: the blank becomes the stock and the job
   * opens on Holding. Null for every other entry.
   */
  starter: string | null;
  /** Open the wizard, optionally at a step (the panel's Stock / Hold `edit`) and/or from a starter. */
  openWizard: (step?: WizardStepId, starter?: string | null) => void;
  closeWizard: () => void;
}

export const useStartWizardStore = create<StartWizardState>()((set) => ({
  open: false,
  initialStep: 'machine',
  starter: null,
  openWizard: (step = 'machine', starter = null) => set({ open: true, initialStep: step, starter }),
  closeWizard: () => set({ open: false }),
}));

/** Test seam: back to closed, with no other state to unwind. */
export function resetStartWizard(): void {
  useStartWizardStore.setState({ open: false, initialStep: 'machine', starter: null });
}
