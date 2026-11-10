/**
 * The work-light switch (#422) — the machine's own light on or off, outside any job.
 *
 * THE VACUUM SWITCH'S SHAPE (#390), because the question is the same one: a single mode the status
 * line does not report, switched by one code, refused unless the machine is idle. The platform half
 * (`platform/machineLight.ts`) owns the guard; this panel owns only what it LAST SENT this
 * connection — `last sent from this app: on/off · hh:mm`, or `not sent this session` until a press
 * comes back cleanly (#1173A item 5), and back to "not sent" whenever a press does not.
 *
 * THE PARENT'S KEY IS THE RESET. `MachinesScope` keys this on the observation, so a machine found at
 * a new address, a re-check, a fresh wizard run or an upload's own live status remounts it at
 * `unknown` — the same rule, and the same reason, as the vacuum switch beside it.
 */

import { useState } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { toggleLight } from '@/platform/machineLight';
import { switchWords, type SwitchSend } from './switchWords';

/** The switch, or nothing at all in a build that cannot open a socket. */
export function MachineLight({ host, port, locked = false }: { host: string; port: number; locked?: boolean }) {
  return canReachMachine ? <LightSwitch host={host} port={port} locked={locked} /> : null;
}

/** The last confirmed send, or null — nothing sent yet, or the last press was unsure. */
type Mode = SwitchSend | null;

function LightSwitch({ host, port, locked }: { host: string; port: number; locked: boolean }) {
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
          setMode({ on: result.on, at: new Date().toISOString() });
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

  const word = switchWords(mode);
  const stateMode = mode === null ? 'unknown' : mode.on ? 'on' : 'off';

  return (
    <div className="mvacuum" data-testid="manage-light">
      <div className="mvacuum-row">
        <span className="mvacuum-label">Work light</span>
        <span className="mvacuum-state" data-testid="manage-light-state" data-mode={stateMode}>
          {word}
        </span>
        <span className="spacer" />
        <div className="mvacuum-btns">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-light-on"
            aria-pressed={mode?.on === true}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : "Switch the machine's work light on (M821) — asked live, and refused unless the machine is idle with no program running"
            }
            onClick={() => void press(true)}
          >
            On
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-light-off"
            aria-pressed={mode?.on === false}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : "Switch the machine's work light off (M822) — asked live, and refused unless the machine is idle with no program running"
            }
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
