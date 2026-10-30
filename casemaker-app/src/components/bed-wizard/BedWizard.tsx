/**
 * #512 — the first-run bed wizard, S0 → S6 (`docs/design/bed-profiles.md` §3).
 *
 * ONE STEP, ONE ANSWER. S0 reads the machine back; S1 picks a shipped template; S2 the surface;
 * S3 what is on the bed; S4 how each stock class is held; S5 consumables; S6 reviews and saves. Every
 * step is skippable, and every answer made before a skip is kept exactly as it was.
 *
 * NO MACHINE MOVES, EVER (the rule this slice is built under). The wizard writes the location and
 * nothing else: there is no probe path, no `$H`, no g-code. The measurement rows say, in place, that
 * the number is not measured and where it is measured later (the Bed block's registration and mount
 * tap). A number that has no measurement stays `null` — a datum is measured, never typed.
 *
 * INFORM, DON'T REFUSE. Choosing the 4th-axis module with the vise already on the pins does not grey
 * the choice out: S3 states the shared pins and offers the one action that resolves it, and S6
 * refuses only the profile that still contradicts — with that same sentence.
 *
 * THE DRAFT RESUMES. It is kept per machine (`localStorage`, versioned), so a closed window is not
 * half an hour of answers lost; a draft that will not read back is dropped rather than half-applied.
 */

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { newId } from '@/utils/id';
import type { BedProfile, FixtureRecord, MachineRecord } from '@/platform/locationClient';
import { useLocationStore, saveMachineWithRetry } from '@/store/locationStore';
import { useBedWizardStore } from '@/store/bedWizardStore';
import {
  BED_WIZARD_STEPS,
  addPlacement,
  answerConsumables,
  answerMountings,
  answerName,
  answerPlacements,
  answerSurface,
  applyTemplate,
  bedDraftStorageKey,
  bedWizardDraft,
  draftFromJson,
  draftToJson,
  finalizeDraft,
  goToStep,
  placementConflict,
  provenanceTally,
  resolveConflict,
  skipStep,
  unmeasuredList,
  type BedWizardDraft,
  type DraftPlacement,
  type ProvenanceTally,
} from '@/platform/bedWizard';
import {
  ALL_TEMPLATES,
  STANDARD_MOUNTINGS,
  type BedTemplate,
  type MountManner,
  type TemplateFixture,
  type TemplatePlacement,
} from '@/platform/bedTemplates';
import './bedWizard.css';

const MANNERS: readonly MountManner[] = ['jaws', 'corner+clamps', 'tape', 'vacuum', 'chuck'];

const MANNER_WORDS: Record<MountManner, string> = {
  jaws: 'in the jaws',
  'corner+clamps': 'corner + clamps',
  tape: 'taped down',
  vacuum: 'vacuum',
  chuck: 'in the chuck',
};

const SURFACE_KINDS: readonly BedProfile['surface']['kind'][] = [
  'bare-bed',
  'wasteboard',
  'fixture-plate',
  'vacuum-bed',
];

const SURFACE_WORDS: Record<BedProfile['surface']['kind'], string> = {
  'bare-bed': 'bare bed',
  wasteboard: 'wasteboard',
  'fixture-plate': 'fixture plate',
  'vacuum-bed': 'vacuum bed',
};

