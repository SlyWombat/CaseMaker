/**
 * The registration specs' shared machine replies (#1180 D).
 *
 * Eight registration/scanning specs each retype the controller's probe lines and a one-line
 * "the machine sent this" constructor. The strings are the controller's own words, copied verbatim
 * from the bench traces — sharing them removes the copy without changing a byte any spec asserts
 * (rule 4: no hash/byte pin here reads these; they are answers, not expected output).
 *
 * `sentReply` is the `ConsoleSendResult` shape; `okReply` is the `ConsoleSend` shape used by the
 * engraver-registration step's two emulators. A spec imports them under its old name (`as reply`)
 * when its call sites read better that way.
 */

import type { ConsoleSend, ConsoleSendResult } from '@/platform/machineConsole';

/** `M119` with the probe open and no endstop hit — the at-rest answer every scan starts from. */
export const PROBE_OPEN_REPLY = 'X_min:0 Y_min:0 Z_min:0 X_max:0 Y_max:0 Z_max:0 Probe:0';

/** `M491`'s macro tail once the stylus has triggered at the bench's reference point. */
export const PROBE_TRIGGERED_REPLY = '[PRB:0,0,-80.000:1]\nok';

/** One reply from the `ConsoleSendResult`-shaped emulators (the registration/scan specs). */
export function sentReply(text: string): ConsoleSendResult {
  return { kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 };
}

/** One reply from the `ConsoleSend`-shaped emulators (the engraver-registration steps). */
export function okReply(text: string): ConsoleSend {
  return { ok: true, line: '', text, frames: 1, elapsedMs: 1 };
}
