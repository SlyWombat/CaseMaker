/**
 * #618 — THE suspend/resume sequence, in ONE place, so a bench correction is one edit here.
 *
 * WHAT STUDIO DOES (RE 05 `docs/reverse/makera-studio/05-file-transfer.md`; workflow appendix A.5 in
 * `docs/design/cnc-job-workflow.md`): a run is started with `play /sd/gcodes/<file>` and controlled
 * with BARE words on the same console — `suspend`, `resume`, `abort` — present in the binary
 * `[DECOMPILED]`, not yet tried on our Z1. Studio's own log lines for the pair: "Suspending, waiting
 * for queue to empty… / now save current pos… / Suspended, resume to continue playing", then
 * "Resuming playing… / Restoring saved XYZ positions and state…". So the controller empties its
 * queue, holds the position, and restores it on resume; Studio itself only asks.
 *
 * WHAT IS STILL UNKNOWN — THE BENCH'S QUESTIONS (#618, the maintainer's): what `suspend` does to the
 * SPINDLE, to the VACUUM and the antistatic, and to Z (whether the firmware lifts it and puts it back
 * itself); whether a suspended job keeps its `P:` field, because the run watch reads `Idle` with no
 * `P:` after progress as a FINISH; and exactly how long the queue takes to empty. This function
 * therefore sends only the word Studio sends and gives it the same generous window the `abort` gets;
 * every additional line or answer rule the bench proves is added HERE and nowhere else.
 */

import type { ConsoleTiming } from './machineConsole';

/**
 * Which request the operator made at the run's boundary: suspend the running job, resume the
 * suspended one, or — #655 — carry a program on past the firmware's `Tool` (tool-change) stop.
 */
export type PauseAction = 'suspend' | 'resume' | 'continue-tool';

/** The console lines one action sends, and the window each is given. */
export interface PauseCommand {
  lines: readonly string[];
  timing: Partial<ConsoleTiming>;
}

/**
 * The sequence for one action. `firstReplyMs`/`maxMs` match the abort's window (60 s): the controller
 * drains its queue before it answers, and the app must not declare a live job dead while it does.
 */
export function pauseResumeCommands(action: PauseAction): PauseCommand {
  const timing: Partial<ConsoleTiming> = { firstReplyMs: 60_000, maxMs: 60_000 };
  if (action === 'suspend') return { lines: ['suspend'], timing };
  if (action === 'resume') return { lines: ['resume'], timing };
  // #655 — THE TOOL CHANGE'S SECOND HALF. After `T<n> M6` with that tool not active the controller
  // stops in state `Tool` (dialect: T:'s third value names the tool it waits for). `M490.2` is the
  // bench's continuation (2026-10-08, C-series): the head measures the tool at the sensor
  // (`M493.2 T<n>`), returns, and the program runs on. Generous window like the pair above — it is
  // a macro that MOVES.
  return { lines: ['M490.2'], timing };
}
