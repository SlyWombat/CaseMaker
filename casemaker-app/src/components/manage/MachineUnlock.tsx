/**
 * Clear alarm (#644) — the `$X` the operator can press, and only against a machine that says it is
 * alarmed.
 *
 * THE GUARD IS THE PLATFORM'S (`platform/machineUnlock.ts`): the press asks `?` first, sends `$X`
 * only when the state word reads Alarm, and reports what the machine says AFTERWARDS, because `ok`
 * on `$X` is not the same as the alarm being gone. There is no live status in this panel, so the
 * button cannot know the state before it is pressed — it is offered whenever a machine is reachable,
 * and a press on a machine that is not alarmed sends nothing and says so.
 *
 * THE NOTE IS THE ANSWER, not a celebration: "the alarm is cleared" only when the state word is no
 * longer Alarm, "still alarming" when it is. And it never homes or moves — an alarm lock is cleared
 * at the machine, by a person who has looked at it.
 */

import { useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import { unlockMachine } from '@/platform/machineUnlock';

/** The control, or nothing at all in a build that cannot open a socket. */
export function MachineUnlock({ host, port }: { host: string; port: number }) {
  return canDriveMachine ? <UnlockButton host={host} port={port} /> : null;
}

function UnlockButton({ host, port }: { host: string; port: number }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function press(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await unlockMachine({ host, port });
      switch (result.kind) {
        case 'cleared':
          setNote('The controller answered — the alarm is cleared.');
          break;
        case 'still-alarmed':
          setNote(result.detail);
          break;
        case 'not-alarmed':
          setNote(result.detail);
          break;
        case 'timeout':
        case 'error':
        case 'unavailable':
          setNote(result.detail);
          break;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mvacuum" data-testid="manage-unlock">
      <div className="mvacuum-row">
        <span className="mvacuum-label">Alarm</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm"
          data-testid="manage-unlock-press"
          disabled={busy}
          title="Clear the machine's alarm lock ($X) — sent only when the status line reads Alarm; nothing is sent otherwise"
          onClick={() => void press()}
        >
          Clear alarm
        </button>
      </div>
      <p className="hint" data-testid="manage-unlock-hint">
        Clears the controller's alarm lock ($X) after you have looked at the machine — a probe fault or a
        limit stop stays your call, not the app's. Offered only against a machine that reports Alarm;
        it never homes or moves.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-unlock-note">
          {note}
        </p>
      )}
    </div>
  );
}
