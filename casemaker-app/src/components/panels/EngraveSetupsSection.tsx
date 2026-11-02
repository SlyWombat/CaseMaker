/**
 * The Setups section (#471, §5.4): what the job's setups are, how each holds the stock, what the
 * planner says about them, and the two approvals a run needs — the registration and the remount.
 *
 * THE SAVED LIST IS AUTHORITATIVE. A job with `setups[]` shows exactly that list; the planner's
 * fresh grouping is only behind **Re-plan**, and nothing is written until **Use this plan**. A job
 * without `setups[]` is the compatibility reading (one top-up setup) and is read-only until **Edit
 * setups** materialises it. A stale saved list (an item removed or disabled after the setups were
 * saved) is REPORTED with the engine's two section codes and is never rewritten on render.
 *
 * This component owns React state only: the suggested plan being previewed, the remount page, and
 * the row notices. Every plan, every reason and every set of words comes from `engine/cnc/setups`.
 */

import { Fragment, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { ProbeFitDiagram } from '@/components/ui/ProbeFitDiagram';
import { probeInstrumentOf } from '@/engine/cnc/registration/plan';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useMachineStore } from '@/store/machineStore';
import { isSideGoal, jobMount, jobTargetObjects } from '@/engine/cnc/engrave/jobSetup';
import { jobVise } from '@/engine/cnc/fixture';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { expandEngraveRow } from '@/store/engraveRowStore';
import { machineAt, useLocationStore } from '@/store/locationStore';
import { newId } from '@/utils/id';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, rotaryOf } from '@/engine/cnc/machine';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { recommendedSurfaceToleranceMm } from '@/engine/cnc/materials';
import { primitiveLabel } from '@/engine/cnc/engrave/partPlan';
import {
  mountDatumFor,
  accessoryNameFor,
  mountDatumMismatch,
  mountTapFor,
  probeFor,
  probeNameFor,
  surfaceTopDatumFor,
  bracketSeatDatumFor,
} from '@/engine/cnc/registration/mountContext';
import { useMountTap, useMountTapBusyFlag } from '@/hooks/useMountTap';
import {
  addSetupOffer,
  applySetupChange,
  cutItemIds,
  faceUpOf,
  materializeSetups,
  orient,
  planFromSetups,
  readSetups,
  removalsFrom,
  setupsSettings,
  suggestedPlan,
  type Face,
  type Mount,
  type MountSpec,
  type SetupsPlan,
  type Setup,
  type SetupChange,
} from '@/engine/cnc/setups';
import { readDefault } from '@/platform/defaultsClient';
import { machineDisplayName } from '@/platform/locationClient';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import { EngraveSetupRow } from './EngraveSetupRow';
import { EngraveRemountPage } from './EngraveRemountPage';
import { planRegistrationAttempt } from './registrationAttempt';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const TAG: CSSProperties = {
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: 3,
  border: '1px solid #2a2f36',
  color: '#9aa4b0',
  whiteSpace: 'nowrap',
};
const BADGE_COLOR: Record<string, string> = {
  planned: '#8fb8d1',
  saved: '#8fd18f',
  stale: '#e0c07a',
  suggested: '#c9a7e0',
  empty: '#9aa4b0',
};

function stripApprovals(setup: JobSetup): JobSetup {
  if (setup.registration === undefined && setup.remount === undefined) return setup;
  const { registration: _registration, remount: _remount, ...rest } = setup;
  return rest;
}

function draftFromPlan(plan: SetupsPlan, toolKey: string): JobSetup[] {
  return plan.setups.map((s) => ({
    id: newId('setup'),
    orientation: { ...s.orientation },
    mount: { ...s.mount },
    itemIds: [...s.itemIds],
    tools: [toolKey],
  }));
}

export interface EngraveSetupsSectionProps {
  initiallyOpen?: boolean;
  /**
   * #723 P2-3 — the SIDES list's two presses. A part cut from several sides gives each setup a
   * goal; the panel opens its goal reader for that side, or clears the side's goal. Absent: the
   * section stays read-only about goals (a test, a preview, the Cut surface).
   */
  onPickGoal?: (setupId: string) => void;
  onClearGoal?: (setupId: string) => void;
}

