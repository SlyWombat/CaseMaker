/**
 * #1123 items 32/33 — THE STRIP'S ONE-LINE RECOVERY PRESSES.
 *
 * At the bench (2026-11-09) the program stopped at its `T1 M6` in the firmware's `Tool` state —
 * the strip said "Waiting for the cutter" and there was no Continue; the machine's own button
 * resumed it. And an alarm sent the operator to Manage › Machines for `$X`, though the Cut step is
 * where the alarm is met. These are the DECISIONS behind the strip's Continue / Unlock / Home
 * presses, pure so the fake-machine specs can pin them without a console.
 */

/** How a Continue press reaches the machine. */
export type ToolContinuePlan =
  /** The run watcher owns the wait: ask it to send `M490.2` at its next poll. */
  | 'request'
  /** No run of ours owns the machine (started by hand): send `M490.2` on a console now. */
  | 'send'
  /** The program is stopping; a Continue now would race the stop. */
  | 'none';

/**
 * #1123 item 32 — the Continue plan for a machine in the firmware's `Tool` state.
 *
 * - our run is running and flagged the wait: `request` (one writer, the watcher's timing);
 * - our run is running but did not flag it (the state moved between polls): `send` anyway — the
 *   operator is standing at a machine that will not move without the line;
 * - no run of ours: `send` (the program was started by hand);
 * - the run is stopping: `none`.
 */
export function toolContinuePlan(
  entry: { running?: boolean; toolWaiting?: { awaited: number | null } | null; stopAsked?: boolean } | null | undefined,
): ToolContinuePlan {
  if (entry?.running !== true) return 'send';
  if (entry.stopAsked === true) return 'none';
  return entry.toolWaiting != null ? 'request' : 'send';
}
