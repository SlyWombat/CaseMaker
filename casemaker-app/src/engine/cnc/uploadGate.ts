/**
 * The verified-only rule (#174, #206, `/Fabrication.md` §5.7) — as one predicate, in one place.
 *
 * NOTHING reaches the machine that has not passed the verifier. Two callers ask this question and
 * they must never disagree:
 *
 *   - `asVerifiedProgram` (`platform/desktop/machineBridge.ts`) builds the TYPE-level gate on it —
 *     `VerifiedProgram` has no other constructor, and `uploadVerifiedProgram` re-checks at runtime
 *     before it opens a socket.
 *   - `platform/machineUpload.ts` asks it BEFORE it reaches for the bridge, so a program that
 *     cannot be uploaded is refused with a sentence and without the desktop module ever being
 *     loaded. The difference the caller sees is "this is not uploadable" rather than "the upload
 *     failed", which is the honest one.
 *
 * It lives in its own module, rather than in `verify.ts` beside `VerifyReport`, for a bundling
 * reason with a correctness consequence: `machineUpload.ts` is in the WEB bundle, and `verify.ts`
 * is not — importing a value from it would drag the G-code parser, the emulator and the tool model
 * into the web entry chunk to answer a three-line question. The import here is type-only, so this
 * module costs nothing but the function.
 *
 * A copy of these three clauses in the web-side caller would be a second statement of a safety
 * rule, which is the one kind of duplicate that is guaranteed to go stale. Hence: one predicate.
 *
 * #535 — THE ONE PROGRAM WITH NO 2.5D REPORT. A pure goal job is 3D, and the exact verifier cannot
 * judge it; its check is the material sweep on the FLAT dexel, recorded as a
 * {@link SurfaceProgramCheck}. The rule becomes "a verifier report OR a surface check, never
 * neither": the union type is the gate, and the report's clauses apply to the report branch alone.
 */

import type { VerifyReport } from './verify';

/**
 * #535 — THE SURFACE PROGRAM'S CHECK. A pure goal job's program is 3D: the exact 2.5D verifier
 * cannot judge it (a ball "can neither sweep nor trace"), so the honest check is the material
 * sweep the simulation ran on the FLAT dexel. This is that check, recorded — never nothing: a
 * program reaches the machine with a verifier report OR this, and the type says so.
 */
export interface SurfaceProgramCheck {
  readonly kind: 'surface';
  /** The flat dexel grid the goal program's sweep ran on, mm; null when the exact engine swept it. */
  readonly gridPitchMm: number | null;
  /** The Z layers the CAM's roughing pass stepped through. */
  readonly roughingLayers: number;
  /**
   * #671 — the passes the sweep judged, by the IR's own operation names (rough, parallel finish,
   * and whichever of scallop and pencil the operation asked for). The grid says what the sweep is
   * good to; this says what it covered, so a program that lost a pass says so in its own record.
   * Absent on a check stored by a build before #671.
   */
  readonly passes?: readonly string[];
  /** The heightfield's resolution sentence the CAM stated. */
  readonly resolutionNote: string;
  /** The program's XY extent, for the console's laser frame (the verifier's role on a 2D file). */
  readonly bbox: { readonly min: readonly [number, number]; readonly max: readonly [number, number] };
}

/** What a program carries as its check: the verifier's report, or (a surface program) the dexel check. */
export type ProgramCheck = { readonly kind: 'verify'; readonly report: VerifyReport } | SurfaceProgramCheck;

/** Wrap a verifier report as a check, so every caller speaks the one type. */
export function verifyCheck(report: VerifyReport): ProgramCheck {
  return { kind: 'verify', report };
}

/**
 * Why this program may not be uploaded, or `null` when it may.
 *
 * The filename clause is not decoration. The transfer protocol names the file it is about to
 * receive (Z1-Bridge-Protocol.md §5), and a name that is not a `.nc` is not a program this app
 * produced — `runSheetFileName` always emits one, so this only ever catches a caller that built a
 * name itself.
 *
 * #535 — A SURFACE PROGRAM has no 2.5D report to ask. Its check is the dexel sweep that ran, and
 * the clauses the report would be asked (did it pass, any error findings) have no 2D analogue; the
 * run gates already refused a sweep with errors before this text was frozen. The type is the
 * guarantee that a check exists, and the filename clause is the same one.
 */
export function programUploadProblem(filename: string, check: ProgramCheck): string | null {
  if (check.kind === 'verify') {
    if (!check.report.ok) return 'the verifier did not pass the program';
    if (check.report.findings.some((finding) => finding.severity === 'error')) {
      return 'the verifier reported errors in the program';
    }
  }
  if (!/\.nc$/i.test(filename)) return `'${filename}' is not a .nc program`;
  return null;
}