/** A positive number, or null for an empty/invalid field (the schema refuses <= 0). */
function positive(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const numText = (n: number | null): string => (n === null ? '' : String(n));

/** A surface of a new kind: the bare bed carries nothing (open question E); a wasteboard states a
 *  thickness, the shipped 2 mm labelled as the default it is. */
function surfaceWithKind(surface: BedProfile['surface'], kind: BedProfile['surface']['kind']): BedProfile['surface'] {
  if (kind === 'bare-bed') {
    return { kind, material: null, length: null, width: null, thickness: null, position: null, provenance: {}, scars: [], lastResurfacedAt: null };
  }
  const next: BedProfile['surface'] = { ...surface, kind, scars: [], lastResurfacedAt: null };
  if (kind === 'wasteboard' && next.thickness === null) {
    next.thickness = 2;
    next.provenance = { ...next.provenance, thickness: 'default' };
  }
  return next;
}

function fixtureWords(fixture: TemplateFixture): string {
  switch (fixture.kind) {
    case 'vise':
      return 'Low-profile vise';
    case 'rotary-module':
      return '4th-axis module';
    case 'bracket':
      return `Bracket (${fixture.variant ?? 'thin'})`;
    case 'top-clamp':
      return 'Top clamps';
    default:
      return fixture.kind;
  }
}

function whereWords(where: TemplatePlacement['where']): string {
  if (where.kind === 'pins') return where.pins === 'vise' ? 'on the vise pins' : 'on the rotary pins';
  if (where.kind === 'anchor') return `at anchor ${where.anchor}`;
  return 'free on the surface';
}

function surfaceWords(surface: BedProfile['surface']): string {
  if (surface.kind === 'bare-bed') return 'bare bed';
  const bits = [SURFACE_WORDS[surface.kind]];
  if (surface.material !== null) bits.push(surface.material);
  if (surface.length !== null && surface.width !== null) bits.push(`${surface.length} × ${surface.width}`);
  if (surface.thickness !== null) bits.push(`${surface.thickness} mm`);
  return bits.join(', ');
}

/** The datums each fixture makes measurable on the bed, in the Bed block's words. */
const FIXTURE_DATUMS: Record<string, { key: string; words: string }> = {
  vise: { key: 'viseJawTopZ', words: 'the jaw top' },
  bracket: { key: 'bracketSeatZ', words: 'the bracket seat' },
  'rotary-module': { key: 'rotaryAxis', words: 'the rotary axis' },
};

function Step({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: 'done' | 'current' | 'later';
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="bw-step" data-state={state} data-testid={`bed-wizard-step-${n}`}>
      <span className="bw-marker" aria-hidden="true">
        {state === 'done' ? '✓' : `S${n}`}
      </span>
      <div className="bw-text">
        <b>
          S{n} · {title}
        </b>
        {children}
      </div>
    </section>
  );
}

function MeasureRow({ datum, words }: { datum: string; words: string }): JSX.Element {
  return (
    <p className="bw-measure" data-testid={`bed-wizard-measure-${datum}`}>
      {words}: <b>not measured</b> — this wizard does not move the machine. Measure it later from
      Manage › Machines › Bed.
    </p>
  );
}

function Tally({ tally }: { tally: ProvenanceTally }): JSX.Element {
  return (
    <span className="bw-meta" data-testid="bed-wizard-provenance">
      where the numbers come from: measured {tally.measured} · vendor {tally.vendor} · default{' '}
      {tally.default} · typed {tally.typed} · unmeasured {tally.unmeasured}
    </span>
  );
}

export function BedWizard(): JSX.Element | null {
  const open = useBedWizardStore((s) => s.open);
  const machineId = useBedWizardStore((s) => s.machineId);
  const session = useBedWizardStore((s) => s.session);
  const close = useBedWizardStore((s) => s.close);
  if (!open || machineId === null) return null;
  return <Wizard key={`${machineId}:${session}`} machineId={machineId} onClose={close} />;
}

function Wizard({ machineId, onClose }: { machineId: string; onClose: () => void }): JSX.Element {
  const machine = useLocationStore((s) => s.location?.machines.find((m) => m.id === machineId) ?? null);
  const accessories = useLocationStore((s) => s.location?.accessories ?? []);

  const [draft, setDraft] = useState<BedWizardDraft>(() => {
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(bedDraftStorageKey(machineId));
      const stored = raw === null ? null : draftFromJson(raw);
      if (stored !== null && stored.machineId === machineId) return stored;
    } catch {
      // storage blocked: start fresh
    }
    return bedWizardDraft(machineId);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The draft is kept as it is answered; a saved draft is NOT written back (the key was removed on
  // save, and a re-render must not resurrect it).
  useEffect(() => {
    if (saved !== null) return;
    try {
      localStorage.setItem(bedDraftStorageKey(machineId), draftToJson(draft));
    } catch {
      // Storage full or blocked: the wizard still works for this session.
    }
  }, [draft, machineId, saved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const step = draft.step;
  const heldFixtures = accessories.filter(
    (a): a is FixtureRecord => a.whereabouts.kind === 'machine' && a.whereabouts.machineId === machineId,
  );

  const conflict = placementConflict(draft.placements);
  const nameMissing = draft.name.trim() === '';
  // The review is the save's own computation, run early: what S6 shows is exactly what Save writes
  // (ids aside), including the provenance tally and the "to measure" list. A bed with no name yet is
  // previewed under a placeholder, so the review does not claim "nothing to measure" merely because
  // the name is the one answer still missing; the name has its own refusal and its own gate.
  const preview =
    machine === null
      ? null
      : finalizeDraft(nameMissing ? { ...draft, name: 'the bed' } : draft, {
          now: new Date().toISOString(),
          id: 'preview',
          existing: heldFixtures,
        });
  const previewFixtures =
    preview !== null && preview.ok ? [...heldFixtures, ...preview.bed.accessories] : heldFixtures;

  const update = (next: BedWizardDraft): void => {
    setDraft(next);
    setError(null);
  };

  const next = (): void => {
    if (step < BED_WIZARD_STEPS.length - 1) update(goToStep(draft, step + 1));
  };
  const back = (): void => {
    if (step > 0) update(goToStep(draft, step - 1));
  };
  const skip = (): void => {
    update(skipStep(draft, step));
  };

  async function save(): Promise<void> {
    if (machine === null) return;
    setSaving(true);
    setError(null);
    const at = new Date().toISOString();
    const live = useLocationStore.getState().location?.machines.find((m) => m.id === machineId) ?? machine;
    const heldNow = useLocationStore
      .getState()
      .location?.accessories?.filter((a) => a.whereabouts.kind === 'machine' && a.whereabouts.machineId === machineId) ?? heldFixtures;
    const result = finalizeDraft(draft, { now: at, id: newId('bp'), existing: heldNow });
    if (!result.ok) {
      setError(result.reason);
      setSaving(false);
      return;
    }
    // Fixtures FIRST: a profile may only name accessory records the location owns.
    for (const record of result.bed.accessories) {
      let outcome = await useLocationStore.getState().saveAccessory(record);
      if (outcome === 'stale') outcome = await useLocationStore.getState().saveAccessory(record);
      if (outcome !== 'ok') {
        setError(
          `The ${record.kind} record was not saved — ${useLocationStore.getState().accessoryNote ?? 'the service refused it'}. Nothing else was written.`,
        );
        setSaving(false);
        return;
      }
    }
    const fresh = (): MachineRecord =>
      useLocationStore.getState().location?.machines.find((m) => m.id === machineId) ?? live;
    const outcome = await saveMachineWithRetry(fresh(), (current) => {
      if (current.bedProfiles?.some((p) => p.id === result.bed.profile.id)) return current;
      return {
        ...current,
        bedProfiles: [...(current.bedProfiles ?? []), result.bed.profile],
        activeBedProfileId: result.bed.profile.id,
        updatedAt: at,
      };
    });
    if (outcome !== 'ok') {
      setError(
        `The bed was not saved — ${useLocationStore.getState().writeNote ?? (outcome === 'stale' ? 'the machine changed again while it was being written' : 'the service refused it')}.`,
      );
      setSaving(false);
      return;
    }
    try {
      localStorage.removeItem(bedDraftStorageKey(machineId));
    } catch {
      // nothing stored
    }
    setSaved(result.bed.profile.name);
    setSaving(false);
  }

  const body = (): ReactNode => {
    switch (step) {
      // ── S0 · Your machine ─────────────────────────────────────────────────────────────────────
      case 0:
        return machine === undefined || machine === null ? (
          <span className="bw-note" data-testid="bed-wizard-no-machine">
            The machine is no longer in the location. Close this and open Manage › Machines again.
          </span>
        ) : (
          <>
            <span className="bw-meta" data-testid="bed-wizard-machine">
              {machine.nickname ?? machine.profileId ?? machine.id}
              {machine.name !== null && machine.name !== (machine.nickname ?? machine.profileId) ? ` · ${machine.name}` : ''}
            </span>
            <span className="bw-meta" data-testid="bed-wizard-machine-address">
              address: {machine.address === null ? 'not set yet' : `${machine.address.host} : ${machine.address.port}`}
            </span>
            <span className="bw-meta" data-testid="bed-wizard-machine-serial">
              serial {machine.serial ?? 'not read yet'} · firmware {machine.firmware ?? 'not read yet'}
            </span>
            <span className="bw-meta" data-testid="bed-wizard-machine-bed">
              bed: {machine.bedProfiles === undefined ? 'not described yet' : `${machine.bedProfiles.length} profile${machine.bedProfiles.length === 1 ? '' : 's'}`}
            </span>
            <span className="bw-hint">
              Nothing on this step changes the machine. The wizard writes the location's description of the bed.
            </span>
          </>
        );

      // ── S1 · Start from ────────────────────────────────────────────────────────────────────────
      case 1: {
        const selected = ALL_TEMPLATES.find((t) => t.id === draft.templateId) ?? null;
        return (
          <>
            <span className="bw-hint">A shipped bed, or empty and describe it yourself. Nothing is saved until S6.</span>
            <div className="bw-radios" data-testid="bed-wizard-templates">
              {ALL_TEMPLATES.map((t: BedTemplate) => (
                <label key={t.id} className="bw-radio" data-selected={selected?.id === t.id}>
                  <input
                    type="radio"
                    name="bed-template"
                    checked={selected?.id === t.id}
                    data-testid={`bed-wizard-template-${t.id}`}
                    onChange={() => update(applyTemplate(draft, t))}
                  />
                  <span>
                    <b>{t.name}</b>
                    <span className="bw-hint"> — {t.words}</span>
                  </span>
                </label>
              ))}
            </div>
            {selected !== null ? (
              <span className="bw-meta" data-testid="bed-wizard-template-words">
                {selected.name}: {selected.words}
              </span>
            ) : null}
            {selected !== null && selected.toMeasure.length > 0 ? (
              <span className="bw-meta" data-testid="bed-wizard-to-measure">
                to measure later: {selected.toMeasure.join(', ')}
              </span>
            ) : null}
          </>
        );
      }

      // ── S2 · The surface ──────────────────────────────────────────────────────────────────────
      case 2: {
        const s = draft.surface;
        return (
          <>
            <label className="bw-field">
              <span>surface</span>
              <select
                className="fld"
                aria-label="Surface kind"
                data-testid="bed-wizard-surface-kind"
                value={s.kind}
                onChange={(e) => update(answerSurface(draft, surfaceWithKind(s, e.target.value as BedProfile['surface']['kind'])))}
              >
                {SURFACE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SURFACE_WORDS[k]}
                  </option>
                ))}
              </select>
            </label>
            {s.kind !== 'bare-bed' ? (
              <div className="bw-fields" data-testid="bed-wizard-surface-fields">
                <label className="bw-field">
                  <span>material</span>
                  <input
                    className="fld fld--text"
                    type="text"
                    aria-label="Surface material"
                    data-testid="bed-wizard-surface-material"
                    value={s.material ?? ''}
                    onChange={(e) => {
                      const value = e.target.value.trim() === '' ? null : e.target.value;
                      const provenance = { ...s.provenance };
                      if (value === null) delete provenance.material;
                      else provenance.material = 'typed';
                      update(answerSurface(draft, { ...s, material: value, provenance }));
                    }}
                  />
                </label>
                <label className="bw-field">
                  <span>length mm</span>
                  <input
                    className="fld"
                    type="number"
                    aria-label="Surface length"
                    data-testid="bed-wizard-surface-length"
                    value={numText(s.length)}
                    onChange={(e) => {
                      const value = positive(e.target.value);
                      const provenance = { ...s.provenance };
                      if (value === null) delete provenance.length;
                      else provenance.length = 'typed';
                      update(answerSurface(draft, { ...s, length: value, provenance }));
                    }}
                  />
                </label>
                <label className="bw-field">
                  <span>width mm</span>
                  <input
                    className="fld"
                    type="number"
                    aria-label="Surface width"
                    data-testid="bed-wizard-surface-width"
                    value={numText(s.width)}
                    onChange={(e) => {
                      const value = positive(e.target.value);
                      const provenance = { ...s.provenance };
                      if (value === null) delete provenance.width;
                      else provenance.width = 'typed';
                      update(answerSurface(draft, { ...s, width: value, provenance }));
                    }}
                  />
                </label>
                <label className="bw-field">
                  <span>thickness mm{s.kind === 'wasteboard' ? ' (a wasteboard states it)' : ''}</span>
                  <input
                    className="fld"
                    type="number"
                    aria-label="Surface thickness"
                    data-testid="bed-wizard-surface-thickness"
                    value={numText(s.thickness)}
                    onChange={(e) => {
                      const value = positive(e.target.value);
                      const provenance = { ...s.provenance };
                      if (value === null) delete provenance.thickness;
                      else provenance.thickness = 'typed';
                      update(answerSurface(draft, { ...s, thickness: value, provenance }));
                    }}
                  />
                </label>
              </div>
            ) : (
              <span className="bw-meta" data-testid="bed-wizard-surface-bare">
                the bare bed has no size, material or position — it is the machine's own table
              </span>
            )}
            <span className="bw-meta">where the surface sits is measured later, with the surface registration.</span>
            <MeasureRow datum="surfaceTopZ" words="the surface top" />
          </>
        );
      }

      // ── S3 · What is on the bed ───────────────────────────────────────────────────────────────
      case 3: {
        const hasKind = (kind: string): boolean => draft.placements.some((p) => p.fixture.kind === kind);
        const datumRows = new Map<string, string>();
        for (const placement of draft.placements) {
          const row = FIXTURE_DATUMS[placement.fixture.kind];
          if (row !== undefined) datumRows.set(row.key, row.words);
        }
        return (
          <>
            <span className="bw-hint">The fixtures physically on the bed right now. Each is registered with its own record at S6.</span>
            {draft.placements.length === 0 ? (
              <span className="bw-meta" data-testid="bed-wizard-placements-empty">
                nothing on the bed
              </span>
            ) : (
              <ul className="bw-list" data-testid="bed-wizard-placements">
                {draft.placements.map((p) => (
                  <li key={p.key} data-testid={`bed-wizard-placement-${p.key}`}>
                    <span>
                      {fixtureWords(p.fixture)} {whereWords(p.where)}
                      {p.count !== null ? ` ×${p.count}` : ''}
                    </span>
                    <button
                      type="button"
                      className="bw-btn"
                      data-testid={`bed-wizard-remove-${p.key}`}
                      onClick={() => update(answerPlacements(draft, draft.placements.filter((x) => x.key !== p.key)))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="bw-btns" data-testid="bed-wizard-add">
              <button type="button" className="bw-btn" data-testid="bed-wizard-add-vise" disabled={hasKind('vise')} onClick={() => update(addPlacement(draft, 'vise'))}>
                Put the low-profile vise on its pins
              </button>
              <button
                type="button"
                className="bw-btn"
                data-testid="bed-wizard-add-rotary-module"
                disabled={hasKind('rotary-module')}
                onClick={() => update(addPlacement(draft, 'rotary-module'))}
              >
                Fit the 4th-axis module
              </button>
              <button type="button" className="bw-btn" data-testid="bed-wizard-add-bracket-thin" disabled={hasKind('bracket')} onClick={() => update(addPlacement(draft, 'bracket-thin'))}>
                Place the L-bracket
              </button>
              <button type="button" className="bw-btn" data-testid="bed-wizard-add-top-clamp" disabled={hasKind('top-clamp')} onClick={() => update(addPlacement(draft, 'top-clamp'))}>
                Add two top clamps
              </button>
            </div>
            {conflict !== null ? (
              <div className="bw-conflict" role="status" data-testid="bed-wizard-conflict">
                <b>{conflict.sentence}</b>{' '}
                <span>{conflict.fix}</span>
                <span className="bw-btns">
                  {conflict.keys.map((key) => {
                    const p = draft.placements.find((x) => x.key === key);
                    if (p === undefined) return null;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="bw-btn bw-btn--primary"
                        data-testid={`bed-wizard-conflict-fix-${key}`}
                        onClick={() => update(resolveConflict(draft, key))}
                      >
                        Remove {fixtureWords(p.fixture).toLowerCase()}
                      </button>
                    );
                  })}
                </span>
              </div>
            ) : null}
            {[...datumRows].map(([key, words]) => (
              <MeasureRow key={key} datum={key} words={words} />
            ))}
          </>
        );
      }

      // ── S4 · How you hold stock ───────────────────────────────────────────────────────────────
      case 4:
        return (
          <>
            <span className="bw-hint">
              For each kind of stock, how this shop holds it on this bed. These are the design's
              defaults; every row can be changed.
            </span>
            {draft.mountings.length === 0 ? (
              <button
                type="button"
                className="bw-btn"
                data-testid="bed-wizard-mount-defaults"
                onClick={() => update(answerMountings(draft, STANDARD_MOUNTINGS))}
              >
                Use the standard stock classes
              </button>
            ) : (
              <ol className="bw-list" data-testid="bed-wizard-mountings">
                {draft.mountings.map((m, i) => (
                  <li key={`${m.stock}:${i}`} data-testid={`bed-wizard-mount-${i}`}>
                    <span className="bw-mono">{m.stock}</span>
                    <select
                      className="fld"
                      aria-label={`How ${m.stock} is held`}
                      data-testid={`bed-wizard-mount-manner-${i}`}
                      value={m.manner}
                      onChange={(e) => {
                        const manner = e.target.value as MountManner;
                        update(answerMountings(draft, draft.mountings.map((x, j) => (j === i ? { ...x, manner } : x))));
                      }}
                    >
                      {MANNERS.map((k) => (
                        <option key={k} value={k}>
                          {MANNER_WORDS[k]}
                        </option>
                      ))}
                    </select>
                    <select
                      className="fld"
                      aria-label={`What holds ${m.stock}`}
                      data-testid={`bed-wizard-mount-placement-${i}`}
                      value={m.placementKey ?? ''}
                      onChange={(e) => {
                        const placementKey = e.target.value === '' ? null : e.target.value;
                        update(answerMountings(draft, draft.mountings.map((x, j) => (j === i ? { ...x, placementKey } : x))));
                      }}
                    >
                      <option value="">on the surface</option>
                      {draft.placements.map((p) => (
                        <option key={p.key} value={p.key}>
                          {fixtureWords(p.fixture)}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ol>
            )}
          </>
        );

      // ── S5 · Consumables ──────────────────────────────────────────────────────────────────────
      case 5: {
        const consumables = draft.consumables ?? { tape: null, boards: [] };
        return (
          <>
            <span className="bw-hint">What the bed has on hand: tape, and boards thick enough to cut through onto.</span>
            {consumables.tape === null ? (
              <button
                type="button"
                className="bw-btn"
                data-testid="bed-wizard-tape-add"
                onClick={() => update(answerConsumables(draft, { ...consumables, tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'default' } }))}
              >
                State a tape
              </button>
            ) : (
              <div className="bw-fields" data-testid="bed-wizard-tape">
                <label className="bw-field">
                  <span>tape width mm</span>
                  <input
                    className="fld"
                    type="number"
                    aria-label="Tape width"
                    data-testid="bed-wizard-tape-width"
                    value={numText(consumables.tape.widthMm)}
                    onChange={(e) =>
                      update(
                        answerConsumables(draft, {
                          ...consumables,
                          tape: { ...consumables.tape!, widthMm: positive(e.target.value) ?? consumables.tape!.widthMm, provenance: 'typed' },
                        }),
                      )
                    }
                  />
                </label>
                <label className="bw-field">
                  <span>tape thickness mm</span>
                  <input
                    className="fld"
                    type="number"
                    aria-label="Tape thickness"
                    data-testid="bed-wizard-tape-thickness"
                    value={numText(consumables.tape.thicknessMm)}
                    onChange={(e) =>
                      update(
                        answerConsumables(draft, {
                          ...consumables,
                          tape: { ...consumables.tape!, thicknessMm: positive(e.target.value) ?? consumables.tape!.thicknessMm, provenance: 'typed' },
                        }),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="bw-btn"
                  data-testid="bed-wizard-tape-none"
                  onClick={() => update(answerConsumables(draft, { ...consumables, tape: null }))}
                >
                  No tape
                </button>
              </div>
            )}
            {consumables.boards.length === 0 ? (
              <span className="bw-meta" data-testid="bed-wizard-boards-empty">
                no boards on hand
              </span>
            ) : (
              <ul className="bw-list" data-testid="bed-wizard-boards">
                {consumables.boards.map((b, i) => (
                  <li key={`${b.material}:${i}`} data-testid={`bed-wizard-board-${i}`}>
                    <span>
                      {b.material} {b.size[0]} × {b.size[1]} × {b.size[2]} mm ×{b.count}
                    </span>
                    <button
                      type="button"
                      className="bw-btn"
                      data-testid={`bed-wizard-board-remove-${i}`}
                      onClick={() =>
                        update(answerConsumables(draft, { ...consumables, boards: consumables.boards.filter((_, j) => j !== i) }))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="bw-btn"
              data-testid="bed-wizard-board-add"
              onClick={() =>
                update(answerConsumables(draft, { ...consumables, boards: [...consumables.boards, { material: 'MDF', size: [200, 200, 2], count: 1 }] }))
              }
            >
              Add a 2 mm MDF board
            </button>
          </>
        );
      }

      // ── S6 · Review and save ─────────────────────────────────────────────────────────────────
      default: {
        const checked = preview;
        const tally = checked !== null && checked.ok ? provenanceTally(checked.bed.profile, previewFixtures) : null;
        const toMeasure = checked !== null && checked.ok ? unmeasuredList(checked.bed.profile, previewFixtures) : [];
        const skippedWords = draft.skipped
          .filter((n) => n >= 1 && n <= 5)
          .map((n) => `${BED_WIZARD_STEPS[n] ?? `S${n}`} (S${n})`)
          .join(', ');
        return (
          <>
            {saved !== null ? (
              <span className="bw-meta" data-testid="bed-wizard-saved">
                Saved “{saved}” and made it the machine's active bed.
              </span>
            ) : (
              <>
                <label className="bw-field">
                  <span>name the bed</span>
                  <input
                    className="fld fld--text"
                    type="text"
                    aria-label="Bed name"
                    data-testid="bed-wizard-name"
                    value={draft.name}
                    onChange={(e) => update(answerName(draft, e.target.value))}
                  />
                </label>
                <span className="bw-meta" data-testid="bed-wizard-review-surface">
                  surface: {surfaceWords(draft.surface)}
                </span>
                <span className="bw-meta" data-testid="bed-wizard-review-placements">
                  on the bed:{' '}
                  {draft.placements.length === 0
                    ? 'nothing'
                    : draft.placements.map((p: DraftPlacement) => `${fixtureWords(p.fixture)} ${whereWords(p.where)}`).join(' · ')}
                </span>
                <span className="bw-meta" data-testid="bed-wizard-review-mountings">
                  holding: {draft.mountings.length === 0 ? 'nothing stated' : draft.mountings.map((m) => `${m.stock} ${MANNER_WORDS[m.manner]}`).join(' · ')}
                </span>
                <span className="bw-meta" data-testid="bed-wizard-review-consumables">
                  consumables:{' '}
                  {draft.consumables === null
                    ? 'not stated'
                    : [
                        draft.consumables.tape === null ? null : `tape ${draft.consumables.tape.widthMm} × ${draft.consumables.tape.thicknessMm} mm`,
                        ...draft.consumables.boards.map((b) => `${b.material} ${b.size[0]} × ${b.size[1]} × ${b.size[2]} ×${b.count}`),
                      ]
                        .filter((x): x is string => x !== null)
                        .join(' · ') || 'not stated'}
                </span>
                {tally !== null ? <Tally tally={tally} /> : null}
                <span className="bw-meta" data-testid="bed-wizard-unmeasured">
                  to measure later: {toMeasure.length === 0 ? 'nothing' : toMeasure.join(', ')}
                </span>
                {skippedWords !== '' ? (
                  <span className="bw-meta" data-testid="bed-wizard-skipped">
                    skipped: {skippedWords}
                  </span>
                ) : null}
                <span className="bw-hint">
                  Saving writes the location only: one new bed profile, made active, and a record for
                  each fixture on it. No measurement is invented, and the machine is not moved.
                </span>
                {nameMissing ? (
                  <p className="bw-note" data-testid="bed-wizard-name-needed">
                    give the bed a name before saving it
                  </p>
                ) : null}
                {checked !== null && !checked.ok ? (
                  <p className="bw-note" data-testid="bed-wizard-refusal">
                    {checked.reason}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="bw-btn bw-btn--primary"
                  data-testid="bed-wizard-save"
                  disabled={saving || nameMissing || checked === null || !checked.ok}
                  onClick={() => void save()}
                >
                  {saving ? 'Writing the bed…' : 'Save this bed'}
                </button>
              </>
            )}
            {error !== null ? (
              <p className="bw-note" data-testid="bed-wizard-error">
                {error}
              </p>
            ) : null}
          </>
        );
      }
    }
  };

  const done = saved !== null;
  const stateOf = (n: number): 'done' | 'current' | 'later' => {
    if (done) return 'done';
    if (n < step) return 'done';
    if (n === step) return 'current';
    return 'later';
  };

  return createPortal(
    <div className="bw-backdrop" data-testid="bed-wizard-backdrop">
      <div className="bw-modal" role="dialog" aria-modal="true" aria-labelledby="bed-wizard-title" data-testid="bed-wizard">
        <header className="bw-head">
          <span className="bw-eyebrow">First-run bed setup</span>
          <h3 id="bed-wizard-title" data-testid="bed-wizard-title">
            Set up the bed — S{step} · {BED_WIZARD_STEPS[step]}
          </h3>
          <button type="button" className="bw-close" aria-label="Close" data-testid="bed-wizard-close" disabled={saving} onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="bw-body">
          <p className="bw-no-moves" data-testid="bed-wizard-no-moves">
            This wizard only writes the bed's description. It never moves the machine; measurements are
            taken later from Manage › Machines › Bed.
          </p>
          {BED_WIZARD_STEPS.map((title, n) => (
            <Step key={title} n={n} title={title} state={stateOf(n)}>
              {n === step ? body() : n === 0 && machine !== null ? (
                <span className="bw-meta">
                  {machine.nickname ?? machine.profileId ?? machine.id}
                  {machine.address !== null ? ` · ${machine.address.host}:${machine.address.port}` : ''}
                </span>
              ) : n === 1 && draft.templateId !== null ? (
                <span className="bw-meta">{ALL_TEMPLATES.find((t) => t.id === draft.templateId)?.name ?? draft.templateId}</span>
              ) : n === 2 ? (
                <span className="bw-meta">{surfaceWords(draft.surface)}</span>
              ) : n === 3 ? (
                <span className="bw-meta">{draft.placements.length === 0 ? 'nothing on the bed' : `${draft.placements.length} fixture${draft.placements.length === 1 ? '' : 's'} on the bed`}</span>
              ) : n === 4 ? (
                <span className="bw-meta">{draft.mountings.length === 0 ? 'nothing stated' : `${draft.mountings.length} stock classes`}</span>
              ) : n === 5 ? (
                <span className="bw-meta">
                  {draft.consumables === null ? 'not stated' : [draft.consumables.tape === null ? null : 'tape', draft.consumables.boards.length === 0 ? null : `${draft.consumables.boards.length} board${draft.consumables.boards.length === 1 ? '' : 's'}`].filter((x): x is string => x !== null).join(' · ') || 'not stated'}
                </span>
              ) : n === 6 ? null : null}
            </Step>
          ))}
        </div>
        <footer className="bw-foot">
          <button type="button" className="bw-btn" data-testid="bed-wizard-back" disabled={step === 0 || saving || done} onClick={back}>
            ← Back
          </button>
          {/* Every step but S0 and S6 can be skipped; the measurement rows are what skipping leaves
              unmeasured, and S6 lists exactly those. */}
          {step >= 1 && step <= 5 && !done ? (
            <button type="button" className="bw-btn" data-testid="bed-wizard-skip" disabled={saving} onClick={skip}>
              Skip this step
            </button>
          ) : null}
          {step < BED_WIZARD_STEPS.length - 1 && !done ? (
            <button type="button" className="bw-btn bw-btn--primary" data-testid="bed-wizard-next" disabled={saving} onClick={next}>
              Next →
            </button>
          ) : null}
          <button type="button" className="bw-btn" data-testid="bed-wizard-done" disabled={saving || !done} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
