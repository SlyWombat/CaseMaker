/**
 * #289 — one of the machine's other accessory switches: spindle fan, power fan, external output,
 * the wireless-probe charge. The vacuum switch's and the work light's shape, because the question is
 * the same: a single mode the status line does not report, switched by one code, refused unless the
 * machine is idle with no job (`platform/machineAccessory.ts` owns the guard and the codes).
 *
 * IT CLAIMS ONLY WHAT IT SENT, WITH ONE OBSERVED EXCEPTION. The status line does not report these
 * outputs, so a switch says what it LAST SENT this connection — `last sent from this app: on/off ·
 * hh:mm`, or `not sent this session` until a press comes back cleanly (#1173A item 5). The parent
 * keys each switch on the observation, so a re-check, a wizard run or a machine found at a new
 * address remounts it — the reset rule the vacuum switch states. The exception is `wp-charge`: the
 * machine's diagnose line carries its `C:` input, an OBSERVED reading, so that row says `reported by
 * the machine: on/off` in its own words rather than pretending the input is this app's send.
 *
 * THE FANS ARE ALSO TEMPERATURE-SWITCHED (`temperatureswitch.spindle/power` in the Z1's own config),
 * so their hint says a press sets the fan NOW and the controller can move it again — the mode is not
 * latched by this app, and the panel does not pretend otherwise.
 */

import { useState } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { accessory, toggleAccessory, type AccessoryId } from '@/platform/machineAccessory';
import { useMachineStore } from '@/store/machineStore';
import { switchWords, type SwitchSend } from './switchWords';

/** The switch, or nothing at all in a build that cannot open a socket. */
export function MachineAccessory({
  host,
  port,
  id,
  locked = false,
}: {
  host: string;
  port: number;
  id: AccessoryId;
  locked?: boolean;
}) {
  return canReachMachine ? <AccessorySwitch host={host} port={port} id={id} locked={locked} /> : null;
}

/** The last confirmed send, or null — nothing sent yet, or the last press was unsure. */
type Mode = SwitchSend | null;

function AccessorySwitch({ host, port, id, locked }: { host: string; port: number; id: AccessoryId; locked: boolean }) {
  const spec = accessory(id);
  // #1173A — the one observed row: the machine's diagnose line reports the charger's input.
  const diagnose = useMachineStore((s) => s.diagnose);
  const reported = id === 'wp-charge' ? (diagnose?.probeChargerOn ?? null) : null;
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function press(on: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await toggleAccessory({ host, port }, id, on);
      switch (result.kind) {
        case 'toggled':
          setMode({ on: result.on, at: new Date().toISOString() });
          setNote(`The controller answered — the ${spec.name.toLowerCase()} is ${result.on ? 'on' : 'off'} now.`);
          break;
        case 'busy':
        case 'refused':
          setNote(result.detail);
          break;
        case 'timeout':
        case 'error':
        case 'unavailable':
          setMode(null);
          setNote(result.detail);
          break;
      }
    } finally {
      setBusy(false);
    }
  }

  // #1173A — the row says only what this app last sent, except the charger, whose input the machine
  // itself reports; that one says so in its own words. The card states the rule once.
  const shown = reported ?? mode?.on ?? null;
  const word =
    reported !== null
      ? `reported by the machine: ${reported ? 'on' : 'off'}`
      : switchWords(mode);
  const stateMode = shown === null ? 'unknown' : shown ? 'on' : 'off';

  return (
    <div className="mvacuum" data-testid={`manage-accessory-${id}`}>
      <div className="mvacuum-row">
        <span className="mvacuum-label">{spec.name}</span>
        <span
          className="mvacuum-state"
          data-testid={`manage-accessory-${id}-state`}
          data-mode={stateMode}
        >
          {word}
        </span>
        <span className="spacer" />
        <div className="mvacuum-btns">
          <button
            type="button"
            className="btn btn--sm"
            data-testid={`manage-accessory-${id}-on`}
            aria-pressed={shown === true}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : `Switch the ${spec.name.toLowerCase()} on (${spec.on}, ${spec.vendorKey}) — asked live, and refused unless the machine is idle with no program running`
            }
            onClick={() => void press(true)}
          >
            On
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid={`manage-accessory-${id}-off`}
            aria-pressed={shown === false}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : `Switch the ${spec.name.toLowerCase()} off (${spec.off}, ${spec.vendorKey}) — asked live, and refused unless the machine is idle with no program running`
            }
            onClick={() => void press(false)}
          >
            Off
          </button>
        </div>
      </div>
      <p className="hint" data-testid={`manage-accessory-${id}-hint`}>
        {spec.meaning}
      </p>
      {note !== null && (
        <p className="hint" data-testid={`manage-accessory-${id}-note`}>
          {note}
        </p>
      )}
    </div>
  );
}
