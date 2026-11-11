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
 *     their state. The jaw-top one-touch is the Tap the fixed jaw button (#603); a surface
 *     registration and the bracket registration tap (#607) fill the rest, and the rotary axis is
 *     not characterised yet (#545). Until a datum is measured each row says what it needs and does
 *     not pretend a probe has run.
 */

import { useState, type JSX } from 'react';
import { ProbeFitDiagram } from '@/components/ui/ProbeFitDiagram';
import { probeInstrumentOf } from '@/engine/cnc/registration/plan';
import type { BedProfile, FixtureRecord, MachineRecord } from '@/platform/locationClient';
import { CALIPERS_LIST_URL } from '@/platform/bedTemplates';
import { formatDay, mm } from './display';
import { BedScene } from '@/components/viewport/BedScene';
import { accessoriesFor, useLocationStore } from '@/store/locationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { canReachMachine } from '@/platform/capabilities';
import { mountNum, mountTapFor, probeFor, accessoryNameFor } from '@/engine/cnc/registration/mountContext';
import { anchorFrom, bracketDatum, bracketSettings } from '@/engine/cnc/mounts/bracket';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, machineFrameProblemById } from '@/engine/cnc/machine';
import { useMountTap, useMountTapBusyFlag } from '@/hooks/useMountTap';
import {
  BED_DATUM_KEYS,
  BED_DATUM_WORDS,
  changedBedProfile,
  switchActiveProfile,
} from '@/platform/bedProfiles';
import type { BedDatumKey } from '@/platform/bedProfiles';
import { surfaceUnmeasuredCount } from '@/engine/cnc/bedScene';
import { newId } from '@/utils/id';
import { openMachineChange } from '@/components/machine-change';
import { openBedWizard } from '@/store/bedWizardStore';

/** The calipers list the unmeasured count links to (#444) — the templates module owns the URL. */

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

/**
 * #616 — what an unmeasured datum row says, in operator language: the measurement that fills each
 * datum, never the S3/registration-executor placeholder.
 */
const UNMEASURED_DATUM_WORDS: Record<BedDatumKey, string> = {
  surfaceTopZ: 'Run a surface registration',
  viseJawTopZ: 'Tap the fixed jaw (probe in the spindle)',
  bracketSeatZ: 'Measure the seat beside the bracket — one touch on the surface beside it; the arm tap checks it on later runs',
  rotaryAxis: 'Fit and characterise the rotary module first',
};

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
    if (jaw !== null) bits.push(`jaw top ${mm(jaw.value)}, ${accessoryNameFor(jaw.by)}, measured ${formatDay(jaw.measuredAt) ?? jaw.measuredAt}`);
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

/**
 * #603 — the jaw-top Measure… row's tap: the same mount tap the Setups row offers in #599, driven
 * by the shared {@link useMountTap} hook, so the fit-probe prompt, the transcript and the write-back
 * are one implementation. Offered only where this build can drive a machine, the machine has an
 * address, and the fixed jaw's frame is known (a registered bed).
 */
function BedJawTap({ machine }: { machine: MachineRecord }) {
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const registrations = useEngraveRegistrationStore((s) => s.records);
  const tapBusy = useMountTapBusyFlag();

  // #773 — a machine whose controller frame has never been read has no clearance Z to judge a tap
  // by; the registration surface says so elsewhere and this row is simply not offered. The check is
  // computed here and applied AFTER the hooks: returning before them called `useMountTapBusyFlag`
  // and `useMountTap` conditionally, so a machine whose frame read changed under a mounted row would
  // change its hook order (the rules-of-hooks finding this fixes).
  const frameProblem = machineFrameProblemById(machine.profileId);
  const target = machine.address;
  const probe = probeFor(machine);
  const profile = jobMachine({ machineId: machine.profileId ?? 'Z1' }, calibration);
  // #845 — a stated machine has no clearance to read. The row is not offered for it (the
  // `frameProblem` guard below returns null), so the 0 is never used to place a tap.
  const seekFromMachineZ = clearanceZOf(profile) ?? 0;
  const viseAcc = accessoriesFor(machine).find((a) => a.kind === 'vise');
  const mountTap = mountTapFor(machine, Object.values(registrations), seekFromMachineZ, mountNum(viseAcc?.unit.jawStartY) ?? -10);

  const api = useMountTap({
    clearanceZ: seekFromMachineZ,
    target,
    settings: registrationSettings(defaults, probe).settings,
    floor: profile.envelope.z.min,
    probeId: probe?.id ?? null,
    successNote: 'the jaw top is recorded',
  });

  if (frameProblem !== null || !canReachMachine || target === null || mountTap === null) return null;

  return (
    <span data-testid="manage-bed-tap-jaw">
      <button
        type="button"
        className="btn btn--sm"
        data-testid="manage-bed-tap-jaw-button"
        disabled={tapBusy}
        onClick={() => void api.tapJaw({ x: mountTap.x, y: mountTap.y, fromMachineZ: mountTap.fromMachineZ })}
      >
        Tap the fixed jaw
      </button>
      {/* #1199 field 7 (e) — THE BED-SETUP TAP SHOWS ITS POINT. This is the only place a jaw is
          touched now; the probe travels there at the clearance and descends only at the point. */}
      <span className="hint" data-testid="manage-bed-tap-point">
        {' '}
        at machine X {mountTap.x}, Y {mountTap.y}
      </span>
      {api.note !== null && (
        <span className="hint" data-testid="manage-bed-tap-note">
          {' '}
          {api.note}
        </span>
      )}
      {api.prompt !== null && (
        <div className="hint" data-testid="manage-bed-tap-prompt">
          <span>
            {api.prompt.text}{' '}
            <button type="button" className="btn btn--sm" data-testid="engrave-mount-tap-continue" onClick={() => api.resolve(true)}>
              Continue
            </button>
            <button type="button" className="btn btn--sm" data-testid="engrave-mount-tap-cancel" onClick={() => api.resolve(false)}>
              Cancel
            </button>
          </span>
          {/* #788 — the tap asks for the probe before it touches: the head diagram says which port,
              for the probe this machine has checked out; none checked out means no diagram. */}
          {api.prompt.kind === 'fit-probe' && (
            <ProbeFitDiagram compact instrument={probe === null ? null : probeInstrumentOf(probe)} />
          )}
        </div>
      )}
    </span>
  );
}

/**
 * #1201 — THE BRACKET SEAT IS A BED-SETUP DATUM, NOT A JOB STEP.
 *
 * One touch with the BED CLEAR — no blank, no clamps in the way — at the point the datum names
 * when it names one (the spot verified solid when it was last taken), else beside the bracket's
 * front arm. The reading is written to the ACTIVE bed profile with the probe's own M491 reference
 * (#1189), so a job can use it as a trusted seat without ever touching the board beside a mounted
 * blank. The Register card in a job never offers this press.
 */
function BedSeatTap({ machine, profile }: { machine: MachineRecord; profile: BedProfile }) {
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const tapBusy = useMountTapBusyFlag();
  // #1201 — THE BED-CLEAR TICK. The seat is measured with the bed CLEAR, and that is the one fact
  // the app cannot read from the machine: the operator states it, and the press stays disabled
  // until they do. The tick clears after every run, so a second press re-affirms it.
  const [bedClear, setBedClear] = useState(false);
  // #773/#845 — no frame read, no clearance: the row is not offered (and the hooks stay
  // unconditional, as BedJawTap's own note explains).
  const frameProblem = machineFrameProblemById(machine.profileId);
  const target = machine.address;
  const probe = probeFor(machine);
  const mill = jobMachine({ machineId: machine.profileId ?? 'Z1' }, calibration);
  const seekFromMachineZ = clearanceZOf(mill) ?? 0;
  const anchor = anchorFrom(calibration, machine.profileId ?? 'Z1');
  const sizes = bracketSettings(defaults);
  const datum = anchor.ok ? bracketDatum(anchor.anchor, sizes) : null;
  const stored = profile.datums.bracketSeatZ?.at ?? null;
  const point =
    stored !== null
      ? { x: stored[0], y: stored[1] }
      : datum === null
        ? null
        : {
            // The seat plane beside the front arm: the arm runs in front of the blank, so the
            // board beside it is just beyond the arm's front face, at its mid-length.
            x: Math.round((datum.x + sizes.settings.armLengthX / 2) * 1000) / 1000,
            y: Math.round((datum.y - sizes.settings.armWidth / 2 - 6) * 1000) / 1000,
          };
  const api = useMountTap({
    clearanceZ: seekFromMachineZ,
    target,
    settings: registrationSettings(defaults, probe).settings,
    floor: mill.envelope.z.min,
    probeId: probe?.id ?? null,
    successNote: 'the bracket seat is recorded',
  });

  if (frameProblem !== null || !canReachMachine || target === null || point === null) return null;

  return (
    <span data-testid="manage-bed-tap-seat">
      <span className="hint" data-testid="manage-bed-tap-seat-clear">
        <label>
          <input
            type="checkbox"
            data-testid="manage-bed-tap-seat-clear-tick"
            checked={bedClear}
            disabled={tapBusy}
            onChange={(e) => setBedClear(e.target.checked)}
          />{' '}
          The bed is clear — no blank, no clamps in the way.
        </label>{' '}
        The touch is at machine X {point.x}, Y {point.y}.
      </span>{' '}
      <button
        type="button"
        className="btn btn--sm"
        data-testid="manage-bed-tap-seat-button"
        disabled={tapBusy || !bedClear}
        title={bedClear ? undefined : 'tick that the bed is clear first'}
        onClick={() => {
          void api
            .tapJaw({
              x: point.x,
              y: point.y,
              fromMachineZ: seekFromMachineZ,
              reference: 'bracket-seat',
              // The reading IS the seat: the touch is on the board, not the arm.
              datumOffsetMm: 0,
            })
            // The statement is about ONE measurement: a second press starts unticked.
            .finally(() => setBedClear(false));
        }}
      >
        Measure the bracket seat
      </button>
      {api.note !== null && (
        <span className="hint" data-testid="manage-bed-tap-seat-note">
          {' '}
          {api.note}
        </span>
      )}
      {api.prompt !== null && (
        <div className="hint" data-testid="manage-bed-tap-seat-prompt">
          <span>
            {api.prompt.text}{' '}
            <button type="button" className="btn btn--sm" data-testid="engrave-mount-tap-continue" onClick={() => api.resolve(true)}>
              Continue
            </button>
            <button type="button" className="btn btn--sm" data-testid="engrave-mount-tap-cancel" onClick={() => api.resolve(false)}>
              Cancel
            </button>
          </span>
          {api.prompt.kind === 'fit-probe' && (
            <ProbeFitDiagram compact instrument={probe === null ? null : probeInstrumentOf(probe)} />
          )}
        </div>
      )}
    </span>
  );
}

export function MachineBed({ machine }: { machine: MachineRecord }) {
  const [note, setNote] = useState<string | null>(null);
  const profiles = machine.bedProfiles ?? [];
  const fixtures = accessoriesFor(machine);
  const active = profiles.find((p) => p.id === machine.activeBedProfileId) ?? null;

  const save = async (record: MachineRecord, ok: string): Promise<void> => {
    const res = await useLocationStore.getState().saveMachine(record);
    setNote(res === 'ok' ? ok : 'the bed was not saved — see the card note');
  };

  // #512 — the first-run entry: the wizard describes the bed before any registration has. It only
  // writes the location (no machine moves), so it is offered on a build that cannot drive one too.
  const wizardButton = (label: string): JSX.Element => (
    <button
      type="button"
      className="btn btn--sm"
      data-testid="manage-bed-wizard"
      title="Describe the bed step by step — surface, fixtures, how stock is held. It never moves the machine."
      onClick={() => openBedWizard(machine.id)}
    >
      {label}
    </button>
  );

  if (machine.bedProfiles === undefined) {
    return (
      <>
        <span>bed</span>
        <b data-testid="manage-bed">
          — not described (described by the first registration){' '}
          {wizardButton('Set up the bed…')}
        </b>
      </>
    );
  }

  if (active === null) {
    return (
      <>
        <span>bed</span>
        <b data-testid="manage-bed">
          — no active profile {wizardButton('Set up the bed…')}
        </b>
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
          {/* #693 — the wizard's Manage entry: with no target it offers the mounts this house can
              give, in step 1. A build with no socket cannot answer the save lines, so it does not
              offer the physical change at all (#354's rule). */}
          {canReachMachine && (
            <button
              type="button"
              className="btn btn--sm"
              data-testid="manage-bed-change"
              title="Take a fixture off the pins and fit another, guided: make it safe, take it off, fit it, confirm"
              onClick={() => openMachineChange()}
            >
              Change the machine…
            </button>
          )}
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
          {wizardButton('Set up the bed…')}
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
                    ? `${mm(datum.value)}, ${datum.by}, measured ${formatDay(datum.measuredAt) ?? datum.measuredAt}`
                    : UNMEASURED_DATUM_WORDS[key]}
                  {key === 'viseJawTopZ' && (
                    <>
                      {' '}
                      <BedJawTap machine={machine} />
                    </>
                  )}
                  {key === 'bracketSeatZ' &&
                    active.placements.some(
                      (p) => fixtures.find((f) => f.id === p.fixture)?.kind === 'bracket',
                    ) && (
                      <>
                        {' '}
                        <BedSeatTap machine={machine} profile={active} />
                      </>
                    )}
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
