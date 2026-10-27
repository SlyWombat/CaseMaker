/**
 * #681/#682 — step 1 of the one cutting-job wizard: the machine.
 *
 * The shell owns the step index and the footer; this component owns the step's body. #682 replaced
 * the old picker-and-check body with the design's (`docs/design/first-job-flow.md` §3.2):
 *
 *     Makera Z1 “Zoomba” · 192.168.10.43      ● Online · Idle · checked 09:02   [ Check again ]
 *                                                          ▸ another machine…
 *
 * - The location's machine is the step's machine: its name and address are on screen and the check
 *   runs when the step opens (E4 — never connected automatically though the location knows it).
 * - ONE line of state, in the machine strip's words, plus `homed` when the `?` frame itself says
 *   so: the controller is Idle with MPos at the Z1's homed rest (#693's `readMachineRest`, the
 *   bench-verified reading). The check still sends no `$H`; when the frame does not say it, the
 *   word is absent rather than guessed.
 * - Next is never gated: a job can be written, verified and simulated with no machine, and the
 *   offline line says so where the operator is looking.
 * - The address field and Connect live under `another machine…` — the one fold, for a machine whose
 *   broadcast does not reach this computer. The two explanatory paragraphs are gone (A3), and the
 *   address has no placeholder: a real-looking example reads as a value the app already filled in.
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { MACHINES } from '@/engine/cnc/machine';
import { formatStamp } from '@/components/manage/display';
import { stateColour, stateWord } from '@/components/viewport/machineWords';
import { canDriveMachine } from '@/platform/capabilities';
import { MACHINE_MOUNT_WORDS, activeMountOf, activeProfileOf, surfaceWords } from '@/platform/machineChange';
import { readStatusLine } from '@/platform/desktop/protocol';
import { readMachineRest } from '@/platform/machineChangeRun';
import type { MachineObservation } from '@/platform/machineProbe';
import type { MachineRecord } from '@/platform/locationClient';
import type { MachineCheckOutcome } from '@/store/machineStore';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const NOTE: CSSProperties = { ...MUTED, borderLeft: '2px solid #3a5a7a', paddingLeft: 6 };
const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: '#8a97a5',
};
const STATE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  margin: '8px 0 0',
};
const STATE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: '#e8eef4',
};
const MUTED_INLINE: CSSProperties = { color: '#8a97a5' };
const FOLD: CSSProperties = {
  display: 'block',
  margin: '8px 0 0',
  padding: 0,
  border: 'none',
  background: 'none',
  color: '#8fb4ff',
  fontSize: 11,
  cursor: 'pointer',
};

/** The location's machine: the one with an address, else the first, else none. */
function houseMachine(machines: readonly MachineRecord[] | null): MachineRecord | null {
  if (machines === null || machines.length === 0) return null;
  return machines.find((m) => m.address !== null) ?? machines[0] ?? null;
}

/** The location record for an address, when the machine that answered is one the location knows. */
function recordAt(machines: readonly MachineRecord[] | null, host: string | null): MachineRecord | null {
  if (machines === null || host === null) return null;
  return machines.find((m) => m.address?.host === host) ?? null;
}

/**
 * `Makera Z1 “Zoomba”` — the profile's name with the person's nickname in quotes (#596), falling
 * back to whichever of the record's own name, the observation's broadcast name, or the nickname
 * exists. Null only when nothing about the machine is known (a typed address that said nothing).
 */
function displayName(
  record: MachineRecord | null,
  profileId: string | null,
  broadcastName: string | null,
): string | null {
  const id = record?.profileId ?? profileId;
  const profile = id === null ? undefined : MACHINES[id];
  const base = profile?.name ?? record?.name ?? broadcastName ?? null;
  const nickname = record?.nickname ?? null;
  if (base === null) return nickname;
  if (nickname === null || nickname === base) return base;
  return `${base} “${nickname}”`;
}

