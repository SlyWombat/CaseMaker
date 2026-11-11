/**
 * #1202 — THE TOOL CHANGE'S OWN DRY LINE VIEW.
 *
 * The 2026-11-10 rule is the same for every motion routine: before a press that moves a machine
 * nobody has proven this sequence on, the CARD shows the exact lines the app will send, and the
 * press that starts them is marked a first run until this machine has completed that shape.
 *
 * THE TOOL CHANGE differs from the registration routines in one important way: its sequence is not
 * built by an executor. It is `pauseResumeCommands('continue-tool')` — the one line the run sends
 * when the operator answers the firmware's `Tool` stop — and this module reads THAT function, so
 * the shown list is the sent list by construction (a unit pins it). The macro's own motion
 * (`M493.2 T<n>` at the sensor, the return) is the controller's, and the card's note says so.
 */
import { pauseResumeCommands } from '@/platform/machinePause';
import { CLEARANCE_UNKNOWN, reviewLines, type DryRoutine } from '@/engine/cnc/registration/dryRun';
import { routineIdentityOf, type RoutineIdentity } from '@/engine/cnc/registration/routineIdentity';

/** The console lines the app sends when the operator presses Continue at the firmware's `Tool` stop. */
export function toolChangeLines(): string[] {
  return [...pauseResumeCommands('continue-tool').lines];
}

/** The tool-change routine's identity: the app's own continue sequence. */
export function toolChangeIdentity(): RoutineIdentity {
  return routineIdentityOf('tool-change', toolChangeLines(), {});
}

/** What the card says when the machine's clearance has not been read: no verdict is possible. */
export const TOOL_CHANGE_NO_CLEARANCE = CLEARANCE_UNKNOWN;

/**
 * The dry view the bit-change card shows before the press: the exact lines, in send order, each
 * with the motion-order guard's verdict. `clearanceZ` is the live machine clearance, the same
 * source the run's own console session is proven against; D's #1199 makes it REQUIRED — a null
 * (unread frame, a stated GRBL model) is refused rather than reviewed against an invented 0.
 */
export function dryToolChange(clearanceZ: number | null): DryRoutine {
  const lines = toolChangeLines();
  const identity = toolChangeIdentity();
  if (clearanceZ === null || !Number.isFinite(clearanceZ)) {
    return {
      lines: lines.map((line) => ({ line, refused: TOOL_CHANGE_NO_CLEARANCE })),
      identity,
      refused: true,
      error: TOOL_CHANGE_NO_CLEARANCE,
    };
  }
  const reviewed = reviewLines(lines, clearanceZ);
  return {
    lines: reviewed,
    identity,
    refused: reviewed.some((l) => l.refused !== null),
    error: null,
  };
}

/** The card's note for this routine: what the line is, and what the guard cannot see. */
export const TOOL_CHANGE_NOTE =
  'The one line the app sends on Continue. The controller’s own M490.2 macro measures the tool at ' +
  'the sensor and returns; that motion is the firmware’s, so this view shows the console line the ' +
  'app sends and the guard reviews, not inside the macro.';
