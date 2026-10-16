/**
 * The location's record of its machine (#412), on the Machines pane.
 *
 * READ FROM THE LOCATION, NOT FROM THIS WINDOW. Everything on this card is what `location.json`
 * holds — the service's copy, the one that exports and that another window on the LAN reads — so a
 * section that never reached it shows as "not in the location" even when this window has one saved.
 * `serial` and `firmware` say "not read yet" until something reads them from the machine: they are
 * never typed in.
 */

import type { ReactNode } from 'react';
import type { LocationView, MachineRecord } from '@/platform/locationClient';
import { formatStamp } from './display';
import { MachinePower } from './MachinePower';
import { MachineWasteboard } from './MachineWasteboard';
import { houseDismissHouseWarning } from '@/platform/locationClient';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

/** Dismiss, then re-read `/health` (through the registry's refresh) so the warning goes. */
async function dismissHouseWarning(): Promise<void> {
  const res = await houseDismissHouseWarning();
  if (res.kind === 'ok') await useToolRegistryStore.getState().refresh();
}

/** The name `location.rs` gives a location nobody has named yet. */
const DEFAULT_LOCATION_NAME = 'My shop';

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <b>{children}</b>
    </>
  );
}

/** A saved section, as provenance: where its numbers came from and when. */
function provenance(source: string | undefined, at: string | undefined): string {
  const when = formatStamp(at);
  return when === null ? (source ?? 'saved') : `${source ?? 'saved'} · ${when}`;
}

function MachineKv({ machine }: { machine: MachineRecord }) {
  const vise = machine.fixtures?.vise;
  const sacrificial = machine.fixtures?.sacrificial;
  return (
    <div className="kv" data-testid="manage-location-machine">
      <Kv label="profile">{machine.profileId ?? '— unknown'}</Kv>
      <Kv label="name">{machine.name ?? '— nothing announced one'}</Kv>
      <Kv label="address">
        {machine.address === null ? '—' : `${machine.address.host} : ${machine.address.port}`}
      </Kv>
      <Kv label="serial">{machine.serial ?? '— not read yet'}</Kv>
      <Kv label="firmware">{machine.firmware ?? '— not read yet'}</Kv>
      <Kv label="calibration">
        {machine.calibration === null
          ? '— not in the location'
          : provenance(machine.calibration.source, machine.calibration.measuredAt)}
      </Kv>
      <Kv label="vise">{vise === undefined ? '— the shipped default' : provenance(vise.source, vise.measuredAt)}</Kv>
      <Kv label="sacrificial">{sacrificial === undefined ? '— none saved' : sacrificial.source}</Kv>
      <Kv label="depth margins">{machine.margins === null ? '— not in the location' : machine.margins.source}</Kv>
      <Kv label="recorded">{formatStamp(machine.updatedAt) ?? machine.updatedAt}</Kv>
      {/* #417 — the wasteboard, and #416 — the optional power switch (which draws nothing when the
          machine has none, beyond a collapsed set-up on the desktop build). */}
      <MachineWasteboard machine={machine} />
      <MachinePower machine={machine} />
    </div>
  );
}

/**
 * The location could not be read (#412 review): the service's own sentence, rather than a fresh,
 * empty location that is not the user's.
 */
export function LocationProblemCard({ reason }: { reason: string | null }) {
  return (
    <div className="mcard" data-testid="manage-location-problem" data-status="error">
      <h4>
        Location <span className="tag tag--muted">cannot be read</span>
      </h4>
      <p className="hint">{reason ?? 'the location could not be read'}</p>
    </div>
  );
}

export function LocationCard({
  location,
  writeNote,
  warnings = [],
}: {
  location: LocationView;
  writeNote: string | null;
  warnings?: readonly string[];
}) {
  const machine = location.machines[0];
  return (
    <div className="mcard" data-testid="manage-location">
      <h4>
        {location.name}{' '}
        {location.name === DEFAULT_LOCATION_NAME && <span className="tag tag--muted">default name</span>}
        <span className="badge">location</span>
      </h4>
      <div className="sub">
        location.json · created {formatStamp(location.createdAt) ?? location.createdAt}
        {location.migratedFrom !== null && ` · ${location.migratedFrom}`}
      </div>
      {machine === undefined ? (
        <p className="hint" data-testid="manage-location-no-machine">
          No machine in this location yet. One is recorded the first time this window has a machine
          setup to keep — a check that finds a machine, a saved vise or sacrificial setup, a
          calibration read back, or depth margins of your own.
        </p>
      ) : (
        <MachineKv machine={machine} />
      )}
      {location.machines.length > 1 && (
        <p className="hint">
          {location.machines.length - 1} more machine record(s) in this location — this build shows the
          first.
        </p>
      )}
      {location.unreadableMachines.map((m, i) => (
        <p key={m.id ?? i} className="hint" data-testid="manage-location-unreadable" data-status="error">
          Machine {m.id ?? '(no id)'} is in the location but this build cannot read it: {m.reason}. It
          is left as it is.
        </p>
      ))}
      {warnings.map((w) => (
        <div key={w} className="hint" data-testid="manage-location-warning" data-status="warning">
          <p>{w}</p>
          {/* Persists until dismissed or until a house file is imported (re-review). */}
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-location-warning-dismiss"
            onClick={() => void dismissHouseWarning()}
          >
            Dismiss
          </button>
        </div>
      ))}
      {writeNote !== null && (
        <p className="hint" data-testid="manage-location-write-note" data-status="error">
          The location did not take this window's machine setup: {writeNote}
        </p>
      )}
    </div>
  );
}
