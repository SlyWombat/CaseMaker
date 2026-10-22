/**
 * WHY SAVE AND UPLOAD ARE DISABLED, as one predicate each (#206, #255, #395) — apart from the store
 * that holds the run.
 *
 * The run store OWNS the run; these two answer a question about one. They live here rather than
 * inside `engraveRunStore.ts` because that module cannot be loaded outside the browser: it imports
 * `platform/features.ts`, which reads vite `define`s (`__FEATURE_SIM__`), so a node script that
 * wants to ask "may this program go to the card?" gets `ReferenceError: __FEATURE_SIM__ is not
 * defined` and is left to re-state the rule for itself — which is exactly how
 * `scripts/machine-upload-check.ts` came to carry a weaker copy of it than the app's Upload button
 * (#395). This module imports NOTHING but types and `simGate`, so the app and the scripts that hand
 * a file to the real machine ask the same function.
 *
 * The store re-exports all of it, so nothing in the app changes its imports; this is the
 * implementation in one place, not a second statement of a rule.
 *
 * `EngraveRunView` is the input deliberately: a `Pick` of the store's state, so a caller that is not
 * the store — a script, a test, the QA harness — can build the end state of a run without a store.
 */

import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { SimDiagnostic } from '@/workers/sim/session';
// From the shared type module, not the store: this file must stay importable by headless scripts
// without reaching the browser-only sim store (#544).
import type { SimStatus } from '@/types/simStatus';
import { simErrors } from '@/engine/cnc/simGate';

/**
 * The warning codes that mean "a human must look at the machine before this file is run"
 * (#206): a vise that has not been measured on THIS machine, and a holder whose reach or
 * clearance to the fixture is not proven. A warning from any of these lists requires the panel's
 * acknowledgement tick.
 *
 * All three are questions the run ASKED and could not answer, so they stay rare on purpose: a
 * default vise job raises `vise-default` only while the vise is the shipped set, and
 * `holder-vs-fixture-unproven` only where an obstacle rises above the stock top with the collet
 * nut's size unstated (#314 — on a vise job the nut is provably held off by the cutter's own
 * shoulder, so the code, and this tick with it, must not appear at all). Seeing a tick prompt
 * therefore still means exactly what it says: go and look at the machine.
 */
export const ACKNOWLEDGE_CODES: ReadonlySet<string> = new Set([
  'vise-default',
  'holder-vs-fixture-unproven',
  'holder-unproven',
  // #218 — a cut-out with `tabs.count: 0` releases the part onto the board. The operator is
  // acknowledging that it stays put only by the blank's own fixing.
  'released-onto-board',
]);

/** Where the run is, as the store spells it — declared here so the view below can name it once. */
export type EngraveRunPhase = 'idle' | 'generating' | 'simulating' | 'checking' | 'ready' | 'blocked';

/**
 * Everything the two gates read, for a caller that has no store. `EngraveRunState` satisfies this
 * structurally, so the store hands its own state straight to the gates.
 */
export interface EngraveRunView {
  generated: EngraveGenerated | null;
  oracle: OracleReport | null;
  simDiagnostics: SimDiagnostic[];
  simStatus: SimStatus | null;
  phase: EngraveRunPhase;
  acknowledged: boolean;
  staleSince: number | null;
  error: string | null;
}

/** Warning codes across every row, so an acknowledgement is required for the right reasons. */
export function requiredAckCodes(v: EngraveRunView): string[] {
  const codes = new Set<string>();
  for (const f of v.generated?.findings ?? []) if (f.severity === 'warning') codes.add(f.code);
  for (const f of v.generated?.verify?.findings ?? []) if (f.severity === 'warning') codes.add(f.code);
  for (const d of v.simDiagnostics) if (d.severity === 'warning') codes.add(d.code);
  return [...codes].filter((c) => ACKNOWLEDGE_CODES.has(c));
}

/**
 * Count errors across the findings, the verifier and the sweep (#206's "zero errors").
 *
 * The sweep's slice goes through `simErrors` (`engine/cnc/simGate.ts`) rather than filtering
 * `severity` here, so that the app and the scripts that produce files (`engrave-job.ts`,
 * `bench-files.ts`) answer "did the simulation report an error?" with one function and not two
 * (#393).
 */
export function runErrorCodes(v: EngraveRunView): string[] {
  const codes: string[] = [];
  for (const f of v.generated?.findings ?? []) if (f.severity === 'error') codes.push(f.code);
  for (const f of v.generated?.verify?.findings ?? []) if (f.severity === 'error') codes.push(f.code);
  for (const d of simErrors(v.simDiagnostics)) codes.push(d.code);
  return codes;
}

