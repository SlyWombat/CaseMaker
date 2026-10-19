/**
 * #511 — the Machines card's Bed block, replacing the wasteboard line (`bed-profiles.md` §5).
 *
 * One card block for the machine's ACTIVE bed profile: its name and date, a one-line summary, the
 * bed picture (`BedScene`, the viewport's machine-frame picture), the unmeasured count linking to
 * #444's calipers list, and its history. Three actions, none of which ever sends a machine command:
 *
 *   - **Switch** picks another saved profile and makes it active — the operator has physically
 *     changed the bed; the app only re-names which description is current. It writes the location,
 *     never the machine.
 *   - **I changed the bed** copies the active profile into a NEW dated profile with its dependent
 *     datums cleared and listed ("to measure"), and makes it active. The old profile stays in the
 *     list, with its scars and datums.
 *   - **Measure…** lists the four datums (surface top, jaw top, bracket seat, rotary axis) with
 *     their state. The one-touch measurement runs through the registration executor in the wizard
 *     (S3, #430's registration step); until then each row says what it needs and does not pretend a
 *     probe has run.
 */

import { useState } from 'react';
import type { BedProfile, FixtureRecord, MachineRecord } from '@/platform/locationClient';
import { formatDay, mm } from './display';
import { BedScene } from '@/components/viewport/BedScene';
import { useLocationStore } from '@/store/locationStore';
import {
  BED_DATUM_KEYS,
  BED_DATUM_WORDS,
  changedBedProfile,
  switchActiveProfile,
} from '@/platform/bedProfiles';
import { surfaceUnmeasuredCount } from '@/engine/cnc/bedScene';
import { newId } from '@/utils/id';

/** The calipers list the unmeasured count links to (#444). */
const CALIPERS_LIST_URL = 'https://github.com/SlyWombat/CaseMaker/issues/444';

/** The surface's one-word kind, for the summary and the per-kind test. */
function surfaceWords(surface: BedProfile['surface']): string {
  switch (surface.kind) {
    case 'bare-bed':
      return 'bare bed';
    case 'wasteboard':
      return surface.material === null ? 'wasteboard' : `${surface.material} wasteboard`;
    case 'fixture-plate':
      return 'fixture plate';
    case 'vacuum-bed':
      return 'vacuum bed';
  }
}

/** How many numbers in this profile no one has measured yet — the count the card links to #444. */
function unmeasuredCount(profile: BedProfile, fixtures: FixtureRecord[]): number {
  let n = 0;
  for (const key of BED_DATUM_KEYS) if (profile.datums[key] === null) n += 1;
  n += surfaceUnmeasuredCount(profile);
  for (const placement of profile.placements) {
    const fixture = fixtures.find((f) => f.id === placement.fixture);
    if (fixture === undefined) continue;
    for (const value of Object.values(fixture.unit)) if (value === null) n += 1;
  }
  return n;
}

/** One placement, in the summary's one line. */
function placementWords(placement: BedProfile['placements'][number], fixture: FixtureRecord, profile: BedProfile): string {
  const where = placement.where.kind === 'pins' ? 'on the pins' : placement.where.kind === 'anchor' ? `at anchor ${placement.where.anchor}` : 'free';
  const bits: string[] = [];
  if (fixture.kind === 'vise') {
    const jaw = profile.datums.viseJawTopZ;
    if (jaw !== null) bits.push(`jaw top ${mm(jaw.value)}, measured ${formatDay(jaw.measuredAt) ?? jaw.measuredAt}`);
  }
  if (fixture.kind === 'bracket') {
    const seat = profile.datums.bracketSeatZ;
    if (seat !== null) bits.push(`seat ${mm(seat.value)}, measured ${formatDay(seat.measuredAt) ?? seat.measuredAt}`);
  }
  if (fixture.kind === 'rotary-module') {
    const axis = profile.datums.rotaryAxis;
    if (axis !== null) bits.push(`axis ${mm(axis.value)}, measured ${formatDay(axis.measuredAt) ?? axis.measuredAt}`);
  }
  const kindWord = fixture.kind === 'rotary-module' ? '4th-axis module' : fixture.kind === 'top-clamp' ? 'top clamps' : fixture.kind;
  return bits.length === 0 ? `${kindWord} ${where}` : `${kindWord} ${where} (${bits.join(' · ')})`;
}

