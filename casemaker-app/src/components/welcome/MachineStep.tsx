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
import { MILL_MODELS } from '@/engine/cnc/machine';
import { formatStamp } from '@/components/manage/display';
import { stateColour, stateWord } from '@/components/viewport/machineWords';
import { canReachMachine, NO_MACHINE_RELAY_SENTENCE } from '@/platform/capabilities';
import { MACHINE_MOUNT_WORDS, activeMountOf, activeProfileOf, surfaceWords } from '@/platform/machineChange';
import { bedNeverMeasured } from '@/engine/cnc/bed/binding';
import { readStatusLine } from '@/platform/desktop/protocol';
import { readMachineRest } from '@/platform/machineChangeRun';
import type { MachineObservation, MachineProbeRoute } from '@/platform/machineProbe';
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
/** #1106 — what a row says where nothing can be checked (the web build) or the record has no address. */
const PROFILE_ONLY_WORDS = 'profile only — vendor defaults; connect it at Cut';
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
  const profile = id === null ? undefined : MILL_MODELS[id];
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
  /** #882 — how the found machine was reached; null when the last check found nothing. */
  route: MachineProbeRoute | null;
  machine: MachineObservation | null;
  reason: string | null;
  address: string;
  onAddress: (value: string) => void;
  /** THE check. With no host it searches; with one it connects to that address (the fold). */
  onCheck: (host?: string) => void;
  /** #1106 — the machine the job carries (the row that is selected). */
  selectedMachineId?: string | null;
  /** #1106 — the machine last used, first in the list and pre-selected on a new job. */
  lastMachineId?: string | null;
  /** #1106 — choose a machine for the job. */
  onSelectMachine?: (id: string) => void;
  /** #1106 — the machine-change wizard, opened here for the selected machine's bed. */
  onChangeBed?: () => void;
}

