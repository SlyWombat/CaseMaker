/**
 * #681 — step 1 of the one cutting-job wizard: the machine.
 *
 * The shell owns the step index and the counter; this component owns only the step's body, so
 * wave 2's machine-step slice (#682) can rewrite it without touching the wizard's numbering,
 * footer or any other step.
 *
 * The body is the one that shipped in the startup wizard (#347): a picker over the profiles this
 * app can write for, and — where a socket exists — a CHECK that asks the network. Neither half
 * blocks: a job can be authored, verified and simulated with no machine at all (UI-PATTERNS §1).
 */

import type { CSSProperties, JSX } from 'react';
import { MACHINES } from '@/engine/cnc/machine';
import { machineCalibrationNotice } from '@/engine/cnc/calibration';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { canDriveMachine } from '@/platform/capabilities';
import type { MachineObservation } from '@/platform/machineProbe';
import type { MachineCheckOutcome } from '@/store/machineStore';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const NOTE: CSSProperties = { ...MUTED, borderLeft: '2px solid #3a5a7a', paddingLeft: 6 };

/** The machines step 1 offers: every profile this app can actually write for (#347). */
const MACHINE_PROFILES = Object.values(MACHINES);

/** `100 × 60 × 12 mm` — the work area is the envelope's span, machine coordinates run negative. */
function span(min: number, max: number): number {
  return Number((max - min).toFixed(3));
}

/**
 * What we can say about a found machine. The profile is looked up by the id the NAME resolved to:
 * a machine we do not know has `profileId: null` and gets no numbers at all — it is never handed
 * another machine's envelope or spindle ceiling.
 */
function MachineAnswer({
  outcome,
  machine,
  reason,
  calibration,
  selectedId,
}: {
  outcome: MachineCheckOutcome;
  machine: MachineObservation | null;
  reason: string | null;
  /** The saved frame for this machine, if there is one (#279). */
  calibration?: MachineCalibration | null;
  /** The profile the job is set up for (#347), so a found machine can disagree with it out loud. */
  selectedId: string;
}): JSX.Element {
  if (outcome === 'not-found') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="not-found" style={NOTE}>
        Nothing answered the search. That is not a problem — a job can be written, verified and
        simulated without a machine, and the machine can be connected later.
      </div>
    );
  }
  if (outcome === 'unavailable') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="unavailable" style={NOTE}>
        This build cannot reach a machine: {reason ?? 'no reason was given.'}
      </div>
    );
  }
  if (outcome === 'error') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="error" style={NOTE}>
        The search failed: {reason ?? 'no detail was given.'}
      </div>
    );
  }
  if (outcome !== 'found' || machine === null) return <></>;

  const profile = machine.profileId !== null ? MACHINES[machine.profileId] : undefined;
  const frameNotice = profile === undefined ? null : machineCalibrationNotice(profile, calibration);
  // #347 — the machine that answered is EVIDENCE about the job's machine, not a substitute for it.
  // When the two disagree, both are named and the fix is the select just above: repointing the job
  // to a controller it was not set up for would move every number in the document without a word.
  const mismatch =
    profile !== undefined && machine.profileId !== null && machine.profileId !== selectedId
      ? { found: profile, chosen: MACHINES[selectedId] }
      : null;
  return (
    <div data-testid="start-wizard-machine-state" data-state="found">
      {mismatch && (
        <p style={NOTE} data-testid="start-wizard-machine-mismatch">
          This controller answers as <b>{mismatch.found.name}</b>, but the job is set up for{' '}
          <b>{mismatch.chosen?.name ?? selectedId}</b>. Nothing has been repointed for you — change
          the machine above if this is the machine the job will run on.
        </p>
      )}
      <p style={{ ...MUTED, color: '#cfe', margin: '6px 0 2px' }} data-testid="start-wizard-machine-name">
        {machine.name ?? `a controller at ${machine.host}`}
      </p>
      <ul style={{ ...MUTED, margin: '2px 0', paddingLeft: 16 }}>
        <li data-testid="start-wizard-machine-address">
          {machine.host}:{machine.port}
          {machine.busy === null ? '' : machine.busy ? ' — busy' : ' — idle'}
        </li>
        <li data-testid="start-wizard-machine-identity">
          ip {machine.ip ?? 'not reported'} · mac {machine.mac ?? 'not reported'}
        </li>
        <li data-testid="start-wizard-machine-status">
          {machine.status === null ? 'status: no answer' : `status: ${machine.status}`}
        </li>
      </ul>
      {profile ? (
        <>
          <p style={MUTED} data-testid="start-wizard-machine-profile">
            {profile.name} — {span(profile.envelope.x.min, profile.envelope.x.max)} ×{' '}
            {span(profile.envelope.y.min, profile.envelope.y.max)} ×{' '}
            {span(profile.envelope.z.min, profile.envelope.z.max)} mm work area, spindle to{' '}
            {profile.maxRpm} rpm. Feeds and speeds are clamped to these.
          </p>
          {/* Which frame is in force, and where its numbers came from (#279, decision 28). A
              warning here is the honest state, not a defect: the vendor's defaults are what ran
              before any of this existed, and saying so beats a blank. */}
          <p
            data-testid="start-wizard-machine-frame"
            data-state={frameNotice?.code}
            style={frameNotice?.severity === 'warning' ? NOTE : MUTED}
          >
            {frameNotice?.message}
          </p>
        </>
      ) : (
        <p style={MUTED} data-testid="start-wizard-machine-unknown">
          This machine is not one the app knows, so its work area and limits are unknown — it is
          not being given another machine's numbers.
        </p>
      )}
      {machine.notes.map((note, i) => (
        <p key={i} style={NOTE} data-testid={`start-wizard-machine-note-${i}`}>
          {note}
        </p>
      ))}
    </div>
  );
}

