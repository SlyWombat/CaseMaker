/**
 * The location's record of its machine (#412), on the Machines pane.
 *
 * READ FROM THE LOCATION, NOT FROM THIS WINDOW. Everything on this card is what `location.json`
 * holds — the service's copy, the one that exports and that another window on the LAN reads — so a
 * section that never reached it shows as "not in the location" even when this window has one saved.
 * `serial` and `firmware` say "not read yet" until something reads them from the machine: they are
 * never typed in.
 */

import { useState, type ReactNode } from 'react';
import type { FixtureRecord, LocationView, MachineRecord } from '@/platform/locationClient';
import { formatStamp } from './display';
import { MachinePower } from './MachinePower';
import { MachineBed } from './MachineBed';
import { houseDismissHouseWarning } from '@/platform/locationClient';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import {
  copiesHeldBy,
  copiesInBox,
  copyAtMachine,
  copyInBox,
  useLocationStore,
} from '@/store/locationStore';
import { useHouseStore } from '@/store/houseStore';
import type { InventoryItem } from '@/platform/houseClient';

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
  // #447: the margins moved off the record into the shop defaults; a null section then says where.
  const marginsHome = useLocationStore((s) => s.marginsHome);
  const vise = machine.fixtures?.vise;
  const sacrificial = machine.fixtures?.sacrificial;
  return (
    <div className="kv" data-testid="manage-location-machine">
      <Kv label="profile">{machine.profileId ?? '— unknown'}</Kv>
      <Kv label="name">{machine.name ?? '— nothing announced one'}</Kv>
      <NicknameKv machine={machine} />
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
      <Kv label="depth margins">
        {machine.margins !== null
          ? machine.margins.source
          : marginsHome === 'defaults'
            ? 'in the shop defaults (margins.*)'
            : '— not in the location'}
      </Kv>
      <Kv label="recorded">{formatStamp(machine.updatedAt) ?? machine.updatedAt}</Kv>
      {/* #511 — the bed profile (the wasteboard's home since #510), and #416 — the optional power
          switch (which draws nothing when the machine has none, beyond a collapsed set-up on the
          desktop build). */}
      <MachineBed machine={machine} />
      <MachinePower machine={machine} />
    </div>
  );
}

/** #602 — the nickname, editable in place and written through `saveMachine` (guarded by `housePutMachine`). */
function NicknameKv({ machine }: { machine: MachineRecord }) {
  const saveMachine = useLocationStore((s) => s.saveMachine);
  const [value, setValue] = useState(machine.nickname ?? '');
  const dirty = value.trim() !== (machine.nickname ?? '');
  const save = () => {
    const nickname = value.trim() === '' ? null : value.trim();
    void saveMachine({ ...machine, nickname, updatedAt: new Date().toISOString() });
  };
  return (
    <>
      <span>nickname</span>
      <b data-testid="manage-location-nickname">
        <input
          className="fld fld--text"
          type="text"
          value={value}
          placeholder="Zoomba"
          aria-label="Nickname"
          data-testid="manage-location-nickname-input"
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm"
          data-testid="manage-location-nickname-save"
          disabled={!dirty}
          onClick={save}
        >
          Save
        </button>
      </b>
    </>
  );
}

/** The accessory's name on the Holds list: its product, or the kind word when nobody named it. */
function accessoryName(a: FixtureRecord): string {
  return a.product ?? a.kind;
}

/** #602 — what this machine holds (accessories + cutter copies) and what is still in the box to check out. */
function MachineHolds({ machine }: { machine: MachineRecord }) {
  const saveAccessory = useLocationStore((s) => s.saveAccessory);
  const accessories = useLocationStore((s) => s.location?.accessories ?? []);
  const items = useToolRegistryStore((s) => s.items);
  const updateItem = useHouseStore((s) => s.updateItem);

  const held = accessories.filter((a) => a.whereabouts.kind === 'machine' && a.whereabouts.machineId === machine.id);
  const heldCopies = copiesHeldBy(items, machine.id);
  const box = accessories.filter((a) => a.whereabouts.kind === 'box');
  const boxCopies = copiesInBox(items);

  const [pick, setPick] = useState('');
  const name = machine.nickname ?? machine.name ?? machine.profileId ?? machine.id;

  const returnAccessory = (a: FixtureRecord) => {
    const now = new Date().toISOString();
    void saveAccessory({
      ...a,
      whereabouts: { kind: 'box' },
      history: [...a.history, { at: now, what: 'returned to the box' }],
    });
  };

  const returnCopy = (item: InventoryItem, index: number) => {
    void updateItem({ ...item, copies: item.copies.map((c, i) => (i === index ? copyInBox(c) : c)) });
  };

  const checkoutAccessory = (a: FixtureRecord) => {
    const now = new Date().toISOString();
    void saveAccessory({
      ...a,
      whereabouts: { kind: 'machine', machineId: machine.id, since: now },
      history: [...a.history, { at: now, what: `checked out to ${name}` }],
    });
  };

  const checkoutCopy = (item: InventoryItem, index: number) => {
    void updateItem({ ...item, copies: item.copies.map((c, i) => (i === index ? copyAtMachine(c, machine.id) : c)) });
  };

  const boxOptions: { key: string; label: string; checkOut: () => void }[] = [
    ...box.map((a) => ({ key: `acc:${a.id}`, label: accessoryName(a), checkOut: () => checkoutAccessory(a) })),
    ...boxCopies.map(({ item, index }) => ({
      key: `copy:${item.id}:${index}`,
      label: `${item.tool.name} (copy ${index + 1})`,
      checkOut: () => checkoutCopy(item, index),
    })),
  ];

  const nothingHeld = held.length === 0 && heldCopies.length === 0;

  return (
    <div data-testid="manage-holds">
      <div className="panel-subhead">Holds</div>
      {nothingHeld ? (
        <p className="hint" data-testid="manage-holds-empty">
          Nothing is checked out to this machine.
        </p>
      ) : (
        <ul className="hint">
          {held.map((a) => (
            <li key={a.id} data-testid={`manage-hold-${a.id}`}>
              {accessoryName(a)}{' '}
              <button
                type="button"
                className="btn btn--sm"
                data-testid={`manage-hold-return-${a.id}`}
                onClick={() => returnAccessory(a)}
              >
                Return
              </button>
            </li>
          ))}
          {heldCopies.map(({ item, index }) => (
            <li key={`${item.id}:${index}`} data-testid={`manage-hold-copy-${item.id}-${index}`}>
              {item.tool.name}{' '}
              <button
                type="button"
                className="btn btn--sm"
                data-testid={`manage-hold-copy-return-${item.id}-${index}`}
                onClick={() => returnCopy(item, index)}
              >
                Return
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-subhead">Check out…</div>
      {boxOptions.length === 0 ? (
        <p className="hint">Nothing is in the box to check out.</p>
      ) : (
        <span className="btn-row">
          <select
            className="fld"
            value={pick}
            aria-label="Check out"
            data-testid="manage-checkout-pick"
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">— pick an item —</option>
            {boxOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-checkout-button"
            disabled={pick === ''}
            onClick={() => {
              const o = boxOptions.find((x) => x.key === pick);
              if (o !== undefined) {
                o.checkOut();
                setPick('');
              }
            }}
          >
            Check out
          </button>
        </span>
      )}
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
        <>
          <MachineKv machine={machine} />
          <MachineHolds machine={machine} />
        </>
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
