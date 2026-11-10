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
  // #1109 — one word for "not answering": `Offline`, and where the check could not reach it at
  // all, the reason in the same breath.
  if (state === null) return heartbeatReachable === false ? 'Offline' : 'Offline — no answer on the network';
  switch (state) {
    case 'Idle':
      return 'Idle';
    case 'Home':
      return 'Homing (finding its rest)';
    case 'Run':
      return registrationActive ? 'Probing' : 'Running';
    case 'Alarm':
      return 'Alarm';
    case 'Hold':
    case 'Door':
      return 'Paused';
    // #655 — the firmware's Tool state (after `T<n> M6`, an `M490.2` away from running on).
    case 'Tool':
      return 'Waiting for a cutter';
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
      return '#e0a020';
    case 'Alarm':
      return '#e05252';
    default:
      // "Homing (finding its rest)" is the same state with its gloss (#1109).
      return word.startsWith('Homing') ? '#e0a020' : '#7a8794';
  }
}