/**
 * The "Matches prediction" sentence body — the metric and the floor the verdict used (#576/#580).
 * Shared by the panel's run row and the wizard's step-4 blocker (#582), so they cannot disagree.
 */
export function oracleSentence(v: EngraveRunView): string {
  if (!v.oracle) return v.phase === 'checking' || v.phase === 'simulating' ? 'checking…' : 'not checked yet';
  const floor = v.oracle.areaFloor ?? 1e-3; // #206 — the sliver floor; local so this module stays browser-free
  if (v.oracle.ok) {
    return `under-cut ${v.oracle.worst.underCut.toFixed(4)} mm², over-cut ${v.oracle.worst.overCut.toFixed(4)} mm², both within the ${floor} mm² floor (tolerance ${v.oracle.band.toFixed(3)} mm)`;
  }
  return v.oracle.worst.underCut > floor
    ? `worst under-cut ${v.oracle.worst.underCut.toFixed(4)} mm² exceeds the ${floor} mm² floor by ${(v.oracle.worst.underCut - floor).toFixed(4)} mm² — the file left material the prediction removed (over-cut ${v.oracle.worst.overCut.toFixed(4)} mm²; tolerance ${v.oracle.band.toFixed(3)} mm)`
    : `worst over-cut ${v.oracle.worst.overCut.toFixed(4)} mm² exceeds the ${floor} mm² floor by ${(v.oracle.worst.overCut - floor).toFixed(4)} mm² — the file cut outside the plan (under-cut ${v.oracle.worst.underCut.toFixed(4)} mm²; tolerance ${v.oracle.band.toFixed(3)} mm)`;
}

/** The "Verified" and "Simulated" sentence bodies, shared by the panel and the wizard (#582). */
export function verifySimulateSentences(v: EngraveRunView): { verified: string; simulated: string } {
  const verifyFindings = v.generated?.verify?.findings ?? [];
  const verifyErrors = verifyFindings.filter((f) => f.severity === 'error').length;
  const verifyWarnings = verifyFindings.filter((f) => f.severity === 'warning').length;
  const simErrs = v.simDiagnostics.filter((d) => d.severity === 'error').length;
  const simWarns = v.simDiagnostics.filter((d) => d.severity === 'warning').length;
  return {
    verified: `Verified — ${
      v.generated?.verify
        ? `${verifyErrors} error${verifyErrors === 1 ? '' : 's'}, ${verifyWarnings} warning${verifyWarnings === 1 ? '' : 's'}`
        : 'not verified yet'
    }`,
    simulated: `Simulated — ${
      v.simStatus === 'ready'
        ? `${simErrs} error${simErrs === 1 ? '' : 's'}, ${simWarns} warning${simWarns === 1 ? '' : 's'}`
        : v.simStatus
          ? `the simulation was ${v.simStatus}`
          : 'not simulated yet'
    }`,
  };
}

/**
 * Why Save is disabled, or null when it is allowed. Order matters: the first true reason is the
 * one the user should fix first.
 */
export function saveBlocker(v: EngraveRunView): string | null {
  if (!v.generated) return 'Generate first.';
  if (v.staleSince !== null) return 'the job or the machine frame changed since it was generated';
  const errors = runErrorCodes(v);
  if (errors.length > 0) return `${errors.length} error${errors.length === 1 ? '' : 's'} outstanding`;
  if (v.phase === 'generating' || v.phase === 'simulating' || v.phase === 'checking') return 'the run is still going';
  if (v.generated.nc === null) return 'no program was produced';
  if (v.simStatus !== 'ready') return 'the simulation did not finish';
  if (!v.oracle) return 'the prediction has not been checked';
  if (!v.oracle.ok) return 'the simulation does not match the prediction';
  const missing = requiredAckCodes(v);
  if (missing.length > 0 && !v.acknowledged) return 'tick the clearance checkbox below';
  return null;
}

/**
 * Why uploading to the machine is disabled, or null when it is allowed (#255).
 *
 * **Never weaker than {@link saveBlocker}** — every reason Save is blocked is a reason Upload is
 * blocked, and the first line here is what makes that true rather than a coincidence of the two
 * lists happening to agree. That direction is the safe one: a program nobody may keep is certainly
 * not one to send.
 *
 * The clauses it adds are about the UPLOAD, not about the program's trust:
 *
 *   - **one file only (#469, review R2).** The app uploads and plays a single program, so a job
 *     with more than one (a job stating `setups[]`, or a facing job, whose face file is program 1)
 *     has files nothing here can play. Uploading file one would leave the machine with half the job
 *     and — on a `'first'` span — the vacuum on. The #419 §3 release step plays the list instead;
 *     this refuses by name rather than sending the first file and hoping.
 *   - **the verifier's report having to EXIST.** `saveBlocker` does not need it —
 *     `runErrorCodes` reads `generated.verify?.findings ?? []`, so an absent report contributes no
 *     errors and a program with no report would slip through. Uploading does need it: the upload
 *     gate is a statement about a report (`programUploadProblem`), and there is no such statement
 *     to make without one. Reachable only from a hand-edited store, and answered with a sentence
 *     rather than a crash.
 */
