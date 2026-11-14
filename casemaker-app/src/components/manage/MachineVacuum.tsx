/**
 * The vacuum switch (#390) — the machine's extraction on or off, for cleaning, outside any job.
 *
 * THE OTHER HALF OF #283. The program turns the vacuum on for every cut and off at the end. The
 * maintainer asked for the manual half on 2026-10-12: "There should be an option to just turn vacuum
 * on/off, the hose can be used to clean out the unit or parts." So this is a two-state control on the
 * machine card, beside the #302 console, sending the machine's own `M331`/`M332` on one press.
 *
 * IT MAKES NO CLAIM IT CANNOT SUPPORT. There is no read-back — the status line does not report the
 * vacuum mode — so the switch says `last sent from this app: on/off · hh:mm`, or `not sent this
 * session` until a press comes back cleanly. That is the honest state: on first draw the controller
 * might be in either mode (the mode is off after every power-up, but this panel cannot see that), so
 * it says so rather than guessing (#1173A item 5, the manager's 2026-11-10 ruling). It falls back to
 * "not sent this session" whenever a press does not come back cleanly, because a socket that failed
 * mid-press may or may not have delivered the code.
 *
 * HANDS-OFF WHILE A JOB RUNS. A running program owns the vacuum — it wrote its own `M331` and will
 * write its own `M332` — so a press must not fight it. The machine is asked what it is doing before
 * the code is sent, and anything that is not an explicit `Idle` refuses (`platform/machineVacuum.ts`,
 * `uploadProgram`'s #296 rule). The refusal is shown, not swallowed. Nor is `Idle` alone enough: the
 * state word reads `Idle` for the last few seconds of a job too, so a line that still carries a `P:`
 * percent below 100 is a job in progress and refuses as well (#390).
 *
 * A MEMORY OF ONE CONNECTION, SO IT IS KEYED BY ONE. What this panel remembers is what it last sent
 * *on the connection it sent it on*. A re-check, a fresh wizard run and a machine found at a new
 * address are all new connections, and a power cycle clears `M331`/`M332` outright — so the parent
 * keys this component on the observation, and every one of those remounts it at `unknown` rather than
 * carrying a claim across (`MachinesScope.tsx`). That is the reset; there is no other.
 *
 * WHAT IS NOT HERE. No arming checkbox: a mode change is not motion, and `/Fabrication.md` §8's
 * "a person at the machine" rule is about moves. No `M331.x` family (`M331.1` blowing, `M331.2` bed
 * cleaning, `M331.4` static removal) — the app models the vacuum and nothing else (#283).
 */

import { useState } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { toggleBlow, toggleVacuum } from '@/platform/machineVacuum';
import { readFlag } from '@/platform/defaultsClient';
import { MACHINES } from '@/engine/cnc/machine';
import { machineAt } from '@/store/locationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { switchWords, type SwitchSend } from './switchWords';

/** The switch, or nothing at all in a build that cannot open a socket. Read at render, not at import. */
export function MachineVacuum({
  host,
  port,
  label = 'Vacuum',
  locked = false,
}: {
  host: string;
  port: number;
  /**
   * #884 — the row's name from the machine PROFILE: on the Z1 the external output IS the vacuum,
   * so the row says both rather than describing one plug twice.
   */
  label?: string;
  /** #1173A item 5 — a running program owns the output codes, so the press is off. */
  locked?: boolean;
}) {
  return canReachMachine ? <VacuumSwitch host={host} port={port} label={label} locked={locked} /> : null;
}

/** The last confirmed send, or null — nothing sent yet, or the last press was unsure. */
type Mode = SwitchSend | null;

function VacuumSwitch({ host, port, label, locked }: { host: string; port: number; label: string; locked: boolean }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function press(on: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      // #1060 — the manual press follows the same coupling the run does: with the shop option on
      // and the machine's capability present, the blower goes OFF BEFORE the vacuum when switching
      // off, and ON right after it when switching on (the vacuum switch is what the operator
      // pressed; the blower rides with it).
      const coupling =
        readFlag(useShopDefaultsStore.getState().defaults, 'run.blowWithVacuum').value &&
        MACHINES[machineAt({ host, port })?.id ?? '']?.capabilities.blow === true;
      if (!on && coupling) await toggleBlow({ host, port }, false);
      const result = await toggleVacuum({ host, port }, on);
      if (on && coupling && result.kind === 'toggled') await toggleBlow({ host, port }, true);
      switch (result.kind) {
        case 'toggled':
          setMode({ on: result.on, at: new Date().toISOString() });
          setNote(`The controller answered — the vacuum is ${result.on ? 'on' : 'off'} now.`);
          break;
        case 'busy':
        case 'refused':
          // Nothing was sent, so the mode this panel remembers is unchanged — only the reason shows.
          setNote(result.detail);
          break;
        case 'timeout':
        case 'error':
        case 'unavailable':
          // The code may or may not have arrived: the honest answer is that we no longer know.
          setMode(null);
          setNote(result.detail);
          break;
      }
    } finally {
      setBusy(false);
    }
  }

  // #884/#1173A — the row never claims machine state; the card says once that these outputs are
  // not reported, and the row says only what this app last sent.
  const word = switchWords(mode);
  const stateMode = mode === null ? 'unknown' : mode.on ? 'on' : 'off';

  return (
    <div className="mvacuum" data-testid="manage-vacuum">
      <div className="mvacuum-row">
        <span className="mvacuum-label">{label}</span>
        <span className="mvacuum-state" data-testid="manage-vacuum-state" data-mode={stateMode}>
          {word}
        </span>
        <span className="spacer" />
        <div className="mvacuum-btns">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-vacuum-on"
            aria-pressed={mode?.on === true}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : "Switch the machine's vacuum on (M851). Refused while a program is running."
            }
            onClick={() => void press(true)}
          >
            On
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-vacuum-off"
            aria-pressed={mode?.on === false}
            disabled={busy || locked}
            title={
              locked
                ? 'Locked while a program is running or while the machine is not answering'
                : "Switch the machine's vacuum off (M852). Refused while a program is running."
            }
            onClick={() => void press(false)}
          >
            Off
          </button>
        </div>
      </div>
      <p className="hint" data-testid="manage-vacuum-hint">
        The machine's own vacuum, for cleaning out the unit or a part with the hose — outside any job.
        A cut turns it on and off by itself, so a press is refused while a program is running.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-vacuum-note">
          {note}
        </p>
      )}
    </div>
  );
}
