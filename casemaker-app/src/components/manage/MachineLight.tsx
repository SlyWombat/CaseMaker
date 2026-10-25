/**
 * The work-light switch (#422) — the machine's own light on or off, outside any job.
 *
 * THE VACUUM SWITCH'S SHAPE (#390), because the question is the same one: a single mode the status
 * line does not report, switched by one code, refused unless the machine is idle. The platform half
 * (`platform/machineLight.ts`) owns the guard; this panel owns only what it LAST SENT this
 * connection — `unknown` until it has sent anything, and `unknown` again whenever a press does not
 * come back cleanly, because a socket that failed mid-press may or may not have delivered the code.
 *
 * THE PARENT'S KEY IS THE RESET. `MachinesScope` keys this on the observation, so a machine found at
 * a new address, a re-check, a fresh wizard run or an upload's own live status remounts it at
 * `unknown` — the same rule, and the same reason, as the vacuum switch beside it.
 */

import { useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import { toggleLight } from '@/platform/machineLight';

/** The switch, or nothing at all in a build that cannot open a socket. */
export function MachineLight({ host, port }: { host: string; port: number }) {
  return canDriveMachine ? <LightSwitch host={host} port={port} /> : null;
}

/** `true` on, `false` off, `null` unknown — nothing has been sent, or the last press was unsure. */
type Mode = boolean | null;

function LightSwitch({ host, port }: { host: string; port: number }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function press(on: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await toggleLight({ host, port }, on);
      switch (result.kind) {
        case 'toggled':
          setMode(result.on);
          setNote(`The controller answered — the work light is ${result.on ? 'on' : 'off'} now.`);
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
    <div className="mvacuum" data-testid="manage-light">
      <div className="mvacuum-row">
        <span className="mvacuum-label">Work light</span>
        <span className="mvacuum-state" data-testid="manage-light-state" data-mode={mode === null ? 'unknown' : mode ? 'on' : 'off'}>
          {word}
        </span>
        <span className="spacer" />
        <div className="mvacuum-btns">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-light-on"
            aria-pressed={mode === true}
            disabled={busy}
            title="Switch the machine's work light on (M821) — asked live, and refused unless the machine is idle with no program running"
            onClick={() => void press(true)}
          >
            On
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-light-off"
            aria-pressed={mode === false}
            disabled={busy}
            title="Switch the machine's work light off (M822) — asked live, and refused unless the machine is idle with no program running"
            onClick={() => void press(false)}
          >
            Off
          </button>
        </div>
      </div>
      <p className="hint" data-testid="manage-light-hint">
        The machine's own work light, for setting up or looking at the cut — outside any job. A press is
        refused while a program is running.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-light-note">
          {note}
        </p>
      )}
    </div>
  );
}
