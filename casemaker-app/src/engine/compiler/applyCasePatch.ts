import type { Project, CaseParameters } from '@/types';
import type { HatProfile } from '@/types';
import { defaultSnapCatchesForCase } from './snapCatches';

/**
 * Apply a (pre-validated) case patch to a project, running the SAME
 * auto-population rules the interactive store path uses. This is the single
 * home for those rules — projectStore.patchCase calls it inside its immer
 * produce, and the template interpreter calls it on a plain project — so a
 * template can never again bypass them (the #35/#62/#29 bug class:
 * `joint = 'snap-fit'` set directly, snapCatches never seeded).
 *
 * Rules:
 *  - snap catches auto-seed the first time joint lands on 'snap-fit'
 *    (HAT-aware — the stack height moves the rim the catches sit on, #46)
 *  - ventilation toggled on with coverage 0 bumps to 0.5, and pattern
 *    'none' becomes 'slots' so vents are actually visible (#33)
 */
export function applyCasePatch(
  draft: Project,
  patch: Partial<CaseParameters>,
  hatResolver: (id: string) => HatProfile | undefined,
): void {
  for (const [k, v] of Object.entries(patch) as [keyof CaseParameters, unknown][]) {
    (draft.case as unknown as Record<string, unknown>)[k as string] = v;
  }
  if (
    draft.case.joint === 'snap-fit' &&
    (!draft.case.snapCatches || draft.case.snapCatches.length === 0)
  ) {
    draft.case.snapCatches = defaultSnapCatchesForCase(
      draft.board,
      draft.case,
      draft.hats ?? [],
      hatResolver,
    );
  }
  if (draft.case.ventilation.enabled && draft.case.ventilation.coverage === 0) {
    draft.case.ventilation.coverage = 0.5;
  }
  if (draft.case.ventilation.enabled && draft.case.ventilation.pattern === 'none') {
    draft.case.ventilation.pattern = 'slots';
  }
}
