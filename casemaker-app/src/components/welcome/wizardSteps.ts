/**
 * #681 — the ONE numbering. A cutting job is one wizard of four steps, and this table is the only
 * place the steps are named, ordered and counted.
 *
 * The shell (`StartWizard`) owns the step index; every step body is presentational, so a wave-2
 * slice can rewrite one step without touching the counter, the footer or another step. Nothing else
 * in the app counts wizard steps: the panel's Stock and Hold `edit` controls re-open the SAME
 * wizard at the step they name, through the store's `openWizard(step)`.
 *
 * The names are the mockup's own (`docs/design/first-job-flow-mockups.html`, stations 1–4); the
 * question step is named by the question it asks, as the mockup's heading is. #897 put that
 * question second, ahead of the blank it sizes.
 */

export type WizardStepId = 'machine' | 'operation' | 'stock' | 'holding';

export interface WizardStepDef {
  id: WizardStepId;
  /** The word after "Step n of 4 ·". */
  name: string;
  /** What the button that LEAVES this step says, per the mockup. */
  nextLabel: string;
}

/**
 * #897 — THE WORK COMES BEFORE THE BLANK. The blank is sized from what is being cut (a mesh's
 * box, a board's outline, a line's measured extent), so the wizard asks for the work first and
 * then proposes the stock it needs; Holding follows, because how it is held follows from both.
 */
export const WIZARD_STEPS: readonly WizardStepDef[] = [
  { id: 'machine', name: 'Machine', nextLabel: 'Next: what are you cutting' },
  { id: 'operation', name: 'What are you cutting?', nextLabel: 'Next: stock' },
  { id: 'stock', name: 'Stock', nextLabel: 'Next: holding' },
  { id: 'holding', name: 'Holding', nextLabel: 'Create the job' },
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

/** `Step 1 of 4` — the header's grey eyebrow (#870); the title under it is the step's name. */
export function wizardStepEyebrow(id: WizardStepId): string {
  return `Step ${wizardStepNumber(id)} of ${WIZARD_STEP_COUNT}`;
}

/** `Step 1 of 4 · Machine` — the one counter, in the one form. */
export function wizardStepLine(id: WizardStepId): string {
  return `${wizardStepEyebrow(id)} · ${wizardStep(id).name}`;
}

/**
 * The label of the button that LEAVES `id` on this run.
 *
 * A run that began as a re-entry is editing a job that already exists, so the last step ADDS an
 * operation to it; only a run that started at step 1 creates a job (#681 follow-up).
 *
 * #874 — a job that already has work opens the question with nothing picked, and the button then
 * adds nothing: it FINISHES, so it says Done until a chip is picked, when it becomes the add again.
 *
 * #897 — the question now comes BEFORE the blank, so the button that leaves it only walks on to
 * the stock; the creating button is Holding's. `idle` is "this run has nothing to add": it makes
 * the question's button Done, and on a re-entry's Holding the same press finishes rather than
 * adding an operation nobody asked for.
 */
export function wizardNextLabel(id: WizardStepId, reEntry: boolean, idle = false): string {
  if (id === 'holding' && reEntry) return idle ? 'Done' : 'Add the operation';
  if (id === 'operation') return idle ? 'Done' : wizardStep(id).nextLabel;
  return wizardStep(id).nextLabel;
}