export function EngraveSetupsSection({
  initiallyOpen = false,
  onPickGoal,
  onClearGoal,
}: EngraveSetupsSectionProps = {}): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
  const setSetups = useEngraveJobStore((s) => s.setSetups);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const machine = useMachineStore((s) => s.machine);
  const tools = useToolRegistry();
  const reading = useMemo(() => readSetups(job), [job]);
  const settings = useMemo(() => setupsSettings(defaults), [defaults]);
  // #598 — the checked-out probe and the measured jaw-top datum, from the machine at the run target.
  const target = useMemo(() => (machine === null ? null : { host: machine.host, port: machine.port }), [machine]);
  // #617 — subscribe to the location store so any write-back (a card tap, a registration frame or
  // datum, an accessory check-out) re-renders and `machineAt` re-reads the current record; a snapshot
  // here would plan from a stale machine after a tap taken outside this section.
  useLocationStore((s) => s.location);
  const machineRecord = target === null ? null : machineAt(target);
  const probe = useMemo(() => probeFor(machineRecord), [machineRecord]);
  const mountDatum = useMemo(() => mountDatumFor(machineRecord), [machineRecord]);
  // #611 — the jaw-top datum's `by` when it names a probe other than the one now checked out.
  const mountDatumMismatchBy = useMemo(() => mountDatumMismatch(machineRecord), [machineRecord]);
  // #640 — the sentence names the probe, not its location id.
  const mountDatumMismatchName = useMemo(
    () => (mountDatumMismatchBy === null ? null : accessoryNameFor(mountDatumMismatchBy)),
    [mountDatumMismatchBy],
  );
  // #619 — the measured surface top, so a re-plan expects the found top rather than the ledge estimate.
  const surfaceTopZ = useMemo(() => surfaceTopDatumFor(machineRecord), [machineRecord]);
  // #509 — the bracket's seat from the ACTIVE bed profile (bracket seat, else surface top; the
  // shop-default fallback lives in the engine for one release).
  const bracketSeat = useMemo(() => bracketSeatDatumFor(machineRecord), [machineRecord]);
  // #599 — the mount tap point (machine XY), from the placement frame or the newest usable registration.
  const registrations = useEngraveRegistrationStore((s) => s.records);
  const seekFromMachineZ = useMemo(() => clearanceZOf(jobMachine(job, calibration)) ?? 0, [job, calibration]);
  const mountTap = useMemo(
    () => mountTapFor(machineRecord, Object.values(registrations), seekFromMachineZ, jobVise(job).jawStartY),
    [machineRecord, registrations, seekFromMachineZ, job],
  );
  const regSettings = useMemo(() => registrationSettings(defaults, probe).settings, [defaults, probe]);
  // #603 — the checked-out probe's name and the machine's display name, on the compact row.
  const probeName = useMemo(() => probeNameFor(machineRecord), [machineRecord]);
  const machineName = useMemo(() => {
    if (machineRecord === null) return null;
    const profile = machineRecord.bedProfiles?.find((p) => p.id === machineRecord.activeBedProfileId);
    return machineDisplayName(machineRecord, profile);
  }, [machineRecord]);
  const tapBusy = useMountTapBusyFlag();
  const mountTapApi = useMountTap({
    target,
    settings: regSettings,
    floor: jobMachine(job, calibration).envelope.z.min,
    probeId: probe?.id ?? null,
    // #607 — the tap may be the bracket's or the rotary's now, so the note names neither.
    successNote: 'the mount reference is recorded — plan the registration again',
  });
  const rotaryEnvelope = useMemo(() => rotaryOf(jobMachine(job, calibration))?.envelope, [job, calibration]);
  const suggested = useMemo(() => suggestedPlan(job, settings, rotaryEnvelope), [job, settings, rotaryEnvelope]);
  const savedPlan = useMemo(() => (job.setups !== undefined ? planFromSetups(job, settings, rotaryEnvelope) : null), [job, settings, rotaryEnvelope]);
  const offer = useMemo(() => addSetupOffer(job, settings, rotaryEnvelope), [job, settings, rotaryEnvelope]);
  const removals = useMemo(() => removalsFrom(job), [job]);
  const removalById = useMemo(() => new Map(removals.map((r) => [r.id, r])), [removals]);

  const [draftState, setDraftState] = useState<{ job: EngraveJob; setups: JobSetup[]; plan: SetupsPlan } | null>(null);
  const [remount, setRemount] = useState<{ setup: Setup; total: number; mount: MountSpec; index: number } | null>(null);
  const [notice, setNotice] = useState<{ index: number; reason: string } | null>(null);
  const [sectionNotice, setSectionNotice] = useState<string | null>(null);

  // A draft describes the document as it was; any document write makes it yesterday's suggestion.
  // Comparing against the job's identity does that during render, with no effect and no extra paint.
  const draft = draftState !== null && draftState.job === job ? draftState : null;

  const shownPlan = draft !== null ? draft.plan : (savedPlan ?? suggested);
  const displayed = draft !== null ? draft.setups : reading.setups;
  const editable = draft === null && job.setups !== undefined;
  const source = draft !== null ? 'suggested' : reading.source === 'saved' ? (reading.stale ? 'stale' : 'saved') : reading.source === 'implicit' ? 'planned' : 'empty';

  const names = useMemo(() => {
    const map = new Map<string, string>();
    const lists: { id: string; name?: string; text?: string }[][] = [
      job.labels,
      job.shapes,
      job.combined ?? [],
      job.traces ?? [],
      job.vectors ?? [],
      job.drills ?? [],
      job.threads ?? [],
      // #743 P-8 review — a CUT-OUT and a CHAMFER are setup items too: their chips read the
      // item's own name, never its id ("Cut out the board", not "cut-s00000y").
      job.cutouts ?? [],
      job.chamfers ?? [],
    ];
    for (const list of lists) {
      for (const item of list) map.set(item.id, item.name ?? item.text ?? item.id);
    }
    // #435 — a primitive has no text; its label is its name, else its shape and size.
    for (const primitive of job.primitives ?? []) {
      map.set(primitive.id, primitive.name ?? primitiveLabel(primitive));
    }
    // #888 item 6 — a goal is a setup item now: its row reads the mesh's own name.
    for (const goal of jobTargetObjects(job)) map.set(goal.id, goal.name);
    return map;
  }, [job]);
  const itemName = (id: string): string => names.get(id) ?? id;

  const stock = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };

  // #589 — the registration surface tolerance: the current house number and the per-stock
  // recommendation beside it. The one write path goes through the shop-defaults store's `set`,
  // which refetches after a successful write, so the new number is seen without a reload.
  const tolerance = readDefault(defaults, 'registration.surfaceToleranceMm');
  const toleranceRec = recommendedSurfaceToleranceMm(job.stock.material);
  const [tolDraft, setTolDraft] = useState<string | null>(null);

  function saveTolerance(): void {
    if (tolDraft === null) return;
    const value = Number(tolDraft);
    if (!Number.isFinite(value) || value < 0.05) {
      setTolDraft(null);
      return;
    }
    void useShopDefaultsStore
      .getState()
      .set('registration.surfaceToleranceMm', {
        value,
        source: 'chosen',
        setAt: new Date().toISOString(),
        unit: 'mm',
        note: null,
      })
      .then((ok) => {
        setTolDraft(null);
        if (!ok) return;
        // A changed tolerance invalidates the plan, not the Generate (#574): drop the approved
        // registrations so the operator plans again with the new number. The Cut screen then offers a
        // re-freeze, never a re-generate — the .nc does not come from the tolerance.
        const setups = job.setups;
        if (setups !== undefined && setups.some((s) => s.registration !== undefined)) {
          setSetups(setups.map((s) => ({ ...s, registration: undefined })));
        }
      });
  }

  function write(next: JobSetup[]): void {
    setSetups(next);
  }

  function baseSetups(): JobSetup[] {
    return job.setups ?? materializeSetups(job);
  }

  function edit(index: number, change: SetupChange): void {
    write(applySetupChange(baseSetups(), index, change));
  }

  function changeFace(index: number, face: Face): void {
    const setup = displayed[index];
    if (!setup) return;
    const o = orient(face, setup.mount, stock);
    if (!o.ok) {
      setNotice({ index, reason: o.reason });
      return;
    }
    setNotice(null);
    edit(index, { orientation: o.orientation });
  }

  function changeMount(index: number, kind: Mount): void {
    const setup = displayed[index];
    if (!setup) return;
    const mount: MountSpec = kind === 'bracket' ? { kind, board: setup.mount.board } : { kind };
    const o = orient(faceUpOf(setup), mount, stock);
    if (!o.ok) {
      setNotice({ index, reason: o.reason });
      return;
    }
    setNotice(null);
    edit(index, { mount, orientation: o.orientation });
  }

  function removeItem(index: number, id: string): void {
    const setup = displayed[index];
    if (!setup) return;
    edit(index, { itemIds: setup.itemIds.filter((x) => x !== id) });
  }

  /**
   * Move a cut item into this setup: take it out of whichever setup held it and put it here. Both
   * item lists change, so run `applySetupChange` at each changed index in ascending order — that is
   * the one place the approval-invalidation rule is written, and it also clears the later setups
   * whose entering stock the move changes.
   */
  function assignItem(index: number, id: string): void {
    const base = baseSetups();
    const target = base[index];
    if (!target) return;
    const changed = base
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i === index || s.itemIds.includes(id))
      .map(({ i }) => i)
      .sort((a, b) => a - b);
    let next = [...base];
    for (const i of changed) {
      const ids =
        i === index
          ? [...base[i]!.itemIds.filter((x) => x !== id), id]
          : base[i]!.itemIds.filter((x) => x !== id);
      next = applySetupChange(next, i, { itemIds: ids });
    }
    setNotice(null);
    write(next);
  }

  function removeSetup(index: number): void {
    const base = baseSetups();
    // Removing a setup changes the stock every later setup enters, so their approvals no longer
    // hold; the rule is the same truthfulness `applySetupChange` applies to an item change.
    const next = base.filter((_, i) => i !== index).map((s, i) => (i >= index ? stripApprovals(s) : s));
    write(next);
  }

  function replaceSetup(index: number, next: JobSetup): void {
    write(baseSetups().map((s, i) => (i === index ? next : s)));
  }

  function replan(): void {
    setDraftState({ job, setups: draftFromPlan(suggested, job.toolKey), plan: suggested });
  }

  function usePlan(): void {
    if (draft !== null) {
      if (draft.setups.length > 0) write(draft.setups);
      return;
    }
    if (reading.source === 'implicit') write(materializeSetups(job));
  }

  function addSetup(): void {
    if (offer.face === null) return;
    const base = materializeSetups(job);
    const mount = base[0]?.mount ?? { kind: jobMount(job) };
    const o = orient(offer.face, mount, stock);
    if (!o.ok) {
      setSectionNotice(o.reason);
      return;
    }
    setSectionNotice(null);
    write([
      ...base,
      { id: newId('setup'), orientation: o.orientation, mount, itemIds: [], tools: [job.toolKey] },
    ]);
  }

  function previewRemount(index: number): void {
    if (!editable) return;
    const setup = displayed[index];
    const derived = savedPlan?.setups.find(
      (s) => s.faceUp === (setup ? faceUpOf(setup) : 'top') && (setup === undefined || s.itemIds.some((id) => setup.itemIds.includes(id))),
    );
    if (!setup || !derived || derived.remount === null) return;
    setRemount({ setup: derived, total: displayed.length, mount: setup.mount, index });
  }

  function storeRemount(remountData: NonNullable<JobSetup['remount']>): void {
    if (remount === null) return;
    const next = baseSetups().map((s, i) => (i === remount.index ? { ...s, remount: remountData } : s));
    write(next);
    setRemount(null);
  }

  /** The planner's setup for one displayed row: a draft is index-aligned; a saved plan is found by its items. */
  function derivedFor(setup: JobSetup, index: number): Setup | undefined {
    if (draft !== null) return draft.plan.setups[index];
    if (savedPlan === null) return suggested.setups.find((s) => s.faceUp === faceUpOf(setup));
    return savedPlan.setups.find(
      (s) => s.faceUp === faceUpOf(setup) && s.itemIds.some((id) => setup.itemIds.includes(id)),
    );
  }

  const canUsePlan = draft !== null ? draft.setups.length > 0 : reading.source === 'implicit';

  // #723 P2-3 — THE SIDES LIST. A job with more than one SAVED setup is a part cut from sides:
  // each row says which goal its side cuts, or that the side cuts the stock flat. Goals are only
  // shown against the saved list (a re-plan draft has its own, unsaved setup ids).
  const sideGoals = jobTargetObjects(job);
  const showSides = job.setups !== undefined && draft === null && displayed.length > 1;
  const goalFor = (setup: JobSetup, index: number): (typeof sideGoals)[number] | null =>
    sideGoals.find((t) => isSideGoal(t) && (t.setupId === setup.id || (t.setupId === undefined && index === 0))) ?? null;

  return (
    <section className="engrave-setups" data-testid="engrave-setups" aria-label="Setups">
      <div className="engrave-setups__header">
        <h3 style={{ fontSize: 12, margin: '0 6px 0 0' }}>Setups ({displayed.length})</h3>
        <span
          style={{ ...TAG, color: BADGE_COLOR[source] ?? '#9aa4b0' }}
          data-testid="engrave-setups-badge"
        >
          {source}
        </span>
        <span style={{ flex: 1 }} />
        {reading.source === 'implicit' && draft === null && (
          <button type="button" data-testid="engrave-setups-edit" onClick={() => write(materializeSetups(job))}>
            Edit setups
          </button>
        )}
        <button type="button" data-testid="engrave-setups-replan" disabled={reading.source === 'empty' && draft === null} onClick={replan}>
          Re-plan
        </button>
        <button type="button" data-testid="engrave-setups-use-plan" disabled={!canUsePlan} onClick={usePlan}>
          Use this plan
        </button>
        {draft !== null && (
          <button type="button" data-testid="engrave-setups-discard" onClick={() => setDraftState(null)}>
            Discard
          </button>
        )}
        <button
          type="button"
          data-testid="engrave-setups-add"
          disabled={offer.face === null}
          title={offer.reason ?? `Add a setup facing ${offer.face} up`}
          onClick={addSetup}
        >
          Add setup
        </button>
      </div>

      {/* #589 — the registration surface tolerance, where the plan is made: the number a bowed
          printed blank needs, writable here rather than only through the API. */}
      <div data-testid="engrave-setups-tolerance" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span>Plausibility width</span>
          <input
            type="number"
            step="any"
            min="0.05"
            max="10"
            value={tolDraft ?? String(tolerance.value)}
            style={{ width: 70 }}
            data-testid="engrave-setups-tolerance-input"
            aria-label="Registration surface tolerance"
            onChange={(e) => setTolDraft(e.target.value)}
          />
          <span>mm</span>
        </label>
        <button
          type="button"
          data-testid="engrave-setups-tolerance-save"
          disabled={tolDraft === null || Number(tolDraft) === tolerance.value}
          onClick={saveTolerance}
        >
          Save
        </button>
        {/* #726 W23 — a disabled Save says why, on the screen (A10). */}
        {(tolDraft === null || Number(tolDraft) === tolerance.value) && (
          <span style={{ ...MUTED, margin: 0 }} data-testid="engrave-setups-tolerance-why">
            {tolDraft === null ? 'type a tolerance to save it' : 'unchanged'}
          </span>
        )}
        <span style={{ ...MUTED, margin: 0 }}>
          ±{toleranceRec.value} mm — {toleranceRec.kind}
        </span>
      </div>

      {reading.source === 'implicit' && draft === null && (
        <p style={MUTED} data-testid="engrave-setups-implicit">
          One setup — every cut opens to the top face. It is the compatibility reading until you press Edit
          setups; nothing is written by showing it.
        </p>
      )}
      {draft !== null && (
        <p style={MUTED} data-testid="engrave-setups-suggested">
          A fresh suggestion — its grouping wins over the saved list only when you press Use this plan.
        </p>
      )}
      {reading.stale && (
        <p style={{ ...MUTED, color: '#e0c07a' }} data-testid="engrave-setups-stale">
          The saved setups no longer match the document. Nothing has been changed: remove a missing item,
          assign the unassigned cuts, or re-plan.
        </p>
      )}
      {reading.unassigned.length > 0 && (
        <div style={{ ...MUTED, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }} data-testid="engrave-setups-unassigned">
          <span>Cut items in no setup:</span>
          {reading.unassigned.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`engrave-setups-unassigned-${id}`}
              style={{ ...TAG, cursor: 'pointer' }}
              onClick={() => expandEngraveRow(id)}
            >
              {itemName(id)}
            </button>
          ))}
        </div>
      )}
      {offer.face === null && offer.reason !== null && (
        <p style={MUTED} data-testid="engrave-setups-add-reason">
          Add setup is unavailable: {offer.reason}
        </p>
      )}
      {sectionNotice !== null && (
        <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="engrave-setups-notice">
          {sectionNotice}
        </p>
      )}
      {mountTapApi.note !== null && (
        <p style={{ ...MUTED, color: '#e0c07a' }} data-testid="engrave-setups-tap-note">
          {mountTapApi.note}
        </p>
      )}
      {mountTapApi.prompt !== null && (
        <div style={{ margin: '8px 0' }} data-testid="engrave-setups-tap-prompt">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12 }}>{mountTapApi.prompt.text}</span>
            <button type="button" data-testid="engrave-mount-tap-continue" onClick={() => mountTapApi.resolve(true)}>
              Continue
            </button>
            <button type="button" data-testid="engrave-mount-tap-cancel" onClick={() => mountTapApi.resolve(false)}>
              Cancel
            </button>
          </div>
          {/* #788 — this prompt is the executor asking for the probe to be fitted (the mount tap
              runs it before the first touch): show which connector, for the probe this machine
              has checked out; none checked out means no diagram. */}
          {mountTapApi.prompt.kind === 'fit-probe' && (
            <ProbeFitDiagram compact instrument={probe === null ? null : probeInstrumentOf(probe)} />
          )}
        </div>
      )}

      {reading.source === 'empty' && draft === null ? (
        <p style={MUTED} data-testid="engrave-setups-empty">
          No cuts to plan — every setup would be empty.
        </p>
      ) : (
        displayed.map((setup, index) => {
          const rowReading =
            draft !== null
              ? {
                  setupIndex: index + 1,
                  itemIds: [...setup.itemIds],
                  cut: [...setup.itemIds],
                  missing: [],
                  notCut: [],
                }
              : reading.items[index]!;
          const face = faceUpOf(setup);
          const here = new Set(setup.itemIds);
          const candidates = cutItemIds(job)
            .filter((id) => !here.has(id) && (removalById.get(id)?.opensTo.includes(face) ?? false))
            .map((id) => ({ id, name: itemName(id) }));
          return (
            <Fragment key={setup.id}>
            <EngraveSetupRow
              key={setup.id}
              index={index}
              total={displayed.length}
              setup={setup}
              derived={derivedFor(setup, index)}
              reading={rowReading}
              editable={editable}
              initiallyOpen={index === 0 && initiallyOpen}
              findings={draft === null ? reading.findings.filter((f) => f.setupIndex === index + 1) : []}
              itemName={itemName}
              candidateItems={candidates}
              tools={tools}
              mountKinds={setup.mount.kind === 'tape' ? ['vise', 'bracket', 'tape'] : ['vise', 'bracket']}
              viseSource={jobVise(job).source}
              probeName={probeName}
              machineName={machineName}
              facingPass={index === 0 && job.facing?.enabled === true}
              notice={notice?.index === index ? notice.reason : null}
              remountMinutes={settings.remountMinutes}
              reregisterMinutes={settings.reregisterMinutes}
              onFace={(f) => changeFace(index, f)}
              onMount={(kind) => changeMount(index, kind)}
              onTool={(key) => edit(index, { tools: [key] })}
              onAssign={(id) => assignItem(index, id)}
              onRemoveItem={(id) => removeItem(index, id)}
              onRemoveSetup={() => removeSetup(index)}
              onReplace={(next) => replaceSetup(index, next)}
              onPreviewRemount={() => previewRemount(index)}
              planRegistration={(seatZ, useTypedSeat) => {
                const derived = derivedFor(setup, index);
                if (!derived) return { kind: 'refused', reason: 'this setup has no cut item to register from yet' };
                return planRegistrationAttempt({
                  job,
                  setup: derived,
                  mount: setup.mount,
                  seatZ,
                  useTypedSeat,
                  mountDatum,
                  mountDatumMismatch: mountDatumMismatchBy,
                  mountDatumMismatchName,
                  surfaceTopZ,
                  bracketSeat,
                  probe,
                  probeName,
                  mountTap,
                  defaults,
                  calibration,
                  settings: regSettings,
                });
              }}
              onTapJaw={mountTapApi.tapJaw}
              tapBusy={tapBusy}
            />
            {showSides && (() => {
              const goal = goalFor(setup, index);
              return (
                <div
                  key={`${setup.id}-goal`}
                  data-testid={`engrave-side-goal-${index}`}
                  style={{ ...MUTED, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', margin: '0 0 6px 8px' }}
                >
                  <span>
                    <span style={{ ...MUTED, margin: 0 }}>Goal</span> ·{' '}
                    {goal === null ? 'none — this side cuts the stock flat' : goal.name}
                  </span>
                  <span style={{ flex: 1 }} />
                  {onPickGoal !== undefined && (
                    <button type="button" data-testid={`engrave-side-goal-pick-${index}`} onClick={() => onPickGoal(setup.id)}>
                      {goal === null ? 'Goal…' : 'Replace…'}
                    </button>
                  )}
                  {goal !== null && onClearGoal !== undefined && (
                    <button type="button" data-testid={`engrave-side-goal-clear-${index}`} onClick={() => onClearGoal(setup.id)}>
                      Clear
                    </button>
                  )}
                </div>
              );
            })()}
            </Fragment>
          );
        })
      )}

      {shownPlan.unholdable.map((u) => (
        <p key={u.face} style={{ ...MUTED, color: '#f0b4ad' }} data-testid={`engrave-setups-unholdable-${u.face}`}>
          <code>unholdable</code> {u.reason} — {u.itemIds.map(itemName).join(', ')}
        </p>
      ))}
      {shownPlan.lost.map((l) => (
        <p key={l.itemId} style={{ ...MUTED, color: '#f0b4ad' }} data-testid={`engrave-setups-lost-${l.itemId}`}>
          <code>lost</code> {l.reason}
        </p>
      ))}
      {shownPlan.rotaryOffer !== null && (
        <p style={{ ...MUTED, color: '#e0c07a' }} data-testid="engrave-setups-rotary">
          {shownPlan.rotaryOffer}
        </p>
      )}

      {remount !== null && (
        <EngraveRemountPage
          setup={remount.setup}
          total={remount.total}
          mount={remount.mount}
          // #723 P2-3 — the flip preview reads the SAVED setup's pins (the engine's setup does not
          // carry them) and the job's stock for its rectangle.
          preview={{
            length: job.stock.length,
            width: job.stock.width,
            pins: displayed[remount.index]?.pins?.at ?? null,
          }}
          onClose={() => setRemount(null)}
          onMounted={storeRemount}
        />
      )}
    </section>
  );
}
