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

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react';
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
  mountTapFor,
  probeFor,
  probeNameFor,
  surfaceTopDatumFor,
  bracketSeatDatumFor,
  bracketPlacementSeedFor,
} from '@/engine/cnc/registration/mountContext';
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
import { partSilhouetteOf, vendorMethodOffer } from '@/engine/cnc/engrave/flipSilhouette';
import { derivedSetupStock, measuredBlankThickness } from '@/engine/cnc/setups/perSetupStock';
// #1082 — the derived box is measured through `toPartPlan`, which typesets every label; on the
// COLD first paint the bundled faces may not be parsed yet, and `resolveFont` throws by design.
// The section subscribes to the faces landing (the panel already loads them on mount) and derives
// only once they are up — the stated stock shows meanwhile, never a measurement that would throw.
import { ensureLabelFontsLoaded, facesLoadedEpoch, labelFontsLoaded, subscribeFacesLoaded } from '@/engine/fonts/registry';
import { machineRecordByProfile } from '@/store/locationStore';
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
  // #1073(b) — THE PART'S OUTLINE FOR THE FLIP'S VENDOR AVAILABILITY. Measured from the goal's
  // mesh on the flip plan's own coverage grid, only when a later bottom-up setup is on screen, so
  // ordinary jobs pay nothing. The verdict is the registration planner's (the same settings the
  // Setups step plans under), so the row's "unavailable" and the plan's refusal are one statement.
  // #1082 — the freed part's box for the flip's side-2 stock offer (derived from the cut extents).
  // #1082 — the blank's measured thickness, from the bed profile's own datums (the surface touch
  // less the bracket seat — the same pair #1073's Z0 reads), when the house has one.
  const bedMachine = machineRecordByProfile(job.machineId);
  const bedProfile = bedMachine?.bedProfiles?.find((p) => p.id === bedMachine.activeBedProfileId) ?? null;
  const measuredThickness = measuredBlankThickness(bedProfile);
  // #1082 — the label faces must be UP before the derived box can be measured. `ensureLabelFontsLoaded`
  // is the panel's own mount call (this one is idempotent and joins the in-flight fetch); the epoch
  // subscription re-runs the memo when a face lands, so the offer is the measured box, never the
  // estimate. Until then `derivedStock` is null and the row shows the setup's stated stock.
  const facesEpoch = useSyncExternalStore(subscribeFacesLoaded, facesLoadedEpoch);
  useEffect(() => {
    if (labelFontsLoaded(job.labels, job.customFonts ?? [])) return;
    // Swallowed like the panel's own wait: a face that plainly fails to fetch leaves the offer
    // absent (there is no honest measurement without the outline), and nothing else breaks.
    void ensureLabelFontsLoaded(job.labels, job.customFonts ?? []).catch(() => {});
  }, [job.labels, job.customFonts]);
  const derivedStock = useMemo(
    () =>
      labelFontsLoaded(job.labels, job.customFonts ?? []) ? derivedSetupStock(job, measuredThickness, useShopDefaultsStore.getState().defaults) : null,
    // The epoch is the memo's cue: a face landing must re-derive even when the job object is unchanged.
    [job, measuredThickness, facesEpoch],
  );
  const flipSilhouette = useMemo(() => {
    const hasFlipCandidate = (job.setups ?? []).some((su) => su.orientation.top === 'bottom');
    if (!hasFlipCandidate) return null;
    const goal = jobTargetObjects(job).find((t) => (t.role ?? 'reference') === 'goal' && t.enabled !== false);
    if (goal === undefined) return null;
    try {
      return partSilhouetteOf(goal);
    } catch {
      return null;
    }
  }, [job]);
  const flipVendorOffer = useMemo(
    () => vendorMethodOffer(flipSilhouette, registrationSettings(defaults).settings),
    [flipSilhouette, defaults],
  );
  // #598 — the checked-out probe and the measured jaw-top datum, from the machine at the run target.
  const target = useMemo(() => (machine === null ? null : { host: machine.host, port: machine.port }), [machine]);
  // #617 — subscribe to the location store so any write-back (a card tap, a registration frame or
  // datum, an accessory check-out) re-renders and `machineAt` re-reads the current record; a snapshot
  // here would plan from a stale machine after a tap taken outside this section.
  useLocationStore((s) => s.location);
  const machineRecord = target === null ? null : machineAt(target);
  const probe = useMemo(() => probeFor(machineRecord), [machineRecord]);
  const mountDatum = useMemo(() => mountDatumFor(machineRecord), [machineRecord]);
  // #619 — the measured surface top, so a re-plan expects the found top rather than the ledge estimate.
  const surfaceTopZ = useMemo(() => surfaceTopDatumFor(machineRecord), [machineRecord]);
  // #509 — the bracket's seat from the ACTIVE bed profile (bracket seat, else surface top; the
  // shop-default fallback lives in the engine for one release).
  const bracketSeat = useMemo(() => bracketSeatDatumFor(machineRecord), [machineRecord]);
  const placedSeed = useMemo(() => bracketPlacementSeedFor(machineRecord), [machineRecord]);
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
  // #1199 field 7 (e) — NO TAP FROM A JOB. The jaw datum is measured in the bed setup (Manage ›
  // the machine); this surface only plans and shows, and its no-frame refusal links there.
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
              // #934 — the setup editor offers the one mount the bench has registered on (vise);
              // a job already on tape or in the bracket keeps its word but cannot be moved TO it.
              mountKinds={setup.mount.kind === 'tape' || setup.mount.kind === 'bracket' ? [setup.mount.kind, 'vise'] : ['vise']}
              viseSource={jobVise(job).source}
              probeName={probeName}
              stock={{ length: job.stock.length, width: job.stock.width, ...(job.stock.squareCorners === undefined ? {} : { squareCorners: job.stock.squareCorners }) }}
              breakthroughMm={job.breakthrough}
              partSilhouette={flipSilhouette}
              vendorOffer={flipVendorOffer}
              derivedStock={derivedStock}
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
              planRegistration={() => {
                const derived = derivedFor(setup, index);
                if (!derived) return { kind: 'refused', reason: 'this setup has no cut item to register from yet' };
                return planRegistrationAttempt({
                  job,
                  setup: derived,
                  mount: setup.mount,
                  mountDatum,
                  surfaceTopZ,
                  bracketSeat,
                  placedSeed,
                  probe,
                  mountTap,
                  defaults,
                  calibration,
                  settings: regSettings,
                  // #1179 B — the saved setup's own number: only its programs are this face's cuts.
                  setupIndex: index + 1,
                });
              }}
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
