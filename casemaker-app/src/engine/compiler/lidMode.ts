import type { CaseParameters } from '@/types';

/**
 * Issue #117 — one place that answers "what shape is the lid?".
 *
 * Before this, seven modules each read `params.lidRecess` and
 * `params.lidCavityHeight` for themselves — the shell (its recess pocket),
 * the lid, the seal (where the channel and tongue sit), the latches (they
 * refuse a recessed lid), the alignment flange, the rugged ribs and the
 * bosses. A clamshell lid is defined by a *combination* of those two
 * fields, so every one of those readers had to agree on the combination or
 * the geometry would disagree with itself. They now all ask these
 * functions, and the answer for a project with no `seal.mode` is exactly
 * what each of them used to compute on its own — so legacy geometry is
 * unchanged by construction.
 *
 * This module is deliberately a leaf: it imports types and nothing else.
 * `seal.ts` imports `caseShell.ts`, and every one of the readers above
 * imports one or both, so anything with compiler imports here would be a
 * cycle.
 */

/**
 * The shallowest cavity a clamshell lid may have (mm). Issue #117: the
 * lid's cavity is "just enough to clear the lid-side gasket flange + 2–3 mm
 * of clearance"; 3 is the top of that range, chosen because the case-side
 * rim is the highest thing above the rim plane and the tongue hangs *below*
 * the lid's bottom face, so nothing above the rim needs more room than the
 * flange lip it is clearing.
 */
export const CLAMSHELL_MIN_CAVITY = 3;

/** Is this project's lid a clamshell box (#117)? */
export function isClamshell(params: CaseParameters): boolean {
  return params.seal?.mode === 'clamshell';
}

/**
 * Does the lid drop INTO a pocket in the rim? A clamshell lid sits ON the
 * rim by definition, so `lidRecess` is ignored in that mode rather than
 * being a second, contradictory way to say the same thing.
 */
export function lidIsRecessed(params: CaseParameters): boolean {
  return !!params.lidRecess && !isClamshell(params);
}

/**
 * Height of the lid's internal cavity, above its open underside. 0 means
 * the lid is a plate, not a shell. A clamshell lid is never a plate: when
 * the user has not set a cavity height it gets {@link CLAMSHELL_MIN_CAVITY},
 * which is the difference between "asked for a box" and "got a box".
 */
export function lidCavityHeight(params: CaseParameters): number {
  const requested = params.lidCavityHeight ?? 0;
  if (!isClamshell(params)) return requested;
  return Math.max(requested, CLAMSHELL_MIN_CAVITY);
}
