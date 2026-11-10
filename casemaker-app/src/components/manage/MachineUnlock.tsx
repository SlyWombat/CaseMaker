/**
 * Unlock (#644, #1173A item 2) — the alarm-clear press, and ONLY in alarm.
 *
 * The page used to draw `Alarm · Clear alarm` beside every reachable machine, which made a healthy
 * machine read alarmed. The state card now decides (`machineStateWords.ts`): in alarm this is the
 * live, primary action; out of alarm it reads `Unlock · no alarm` and is disabled. The platform
 * guard (`platform/machineUnlock.ts`) still asks `?` and sends the clear code only from `Alarm` —
 * the label is honest about what a press would do, and the guard is what makes it true.
 *
 * THE NOTE IS THE ANSWER: "the alarm is cleared" only when the state word is no longer Alarm. It
 * never homes or moves — an alarm lock is cleared by a person who has looked at the machine.
 */

import { useState } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { unlockMachine } from '@/platform/machineUnlock';

/** The control, or nothing at all in a build that cannot open a socket. */
export function MachineUnlock({ host, port, alarmed }: { host: string; port: number; alarmed: boolean }) {
  return canReachMachine ? <UnlockButton host={host} port={port} alarmed={alarmed} /> : null;
}

function UnlockButton({ host, port, alarmed }: { host: string; port: number; alarmed: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function press(): Promise<void> {
    if (busy || !alarmed) return;
    setBusy(true);
    try {
      const result = await unlockMachine({ host, port });
      switch (result.kind) {
        case 'cleared':
          setNote('The controller answered — the alarm is cleared.');
          break;
        case 'still-alarmed':
        case 'not-alarmed':
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
      <button
        type="button"
        className={alarmed ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
        data-testid="manage-unlock-press"
        disabled={busy || !alarmed}
        title={
          alarmed
            ? 'Clear the controller’s alarm lock, after you have looked at the machine'
            : 'There is no alarm to clear — this press is offered only while the controller reports Alarm'
        }
        onClick={() => void press()}
      >
        {alarmed ? 'Unlock' : 'Unlock · no alarm'}
      </button>
      <p className="hint" data-testid="manage-unlock-hint">
        Clears the controller&rsquo;s alarm lock after you have looked at the machine — a probe fault
        or a limit stop stays your call. It never homes or moves.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-unlock-note">
          {note}
        </p>
      )}
    </div>
  );
}
