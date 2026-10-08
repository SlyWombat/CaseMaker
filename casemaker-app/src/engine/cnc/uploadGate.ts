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
 */

import type { VerifyReport } from './verify';

/**
 * Why this report's program may not be uploaded, or `null` when it may.
 *
 * The filename clause is not decoration. The transfer protocol names the file it is about to
 * receive (Z1-Bridge-Protocol.md §5), and a name that is not a `.nc` is not a program this app
 * produced — `runSheetFileName` always emits one, so this only ever catches a caller that built a
 * name itself.
 */
export function programUploadProblem(filename: string, report: VerifyReport): string | null {
  if (!report.ok) return 'the verifier did not pass the program';
  if (report.findings.some((finding) => finding.severity === 'error')) {
    return 'the verifier reported errors in the program';
  }
  if (!/\.nc$/i.test(filename)) return `'${filename}' is not a .nc program`;
  return null;
}
