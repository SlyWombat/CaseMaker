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
import type { OracleBbox, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { SimDiagnostic } from '@/workers/sim/session';
// From the shared type module, not the store: this file must stay importable by headless scripts
// without reaching the browser-only sim store (#544).
import type { SimStatus } from '@/types/simStatus';
import { simErrors } from '@/engine/cnc/simGate';
import { inputLabel, staleSentence, type EngraveInputKey } from '@/engine/cnc/engrave/runInputs';

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
  /**
   * #581 — WHICH input moved under a generated result, when the store knows (it names the edit that
   * set `staleSince`). Optional so a caller that has no run — a script, a test, the QA harness —
   * keeps the generic sentence.
   */
  staleReason?: EngraveInputKey | null;
  /**
   * #581 — the previous Generate's oracle verdict and the inputs that differ from it, so a flip
   * between two runs can say what changed rather than leaving a silent ✓→×. `previousVerdict`
   * null means there was no completed run to compare with.
   */
  previousVerdict?: boolean | null;
  changedSinceLast?: readonly EngraveInputKey[];
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
 * §4 — a printed figure: at most three decimals, trailing zeros dropped (`0.04`, `0.001`, `0`),
 * never `0.0000 mm²`. Returned as a number so a template prints it without a second rounding.
 * #691 — the oracle numbers now sit in the Simulate panel as facts about the picture, and the
 * vocabulary's number rule applies there like everywhere else.
 */
function figure(v: number): number {
  return Number(v.toFixed(3));
}

/**
 * #691 — §4 for a FAILING clause. A positive quantity below half a thousandth rounds to `0`, and
 * the sentence would read "exceeds the 0.001 mm² floor by 0 mm²" — a failing verdict that states
 * no failure. Such a figure prints `less than 0.001` instead. Passing sentences keep `0`, where
 * zero is the truth; the floor, tolerance and location keep their own figures, where a zero is a
 * stated threshold or a position, not a rounded-away failure.
 */
function figureFailing(v: number): number | string {
  const rounded = figure(v);
  return rounded === 0 && v > 0 ? 'less than 0.001' : rounded;
}

/**
 * #584 — the "at level Z −0.8, near (x, y) — a 0.3 × 0.27 mm patch" clause the failing sentence
 * appends, from the worst disagreement's level Z and bbox (job mm). `null` when there is none.
 */
function oracleLocation(loc: { z: number; bbox: OracleBbox } | null | undefined): string {
  if (!loc) return '';
  const cx = (loc.bbox.min[0] + loc.bbox.max[0]) / 2;
  const cy = (loc.bbox.min[1] + loc.bbox.max[1]) / 2;
  const w = loc.bbox.max[0] - loc.bbox.min[0];
  const h = loc.bbox.max[1] - loc.bbox.min[1];
  return ` at level Z ${figure(loc.z)}, near (${figure(cx)}, ${figure(cy)}) — a ${figure(w)} × ${figure(h)} mm patch`;
}

/**
 * #581 — WHY the verdict differs from the previous Generate's, in words, or '' when it does not.
 *
 * #577 proved the sweep and the oracle deterministic, so a flip means an input moved. The store
 * records which ones differ; the first in `RUN_INPUT_ORDER` is named and the rest counted. When
 * the verdict flipped and NOTHING differs, that is said plainly: the same inputs gave a different
 * verdict, which is the determinism alarm rather than a diagnosis.
 */
function flipClause(v: OracleSentenceInput): string {
  if (v.oracle === null) return '';
  const previous = v.previousVerdict;
  if (previous === null || previous === undefined) return '';
  if (v.oracle.ok === previous) return '';
  const changed = v.changedSinceLast ?? [];
  if (changed.length === 0) {
    return ' — nothing this run reads changed since the previous Generate; the same inputs gave a different verdict';
  }
  const first = inputLabel(changed[0]!);
  const others =
    changed.length === 1
      ? ''
      : `, along with ${changed.length - 1} other input${changed.length === 2 ? '' : 's'}`;
  return ` — ${first} changed since the previous Generate${others}`;
}

/**
 * What the "Matches prediction" sentence reads: the report, the phase that says whether a check is
 * still running, and the #581 comparison facts. Narrowed from {@link EngraveRunView} so a caller
 * holding a report (the Cut step's one screen) builds those four facts instead of a whole view.
 */
export interface OracleSentenceInput {
  oracle: OracleReport | null;
  phase?: EngraveRunPhase | null;
  previousVerdict?: boolean | null;
  changedSinceLast?: readonly EngraveInputKey[];
  /**
   * #535 — set when the run's program is a SURFACE (goal) program. The 2.5D oracle compares zero
   * predicted levels for one by design, so its report says 0/0 within the floor without having
   * asked anything; the sentence states the check that WAS made — the sweep of the stock, on the
   * flat dexel grid the simulation ran — instead of printing that vacuous 0/0. `gridPitchMm` is
   * the FLAT column grid's Y pitch, or null when the run was not swept on the column engine.
   */
  surface?: { gridPitchMm: number | null } | null;
}

/** A grid pitch in the words a sentence needs it in: `0.1`, never `0.10000000000000001`. */
function pitchText(mm: number): string {
  return `${Number(mm.toFixed(3))}`;
}

/**
 * #535 — the goal program's check, in words. A goal program's predicted list is empty by design
 * (a heightfield is not a 2D region), so the 2.5D oracle's 0/0 is not evidence; the check that
 * was made is the material sweep, and on a column run it carries the grid it is good to.
 */
export function surfaceCheckSentence(gridPitchMm: number | null): string {
  return gridPitchMm === null
    ? 'No 2.5D check for a surface program — the simulation swept the stock'
    : `No 2.5D check for a surface program — checked on the ${pitchText(gridPitchMm)} mm dexel grid`;
}

/** The same fact for a status line that already says "Simulated ✓": `checked on the 0.1 mm dexel grid`. */
export function surfaceGridWords(gridPitchMm: number | null): string {
  return gridPitchMm === null
    ? 'swept by the exact engine'
    : `checked on the ${pitchText(gridPitchMm)} mm dexel grid`;
}

/**
 * The "Matches prediction" sentence body — the metric and the floor the verdict used (#576/#580).
 * Shared by the panel's run row and the wizard's step-4 blocker (#582), so they cannot disagree.
 */
export function oracleSentence(v: OracleSentenceInput): string {
  if (!v.oracle) return v.phase === 'checking' || v.phase === 'simulating' ? 'checking…' : 'not checked yet';
  // #535 — a surface program has no 2.5D prediction to compare: the sentence names its own check,
  // never the 0/0 the oracle would report for an empty prediction list.
  if (v.surface) return surfaceCheckSentence(v.surface.gridPitchMm);
  const floor = v.oracle.areaFloor ?? 1e-3; // #206 — the sliver floor; local so this module stays browser-free
  const floorText = figure(floor); // #584 — the floor is a computed number, print it rounded (§4)
  // #623 — a re-posted package is judged in the blank's fitted surface frame, and the row says so:
  // the numbers otherwise read as if the lift were never applied, and a reader comparing this run
  // with the pre-re-post one needs to know the frame did not change the question asked.
  const frame = v.oracle.frame === 'surface' ? ", in the blank's fitted surface frame" : '';
  if (v.oracle.ok) {
    return `under-cut ${figure(v.oracle.worst.underCut)} mm², over-cut ${figure(v.oracle.worst.overCut)} mm², both within the ${floorText} mm² floor (tolerance ${figure(v.oracle.band)} mm${frame})${flipClause(v)}`;
  }
  return v.oracle.worst.underCut > floor
    ? `worst under-cut ${figureFailing(v.oracle.worst.underCut)} mm² exceeds the ${floorText} mm² floor by ${figureFailing(v.oracle.worst.underCut - floor)} mm²${oracleLocation(v.oracle.worst.underAt)} — the file left material the prediction removed (over-cut ${figureFailing(v.oracle.worst.overCut)} mm²; tolerance ${figure(v.oracle.band)} mm${frame})${flipClause(v)}`
    : `worst over-cut ${figureFailing(v.oracle.worst.overCut)} mm² exceeds the ${floorText} mm² floor by ${figureFailing(v.oracle.worst.overCut - floor)} mm²${oracleLocation(v.oracle.worst.overAt)} — the file cut outside the plan (under-cut ${figureFailing(v.oracle.worst.underCut)} mm²; tolerance ${figure(v.oracle.band)} mm${frame})${flipClause(v)}`;
}

// #581 — `staleSentence` (the input that moved, in words) lives with the input stamp itself
// (`engine/cnc/engrave/runInputs.ts`), so the Cut screen can state the same sentence.

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
        : 'not run'
    }`,
    simulated: `Simulated — ${
      v.simStatus === 'ready'
        ? `${simErrs} error${simErrs === 1 ? '' : 's'}, ${simWarns} warning${simWarns === 1 ? '' : 's'}`
        : v.simStatus
          ? `the simulation was ${v.simStatus}`
          : 'not run'
    }`,
  };
}

/**
 * Why Save is disabled, or null when it is allowed. Order matters: the first true reason is the
 * one the user should fix first.
 */
export function saveBlocker(
  v: EngraveRunView,
  /**
   * #688 — the Design panel's Save writes the program; the clearance statement is the RUN's, and
   * Cut step 1 owns it (#689). Passing `false` there keeps the panel from disabling Save behind a
   * checkbox that no longer lives beside it; Upload and Release keep the default, so a program
   * still cannot go to the machine before the operator has said they looked.
   */
  opts?: { requireAcknowledgement?: boolean },
): string | null {
  if (!v.generated) return 'Generate first.';
  if (v.staleSince !== null) return staleSentence(v.staleReason);
  const errors = runErrorCodes(v);
  if (errors.length > 0) return `${errors.length} error${errors.length === 1 ? '' : 's'} outstanding`;
  if (v.phase === 'generating' || v.phase === 'simulating' || v.phase === 'checking') return 'the run is still going';
  if (v.generated.nc === null) return 'no program was produced';
  if (v.simStatus !== 'ready') return 'the simulation did not finish';
  if (!v.oracle) return 'the prediction has not been checked';
  if (!v.oracle.ok) return 'the simulation does not match the prediction';
  if (opts?.requireAcknowledgement !== false) {
    const missing = requiredAckCodes(v);
    if (missing.length > 0 && !v.acknowledged) return 'tick the clearance check in Cut, step 1';
  }
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
  // #535 — a surface program carries no 2.5D report; its check is the dexel sweep, which
  // saveBlocker has already required to have finished (a simulation that did not is refused
  // there). "Never none": every runnable result carries a report or a surface program.
  if (!v.generated?.verify && v.generated?.surface3d == null) return 'the program carries no verifier report';
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
 * surfaces read). A list is runnable only when every entry carries a check that passed — a
 * verifier report, or (#535) a surface program's dexel check. Never neither.
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
  if (programs.some((p) => !(p.verify?.ok === true || p.surfaceCheck != null))) {
    return 'a program did not pass the verifier';
  }
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
 * #608 — why the release cannot start while the frozen package does not follow the registration's
 * measured tilt, or null when it does.
 *
 * A registration that fits a TILT stores `{plane, z0}` on its record (the fit's slopes at r6). The
 * frozen package was posted either flat — before the tilt was known — or against some fit. Until
 * the package's `surface` matches the registration's, the flat program would cut the colour plane
 * at a depth that drifts across the tilt, so the release refuses and points the operator at the
 * re-post, never silently uploading the flat file.
 */
export function surfaceRepostBlocker(
  pkg: { surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null } | null,
  registration: { surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null } | null,
): string | null {
  if (pkg === null || registration === null) return null;
  // #635 — BOTH DIRECTIONS. The comparison used to return early whenever the registration recorded
  // NO fit, so a package re-posted against tilt A stayed uploadable after the blank was re-seated
  // and measured as a dome or flat: the lifted program would go up under "the machine levels it and
  // the program uploads FLAT", and the colour plane would drift by A's tilt. `surface: null` there
  // means the registration recorded no tilt — a flat or dome fit, or no fit was attempted at all
  // (`surfaceSpreadPlan` answers null for a job with no cut regions to measure, #642). None of
  // those is a tilt to follow, so the flat-side answer is the conservative one either way.
  const posted = pkg.surface ?? null;
  const measured = registration.surface ?? null;
  if (measured === null) {
    return posted === null ? null : 're-generate flat — the frozen program follows a tilt, and the blank measures none now';
  }
  if (posted !== null && sameSurface(posted, measured)) return null;
  return posted === null
    ? 're-post against the tilt first — the frozen program is flat but the blank is tilted'
    : 're-post against the new tilt — the frozen program follows a different tilt than the blank measures now';
}

/** Two post fits are the same surface: the r6 coefficients and the reference Z0 all agree. */
function sameSurface(
  a: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null,
  b: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number },
): boolean {
  if (a === null) return false;
  const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
  return (
    r6(a.plane.offset) === r6(b.plane.offset) &&
    r6(a.plane.slopeX) === r6(b.plane.slopeX) &&
    r6(a.plane.slopeY) === r6(b.plane.slopeY) &&
    r6(a.z0) === r6(b.z0)
  );
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