export interface MachineStepProps {
  /** The job's machine id, as the `<select>` holds it. */
  machineChoice: string;
  onMachine: (id: string) => void;
  busy: boolean;
  outcome: MachineCheckOutcome | null;
  machine: MachineObservation | null;
  reason: string | null;
  calibration: MachineCalibration | null;
  address: string;
  onAddress: (value: string) => void;
  onCheck: () => void;
  onConnect: () => void;
}

export function MachineStep({
  machineChoice,
  onMachine,
  busy,
  outcome,
  machine,
  reason,
  calibration,
  address,
  onAddress,
  onCheck,
  onConnect,
}: MachineStepProps): JSX.Element {
  return (
    <div data-testid="start-wizard-step-machine" style={{ marginTop: 8 }}>
      {/* #347 — the machine is a QUESTION first, and it is asked on every build. Before this, step
          1 was the check alone: the job carried `defaultEngraveJob`'s Z1 whoever was on the bench,
          and the web build (#346) could not answer at all. The list is `MACHINES` — the profiles
          this app can write for — and picking one writes the id and nothing else (`setMachine`),
          so nothing else in a half-built document moves. The check below is then evidence about
          that answer; where there is no socket it is the whole of step 1. */}
      <label style={{ ...MUTED, display: 'block', margin: '4px 0 0' }}>
        <span>Machine</span>
        <select
          data-testid="start-wizard-machine-select"
          aria-label="Machine profile"
          value={machineChoice}
          onChange={(e) => onMachine(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 2 }}
        >
          {MACHINE_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p style={MUTED} data-testid="start-wizard-machine-pick-note">
        Every job is written for one machine: its work area, its spindle ceiling and its own
        limits. That is true whether or not one is connected now.
      </p>

      {!canDriveMachine && (
        <p style={NOTE} data-testid="start-wizard-machine-note-build">
          This instance cannot control a machine. To connect one, launch Case Maker from your
          local (desktop) instance. You can still set the job up here, without a machine.
        </p>
      )}

      {canDriveMachine && (
        <>
          <p style={MUTED}>
            Whether a machine is on the network. This is a check rather than a question — the
            machine is asked, and it answers or it does not.
          </p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="start-wizard-check"
              disabled={busy}
              style={{ padding: '3px 12px' }}
              onClick={onCheck}
            >
              {busy ? 'Looking…' : 'Check for a machine'}
            </button>
            <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
              or connect to an address
              {/* A GENERIC example, deliberately not the address of the machine on this bench:
                  a real one in the placeholder reads as a value the app already filled in. */}
              <input
                type="text"
                inputMode="decimal"
                placeholder="192.168.1.50"
                data-testid="start-wizard-address"
                aria-label="Machine address"
                title="For a machine whose broadcast does not reach this computer."
                style={{ width: 120 }}
                value={address}
                onChange={(e) => onAddress(e.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="start-wizard-connect-address"
              disabled={busy || address.trim().length === 0}
              onClick={onConnect}
            >
              Connect
            </button>
          </div>
          {busy && (
            <p style={MUTED} data-testid="start-wizard-machine-busy">
              Listening for a machine, then reading its own configuration…
            </p>
          )}
          {!busy && outcome !== null && (
            <MachineAnswer
              outcome={outcome}
              machine={machine}
              reason={reason}
              calibration={calibration}
              selectedId={machineChoice}
            />
          )}
        </>
      )}
    </div>
  );
}
