/**
 * The one sentence a machine-output switch may say about itself (#1173A item 5).
 *
 * THE MACHINE DOES NOT REPORT THESE OUTPUTS. On 2026-11-10 the Manager ruled that nothing in the
 * bench notes proves the `S:` fields track the vacuum / external output, so a switch row must not
 * read as machine STATE. It says what THIS APP last sent it, and when — or that it has sent nothing
 * this session. That is an observation of the app's own act, not an inference about the hardware.
 *
 * A press that did not come back cleanly clears the memory (the code may or may not have arrived),
 * so the row falls back to "not sent this session"; the switch's own note carries the failure.
 */

/** One confirmed send: what went out, and the moment the controller answered it. */
export interface SwitchSend {
  on: boolean;
  /** ISO timestamp of the press's clean answer. */
  at: string;
}

/** `HH:MM` in the operator's own clock, for "last sent … · 14:32". */
export function clockWords(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** The row's state text. Never "on"/"off" alone: that would read as the machine's own report. */
export function switchWords(sent: SwitchSend | null): string {
  if (sent === null) return 'not sent this session';
  return `last sent from this app: ${sent.on ? 'on' : 'off'} · ${clockWords(sent.at)}`;
}
