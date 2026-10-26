/**
 * The machine's state in the operator's words: the status strip's own vocabulary, in one place.
 *
 * These were the strip's private helpers until the first-job wizard needed the same line (#682,
 * design `first-job-flow.md` §3.2: "one line in the machine strip's words"). They live in their own
 * module rather than being exported from the component file because a component module may only
 * export components (react-refresh), and a second copy of the words is how two surfaces start
 * saying different things about the same machine.
 */

/** The controller's state word in the operator's words (#647's vocabulary, the Cut step's own). */
export function stateWord(
  state: string | null,
  registrationActive: boolean,
  heartbeatReachable: boolean | null,
): string {
  if (state === null) return heartbeatReachable === false ? 'Offline' : 'Not answering';
  switch (state) {
    case 'Idle':
      return 'Idle';
    case 'Home':
      return 'Homing';
    case 'Run':
      return registrationActive ? 'Probing' : 'Running';
    case 'Alarm':
      return 'Alarm';
    case 'Hold':
    case 'Door':
      return 'Paused';
    // #655 — the firmware's Tool state (after `T<n> M6`, an `M490.2` away from running on).
    case 'Tool':
      return 'Waiting for the cutter';
    default:
      return state;
  }
}

/** The dot's colour: the state as a glance, the word as the answer. */
export function stateColour(word: string): string {
  switch (word) {
    case 'Idle':
      return '#4caf50';
    case 'Running':
    case 'Probing':
      return '#4a9eff';
    case 'Paused':
    case 'Homing':
      return '#e0a020';
    case 'Alarm':
      return '#e05252';
    default:
      return '#7a8794';
  }
}
