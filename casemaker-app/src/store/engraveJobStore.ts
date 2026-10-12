import { create } from 'zustand';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { DEFAULT_STROKE_FONT_ID } from '@/engine/fonts/stroke/strokeFont';
import {
  defaultEngraveJob,
  newEngraveDrillId,
  newEngraveKeepOutId,
  newEngraveLabelId,
  newEngraveShapeId,
  newEngraveTraceId,
} from '@/engine/cnc/engrave/defaults';
import { defaultStockProud, todayISODate, viseForNewJob } from '@/engine/cnc/fixture';
import { sacrificialForNewJob } from '@/engine/cnc/sacrificial';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { applyAnswers, type SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { effectiveMargins, recommendLabelDepth } from '@/engine/cnc/engrave/depthBounds';
import { labelGlyphMeasure, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import {
  BLANK_SEED_TEXT,
  blankLabelSeed,
  isShippedDemoLabelSet,
  mayRelayoutLabels,
} from '@/engine/cnc/engrave/blankLabelSeed';
import { BADGE_POCKET_KEEP_OUT_ID, type BadgeBlank } from '@/engine/cnc/engrave/fromBadge';
import { blankStockFor } from '@/engine/cnc/engrave/fromBlank';
import type { BlankParams } from '@/types/blank';
import type { CutParams } from '@/engine/cnc/feeds';
import type {
  EngraveBorderShape,
  EngraveCircleShape,
  EngraveCombinedShape,
  EngraveCutawayShape,
  EngraveDrill,
  EngraveDrillArrayItem,
  EngraveDrillItem,
  EngraveFrameShape,
  EngraveJob,
  EngraveJobSources,
  EngraveKeepOut,
  EngraveKeepOutCircle,
  EngraveKeepOutPolygon,
  EngraveKeepOutRect,
  EngraveKeepOutSlot,
  EngraveLabel,
  EngraveLineItem,
  EngraveMargins,
  EngravePolygonShape,
  EngraveRectShape,
  EngraveShape,
  EngraveShapeBase,
  EngraveSlotShape,
  EngraveStrokeLabelItem,
  EngraveTraceItem,
  EngraveVectorShape,
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

/**
 * A hand edit to one trace item (#219). The same shape as `ShapePatch`: every field optional and
 * both kinds' fields present, so a row can patch just what it changed without naming the
 * discriminant; the `kind` is never patched (a line does not become a stroke label in place).
 */
export type TracePatch = Partial<Omit<EngraveLineItem, 'kind'>> &
  Partial<Omit<EngraveStrokeLabelItem, 'kind'>>;

/**
 * A hand edit to one imported vector (#217). Unlike `ShapePatch`, this CANNOT touch the
 * geometry: a vector's `contours` are the flattened file, and a partial edit of them is not a
 * shape. Sizing is the import dialog's job (`scaleOutlineToWidth`), before the item exists;
 * once added, only placement, depth, name and flags are editable, exactly as the row offers.
 */
export type VectorPatch = Partial<
  Pick<EngraveVectorShape, 'name' | 'position' | 'rotation' | 'depth' | 'enabled' | 'construction'>
>;

/**
 * A hand edit to one plunge drill (#220). Every optional field of both kinds is present, so a
 * row patches just what it changed without naming the discriminant — the same shape as
 * `TracePatch`. `count` and `pitch` are whole objects of their own (a partial one would be a
 * different lattice), so a row sends them together.
 */
export type DrillPatch = Partial<Omit<EngraveDrillItem, 'kind'>> &
  Partial<Omit<EngraveDrillArrayItem, 'kind'>>;

/**
 * A hand edit to one under-surface void (#271). The same shape as `ShapePatch` — every optional
 * field of all four kinds, so a row patches just what it changed without naming the
 * discriminant, and the `kind` is never patched (remove and re-add instead).
 */
export type KeepOutPatch = Partial<Omit<EngraveKeepOutRect, 'kind'>> &
  Partial<Omit<EngraveKeepOutCircle, 'kind'>> &
  Partial<Omit<EngraveKeepOutSlot, 'kind'>> &
  Partial<Omit<EngraveKeepOutPolygon, 'kind'>>;

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
 * settings when one exists (#203/#213, decision 28), and its floor / edge margin / breakthrough
 * SEEDED from the house thresholds (#345). The reading of settings happens HERE, in the store, so
 * `defaultEngraveJob` stays a pure function of its arguments.
 *
 * The new job carries no `margins` key of its own: absent means "run on the house setting", which
 * is what makes a later change to the setting reach a job nobody has overridden.
 */
function newDefaultJob(): EngraveJob {
  const { fixtures, margins } = useSettingsStore.getState();
  const job = defaultEngraveJob(viseForNewJob(fixtures.vise), margins);
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

/**
 * The fields a label's `layout` claim covers (#363 review): everything about the line EXCEPT how
 * deep it cuts. A patch that touches any of them is a person deciding what the label is or where it
 * goes, and the badge route may not lay it out again.
 *
 * `construction` is in the list because it is one of the fields the person can set that the route's
 * own seed never writes — losing it to a re-lay would be silent.
 */
const LAYOUT_FIELDS = [
  'text',
  'font',
  'weight',
  'size',
  'position',
  'rotation',
  'enabled',
  'construction',
] as const;

/**
 * Is this stock the DEMO PLANK the shipped labels were written for? (#364)
 *
 * `defaultEngraveJob` ships three lines laid out for a 100 × 60 mm plank, and those words are that
 * blank's own content — so a bare blank of the same footprint keeps them, re-depthed. Any other
 * blank replaces them, because they were never written for it.
 *
 * A FOOTPRINT test: length and width, and deliberately not thickness. The three lines are laid out
 * in X and Y, so a thinner or thicker slab of the same face is still the plank they were written
 * for — which is why 100 × 60 × 4 keeps them (and why only their DEPTHS move with the thickness).
 */
function isDemoPlank(stock: Pick<EngraveJob['stock'], 'length' | 'width'>): boolean {
  const demo = defaultEngraveJob().stock;
  return stock.length === demo.length && stock.width === demo.width;
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

/**
 * The vise after a stock edit that moves the blank's thickness (#344).
 *
 * `viseForNewJob` derives `stockProud` from the stock, but it only runs when a job is CREATED. Every
 * path that puts a blank into an EXISTING job — the wizard's blank route, the panel's "Use the
 * blank" / "Use the badge blank", the stale-stock nag that points at them — goes through `setStock`,
 * which patched the stock and left the vise alone. So the shipped 4 mm default met a 3.81 mm badge
 * blank and `validateVise` refused the job outright (`vise-stock-proud-exceeds-thickness`) before
 * anything else was possible, and the person had to find the number and type a smaller one.
 *
 * Only the shipped default is re-derived. A SAVED or MEASURED vise is the user's own number, kept
 * exactly even when it refuses the new blank, so the panel can still show why (#231/#203). An edit
 * that states no thickness — a width, a material — says nothing about how tall the blank stands,
 * so the vise is untouched and the object's identity is kept.
 *
 * A patch that restates the thickness the stock already has is NOT skipped (#344 review). It looks
 * like a no-op and the derived number makes it one — `stockProud === vise.stockProud` returns the
 * same object — but only when the state is already right. A job saved by an older build before this
 * derivation existed (a 3.81 mm blank still carrying the shipped 4 mm) heals on the next press of
 * "Use the badge blank" precisely because the restated thickness is re-derived rather than trusted.
 */
function viseAfterStockEdit(job: EngraveJob, patch: Partial<EngraveJob['stock']>): ViseParams {
  const thickness = patch.thickness;
  const { vise } = job.workholding;
  if (thickness === undefined) return vise;
  if (vise.source !== 'default') return vise;
  const stockProud = defaultStockProud(thickness);
  return stockProud === vise.stockProud ? vise : { ...vise, stockProud };
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
  const first = [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])][0] ?? null;
  switch (kind) {
    case 'border':
      return { ...base, kind: 'border', inset: 3, width: 2 };
    case 'frame':
      return first ? { ...base, kind: 'frame', around: first.id, gap: 1, width: 2 } : null;
    case 'cutaway':
      return first ? { ...base, kind: 'cutaway', outer: first.id, islands: [] } : null;
  }
}

/**
 * A default trace of the given kind (#219), centred on the stock like a new shape; every number
 * is valid against the schema. A `line` is a short open polyline the user redraws; a
 * `stroke-label` uses the one bundled single-stroke face at the default cap height.
 */
function newTrace(kind: EngraveTraceItem['kind'], job: EngraveJob): EngraveTraceItem {
  const base = {
    id: newEngraveTraceId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
  if (kind === 'line') {
    // A 20 mm horizontal line through the centre; the row editor replaces the points.
    return { ...base, kind: 'line', points: [[-10, 0], [10, 0]], closed: false };
  }
  return { ...base, kind: 'stroke-label', text: 'Line', font: DEFAULT_STROKE_FONT_ID, size: 8 };
}

/**
 * A brand-new plunge drill (#220), centred on the stock at a 1 mm depth — the same `0.5`-class
 * starting depth the other items use, comfortably inside the 12 mm default blank. An array
 * starts as a 2 × 2 lattice at 10 mm pitch, which the row editor then replaces. There is no
 * diameter: the hole IS the cutter's (#220), so a new drill just needs somewhere to be.
 */
function newDrill(kind: EngraveDrill['kind'], job: EngraveJob): EngraveDrill {
  const base = {
    id: newEngraveDrillId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 1.0,
    enabled: true,
    through: false,
  };
  if (kind === 'drill-array') {
    return { ...base, kind: 'drill-array', count: { x: 2, y: 2 }, pitch: { x: 10, y: 10 } };
  }
  return { ...base, kind: 'drill' };
}

/**
 * A default under-surface void of the given kind (#271), centred on the stock like a new shape.
 *
 * `zCeiling` is HALF the blank's thickness, rounded to 0.1 mm: a neutral place to start that
 * always leaves a membrane to reason about, and the row states what it leaves in millimetres. It
 * is NOT a guess at the user's pocket — the void it describes is one they already cut, and the
 * number is theirs to correct. Every value is valid against the schema (`zCeiling` positive, a
 * rect's corner radius, a slot's length ≥ width).
 */
function newKeepOut(kind: EngraveKeepOut['kind'], job: EngraveJob): EngraveKeepOut {
  const base = {
    id: newEngraveKeepOutId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    enabled: true,
    zCeiling: Math.max(0.1, Math.round((job.stock.thickness / 2) * 10) / 10),
  };
  switch (kind) {
    case 'rect':
      return { ...base, kind: 'rect', width: 20, height: 10, cornerRadius: 0 };
    case 'circle':
      return { ...base, kind: 'circle', diameter: 8 };
    case 'slot':
      return { ...base, kind: 'slot', length: 24, width: 8 };
    case 'polygon':
      // A 20 × 10 ring at the centre; the row editor replaces the points.
      return { ...base, kind: 'polygon', points: [[-10, -5], [10, -5], [10, 5], [-10, 5]] };
  }
}

export interface EngraveJobState {
  job: EngraveJob;
  /**
   * Point the job at a machine (#347) — its `machineId`, which decides the materials the flow
   * offers and the envelope and spindle ceiling every resolver reads.
   *
   * It writes the id and NOTHING else, deliberately. The blank, the cutter and the labels are the
   * same objects whoever cuts them, and the app's own findings are what say when they do not fit
   * the machine — so re-deriving them here would be a second, quieter opinion than the one the
   * panel prints. (There is one mill in `MACHINES` today, so a change is a statement about the
   * job's machine rather than a different machine's numbers; when a second lands, this is where the
   * stock bounds and the material's availability get their say.)
   */
  setMachine: (id: string) => void;
  /**
   * Merge a stock edit and stamp each edited field's source (#254). Defaults to `'user'`.
   *
   * A patch that changes the thickness carries the SHIPPED-DEFAULT vise with it, re-deriving its
   * `stockProud` from the new blank (#344). A saved or measured vise is never touched.
   */
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
  /** Add a default trace of `kind` (#219) and return its id. */
  addTrace: (kind: EngraveTraceItem['kind']) => string;
  /** Merge a hand edit into one trace (#219). A partial `position` is merged, not replaced. */
  updateTrace: (id: string, patch: TracePatch) => void;
  removeTrace: (id: string) => void;
  /** Add a default plunge drill of `kind` (#220) and return its id. */
  addDrill: (kind: EngraveDrill['kind']) => string;
  /** Merge a hand edit into one drill (#220). A partial `position` is merged, not replaced. */
  updateDrill: (id: string, patch: DrillPatch) => void;
  removeDrill: (id: string) => void;
  /**
   * Declare an under-surface void of `kind` (#271) and return its id. A void is a fact about the
   * blank, not an item: it is never cut, and it is what `jobDepthLimit` reads to refuse a cut
   * that would break through the membrane above it.
   */
  addKeepOut: (kind: EngraveKeepOut['kind']) => string;
  /** Merge a hand edit into one void (#271). A partial `position` is merged, not replaced. */
  updateKeepOut: (id: string, patch: KeepOutPatch) => void;
  /** Declare `keepOut` outright, replacing any void already declared under its id (#271). */
  upsertKeepOut: (keepOut: EngraveKeepOut) => void;
  removeKeepOut: (id: string) => void;
  /**
   * Take a `BadgeBlank` as this job's blank (#271 route 1, #352) — the ONE owner of that write,
   * shared by the panel's "Use the badge blank" and the wizard's hand-off seed so the two cannot
   * drift into two versions of "the badge is the blank".
   */
  takeBadgeBlank: (blank: BadgeBlank) => void;
  /**
   * Take a bare blank as this job's stock (#280, #364) — the twin of `takeBadgeBlank`, and the ONE
   * owner of that write, shared by the panel's "Use the blank" and the wizard's hand-off seed so the
   * two cannot drift into two versions of "the blank is the stock".
   *
   * It carries the dimensions only (`blankStockFor`): the material is the operator's and a blank
   * cannot know it. On top of `setStock` it does the two things the badge route does — seed a line,
   * and re-depth every unclaimed label — because a blank that changes the stock and nothing else
   * hands over a job laid out for a different blank, which will not generate.
   */
  takeBlankStock: (blank: BlankParams) => void;
  /**
   * Give every label a depth THIS blank allows, and say who decided (#362) — the arithmetic is
   * `recommendLabelDepth`, this is only the walk over the labels and the provenance.
   *
   * Called by `takeBadgeBlank` on the job as it now stands, and exposed on its own so the
   * re-depthing has a name a test can call without a badge template in hand.
   *
   * Two labels are SKIPPED, and both for the same reason — the recommendation is a starting point,
   * not an authority over a number someone else stated:
   *
   *   - one whose depth source is `'user'` or `'measured'` (`sources.labels[id]`, #362), i.e. one
   *     the user typed or read at the bench;
   *   - one that states its own `depthIntent` — `recommendLabelDepth` declines those itself, since
   *     an item that has said which colour its floor means is the user's to place.
   *
   * The provenance has a floor in time that cannot be seen from here: a depth typed before #362
   * shipped is indistinguishable from one the app wrote, since the document recorded only the
   * number. Such a label is treated as unclaimed and re-depth-ed. That is the right way round for a
   * route whose whole job is to make the blank and the depths agree (a stale pre-#362 depth is
   * exactly the one that disagrees), and there is nothing left to recover the intent from — but it
   * does mean "the label editor remembers what I typed" only holds for a depth typed since #362.
   */
  redepthLabelsForBlank: () => void;
  /**
   * Add an imported vector outline (#217) and return its id. The shape is built by the panel
   * from an accepted `OutlineImport` (via `toVectorShape`), because only the panel holds the
   * placement fields the import dialog settled on.
   */
  addVector: (shape: EngraveVectorShape) => string;
  /** Merge a hand edit into one vector (#217). A partial `position` is merged, not replaced. */
  updateVector: (id: string, patch: VectorPatch) => void;
  removeVector: (id: string) => void;
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
  /**
   * Set this job's own depth margins, or clear them back to the house setting (#345). The
   * panel's "use the recommendation" passes `{ ...rec, source: 'recommended' }`; `null` deletes
   * the key, which is the same state every stored job is in and the one a settings change then
   * reaches.
   */
  setJobMargins: (margins: EngraveMargins | null) => void;
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

    // #347 — the id alone, and no other field. See the interface's own doc for why.
    setMachine: (id) => apply((job) => (job.machineId === id ? job : { ...job, machineId: id })),

    setStock: (patch, source = 'user') =>
      apply((job) => {
        const keys = (Object.keys(patch) as (keyof EngraveJob['stock'])[]).filter(
          (k) => patch[k] !== undefined,
        );
        const stock = { ...job.stock, ...patch };
        // `print` and `flatness` are the two stock fields a patch can CLEAR (#285 review, #345).
        // "Use the badge blank" on a badge that has lost its print must take the layer grid away
        // with it, or the stack limit goes on applying to a blank whose print is no longer known —
        // and the stated dome (`flatness`) is a fact about the SAME printed blank, so it goes with
        // it too. An explicit `undefined` says that; an OMITTED key still means "leave it alone",
        // which is what every other caller relies on. The provenance goes with it — a source for a
        // value that is gone is a lie.
        const sources = withStockSource(job, keys, source);
        for (const key of ['print', 'flatness'] as const) {
          if (key in patch && patch[key] === undefined) {
            delete stock[key];
            if (sources.stock) delete sources.stock[key];
          }
        }
        // The vise follows a blank that changes size (#344) — see `viseAfterStockEdit`.
        const vise = viseAfterStockEdit(job, patch);
        const next = { ...job, stock, sources };
        return vise === job.workholding.vise
          ? next
          : { ...next, workholding: { ...job.workholding, vise } };
      }),

    addLabel: () => {
      const label = newLabel(get().job);
      apply((job) => ({ ...job, labels: [...job.labels, label] }));
      return label.id;
    },

    updateLabel: (id, patch) =>
      apply((job) => {
        // #362 — a depth typed into the label editor is the user's number, and it has to say so:
        // `takeBadgeBlank` re-depths the labels a blank has not claimed, and a stated depth is
        // precisely the one it must leave alone. Stamped here rather than at each call site, so
        // there is one place that decides what "the user typed this depth" means.
        //
        // The INTENT's provenance is stamped the same way and for the same reason (review): the
        // recommendation writes a `'reveal'` of its own, and the guard it has to get past declines
        // any item that states an intent. Without a source on the USER's intent, a person's reveal
        // and a previous call's would be indistinguishable — so either the person's statement would
        // be silently revised, or the app's own would be frozen in place forever.
        //
        // The label's own fields — what it says, its face, and where and how big it sits — are ONE
        // claim, stamped the same way and for the same reason (#363 review). They are the fields a
        // route lays out in a single pass (`blankLabelSeed`) and only a person otherwise decides, so
        // a single `layout` stamp is what tells the route "this line is not yours to re-lay" — a
        // stamp per field would only record the same decision four times. `depth` keeps its own slot
        // above, because the re-depth and the replacement are different decisions.
        const claim = { ...(job.sources?.labels?.[id] ?? {}) };
        if (patch.depth !== undefined) claim.depth = 'user';
        if (LAYOUT_FIELDS.some((key) => key in patch)) claim.layout = 'user';
        if ('depthIntent' in patch) {
          if (patch.depthIntent === undefined) delete claim.depthIntent;
          else claim.depthIntent = 'user';
        }
        const claimed = Object.keys(claim).length > 0;
        const sources: EngraveJobSources = {
          ...(job.sources ?? {}),
          labels: { ...(job.sources?.labels ?? {}), [id]: claim },
        };
        // A label whose claims have all been cleared goes back to claiming nothing, so the map does
        // not accumulate `{}` entries the schema has to carry.
        if (!claimed) delete sources.labels![id];
        if (Object.keys(sources.labels!).length === 0) delete sources.labels;
        return {
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
          sources,
        };
      }),

    removeLabel: (id) =>
      apply((job) => {
        // #363 (review nit) — a removed label must not leave its claim behind. `sources.labels` is
        // keyed by label id, so the entry survives the label and is then an orphan: nothing reads
        // it (every lookup is by a live label's id), but it is carried by the document and counted
        // by nothing. Deleted the same way `updateLabel` drops a claim that has gone empty, map and
        // all, so the field never holds an empty object.
        const sources: EngraveJobSources = { ...(job.sources ?? {}) };
        if (sources.labels) {
          const labels = { ...sources.labels };
          delete labels[id];
          if (Object.keys(labels).length > 0) sources.labels = labels;
          else delete sources.labels;
        }
        return { ...job, labels: job.labels.filter((l) => l.id !== id), sources };
      }),

    setTool: (key, source = 'user') =>
      apply((job) => ({
        ...job,
        toolKey: key,
        // #305 design point 2 — snapshot the materialised cutter beside its key, so the job is
        // still reproducible when the tier that key names is not loaded (the built-ins always
        // are, which is why `resolveTool` is enough here and no failure is possible for them).
        tool: resolveTool(key),
        sources: { ...(job.sources ?? {}), tool: source },
      })),

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

    addTrace: (kind) => {
      const trace = newTrace(kind, get().job);
      apply((job) => ({ ...job, traces: [...(job.traces ?? []), trace] }));
      return trace.id;
    },

    updateTrace: (id, patch) =>
      apply((job) => ({
        ...job,
        traces: (job.traces ?? []).map((trace) =>
          trace.id === id
            ? ({
                ...trace,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...trace.position, ...patch.position } : trace.position,
              } as EngraveTraceItem)
            : trace,
        ),
      })),

    removeTrace: (id) =>
      apply((job) => ({ ...job, traces: (job.traces ?? []).filter((t) => t.id !== id) })),

    addDrill: (kind) => {
      const drill = newDrill(kind, get().job);
      apply((job) => ({ ...job, drills: [...(job.drills ?? []), drill] }));
      return drill.id;
    },

    updateDrill: (id, patch) =>
      apply((job) => ({
        ...job,
        drills: (job.drills ?? []).map((drill) =>
          drill.id === id
            ? ({
                ...drill,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...drill.position, ...patch.position } : drill.position,
              } as EngraveDrill)
            : drill,
        ),
      })),

    removeDrill: (id) =>
      apply((job) => ({ ...job, drills: (job.drills ?? []).filter((d) => d.id !== id) })),

    addKeepOut: (kind) => {
      const keepOut = newKeepOut(kind, get().job);
      apply((job) => ({ ...job, keepOuts: [...(job.keepOuts ?? []), keepOut] }));
      return keepOut.id;
    },

    updateKeepOut: (id, patch) =>
      apply((job) => ({
        ...job,
        keepOuts: (job.keepOuts ?? []).map((ko) =>
          ko.id === id
            ? ({
                ...ko,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...ko.position, ...patch.position } : ko.position,
              } as EngraveKeepOut)
            : ko,
        ),
      })),

    // A whole void, not a patch: the badge derivation (#271) builds one and must land on the SAME
    // void every time it is applied, so an existing one under that id is replaced rather than
    // duplicated. The position is a whole object here, so there is nothing to merge.
    upsertKeepOut: (keepOut) =>
      apply((job) => {
        const existing = job.keepOuts ?? [];
        const next = existing.some((k) => k.id === keepOut.id)
          ? existing.map((k) => (k.id === keepOut.id ? keepOut : k))
          : [...existing, keepOut];
        return { ...job, keepOuts: next };
      }),

    removeKeepOut: (id) =>
      apply((job) => ({ ...job, keepOuts: (job.keepOuts ?? []).filter((k) => k.id !== id) })),

    // #352 — the badge's blank, applied in one place. The stock goes through `setStock` rather than
    // being written here, so the `print`/`flatness` clearing and the vise follow (#344) stay
    // `setStock`'s rules and not a second copy of them. A badge with no pocket must also CLEAR a
    // pocket an earlier badge stamped — but only the one the badge owns (`BADGE_POCKET_KEEP_OUT_ID`);
    // a void the user typed carries a `ko-…` id and is never touched.
    takeBadgeBlank: (blank) => {
      get().setStock(blank.stock, 'computed');
      if (blank.pocket) get().upsertKeepOut(blank.pocket);
      else if ((get().job.keepOuts ?? []).some((k) => k.id === BADGE_POCKET_KEEP_OUT_ID)) {
        get().removeKeepOut(BADGE_POCKET_KEEP_OUT_ID);
      }
      // #363 — and the LINES, where the job's set is still one a ROUTE laid out. Those three demo
      // lines were laid out for the 100 × 60 mm default plank and nothing had ever moved them, so a
      // 76.2 mm badge got a `CASE` running 12 mm off its back edge and three `item-outside-stock`
      // errors on the job the wizard had just built. A badge is a name badge, so this route seeds
      // ONE line, laid out from the blank as it now stands — the document's own stock and pocket,
      // not the patch that was just applied to it.
      //
      // `mayRelayoutLabels` is the gate, and it asks about provenance as well as values (#363
      // review): the shipped demo set, or the line an earlier take seeded — so taking a second,
      // different badge blank re-lays the line rather than leaving the first badge's size and
      // position standing on a blank they were not measured for. A set the person has touched in
      // any way is left alone, and either way every label gets its depth from the walk below.
      const job = get().job;
      // Every branch of the gate requires at least one label, so whenever it passes there is a face
      // to borrow — which is the point: the seeded line is set in the face the person is already
      // looking at, rather than in a second default that would disagree with the job's own labels.
      const face = job.labels[0];
      if (face && mayRelayoutLabels(job)) {
        const pocket = (job.keepOuts ?? []).find((k) => k.id === BADGE_POCKET_KEEP_OUT_ID);
        const seed = blankLabelSeed({
          blank: {
            length: job.stock.length,
            width: job.stock.width,
            // The badge builds its pocket as a rect (`badgeBlankFor`); a void under that id of any
            // other shape is not one, and a seed laid out as if the void were absent is the honest
            // reading of a shape this layout has no y-band for.
            pocket: pocket?.kind === 'rect' ? pocket : null,
          },
          edgeMargin: job.edgeMargin,
          font: face.font,
          weight: face.weight,
          measure: labelGlyphMeasure(job.customFonts ?? []),
        });
        // Nothing at all on a blank too small for one line at 1 mm: the seed declines and the demo
        // labels' own findings stand, which is the honest report for a blank nothing fits on.
        if (seed) {
          apply((current) => ({
            ...current,
            labels: [seed],
            // The line and its provenance go in TOGETHER, and the claim map is replaced rather than
            // merged: the stamps on the labels this call just dropped are about labels that are
            // gone, and `layout: 'computed'` is what tells a later take that this new line is still
            // a route's to re-lay (#363 review). The walk below adds the depth to this same entry.
            sources: {
              ...(current.sources ?? {}),
              labels: { [seed.id]: { layout: 'computed' } },
            },
          }));
        }
      }
      // #362 — and a DEPTH for each label the blank has not been told about. Before this, taking a
      // 3.81 mm badge blank left the 12 mm softwood job's 2.0/1.0/0.5 mm depths on it, and the
      // wizard immediately complained about a job it had just built. Every clause of "why this is
      // deep" is arithmetic on the blank that was just applied, so it has to run AFTER the stock
      // and the pocket, on the job as it now stands — and after the seed, which is a label with a
      // starting depth and no claim, so this walk is what writes the number it really takes (#363).
      get().redepthLabelsForBlank();
    },

    // #364 — the bare blank's twin. `blankStockFor` is the blank's own reading of itself
    // (dimensions only; the material is the operator's and a blank cannot know it), and `setStock`
    // keeps owning the `stockProud` re-derivation and the vise follow (#344) rather than this
    // method growing a second copy of those rules.
    takeBlankStock: (blank) => {
      get().setStock(blankStockFor(blank).stock, 'computed');

      // …and the LINES, the same gap the badge route had (#363) one archetype over. The three demo
      // words are laid out for the 100 × 60 mm plank — `CASE` centred at x = 50, which is 10 mm from
      // the right edge of a 60 mm blank and more than its own half-width — so on a 60 × 40 blank
      // `generate` refused the job with three `item-outside-stock` errors, and on any other blank
      // they ran off in the same way.
      //
      // Two conditions, and each answers a different question (#364):
      //   - NOT the demo plank — the three lines ARE that blank's content, so a blank of the same
      //     footprint (thickness aside) keeps them. `isDemoPlank` is the footprint test.
      //   - `isShippedDemoLabelSet` — the demo set is the only thing this route may replace. It is
      //     NOT the badge's wider `mayRelayoutLabels`: a bare blank has no content of its own to
      //     justify taking over a set a route seeded (a line the badge route wrote survives, and
      //     only its depth is re-walked), and it never re-lays a set the person has touched.
      const job = get().job;
      const face = job.labels[0];
      if (face && !isDemoPlank(job.stock) && isShippedDemoLabelSet(job)) {
        const seed = blankLabelSeed({
          // No pocket: a bare blank declares none, so `freeBands` answers its whole usable face as
          // one band and the line is sized to the blank (`blankStockFor` carries dimensions only).
          blank: { length: job.stock.length, width: job.stock.width, pocket: null },
          edgeMargin: job.edgeMargin,
          font: face.font,
          weight: face.weight,
          text: BLANK_SEED_TEXT,
          measure: labelGlyphMeasure(job.customFonts ?? []),
        });
        if (seed) {
          apply((current) => ({
            ...current,
            labels: [seed],
            // Written together with the line, and the claim map replaced rather than merged: the
            // dropped demo labels' stamps are about labels that are gone, and `layout: 'computed'`
            // is what lets the BADGE route recognise this line as a route's if one is taken next.
            sources: {
              ...(current.sources ?? {}),
              labels: { [seed.id]: { layout: 'computed' } },
            },
          }));
        }
      }

      // Unconditional, and after either branch (#364): the walk is right at every thickness — the
      // demo plank's own three lines are re-depthed to 3/3/3 on a 100 × 60 × 12 and to 1/1/1 on a
      // 100 × 60 × 4 — and it is the only thing that writes the seeded line's real depth (#362).
      get().redepthLabelsForBlank();
    },

    redepthLabelsForBlank: () =>
      apply((job) => {
        // Resolved ONCE, the way every other reader of the margins does it: the recommendation and
        // the checker must be holding the same margin, or a depth can be recommended and then
        // refused by the bound it was recommended against.
        const boundaryMargin = effectiveMargins(job, useSettingsStore.getState().margins).boundaryMargin;
        // The void bound is worked out PER LINE, from the same measurement the seed laid it out with
        // (#365): a line clear of the pocket is not charged for it. The measure is the one
        // `labelGlyphMeasure` builds for every reader, so the box this walk tests a void against is
        // the box the line was placed by.
        const measure = labelGlyphMeasure(job.customFonts ?? []);
        const stated = job.sources?.labels ?? {};
        const stamps: Record<string, { depth: FieldSource; depthIntent?: FieldSource }> = {};
        let changed = false;

        const labels = job.labels.map((label) => {
          const claim = stated[label.id];
          if (claim?.depth === 'user' || claim?.depth === 'measured') return label;
          const rec = recommendLabelDepth(job, label, {
            voidLimit: voidLimitForItem(job, label, boundaryMargin, measure),
            boundaryMargin,
            // Its OWN past intent does not lock the label out (#362 review): `'computed'` says the
            // `'reveal'` on this label is a previous call's, so a thicker badge or a different split
            // gets a fresh answer instead of a stale depth the checker would refuse.
            ...(claim?.depthIntent === undefined ? {} : { intent: claim.depthIntent }),
          });
          if (rec === null) return label;
          changed = true;
          // The depth is written as `computed`, the honest member of `FieldSource` for a number the
          // app worked out: the issue's "stamped recommended" has no member here, and inventing one
          // in a shared enum to say what `computed` already says would widen the vocabulary of the
          // stock, tool and cut fields too. What the source is FOR is the guard above — a value the
          // user or the bench claimed is never overwritten, and `computed` is precisely a value they
          // have not.
          stamps[label.id] = {
            depth: 'computed',
            // The intent travels with its provenance for the same reason, and is CLEARED when the
            // recommendation no longer states one — a `'reveal'` left behind on a floor that has
            // moved back above the split is a claim about a blank this job is no longer on.
            ...(rec.depthIntent === undefined ? {} : { depthIntent: 'computed' as FieldSource }),
          };
          return {
            ...label,
            depth: rec.depth,
            // Written unconditionally, `undefined` included: a label reaching here with an intent
            // can only be carrying one this same code wrote (`'computed'` is the only provenance the
            // guard above lets through), and a `'reveal'` on a floor the new blank no longer puts
            // past the split would be a claim about the blank this job has left.
            depthIntent: rec.depthIntent,
          };
        });

        // Nothing was written, so nothing is claimed: `apply` still persists, but a job that came
        // through untouched keeps the byte-identical document it had.
        if (!changed) return job;
        // The walk writes its own entry WHOLE. `depth` and the intent are the fields it decides, and
        // a stamp that no longer states an intent has to take the stale one with it (#362 review) —
        // a claim about a value that is gone is a lie.
        //
        // But the same entry may also carry the label's `layout` claim, which is about where the line
        // is and what it says, not how deep it cuts (#363 review). That one is carried ACROSS the
        // write: replacing the whole entry would drop it, and a line the badge route had laid out
        // would come out of the walk looking as if nobody had ever placed it.
        const merged: NonNullable<EngraveJobSources['labels']> = { ...stated };
        for (const [id, stamp] of Object.entries(stamps)) {
          const { layout } = stated[id] ?? {};
          merged[id] = { ...(layout === undefined ? {} : { layout }), ...stamp };
        }
        return { ...job, labels, sources: { ...(job.sources ?? {}), labels: merged } };
      }),

    addVector: (shape) => {
      apply((job) => ({ ...job, vectors: [...(job.vectors ?? []), shape] }));
      return shape.id;
    },

    updateVector: (id, patch) =>
      apply((job) => ({
        ...job,
        vectors: (job.vectors ?? []).map((v) =>
          v.id === id
            ? {
                ...v,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...v.position, ...patch.position } : v.position,
              }
            : v,
        ),
      })),

    removeVector: (id) =>
      apply((job) => ({ ...job, vectors: (job.vectors ?? []).filter((v) => v.id !== id) })),

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

    setJobMargins: (margins) =>
      apply((job) => {
        if (margins === null) {
          // ABSENCE IS THE SWITCH: delete the key rather than writing the house numbers into the
          // document, so the job keeps following the setting the way a fresh job does.
          const { margins: _dropped, ...rest } = job;
          return rest;
        }
        return { ...job, margins: { ...margins } };
      }),

    replace: (job) => apply(() => job),

    reset: () => apply(() => newDefaultJob()),
  };
});
