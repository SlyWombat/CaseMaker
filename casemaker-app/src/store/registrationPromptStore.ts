/**
 * #hotfix — A LIVE REGISTRATION PROMPT MUST NEVER WAIT IN A FOLDED STEP.
 *
 * The registration executor's operator prompts (`confirm-mount`, `fit-cutter`, `search-lower`) are
 * rendered inside Cut step 2. A Register press can stale the package, at which point `currentStep`
 * falls to 1 and step 2 folds — with the executor still waiting inside it. The bench lost two runs
 * to a prompt nobody could see.
 *
 * The prompt's state is local to `EngraveRegistrationStep`, so this is the one boolean it publishes
 * to the Cut surface: true while the executor is busy AND a prompt is live. The Step that holds it
 * forces itself open on that flag and refuses the operator's fold while it is set.
 */
import { create } from 'zustand';

export interface RegistrationPromptState {
  /** True while the registration executor is waiting on the operator. */
  pending: boolean;
  setPending: (pending: boolean) => void;
}

export const useRegistrationPromptStore = create<RegistrationPromptState>()((set) => ({
  pending: false,
  setPending: (pending) => set({ pending }),
}));
