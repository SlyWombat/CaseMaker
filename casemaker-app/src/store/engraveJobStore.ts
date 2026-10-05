import { create } from 'zustand';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { defaultEngraveJob, newEngraveLabelId, newEngraveShapeId } from '@/engine/cnc/engrave/defaults';
import { todayISODate, viseForNewJob } from '@/engine/cnc/fixture';
import { sacrificialForNewJob } from '@/engine/cnc/sacrificial';
import { applyAnswers, type SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import type { CutParams } from '@/engine/cnc/feeds';
import type {
  EngraveBorderShape,
  EngraveCircleShape,
  EngraveCombinedShape,
  EngraveCutawayShape,
  EngraveFrameShape,
  EngraveJob,
  EngraveJobSources,
  EngraveLabel,
  EngravePolygonShape,
  EngraveRectShape,
  EngraveShape,
  EngraveShapeBase,
  EngraveSlotShape,
  FieldSource,
  Sacrificial,
  ViseParams,
} from '@/types/engraveJob';
import { parseEngraveJob, type ParseEngraveJobResult } from './engraveJobSchema';
import { useSettingsStore } from './settingsStore';

/**
 * The `EngraveJob` store (#200). Persists to localStorage on every change, hydrates through
 * `parseEngraveJob` on load, and never silently loses a payload it could not parse.
 *
 * The persistence is the plain `persist()` helper pattern of `settingsStore.ts` — a function
 * that writes, not the zustand `persist` middleware — so the store's public shape stays the
 * explicit `job` field the rest of the CNC-2 work reads.
 */

/**
 * A hand edit to one shape (#214). Every field is optional and every kind's fields are
 * present, so a row editor can patch just what it changed without naming the discriminant;
 * the shape's `kind` is never patched (a circle does not become a rect in place — remove and
 * re-add instead).
 */
export type ShapePatch = Partial<Omit<EngraveRectShape, 'kind'>> &
  Partial<Omit<EngraveCircleShape, 'kind'>> &
  Partial<Omit<EngraveSlotShape, 'kind'>> &
  Partial<Omit<EngravePolygonShape, 'kind'>>;

/**
 * A hand edit to one combined item (#215). The same shape as `ShapePatch`: every field optional
 * and every kind's fields present, so a row can patch just what it changed without naming the
 * discriminant; the `kind` is never patched (remove and re-add instead).
 */
export type CombinedPatch = Partial<Omit<EngraveBorderShape, 'kind'>> &
  Partial<Omit<EngraveFrameShape, 'kind'>> &
  Partial<Omit<EngraveCutawayShape, 'kind'>>;

export const ENGRAVE_JOB_KEY = 'casemaker.engraveJob.v1';
/** Where a payload that failed validation is parked so it is not silently lost. */
export const ENGRAVE_JOB_REJECTED_KEY = `${ENGRAVE_JOB_KEY}.rejected`;

function persist(job: EngraveJob): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ENGRAVE_JOB_KEY, JSON.stringify(job));
  } catch {
    // ignore quota / private-mode errors
  }
}

/**
 * A brand-new job, with its vise and its sacrificial setup taken from the saved setup in
 * settings when one exists (#203/#213, decision 28). The reading of `settings.fixtures`
 * happens HERE, in the store, so `defaultEngraveJob` stays a pure function of its argument.
 */
function newDefaultJob(): EngraveJob {
  const { fixtures } = useSettingsStore.getState();
  const job = defaultEngraveJob(viseForNewJob(fixtures.vise));
  return { ...job, sacrificial: sacrificialForNewJob(fixtures.sacrificial) };
}

function loadJob(): EngraveJob {
  if (typeof localStorage === 'undefined') return newDefaultJob();
  let raw: string | null;
  try {
    raw = localStorage.getItem(ENGRAVE_JOB_KEY);
  } catch {
    return newDefaultJob();
  }
  if (!raw) return newDefaultJob();

  let json: unknown;
  let parsed: ParseEngraveJobResult;
  try {
    json = JSON.parse(raw);
    parsed = parseEngraveJob(json);
  } catch {
    parsed = { ok: false, errors: ['stored payload is not valid JSON'] };
  }
  if (parsed.ok) return parsed.job;

  // Fall back to the default, but keep the bad payload under `.rejected` so a hand-edited
  // file or a newer-minor job is recoverable rather than gone.
  try {
    localStorage.setItem(ENGRAVE_JOB_REJECTED_KEY, raw);
  } catch {
    // ignore quota errors
  }
  return newDefaultJob();
}

