/**
 * #681 — the ONE numbering. A cutting job is one wizard of four steps, and this table is the only
 * place the steps are named, ordered and counted.
 *
 * The shell (`StartWizard`) owns the step index; every step body is presentational, so a wave-2
 * slice can rewrite one step without touching the counter, the footer or another step. Nothing else
 * in the app counts wizard steps: the panel's Stock and Hold `edit` controls re-open the SAME
 * wizard at the step they name, through the store's `openWizard(step)`.
 *
 * The names are the mockup's own (`docs/design/first-job-flow-mockups.html`, stations 1–4); step 4
 * is named by the question it asks, as the mockup's heading is.
 */

export type WizardStepId = 'machine' | 'stock' | 'holding' | 'operation';

export interface WizardStepDef {
  id: WizardStepId;
  /** The word after "Step n of 4 ·". */
  name: string;
  /** What the button that LEAVES this step says, per the mockup. */
  nextLabel: string;
}

export const WIZARD_STEPS: readonly WizardStepDef[] = [
  { id: 'machine', name: 'Machine', nextLabel: 'Next: stock' },
  { id: 'stock', name: 'Stock', nextLabel: 'Next: holding' },
  { id: 'holding', name: 'Holding', nextLabel: 'Next: operation' },
  { id: 'operation', name: 'What are you cutting?', nextLabel: 'Create the job' },
];

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

export function wizardStep(id: WizardStepId): WizardStepDef {
  const found = WIZARD_STEPS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`unknown wizard step ${id}`);
  return found;
}

/** The 1-based number the counter shows. */
export function wizardStepNumber(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id) + 1;
}

/** The step before `id`, or null on the first one. */
export function previousWizardStep(id: WizardStepId): WizardStepId | null {
  const i = WIZARD_STEPS.findIndex((s) => s.id === id);
  return i > 0 ? (WIZARD_STEPS[i - 1]?.id ?? null) : null;
}

/** `Step 1 of 4 · Machine` — the one counter, in the one form. */
export function wizardStepLine(id: WizardStepId): string {
  return `Step ${wizardStepNumber(id)} of ${WIZARD_STEP_COUNT} · ${wizardStep(id).name}`;
}

/**
 * The label of the button that LEAVES `id` on this run.
 *
 * A run that began as a re-entry is editing a job that already exists, so walking on to step 4
 * ADDS an operation to it; only a run that started at step 1 creates a job (#681 follow-up).
 */
export function wizardNextLabel(id: WizardStepId, reEntry: boolean): string {
  return id === 'operation' && reEntry ? 'Add the operation' : wizardStep(id).nextLabel;
}
