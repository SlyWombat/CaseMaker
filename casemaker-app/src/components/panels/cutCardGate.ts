/**
 * #1123 item 8 — WHICH GATE THE CUT CARD'S ONE START CARRIES.
 *
 * The card is step 3's only Start, so it must carry the gate of the path that Start actually
 * runs. Two paths meet here:
 *
 *   - ONE program: the Start uploads it and plays it — `uploadBlocker` states that path's gates
 *     (including "this job is N programs; the app plays one", which is about the SINGLE-FILE
 *     uploader and is true by construction for N > 1).
 *   - TWO or more: the Start is the RELEASE's (`startRelease` uploads every file and plays them in
 *     order), and `releaseBlocker` is the gate that lifts the single-file count clause while
 *     keeping every other reason.
 *
 * THE BUG THIS EXISTS TO PREVENT: falling back to `uploadBlocker` for a multi-program job. That
 * reads harmless (a second opinion) but `uploadBlocker` refuses every job of more than one
 * program by construction, so the card's Start could never be pressed on the one flow it exists
 * for. Multi-program jobs never consult the single-file gate here at all.
 */

export interface CardStartGates {
  step1Blocker: string | null;
  programBlocker: string | null;
  ackBlocker: string | null;
  releaseBlocker: string | null;
  uploadBlocker: string | null;
  missingReportBlocker: string | null;
  surfaceGate: string | null;
  domeG32Blocker: string | null;
  cutterChecklistBlocker: string | null;
  /** #1286 — the registration gate: this setup has no usable origin on this machine (`setupRunGate`). */
  registrationBlocker: string | null;
  /** True when this run is the release's (two or more programs in cut order). */
  multiProgram: boolean;
}

/** The card Start's gate: the first stated reason, in the panel's order; null means pressable. */
export function cardStartBlocker(input: CardStartGates): string | null {
  return (
    input.step1Blocker ??
    input.programBlocker ??
    input.ackBlocker ??
    // ONE PATH, ONE GATE: the release's for a multi-program run, the upload's for a single file.
    (input.multiProgram ? input.releaseBlocker : input.uploadBlocker) ??
    input.missingReportBlocker ??
    input.surfaceGate ??
    input.domeG32Blocker ??
    input.cutterChecklistBlocker ??
    // #1286 — the origin is written by Register: nothing is uploaded or played before it. It reads
    // after the reasons that name a more specific gap (the facing job's own registration sentence).
    input.registrationBlocker ??
    null
  );
}
