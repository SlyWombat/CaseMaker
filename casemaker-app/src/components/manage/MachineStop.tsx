/**
 * The Stop and Home controls (#424, #1173A item 4) — at the top of the machine card, inside its
 * state card, so the action sits beside the state it acts on.
 *
 * THE LABEL IS THE ACTION. `stopProgram` (`platform/machineStop.ts`) asks the machine first and
 * aborts only a running program; the control says what a press would do NOW — `■ Stop · stops now`
 * while a program runs, `■ Stop · nothing running` and disabled when it does not. The state card
 * decides which (`machineStateWords.ts`), because it already reads the same status line.
 *
 * HOME IS THE SEAM'S, NOT A SECOND COMMAND. `homeMachine` (#693) asks `?`, sends `$H` only from
 * `Idle`, and polls until the machine reports its homed rest; an already-homed machine answers
 * without moving. That is the behaviour the wizard already uses, kept here rather than restated.
 * Homing is motion, so Home is offered only in the ready state and says so in its own note.
 */

import { useState } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { homeMachine } from '@/platform/machineChangeRun';
import { stopProgram, stopSettings } from '@/platform/machineStop';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';

export function MachineStop({
  host,
  port,
  stopLive,
  canHome,
}: {
  host: string;
  port: number;
  /** A program is running, so Stop would send `abort`. */
  stopLive: boolean;
  /** The machine is idle and reachable, so Home is a sensible press. */
  canHome: boolean;
}) {
  return canReachMachine ? (
    <StopControl host={host} port={port} stopLive={stopLive} canHome={canHome} />
  ) : null;
}

function StopControl({ host, port, stopLive, canHome }: { host: string; port: number; stopLive: boolean; canHome: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNote('Stopping — the spindle stops now; the moves already queued finish first…');
    try {
      // #449 — the shop's `stop.*` polls; the 2 s floor holds inside `stopProgram` whatever they say.
      const r = await stopProgram({ host, port }, undefined, stopSettings(useShopDefaultsStore.getState().defaults));
      switch (r.kind) {
        case 'stopped':
          setNote(
            r.vacuumOff
              ? 'Stopped. The program was aborted and the vacuum is off.'
              : 'Stopped. The program was aborted, but the vacuum-off (M852) was not answered — check the vacuum.',
          );
          break;
        case 'not-running':
          setNote('No program is running, so nothing was sent.');
          break;
        default:
          setNote(r.detail);
      }
    } finally {
      setBusy(false);
    }
  }

  async function home(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const r = await homeMachine({ host, port });
      setNote(
        r.kind === 'homed'
          ? r.sent
            ? 'Homed.'
            : 'Already home — nothing was sent.'
          : `Home did not complete: ${r.detail}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mstop" data-testid="manage-stop">
      <button
        type="button"
        className="btn btn--sm btn--danger"
        data-testid="manage-stop-button"
        disabled={busy || !stopLive}
        title={
          stopLive
            ? 'Sends abort: the spindle stops at once and the moves already queued finish. Not an emergency stop.'
            : 'No program is running, so there is nothing to stop.'
        }
        onClick={() => void stop()}
      >
        {stopLive ? '■ Stop · stops now' : '■ Stop · nothing running'}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="manage-stop-home"
        disabled={busy || !canHome}
        title="Home the machine ($H) — the head moves. Offered when the machine is idle and answering."
        onClick={() => void home()}
      >
        Home
      </button>
      <p className="hint" data-testid="manage-stop-hint">
        Stop aborts the running program. The machine&rsquo;s red button is the emergency stop.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-stop-note">
          {note}
        </p>
      )}
    </div>
  );
}