export function MachineBed({ machine }: { machine: MachineRecord }) {
  const [note, setNote] = useState<string | null>(null);
  const profiles = machine.bedProfiles ?? [];
  const fixtures = machine.bedFixtures ?? [];
  const active = profiles.find((p) => p.id === machine.activeBedProfileId) ?? null;

  const save = async (record: MachineRecord, ok: string): Promise<void> => {
    const res = await useLocationStore.getState().saveMachine(record);
    setNote(res === 'ok' ? ok : 'the bed was not saved — see the card note');
  };

  if (machine.bedProfiles === undefined) {
    return (
      <>
        <span>bed</span>
        <b data-testid="manage-bed">— not described (set it up in the wizard)</b>
      </>
    );
  }

  if (active === null) {
    return (
      <>
        <span>bed</span>
        <b data-testid="manage-bed">— no active profile</b>
      </>
    );
  }

  const summaryParts = [`surface: ${surfaceWords(active.surface)}`];
  for (const placement of active.placements) {
    const fixture = fixtures.find((f) => f.id === placement.fixture);
    if (fixture === undefined) continue;
    summaryParts.push(placementWords(placement, fixture, active));
  }
  const unmeasured = unmeasuredCount(active, fixtures);

  return (
    <>
      <span>bed</span>
      <b data-testid="manage-bed">
        <span data-testid="manage-bed-summary">
          {active.name} (since {formatDay(active.createdAt) ?? active.createdAt}) ·{' '}
          {summaryParts.join(' · ')}
        </span>{' '}
        <span className="dim" data-testid="manage-bed-unmeasured">
          {unmeasured} {unmeasured === 1 ? 'number' : 'numbers'} unmeasured{' '}
          <a href={CALIPERS_LIST_URL} target="_blank" rel="noreferrer">
            ▸ calipers list
          </a>
        </span>
        <span className="btn-row" data-testid="manage-bed-actions">
          <label>
            Switch{' '}
            <select
              className="fld"
              aria-label="Switch bed profile"
              data-testid="manage-bed-switch"
              value={active.id}
              onChange={(e) => void save(switchActiveProfile(machine, e.target.value, new Date().toISOString()), 'Switched.')}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatDay(p.createdAt) ?? p.createdAt})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-bed-changed"
            onClick={() => {
              const at = new Date().toISOString();
              const { profile, cleared } = changedBedProfile(active, newId('bp'), at);
              void save(
                { ...machine, bedProfiles: [...profiles, profile], activeBedProfileId: profile.id, updatedAt: at },
                cleared.length === 0
                  ? 'New bed saved.'
                  : `New bed saved; to measure: ${cleared.join(', ')}.`,
              );
            }}
          >
            I changed the bed
          </button>
        </span>
        <details data-testid="manage-bed-measure">
          <summary>Measure…</summary>
          <ul className="hint">
            {BED_DATUM_KEYS.map((key) => {
              const datum = active.datums[key];
              return (
                <li key={key} data-testid={`manage-bed-measure-${key}`}>
                  {BED_DATUM_WORDS[key]}:{' '}
                  {datum !== null
                    ? `${mm(datum.value)}, measured ${formatDay(datum.measuredAt) ?? datum.measuredAt}`
                    : 'not measured — one touch via the registration executor in the wizard (S3)'}
                </li>
              );
            })}
          </ul>
        </details>
        <span className="hint" data-testid="manage-bed-history">
          history: {active.history.map((h) => `${h.what} (${formatDay(h.at) ?? h.at})`).join(' · ')}
        </span>
        <BedScene machine={machine} />
        {note !== null && (
          <span className="hint" data-testid="manage-bed-note">
            {' '}
            {note}
          </span>
        )}
      </b>
    </>
  );
}
