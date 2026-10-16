/**
 * A machine's optional power switch on the Machines card (#416, decision Q5).
 *
 * NOTHING WITHOUT ONE. With no switch configured this draws no state and no On / Off — only, on the
 * desktop build, a collapsed "Power switch (optional)" to set one up. A web window draws nothing at
 * all: it cannot read the machine's status, so it could never meet the Off guard, and the token can
 * only be saved from the app's own computer.
 *
 * ON waits for the controller to answer, for the shop's `power.onWaitSeconds`; OFF is judged by
 * `manualOffAllowed` on a status read taken at the moment of the click (`power.sh off`'s rule).
 * The token is sent once, into the desktop's secure store, and never shown again — the card says
 * only whether one is saved, and that it does not travel with an exported `location.json`.
 */

import { useCallback, useEffect, useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import { probeMachine } from '@/platform/machineProbe';
import type { MachineRecord } from '@/platform/locationClient';
import {
  housePower,
  houseRemovePower,
  houseSetPower,
  houseSetPowerToken,
  houseSwitchPower,
  type PowerStatus,
} from '@/platform/powerClient';
import { useLocationStore } from '@/store/locationStore';
import {
  cycleConfirmed,
  manualOffAllowed,
  powerOffGuarded,
  powerOnAndWait,
  probeSettled,
  type PowerDeps,
} from '@/store/powerStore';
import { shopDefault } from '@/store/shopDefaultsStore';

function sentence(res: { kind: string; reason?: string; message?: string; detail?: string }): string {
  return res.message ?? res.reason ?? res.detail ?? 'it did not work';
}

/** The world a flow runs against, for this machine. */
function depsFor(machine: MachineRecord): PowerDeps {
  return {
    switchPlug: async (on) => {
      const res = await houseSwitchPower(machine.id, on);
      return res.kind === 'ok' ? { ok: true } : { ok: false, reason: sentence(res) };
    },
    plugIsOn: async () => {
      const res = await housePower(machine.id);
      if (res.kind !== 'ok' || res.status.state === null) return null;
      return res.status.state.kind === 'on' ? true : res.status.state.kind === 'off' ? false : null;
    },
    probe: async () => {
      if (machine.address === null) return { answered: false, status: null };
      const r = await probeMachine({ host: machine.address.host, port: machine.address.port });
      return r.kind === 'found'
        ? { answered: r.observation.status !== null, status: r.observation.status }
        : { answered: false, status: null };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export function MachinePower({
  machine,
  probeGapMs,
}: {
  machine: MachineRecord;
  /** The pause between the probes that decide "silent" — the default 2 s; a test passes a short one. */
  probeGapMs?: number;
}) {
  const [status, setStatus] = useState<PowerStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  /** A step the person must confirm: switching a silent machine off, or cycling the plug. */
  const [ask, setAsk] = useState<'off' | 'cycle' | null>(null);

  const read = useCallback(async () => {
    if (machine.power === null) return;
    const res = await housePower(machine.id);
    if (res.kind === 'ok') setStatus(res.status);
    else setNote({ kind: 'error', text: sentence(res) });
  }, [machine.id, machine.power]);

  useEffect(() => {
    // The first read, as a subscription to the service's answer: state is set in its callback.
    if (machine.power === null) return;
    let live = true;
    void housePower(machine.id).then((res) => {
      if (!live) return;
      if (res.kind === 'ok') setStatus(res.status);
      else setNote({ kind: 'error', text: sentence(res) });
    });
    return () => {
      live = false;
    };
  }, [machine.id, machine.power]);

  if (!canDriveMachine) return null;
  if (machine.power === null) {
    return (
      <>
        <span>power</span>
        <b data-testid="manage-power-none">
          <span className="dim">no switch — nothing needs one </span>
          <PowerSetup machine={machine} />
        </b>
      </>
    );
  }

  const on = async () => {
    setBusy('on');
    setNote(null);
    setAsk(null);
    try {
      const wait = shopDefault('power.onWaitSeconds');
      const r = await powerOnAndWait(depsFor(machine), { waitSeconds: wait.value, probeGapMs });
      if (r.ok) setNote({ kind: 'ok', text: 'On — the machine answered.' });
      else {
        setNote({ kind: 'error', text: r.reason });
        // Never automatic (#416 review): the cycle is offered, and only the person starts it.
        if (r.needsCycle) setAsk('cycle');
      }
    } finally {
      setBusy(null);
      void read();
    }
  };

  const cycle = async () => {
    setBusy('cycle');
    setAsk(null);
    try {
      const wait = shopDefault('power.onWaitSeconds');
      const r = await cycleConfirmed(depsFor(machine), { waitSeconds: wait.value, probeGapMs });
      setNote(r.ok ? { kind: 'ok', text: 'Cycled — the machine answered.' } : { kind: 'error', text: r.reason });
    } finally {
      setBusy(null);
      void read();
    }
  };

  const off = async (confirmedSilent = false) => {
    setBusy('off');
    setNote(null);
    setAsk(null);
    try {
      const deps = depsFor(machine);
      // Several probes, never one (#416 review): a single silent answer is a network blip as often
      // as a dead controller, and this decides whether mains is cut.
      const fresh = await probeSettled(deps, { gapMs: probeGapMs });
      // The card knows of no running job; the status line's own `P:` is what the guard reads.
      const verdict = manualOffAllowed({ canReadStatus: true, status: fresh, jobRunning: false, confirmedSilent });
      if (!verdict.ok && 'needsConfirm' in verdict) {
        setNote({ kind: 'warn', text: verdict.reason });
        setAsk('off');
        return;
      }
      const r = await powerOffGuarded(deps, verdict);
      setNote(
        r.ok
          ? { kind: r.warning ? 'warn' : 'ok', text: r.warning ? `Off — ${r.warning}.` : 'Off.' }
          : { kind: 'error', text: `Not switched off: ${r.reason}.` },
      );
    } finally {
      setBusy(null);
      void read();
    }
  };

  const state = status?.state;
  return (
    <>
      <span>power</span>
      <b data-testid="manage-power">
        <span data-testid="manage-power-state">
          {state == null ? '—' : state.kind === 'other' ? state.detail : state.kind}
        </span>{' '}
        <span className="dim">
          {machine.power.entityId} via Home Assistant
          {status !== null && !status.hasToken ? ' · no token saved on this computer' : ''}
        </span>
        <span className="btn-row">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-power-on"
            disabled={busy !== null || status?.hasToken !== true}
            onClick={() => void on()}
          >
            {busy === 'on' ? 'Switching on…' : 'On'}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-power-off"
            disabled={busy !== null || status?.hasToken !== true}
            title="Refused unless the machine reads Idle; a machine that does not answer is switched off only if you confirm"
            onClick={() => void off()}
          >
            {busy === 'off' ? 'Switching off…' : 'Off'}
          </button>
          {ask === 'off' && (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              data-testid="manage-power-off-confirm"
              disabled={busy !== null}
              onClick={() => void off(true)}
            >
              Switch off anyway
            </button>
          )}
          {ask === 'cycle' && (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              data-testid="manage-power-cycle-confirm"
              disabled={busy !== null}
              title="Off, a pause, on — only if no job is running"
              onClick={() => void cycle()}
            >
              Cycle the plug
            </button>
          )}
        </span>
        {status?.problem && <span className="dim" data-testid="manage-power-problem"> {status.problem}</span>}
        {note !== null && (
          <span className="hint" data-testid="manage-power-note" data-status={note.kind}>
            {' '}
            {note.text}
          </span>
        )}
        <PowerSetup machine={machine} />
      </b>
    </>
  );
}

/** Set up, change or remove the switch, and save its token. Collapsed by default. */
function PowerSetup({ machine }: { machine: MachineRecord }) {
  const [baseUrl, setBaseUrl] = useState(machine.power?.baseUrl ?? '');
  const [entityId, setEntityId] = useState(machine.power?.entityId ?? 'switch.');
  const [token, setToken] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    const res = await houseSetPower(
      machine.id,
      { provider: 'home-assistant', baseUrl: baseUrl.trim(), entityId: entityId.trim() },
      useLocationStore.getState().etag,
    );
    if (res.kind !== 'ok') return setNote(sentence(res));
    if (token !== '') {
      const t = await houseSetPowerToken(machine.id, token);
      setToken('');
      if (t.kind !== 'ok') {
        await useLocationStore.getState().refresh();
        return setNote(`the switch is saved, the token is not: ${sentence(t)}`);
      }
    }
    setNote('Saved.');
    await useLocationStore.getState().refresh();
  };

  const remove = async () => {
    const res = await houseRemovePower(machine.id, useLocationStore.getState().etag);
    setNote(res.kind === 'ok' ? 'Removed, with its token.' : sentence(res));
    await useLocationStore.getState().refresh();
  };

  return (
    <details data-testid="manage-power-setup">
      <summary>Power switch (optional)</summary>
      <p className="hint">
        A controllable plug lets a job switch the machine on at its start and off after it has homed.
        Most machines have none, and nothing needs one. Home Assistant is the provider this build knows.
      </p>
      <label className="lf">
        <span>Home Assistant address</span>
        <input
          className="fld fld--text"
          type="text"
          value={baseUrl}
          placeholder="http://homeassistant.local:8123"
          data-testid="manage-power-url"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="lf">
        <span>switch entity</span>
        <input
          className="fld fld--text"
          type="text"
          value={entityId}
          data-testid="manage-power-entity"
          onChange={(e) => setEntityId(e.target.value)}
        />
      </label>
      <label className="lf">
        <span>
          token <em>kept in this computer’s secure store; not in an exported location.json</em>
        </span>
        <input
          className="fld fld--text"
          type="password"
          autoComplete="off"
          value={token}
          data-testid="manage-power-token"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <div className="btn-row">
        <button type="button" className="btn btn--sm btn--primary" data-testid="manage-power-save" onClick={() => void save()}>
          Save
        </button>
        {machine.power !== null && (
          <button type="button" className="btn btn--sm btn--danger" data-testid="manage-power-remove" onClick={() => void remove()}>
            Remove the switch
          </button>
        )}
      </div>
      {note !== null && (
        <p className="hint" data-testid="manage-power-setup-note">
          {note}
        </p>
      )}
    </details>
  );
}