export function MachineStep({
  machines,
  busy,
  outcome,
  route,
  machine,
  reason,
  address,
  onAddress,
  onCheck,
  selectedMachineId = null,
  lastMachineId = null,
  onSelectMachine,
  onChangeBed,
}: MachineStepProps): JSX.Element {
  const [another, setAnother] = useState(false);
  // #1106 — the selected machine is the header's, not merely the first record: step 1 is a picker.
  const selectedRecord =
    selectedMachineId === null || machines === null ? null : (machines.find((m) => m.id === selectedMachineId) || null);
  const house = selectedRecord ?? houseMachine(machines);
  const houseHost = house?.address?.host ?? null;

  // THE CHECK ON OPEN (#682, E4). One per arrival at the step; Back remounts the body, so going
  // back to the machine checks again. The shell's probe is the one check the app has.
  const opened = useRef(false);
  const [checkStarted, setCheckStarted] = useState(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    setCheckStarted(true);
    if (!canReachMachine) return;
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

  // #1106 item 2 — "checking" only where a check can run. The web build never calls `onCheck`, so
  // `outcome` stays null and the selected row read "Checking…" for ever.
  const checking = canReachMachine && (busy || !checkStarted || outcome === null);
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
  // #1109 — `homed` is the spec's word; the operator reads what it means.
  const word = found ? `Online · ${wordBase}${homed ? ' · knows where it is' : ''}` : wordBase;
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

  // #1106 — WHICH MACHINE? The location's CNC records, the last used first, profile-only rows a
  // full citizen. A one-machine house sees its machine selected and presses Next.
  const orderedMachines = (machines ?? [])
    .slice()
    .sort((a, b) => {
      const used = (m: MachineRecord): number => (m.id === lastMachineId ? 0 : 1);
      if (used(a) !== used(b)) return used(a) - used(b);
      const address = (m: MachineRecord): number => (m.address === null ? 1 : 0);
      if (address(a) !== address(b)) return address(a) - address(b);
      return displayName(a, null, null)!.localeCompare(displayName(b, null, null)!);
    });

  return (
    <div data-testid="start-wizard-step-machine" style={{ marginTop: 8 }}>
      {/* #821 — the same one sentence the Manage card carries
          (#1106 item 2: it HEADS the step, above the list): the relay-less deploy cannot drive
          a machine, and says where it can. The job can still be set up here. */}
      {!canReachMachine && (
        <p style={NOTE} data-testid="start-wizard-machine-note-build">
          {NO_MACHINE_RELAY_SENTENCE}
        </p>
      )}
      {orderedMachines.length > 0 && (
        <div data-testid="start-wizard-machine-list" style={{ display: 'grid', gap: 4, margin: '2px 0 10px' }}>
          <p style={{ ...MUTED, margin: 0 }}>Which machine?</p>
          {orderedMachines.map((record) => {
            const selected = record.id === (selectedMachineId ?? house?.id ?? null);
            const profile = activeProfileOf(record);
            const bed = profile === null ? null : `${MACHINE_MOUNT_WORDS[activeMountOf(record)]} · ${surfaceWords(profile.surface)}`;
            const state = !canReachMachine
              ? PROFILE_ONLY_WORDS
              : selected
              ? checking
                ? 'Checking…'
                : found
                  ? `Online · ${wordBase}`
                  : 'Offline — you can still write, check and simulate; the machine is needed at Cut'
              : record.address === null
                ? PROFILE_ONLY_WORDS
                : 'Offline — you can still write, check and simulate; the machine is needed at Cut';
            return (
              <button
                key={record.id}
                type="button"
                className="sw-btn"
                data-testid={`start-wizard-machine-row-${record.id}`}
                data-mount={activeMountOf(record)}
                aria-pressed={selected}
                disabled={onSelectMachine === undefined}
                onClick={() => onSelectMachine?.(record.id)}
                style={{ width: '100%', textAlign: 'left', padding: 5, border: selected ? '1px solid #5a8abf' : undefined }}
              >
                <span style={{ display: 'block', fontSize: 12, color: '#cfe' }}>
                  {displayName(record, null, null)}
                  {bed === null ? '' : ` · ${bed}`}
                </span>
                <span style={{ display: 'block', ...MUTED, margin: 0 }}>{state}</span>
                {record.profileId === null && (
                  <span style={{ display: 'block', ...MUTED, margin: 0 }}>no profile — set it in Manage › Machines</span>
                )}
              </button>
            );
          })}
          {onChangeBed !== undefined && (
            <button type="button" data-testid="start-wizard-change-bed" onClick={onChangeBed} style={{ textAlign: 'left' }}>
              Change what’s on the bed…
            </button>
          )}
        </div>
      )}
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
          "On the machine now: Vise on the pins · bare bed"). Absent when the house records no bed.
          #513 — the bed's measured state is stated HERE once (the maintainer's rule), not as a
          finding on every job: a profile with no datum measured says so on the Start line, and the
          job findings speak only where an unmeasured datum changes that job. */}
      {house !== null && activeProfileOf(house) !== null && (
        <p style={MUTED} data-testid="start-wizard-machine-now">
          On the machine now: {MACHINE_MOUNT_WORDS[activeMountOf(house)]} · {surfaceWords(activeProfileOf(house)!.surface)}
          {bedNeverMeasured(activeProfileOf(house)!) ? ' · not measured yet' : ''}
        </p>
      )}

      {canReachMachine && (
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
              className="sw-btn"
              data-testid="start-wizard-check"
              disabled={busy}
              style={{ marginLeft: 'auto' }}
              onClick={() => requestCheck()}
            >
              {busy ? 'Looking…' : 'Check again'}
            </button>
          </div>

          {/* #882 — WHICH ROUTE FOUND IT. A LAN server on a bridge network cannot hear the UDP
              broadcast, so a location-known machine is also tried at its recorded address; the
              line says when that was the way, plainly, rather than leaving the operator to guess
              why "the search" found nothing. */}
          {found && route !== null && (
            <p style={NOTE} data-testid="start-wizard-machine-route">
              {route === 'recorded'
                ? 'Found at the address you wrote — the network search heard nothing, which is normal for a server that cannot receive broadcasts.'
                : route === 'network'
                  ? 'Found on the network.'
                  : 'Reached at the address you gave.'}
            </p>
          )}

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
              are the manual route for a machine the search cannot hear. A fold toggle is not an
              action: `data-fold` keeps it out of the component-set gate. */}
          <button
            type="button"
            data-testid="start-wizard-machine-another"
            data-fold="true"
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
                    // #875 — a hostname (`zoomba.local`) is letters: the phone's keypad must offer
                    // them, and nothing here should be auto-capitalized or spell-checked.
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-testid="start-wizard-address"
                    aria-label="Machine address"
                    style={{ width: 120 }}
                    value={address}
                    onChange={(e) => onAddress(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="sw-btn"
                  data-testid="start-wizard-connect-address"
                  disabled={busy || address.trim().length === 0}
                  onClick={() => requestCheck(address.trim())}
                >
                  Connect
                </button>
              </div>
              {/* #875 — Connect is disabled while the field is empty, and that IS the unblock: the
                  sentence that repeated it appeared the instant the fold opened, before anything
                  was wrong, so it is gone. */}
            </>
          )}
        </>
      )}

    </div>
  );
}
