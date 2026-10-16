/**
 * The Stop button (#424) — stops a running program with `abort`, and says it is not the emergency stop.
 *
 * Maintainer decision Q16 (2026-10-15): ship Stop now, labelled honestly; #303 refines it. The seam is
 * `platform/machineStop.ts`: it asks first, aborts only a running program, waits for `Idle`, and then
 * switches the vacuum off — the aborted program never reaches its own `M332`.
 *
 * After a clean stop the panel offers Home as its own press: homing is motion, and the person who
 * pressed Stop decides when the head moves again (the bench rule: home when an activity is done).
 */

import { useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import { attachConsole } from '@/platform/machineConsole';
import { stopProgram, stopSettings } from '@/platform/machineStop';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';

export function MachineStop({ host, port }: { host: string; port: number }) {
  return canDriveMachine ? <StopControl host={host} port={port} /> : null;
}

function StopControl({ host, port }: { host: string; port: number }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [offerHome, setOfferHome] = useState(false);

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOfferHome(false);
    setNote('Stopping — the spindle stops now; the moves already queued finish first…');
    try {
      // #449 — the shop's `stop.*` polls; the 2 s floor holds inside `stopProgram` whatever they say.
      const r = await stopProgram({ host, port }, undefined, stopSettings(useShopDefaultsStore.getState().defaults));
      switch (r.kind) {
        case 'stopped':
          setNote(
            r.vacuumOff
              ? 'Stopped. The program was aborted and the vacuum is off.'
              : 'Stopped. The program was aborted, but the vacuum-off (M332) was not answered — check the vacuum.',
          );
          setOfferHome(true);
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
    const session = attachConsole({ host, port });
    try {
      const r = await session.send('$H');
      setNote(r.kind === 'sent' ? 'Homed.' : `Home did not complete: ${r.detail}`);
      if (r.kind === 'sent') setOfferHome(false);
    } finally {
      await session.close();
      setBusy(false);
    }
  }

  return (
    <div className="mstop" data-testid="manage-stop">
      <div className="mvacuum-row">
        <button
          type="button"
          className="btn btn--sm btn--danger"
          data-testid="manage-stop-button"
          disabled={busy}
          title="Sends abort: the spindle stops at once and the moves already queued finish. Not an emergency stop."
          onClick={() => void stop()}
        >
          Stop program
        </button>
        {offerHome && (
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-stop-home"
            disabled={busy}
            title="Home the machine ($H) — the head moves"
            onClick={() => void home()}
          >
            Home
          </button>
        )}
      </div>
      <p className="hint" data-testid="manage-stop-hint">
        Stops the running program. The machine&rsquo;s red button is the emergency stop.
      </p>
      {note !== null && (
        <p className="hint" data-testid="manage-stop-note">
          {note}
        </p>
      )}
    </div>
  );
}