function newLabel(job: EngraveJob): EngraveLabel {
  return {
    id: newEngraveLabelId(),
    text: 'New text',
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    size: 10,
    // Centre of the stock; the caller moves it. Depth must be > 0 or the schema rejects it.
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
}

/** The job with its feeds/speeds override removed entirely (#205), provenance included (#246). */
function withoutCutOverride(job: EngraveJob): EngraveJob {
  const next = { ...job };
  delete next.cutOverride;
  if (next.sources) {
    const { cut: _cut, ...rest } = next.sources;
    if (Object.keys(rest).length > 0) next.sources = rest;
    else delete next.sources;
  }
  return next;
}

/** The job with a source stamped on each of `keys` in `sources.stock` (#254). */
function withStockSource(
  job: EngraveJob,
  keys: readonly (keyof EngraveJob['stock'])[],
  source: FieldSource,
): EngraveJobSources {
  const stock = { ...(job.sources?.stock ?? {}) };
  for (const key of keys) stock[key] = source;
  return { ...(job.sources ?? {}), stock };
}

/**
 * A default shape of the given kind (#214). Every dimension is valid against the schema
 * (positive, `cornerRadius ≤ min(w,h)/2`, slot `length ≥ width`, ≥ 3 polygon points) so a
 * freshly added item never lands the job in a state that cannot be reloaded. Centred on the
 * stock like a new label; the caller moves it.
 */
function newShape(kind: EngraveShape['kind'], job: EngraveJob): EngraveShape {
  const base: EngraveShapeBase = {
    id: newEngraveShapeId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
  switch (kind) {
    case 'rect':
      return { ...base, kind: 'rect', width: 20, height: 10, cornerRadius: 0 };
    case 'circle':
      return { ...base, kind: 'circle', diameter: 6 };
    case 'slot':
      return { ...base, kind: 'slot', length: 24, width: 8 };
    case 'polygon':
      // A small triangle at the centre; the row editor replaces the points.
      return { ...base, kind: 'polygon', points: [[-5, -5], [5, -5], [0, 5]] };
  }
}

/**
 * A default combined item of the given kind (#215), centred like a new shape; every number is
 * valid against the schema. A `frame`/`cutaway` names another item, so this returns null when
 * the job has nothing to reference — the panel disables that button rather than creating an
 * item whose reference the schema would reject on the next load.
 */
function newCombined(kind: EngraveCombinedShape['kind'], job: EngraveJob): EngraveCombinedShape | null {
  const base: EngraveShapeBase = {
    id: newEngraveShapeId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
  const first = [...job.labels, ...job.shapes, ...(job.combined ?? [])][0] ?? null;
  switch (kind) {
    case 'border':
      return { ...base, kind: 'border', inset: 3, width: 2 };
    case 'frame':
      return first ? { ...base, kind: 'frame', around: first.id, gap: 1, width: 2 } : null;
    case 'cutaway':
      return first ? { ...base, kind: 'cutaway', outer: first.id, islands: [] } : null;
  }
}

export interface EngraveJobState {
  job: EngraveJob;
  /** Merge a stock edit and stamp each edited field's source (#254). Defaults to `'user'`. */
  setStock: (patch: Partial<EngraveJob['stock']>, source?: FieldSource) => void;
  /** Add a default label and return its id. */
  addLabel: () => string;
  updateLabel: (id: string, patch: Partial<EngraveLabel>) => void;
  removeLabel: (id: string) => void;
  /** Set the cutter and stamp its source (#254). Defaults to `'user'`. */
  setTool: (key: string, source?: FieldSource) => void;
  setVise: (patch: Partial<ViseParams>) => void;
  /** Add a default shape of `kind` (#214) and return its id. */
  addShape: (kind: EngraveShape['kind']) => string;
  /** Merge a hand edit into one shape (#214). A partial `position` is merged, not replaced. */
  updateShape: (id: string, patch: ShapePatch) => void;
  removeShape: (id: string) => void;
  /**
   * Add a default combined item of `kind` (#215) and return its id, or null when the kind needs a
   * reference the job cannot supply (a frame or cut-away on an empty job).
   */
  addCombined: (kind: EngraveCombinedShape['kind']) => string | null;
  /** Merge a hand edit into one combined item (#215). A partial `position` is merged, not replaced. */
  updateCombined: (id: string, patch: CombinedPatch) => void;
  removeCombined: (id: string) => void;
  /**
   * Replace the sacrificial material model (#213). The caller owns `source`: the panel passes
   * `'saved'` for an edit it made, a preset carries its own, `noneSacrificial()` clears it.
   */
  setSacrificial: (sacrificial: Sacrificial) => void;
  /**
   * Merge a hand edit into the feeds/speeds override (#205). A key set to `undefined` clears
   * just that field back to the computed value; `null` clears the whole override. The source
   * (#246) defaults to `'user'` — the panel passes `'measured'` for a bench value.
   */
  setCutOverride: (patch: Partial<CutParams> | null, source?: FieldSource) => void;
  /**
   * Re-tag one existing override field's provenance (#246): the panel's "measured" toggle. Has
   * no effect on a field the job does not override — the source is the value's, not a label.
   */
  setCutOverrideSource: (key: keyof CutParams, source: FieldSource) => void;
  /** Apply a whole guided job setup in one write, stamping every value's source (#254). */
  applySetup: (answers: SetupAnswers) => void;
  replace: (job: EngraveJob) => void;
  reset: () => void;
}

export const useEngraveJobStore = create<EngraveJobState>()((set, get) => {
  const apply = (mutate: (job: EngraveJob) => EngraveJob): void => {
    set((s) => ({ job: mutate(s.job) }));
    persist(get().job);
  };

  return {
    job: loadJob(),

    setStock: (patch, source = 'user') =>
      apply((job) => {
        const keys = (Object.keys(patch) as (keyof EngraveJob['stock'])[]).filter(
          (k) => patch[k] !== undefined,
        );
        return { ...job, stock: { ...job.stock, ...patch }, sources: withStockSource(job, keys, source) };
      }),

    addLabel: () => {
      const label = newLabel(get().job);
      apply((job) => ({ ...job, labels: [...job.labels, label] }));
      return label.id;
    },

    updateLabel: (id, patch) =>
      apply((job) => ({
        ...job,
        labels: job.labels.map((l) =>
          l.id === id
            ? {
                ...l,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...l.position, ...patch.position } : l.position,
              }
            : l,
        ),
      })),

    removeLabel: (id) => apply((job) => ({ ...job, labels: job.labels.filter((l) => l.id !== id) })),

    setTool: (key, source = 'user') =>
      apply((job) => ({ ...job, toolKey: key, sources: { ...(job.sources ?? {}), tool: source } })),

    addShape: (kind) => {
      const shape = newShape(kind, get().job);
      apply((job) => ({ ...job, shapes: [...job.shapes, shape] }));
      return shape.id;
    },

    updateShape: (id, patch) =>
      apply((job) => ({
        ...job,
        shapes: job.shapes.map((shape) =>
          shape.id === id
            ? ({
                ...shape,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...shape.position, ...patch.position } : shape.position,
              } as EngraveShape)
            : shape,
        ),
      })),

    removeShape: (id) => apply((job) => ({ ...job, shapes: job.shapes.filter((s) => s.id !== id) })),

    addCombined: (kind) => {
      const item = newCombined(kind, get().job);
      if (!item) return null;
      apply((job) => ({ ...job, combined: [...(job.combined ?? []), item] }));
      return item.id;
    },

    updateCombined: (id, patch) =>
      apply((job) => ({
        ...job,
        combined: (job.combined ?? []).map((c) =>
          c.id === id
            ? ({
                ...c,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...c.position, ...patch.position } : c.position,
              } as EngraveCombinedShape)
            : c,
        ),
      })),

    removeCombined: (id) =>
      apply((job) => ({ ...job, combined: (job.combined ?? []).filter((c) => c.id !== id) })),

    setSacrificial: (sacrificial) => apply((job) => ({ ...job, sacrificial })),

    // Any edit to the vise makes it a SAVED value, unless the patch states its own source
    // (e.g. a re-probe writing `measured`). A default is not a measurement (decision 28).
    // A non-default value records the day it was asserted ("I just measured these", #203),
    // unless the patch already carries a date.
    setVise: (patch) =>
      apply((job) => {
        const source = patch.source ?? 'saved';
        const vise: ViseParams = {
          ...job.workholding.vise,
          ...patch,
          source,
          ...(source !== 'default' && !patch.measuredAt ? { measuredAt: todayISODate() } : {}),
        };
        return { ...job, workholding: { ...job.workholding, vise } };
      }),

    // #205: hand edits sit ON TOP of the computed values, field by field. `undefined` clears one
    // field; `null` clears the lot, so the panel can always get back to the table's values. The
    // per-field source (#246) travels with the value: setting one records where it came from,
    // clearing one drops its tag, so a computed field never keeps a stale "measured" label.
    setCutOverride: (patch, source = 'user') =>
      apply((job) => {
        if (patch === null) return withoutCutOverride(job);
        const cutOverride = { ...job.cutOverride, ...patch };
        const cut = { ...(job.sources?.cut ?? {}) };
        for (const key of Object.keys(patch) as (keyof CutParams)[]) {
          if (patch[key] === undefined) delete cut[key];
          else cut[key] = source;
        }
        return { ...job, cutOverride, sources: { ...(job.sources ?? {}), cut } };
      }),

    setCutOverrideSource: (key, source) =>
      apply((job) => {
        const cut = { ...(job.sources?.cut ?? {}) };
        if (job.cutOverride?.[key] === undefined) delete cut[key];
        else cut[key] = source;
        return { ...job, sources: { ...(job.sources ?? {}), cut } };
      }),

    applySetup: (answers) => apply((job) => applyAnswers(job, answers)),

    replace: (job) => apply(() => job),

    reset: () => apply(() => newDefaultJob()),
  };
});
