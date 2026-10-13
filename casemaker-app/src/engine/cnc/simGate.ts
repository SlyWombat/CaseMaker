/**
 * The simulation's own rule (#393) — as one predicate, in one place.
 *
 * `SimLoadResult.ok` answers a different question from the one every caller thinks it is asking.
 * It means "the sweep produced material". It does NOT mean "this program is safe". The two come
 * apart exactly where it matters: a sweep that found the cutter 0.97 mm³ inside the fixed jaw
 * returns `ok: true` — WITH a `tool-into-fixture` error in its `diagnostics` — and it must, because
 * the Simulate panel's whole job is to draw that cut and `SimLoadRefused` carries no meshes (#194).
 *
 * So `ok` alone says nothing about safety, and a caller that trusts it writes the file. That is
 * what happened: `scripts/engrave-job.ts` gated its coupons on `load.ok`, so an 11.5 mm label whose
 * cutter reached the jaw was written, four programs, and the receipt said "all generated" (#393).
 *
 * The app's own gates never had the hole — `runErrorCodes` (`store/engraveRunStore.ts`) folds the
 * sweep's errors into `saveBlocker`, and `uploadBlocker` is never weaker — but it stated the rule a
 * second time, and a second statement of a safety rule is the one kind of duplicate guaranteed to
 * go stale (the same reasoning as `uploadGate.ts`, one file over). This module is the one
 * statement: the app's run store, `scripts/engrave-job.ts` and `scripts/bench-files.ts` all ask it,
 * so no producer of a file can differ from another about what "the simulation refused" means.
 *
 * The import is TYPE-ONLY, for the same reason `uploadGate.ts` imports `VerifyReport` that way:
 * the run store is in the WEB bundle and `session.ts` drags the geometry worker in behind it.
 */

import type { SimDiagnostic } from '@/workers/sim/session';

/** The error-severity diagnostics, in the order the sweep raised them. */
export function simErrors(diagnostics: readonly SimDiagnostic[]): SimDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/**
 * Why these diagnostics forbid writing or sending the program, or `null` when they do not.
 *
 * NAMES each error and where it was raised rather than counting them: a count tells the operator
 * that something is wrong and not what, which is how a program that drives the cutter into the jaw
 * reads exactly like one that grazes the stock top.
 */
export function simulationProblem(diagnostics: readonly SimDiagnostic[]): string | null {
  const errors = simErrors(diagnostics);
  if (errors.length === 0) return null;
  const where = (d: SimDiagnostic): string =>
    d.line !== undefined ? ` at line ${d.line}` : d.step !== undefined ? ` at step ${d.step}` : d.checkpoint !== undefined ? ` at checkpoint ${d.checkpoint}` : '';
  return `${errors.length} simulation error${errors.length === 1 ? '' : 's'}: ${errors
    .map((d) => `${d.code}${where(d)}`)
    .join('; ')}`;
}