/** `09:02` — the check's local time of day, or null for an unreadable stamp. */
function timeOfDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface MachineStepProps {
  /** The location's machines; null when this build has no location. */
  machines: readonly MachineRecord[] | null;
  busy: boolean;
  outcome: MachineCheckOutcome | null;
  machine: MachineObservation | null;
  reason: string | null;
  address: string;
  onAddress: (value: string) => void;
  /** THE check. With no host it searches; with one it connects to that address (the fold). */
  onCheck: (host?: string) => void;
}

export function MachineStep({
  machines,
  busy,
  outcome,
  machine,
  reason,
  address,
  onAddress,
  onCheck,
}: MachineStepProps): JSX.Element {
  const [another, setAnother] = useState(false);
  const house = houseMachine(machines);
  const houseHost = house?.address?.host ?? null;

  // THE CHECK ON OPEN (#682, E4). One per arrival at the step; Back remounts the body, so going
  // back to the machine checks again. The shell's probe is the one check the app has.
  const opened = useRef(false);
  const [checkStarted, setCheckStarted] = useState(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    setCheckStarted(true);
    if (!canDriveMachine) return;
    onCheck();
  }, [onCheck]);

  // The last machine the app REACHED, captured before a check can clear it (the store forgets a
  // machine when nothing answers). That observation is what "last seen" means; a failed check has no
  // timestamp of its own to offer. The mount value is the record the last check left, and a manual
  // check takes the current record first, so the line never borrows the failed check's clock.
  const [lastReached, setLastReached] = useState<MachineObservation | null>(machine);

  /** A check the operator asked for: keep what the app last reached before the store can forget it. */
  function requestCheck(host?: string): void {
    if (machine !== null) setLastReached(machine);
    onCheck(host);
  }

  const checking = busy || !checkStarted || outcome === null;
  const found = !checking && outcome === 'found' && machine !== null;
  const line = machine?.statusLine ?? (machine?.status ? readStatusLine(machine.status) : null);

  // Which machine the two-line header names: the house's while there is no better answer, the one
  // that actually answered when the search found a different controller (it is evidence, not a
  // substitute — but saying nothing about it would hide the machine the check reached).
  const houseMatch = house !== null && machine !== null && machine.host === houseHost;
  const showHouse = house !== null && (checking || !found || houseMatch);
  const showObserved = found && !showHouse;
  const foundRecord = showObserved ? recordAt(machines, machine.host) : null;
  const name = showHouse
    ? displayName(house, machine?.profileId ?? null, machine?.name ?? null)
    : showObserved
      ? displayName(foundRecord, machine.profileId, machine.name)
      : null;
  const host = showHouse ? houseHost : showObserved ? machine.host : null;

  // The strip's own word, and the dot's colour, so two surfaces cannot describe one machine
  // differently. "Online ·" is the reachability the found check established; the word after it is
  // the state it reported.
  const wordBase = checking
    ? 'Checking…'
    : found
      ? stateWord(line?.state ?? null, false, true)
      : outcome === 'not-found'
        ? stateWord(null, false, false)
        : stateWord(null, false, null);
  // `homed` is a reading of the frame the check just fetched (#693): Idle with MPos at the Z1's
  // homed rest. It is not a `$H` the app sent; a frame that does not say it gets no word.
  const homed =
    found && machine !== null && machine.status !== null
      ? readMachineRest(machine.status)?.homed === true
      : false;
  const word = found ? `Online · ${wordBase}${homed ? ' · homed' : ''}` : wordBase;
  const checked = found ? timeOfDay(machine.observedAt) : null;

  // Last seen belongs to the machine this line is about. When a house record exists, another
  // controller's timestamp would be a fact sitting next to the wrong name.
  const lastSeen =
    !checking &&
    outcome === 'not-found' &&
    lastReached !== null &&
    (house === null || lastReached.host === houseHost)
      ? formatStamp(lastReached.observedAt)
      : null;

  return (
    <div data-testid="start-wizard-step-machine" style={{ marginTop: 8 }}>
      {(name !== null || host !== null) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {name !== null && (
            <b data-testid="start-wizard-machine-name" style={{ fontSize: 13 }}>
              {name}
            </b>
          )}
          {host !== null && (
            <span data-testid="start-wizard-machine-address" style={MONO}>
              {host}
            </span>
          )}
        </div>
      )}

      {/* #726 W24 — WHAT IS ON THE MACHINE, from the active bed profile (the design's
          "On the machine now: Vise on the pins · bare bed"). Absent when the house records no bed. */}
      {house !== null && activeProfileOf(house) !== null && (
        <p style={MUTED} data-testid="start-wizard-machine-now">
          On the machine now: {MACHINE_MOUNT_WORDS[activeMountOf(house)]} · {surfaceWords(activeProfileOf(house)!.surface)}
        </p>
      )}

      {canDriveMachine && (
        <>
          <div style={STATE_ROW}>
            <span
              data-testid="start-wizard-machine-state"
              data-state={checking ? 'checking' : (outcome ?? 'checking')}
              role="status"
              style={STATE}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: stateColour(wordBase),
                  flex: 'none',
                }}
              />
              <span style={{ fontWeight: 600 }}>{word}</span>
              {checked !== null && (
                <span style={MUTED_INLINE}>
                  {' · checked '}
                  <span style={MONO}>{checked}</span>
                </span>
              )}
              {lastSeen !== null && (
                <span style={MUTED_INLINE}>
                  {' · last seen '}
                  <span style={MONO}>{lastSeen}</span>
                </span>
              )}
            </span>
            <button
              type="button"
              data-testid="start-wizard-check"
              disabled={busy}
              style={{ marginLeft: 'auto', padding: '3px 12px' }}
              onClick={() => requestCheck()}
            >
              {busy ? 'Looking…' : 'Check again'}
            </button>
          </div>

          {!checking && outcome === 'not-found' && (
            <p style={MUTED} data-testid="start-wizard-machine-offline-note">
              The job can be written, checked and simulated now; the machine is needed at Cut.
            </p>
          )}

          {(outcome === 'unavailable' || outcome === 'error') && !checking && (
            <p style={NOTE} data-testid="start-wizard-machine-reason">
              {outcome === 'unavailable'
                ? `This build cannot reach a machine: ${reason ?? 'no reason was given.'}`
                : (reason ?? 'The search failed, and no detail was given.')}
            </p>
          )}

          {/* THE ONE FOLD. The address and Connect are not a second way to ask the question; they
              are the manual route for a machine the search cannot hear. */}
          <button
            type="button"
            data-testid="start-wizard-machine-another"
            aria-expanded={another}
            style={FOLD}
            onClick={() => setAnother((open) => !open)}
          >
            <span aria-hidden="true">{another ? '▾' : '▸'}</span> another machine…
          </button>

          {another && (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
                  Address
                  <input
                    type="text"
                    inputMode="decimal"
                    data-testid="start-wizard-address"
                    aria-label="Machine address"
                    title="For a machine the search cannot hear."
                    style={{ width: 120 }}
                    value={address}
                    onChange={(e) => onAddress(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  data-testid="start-wizard-connect-address"
                  disabled={busy || address.trim().length === 0}
                  onClick={() => requestCheck(address.trim())}
                >
                  Connect
                </button>
              </div>
              {address.trim().length === 0 && (
                <p style={MUTED} data-testid="start-wizard-machine-address-unblock">
                  Type the machine’s address to connect to it.
                </p>
              )}
            </>
          )}
        </>
      )}

      {!canDriveMachine && (
        <p style={NOTE} data-testid="start-wizard-machine-note-build">
          This instance cannot control a machine. To connect one, launch Case Maker from your local
          (desktop) instance. You can still set the job up here, without a machine.
        </p>
      )}
    </div>
  );
}