export function uploadBlocker(v: EngraveRunView): string | null {
  const save = saveBlocker(v);
  if (save !== null) return save;
  const count = (v.generated?.programs ?? []).length;
  if (count > 1) return `this job is ${count} programs; the app plays one`;
  if (!v.generated?.verify) return 'the program carries no verifier report';
  return null;
}

/**
 * Why the #419 §3 RELEASE STEP is disabled, or null when it may take the whole run (#469).
 *
 * The release step is the one owner of a multi-program run: it uploads every file and plays them
 * in order. It is therefore allowed where {@link uploadBlocker} must refuse — a job of more than
 * one program — and this is the gate that lifts that refusal: `uploadBlocker`'s count clause is
 * deliberately absent here, while every other reason it states is kept.
 *
 * The verifier requirement is per PROGRAM, not just the first: each file is a separate upload and
 * a separate cut, and `generated.verify` describes only program 1 (the adapter the single-file
 * surfaces read). A list is runnable only when every entry carries a report that passed.
 *
 * A FACED JOB (#473) plays its face file as program 1. The generator puts it FIRST in
 * `generated.programs` (`kind: 'facing'`, posted `'first'` so the vacuum stays on across the bit
 * change), so the release step plays it like any other file. What this gate still refuses is a run
 * order that cannot be played whole: a face file the worker could not produce, or a stored result
 * from before the face file joined the list.
 */
export function releaseBlocker(v: EngraveRunView): string | null {
  const save = saveBlocker(v);
  if (save !== null) return save;
  const programs = v.generated?.programs ?? [];
  if (programs.length === 0) return 'no program was produced';
  if (programs.some((p) => !p.verify?.ok)) return 'a program did not pass the verifier';
  const generated = v.generated!;
  // #473 — a face file that exists on the result but could not join the list leaves the engraving
  // assuming a surface nobody will skim. Refuse rather than play program 1 as if it were the run.
  // (`!= null` covers both: a result stored before #432 has neither field, and must stay playable.)
  if (generated.facingError != null) {
    return `this job faces the stock first, but the face program was not produced — ${generated.facingError}`;
  }
  if (generated.facingNc != null && programs[0]?.kind !== 'facing') {
    return 'this job faces the stock first, but the face program is not in the run order — generate again';
  }
  return null;
}

/**
 * Why a FACED job cannot start before its first registration is in app state (#494), or null.
 *
 * #473's release flow plays the face file first, then the operator changes to the engraving cutter.
 * At that pause the faced top is re-touched and Z0 is written for the engraving cutter by
 * `retouchAndCorrectAfterFacing`, which needs the job's FIRST registration: the measured top the
 * facing pass was posted against. Losing that reading is not a recoverable mid-run condition — the
 * correction would have no `surfaceZ` to measure the skim against — so the refusal is stated before
 * the first file is played, with nothing cutting.
 *
 * This is a pure statement like the gates above: it takes the job, the run order and the stored
 * registration, so the panel (which holds the job) and the store (which holds the run) ask the same
 * question. The registration itself is another owner's UI; this is the seam that waits for it.
 */
export function facingRegistrationBlocker(
  job: Pick<EngraveJob, 'facing'>,
  programs: readonly Pick<EngraveProgram, 'kind'>[],
  first: { plan: RegistrationPlan; outcome: RegistrationOutcome } | null,
): string | null {
  if (job.facing?.enabled !== true) return null;
  // A job that faces plays the face file first (#473). A result from before that joined the list is
  // already refused by `releaseBlocker`; this clause only says when a registration is needed at all.
  if (programs[0]?.kind !== 'facing') return null;
  const depth = job.facing.depth;
  if (!Number.isFinite(depth) || depth <= 0) {
    return 'the facing depth must be above 0 before Z0 can be set after the skim';
  }
  if (first === null) {
    return 'this job faces the stock first, but its first registration is not in app state — run the registration step for this machine before the release';
  }
  if (!first.outcome.usable) {
    const why = first.outcome.problems.length > 0 ? first.outcome.problems.join('; ') : 'no origin may be written from it';
    return `the job's first registration is not usable — ${why}`;
  }
  return null;
}
