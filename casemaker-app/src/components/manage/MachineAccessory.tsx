/**
 * #289 — one of the machine's other accessory switches: spindle fan, power fan, external output,
 * the wireless-probe charge. The vacuum switch's and the work light's shape, because the question is
 * the same: a single mode the status line does not report, switched by one code, refused unless the
 * machine is idle with no job (`platform/machineAccessory.ts` owns the guard and the codes).
 *
 * IT CLAIMS ONLY WHAT IT SENT. There is no read-back, so the switch shows what it LAST SENT this
 * connection — `unknown` until it has sent anything, and `unknown` again whenever a press does not
 * come back cleanly. The parent keys each switch on the observation, so a re-check, a wizard run or a
 * machine found at a new address remounts it at `unknown` — the reset rule the vacuum switch states.
 *
 * THE FANS ARE ALSO TEMPERATURE-SWITCHED (`temperatureswitch.spindle/power` in the Z1's own config),
 * so their hint says a press sets the fan NOW and the controller can move it again — the mode is not
 * latched by this app, and the panel does not pretend otherwise.
 */

import { useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import { accessory, toggleAccessory, type AccessoryId } from '@/platform/machineAccessory';

/** The switch, or nothing at all in a build that cannot open a socket. */
export function MachineAccessory({ host, port, id }: { host: string; port: number; id: AccessoryId }) {
  return canDriveMachine ? <AccessorySwitch host={host} port={port} id={id} /> : null;
}

/** `true` on, `false` off, `null` unknown — nothing has been sent, or the last press was unsure. */
type Mode = boolean | null;

function AccessorySwitch({ host, port, id }: { host: string; port: number; id: AccessoryId }) {
  const spec = accessory(id);
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
          setMode(result.on);
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

  const word = mode === null ? 'unknown' : mode ? 'on' : 'off';

  return (
    <div className="mvacuum" data-testid={`manage-accessory-${id}`}>
      <div className="mvacuum-row">
        <span className="mvacuum-label">{spec.name}</span>
        <span
          className="mvacuum-state"
          data-testid={`manage-accessory-${id}-state`}
          data-mode={mode === null ? 'unknown' : mode ? 'on' : 'off'}
        >
          {word}
        </span>
        <span className="spacer" />
        <div className="mvacuum-btns">
          <button
            type="button"
            className="btn btn--sm"
            data-testid={`manage-accessory-${id}-on`}
            aria-pressed={mode === true}
            disabled={busy}
            title={`Switch the ${spec.name.toLowerCase()} on (${spec.on}, ${spec.vendorKey}) — asked live, and refused unless the machine is idle with no program running`}
            onClick={() => void press(true)}
          >
            On
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid={`manage-accessory-${id}-off`}
            aria-pressed={mode === false}
            disabled={busy}
            title={`Switch the ${spec.name.toLowerCase()} off (${spec.off}, ${spec.vendorKey}) — asked live, and refused unless the machine is idle with no program running`}
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
