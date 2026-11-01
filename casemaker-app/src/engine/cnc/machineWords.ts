/**
 * #845 — THE SENTENCES A MACHINE'S FRAME STATE SPEAKS, in their own module so the run gate can
 * print one without loading the machine profiles.
 *
 * `store/engraveRunGate.ts` must stay loadable outside a browser — a node script imports its gates
 * (#395), which is why its one sentence-building import (`pcbWords`) lives apart from the engine
 * module that computes the report. `machine.ts` pulls zod and the material table, so the refusal a
 * stated machine's upload prints lives here instead, and the Manage card, the Cut panel and the run
 * sheet read the SAME string.
 *
 * NO IMPORTS, on purpose. Adding one re-opens the addressability the gate module exists to keep.
 */

/**
 * The refusal every frame-dependent path gives a machine whose controller frame has not been read
 * (#773). It names the fix — one connection, which runs the same `config-get sd` read the Z1's
 * #279 calibration runs — rather than a generic "unsupported".
 */
export const MACHINE_FRAME_UNREAD =
  "This Carvera's frame has not been read from the machine yet; connect it once.";

/**
 * #845 — the refusal for a machine that is run from its owner's own sender: it has no frame this
 * app can read or drive, so anything positional is not offered — the .nc is.
 */
export const MACHINE_RUN_ELSEWHERE =
  'This machine is run from your own sender: Case Maker writes its .nc and does not drive it.';
