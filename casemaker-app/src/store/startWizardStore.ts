/**
 * Whether the startup wizard (#280) is up.
 *
 * One boolean, in a store rather than in `AppShell`'s state, for a structural reason: the wizard
 * has to OUTLIVE the welcome overlay. Step 2 creates the project, which flips `welcomeMode` off and
 * unmounts `WelcomeOverlay` — and the wizard's own entry button lives inside that overlay. Mounting
 * the wizard from `AppShell` and driving it from here keeps it up across that flip.
 *
 * Session-scoped and deliberately NOT persisted: the wizard is a thing you open, not a mode the app
 * restores. Reopening it is one click, and a wizard that reappears on every launch would be the
 * onboarding gate the field's examples all warn against (UI-PATTERNS §1: MillMage's is skippable,
 * Bantam's does not block).
 */

import { create } from 'zustand';

export interface StartWizardState {
  open: boolean;
  /** Open the wizard. Always starts at step 1 — a check, not a remembered step. */
  openWizard: () => void;
  closeWizard: () => void;
}

export const useStartWizardStore = create<StartWizardState>()((set) => ({
  open: false,
  openWizard: () => set({ open: true }),
  closeWizard: () => set({ open: false }),
}));

/** Test seam: back to closed, with no other state to unwind. */
export function resetStartWizard(): void {
  useStartWizardStore.setState({ open: false });
}
