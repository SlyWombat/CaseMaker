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

import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { expandEngraveRow } from '@/store/engraveRowStore';
import { newId } from '@/utils/id';
import { bracketSettings, anchorFrom, bracketDatum, bracketExpectedSurface, clampObstacles, bracketObstacles, defaultClampPlacements } from '@/engine/cnc/mounts/bracket';
import { jobMachine } from '@/engine/cnc/calibration';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { recommendedSurfaceToleranceMm } from '@/engine/cnc/materials';
import { primitiveLabel } from '@/engine/cnc/engrave/partPlan';
import { summarizePlan } from '@/engine/cnc/registration/summary';
import type { PlanObstacle, RegistrationPlan } from '@/engine/cnc/registration/plan';
import {
  addSetupOffer,
  applySetupChange,
  cutItemIds,
  faceUpOf,
  materializeSetups,
  orient,
  machineSize,
  planFromSetups,
  readSetups,
  referenceOpenings,
  referenceRegistrationFor,
  registrationFor,
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
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import { EngraveSetupRow, type RegistrationAttempt } from './EngraveSetupRow';
import { EngraveRemountPage } from './EngraveRemountPage';

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

/**
 * The stock the app models is a rectangular prism: its corners are square. The job carries no
 * corner radius, and the registration planner needs one, so this states the geometry rather than
 * inventing a measurement (decision 28).
 */
const STOCK_CORNER_RADIUS_MM = 0;

function expectedWords(plan: RegistrationPlan): string {
  const z = `Z from the surface touch, within ±${plan.settings.surfaceToleranceMm} mm`;
  if (plan.bracketOrigin !== null) return `XY from the bracket (${plan.bracketOrigin.from}); ${z}`;
  if (plan.references !== undefined) return `X/Y from the earlier features; ${z}`;
  const edges = plan.scans.map((s) => s.edge);
  if (edges.length === 0) return z;
  return `X/Y re-checked on the ${edges.join(' and ')} edge${edges.length === 1 ? '' : 's'}; ${z}`;
}

/**
 * Plan one setup's registration, or say why it cannot be planned.
 *
 * No number is invented here. The vise/tape seat is the operator's typed measurement (there is no
 * stored vise-seat setting); the bracket's seat comes from the measured `bracket.seatMachineZ`, and
 * the bracket's datum, clamps and arms come from the machine's own anchor and the shop defaults —
 * `anchorFrom` / `bracketExpectedSurface` refuse when the machine has not supplied them.
 */
function planRegistrationAttempt(args: {
  job: EngraveJob;
  setup: Setup;
  mount: MountSpec;
  seatZ: string;
  defaults: ShopDefaults | null;
  calibration: MachineCalibration | undefined;
  settings: ReturnType<typeof registrationSettings>['settings'];
}): RegistrationAttempt {
  const { job, setup, mount, defaults, calibration } = args;
  const seekFromMachineZ = jobMachine(job, calibration).toolChange.clearanceZ;
  let input: Parameters<typeof registrationFor>[2];

  if (mount.kind === 'bracket') {
    const sizes = bracketSettings(defaults);
    const anchor = anchorFrom(calibration, job.machineId);
    if (!anchor.ok) return { kind: 'refused', reason: anchor.reason };
    const datum = bracketDatum(anchor.anchor, sizes);
    const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
    const under = mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
    // The engine's expected-surface read also carries the refusal when the seat was never measured.
    const expected = bracketExpectedSurface(defaults, dims.z, under);
    if (!expected.ok) return { kind: 'refused', reason: expected.reason };
    const stock = { x: dims.x, y: dims.y, z: dims.z };
    const obstacles: PlanObstacle[] = [
      ...clampObstacles(stock, defaultClampPlacements(stock, sizes.settings), sizes.settings),
      ...bracketObstacles(stock, sizes.settings, under),
    ].map((o) => ({ kind: o.kind, label: o.label, min: o.min, max: o.max, topZ: o.topZ }));
    input = {
      // `registrationFor` adds the stock's height this way up to the seat; take it back off the
      // expected surface so the two statements cannot drift.
      seatMachineZ: expected.expectedSurface.machineZ - dims.z,
      seekFromMachineZ,
      cornerRadius: STOCK_CORNER_RADIUS_MM,
      bracketOrigin: datum,
      mountObstacles: obstacles,
      bracketConfirm: !datum.offsetMeasured,
    };
  } else {
    const seat = Number(args.seatZ);
    if (args.seatZ.trim() === '' || !Number.isFinite(seat)) {
      return {
        kind: 'need-seat',
        message:
          'Enter the seat’s machine Z first — the surface the stock sits on, measured with one probe touch. The section has no stored vise seat and will not invent one.',
      };
    }
    input = { seatMachineZ: seat, seekFromMachineZ, cornerRadius: STOCK_CORNER_RADIUS_MM };
  }

  const result =
    referenceOpenings(setup).openings.length > 0
      ? referenceRegistrationFor(setup, mount, input, args.settings)
      : registrationFor(setup, mount, input, args.settings).plan;
  if (!result.ok) return { kind: 'refused', reason: result.reason };
  return {
    kind: 'plan',
    method: mount.kind,
    plan: result.plan,
    summary: summarizePlan(result.plan),
    expected: expectedWords(result.plan),
  };
}

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

export function EngraveSetupsSection({ initiallyOpen = false }: { initiallyOpen?: boolean } = {}): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
  const setSetups = useEngraveJobStore((s) => s.setSetups);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const tools = useToolRegistry();

  const reading = useMemo(() => readSetups(job), [job]);
  const settings = useMemo(() => setupsSettings(defaults), [defaults]);
  const regSettings = useMemo(() => registrationSettings(defaults).settings, [defaults]);
  const rotaryEnvelope = useMemo(() => jobMachine(job, calibration).rotary?.envelope, [job, calibration]);
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
    ];
    for (const list of lists) {
      for (const item of list) map.set(item.id, item.name ?? item.text ?? item.id);
    }
    // #435 — a primitive has no text; its label is its name, else its shape and size.
    for (const primitive of job.primitives ?? []) {
      map.set(primitive.id, primitive.name ?? primitiveLabel(primitive));
    }
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
    const mount = base[0]?.mount ?? { kind: job.workholding.kind };
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
          <span>Surface tolerance</span>
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
          The engine’s fresh suggestion — its grouping wins over the saved list only when you press Use this
          plan.
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
              viseSource={job.workholding.vise.source}
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
              planRegistration={(seatZ) => {
                const derived = derivedFor(setup, index);
                if (!derived) return { kind: 'refused', reason: 'this setup has no cut item to register from yet' };
                return planRegistrationAttempt({
                  job,
                  setup: derived,
                  mount: setup.mount,
                  seatZ,
                  defaults,
                  calibration,
                  settings: regSettings,
                });
              }}
            />
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
          onClose={() => setRemount(null)}
          onMounted={storeRemount}
        />
      )}
    </section>
  );
}
