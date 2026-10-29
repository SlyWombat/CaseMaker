import { create } from 'zustand';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { tabSettings, type TabSettings } from '@/engine/cnc/cam/tabSettings';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { DEFAULT_STROKE_FONT_ID } from '@/engine/fonts/stroke/strokeFont';
import {
  defaultEngraveJob,
  newEngraveDrillId,
  newEngraveChamferId,
  newEngraveCutoutId,
  newEngraveKeepOutId,
  newEngraveLabelId,
  newEngravePrimitiveId,
  newEngraveShapeId,
  newEngraveTargetObjectId,
  newEngraveThreadId,
  newEngraveTraceId,
} from '@/engine/cnc/engrave/defaults';
import { defaultStockProud, jobVise, seatedVise, todayISODate, viseForNewJob } from '@/engine/cnc/fixture';
import { cylinderFrameOf, rodDimsOf, rotaryBoxForRod, standingBoxForRod } from '@/engine/cnc/stockStart';
import { rotaryFreeSpan, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { sacrificialForNewJob } from '@/engine/cnc/sacrificial';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { applyHoldAnswers, type SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { getMeshBlob, putMeshBlob } from '@/platform/meshBlobs';
import {
  itemKindWord,
  itemRowName,
  jobTool,
  type EngraveNamedItem,
} from '@/engine/cnc/engrave/jobSetup';
import { effectiveMargins, recommendLabelDepth, recommendedEngraveDepth } from '@/engine/cnc/engrave/depthBounds';
import { labelGlyphMeasure, labelJawReach, primitiveLabel, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import { inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import {
  BLANK_SEED_TEXT,
  blankLabelSeed,
  isShippedDemoLabelSet,
  mayRelayoutLabels,
  type JobBox,
} from '@/engine/cnc/engrave/blankLabelSeed';
import { BADGE_POCKET_KEEP_OUT_ID, type BadgeBlank } from '@/engine/cnc/engrave/fromBadge';
import { DESIGN_POCKET_KEEP_OUT_ID, designReplacesItems, mergeDesignItems, type DesignJobPatch } from '@/engine/cnc/engrave/fromDesign';
import { blankStockFor } from '@/engine/cnc/engrave/fromBlank';
import type { BlankParams } from '@/types/blank';
import { materializeSetups } from '@/engine/cnc/setups/authoring';
import type { CutParams } from '@/engine/cnc/feeds';
import type {
  BracketHold,
  EngraveBorderShape,
  EngraveBoxPrimitive,
  EngraveCircleShape,
  EngraveCombinedShape,
  EngraveConePrimitive,
  EngraveCutawayShape,
  EngraveChamfer,
  EngraveCutout,
  EngraveCylinderPrimitive,
  EngraveDrill,
  EngraveDrillArrayItem,
  EngraveDrillItem,
  EngraveFacing,
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
  EngravePrimitive,
  EngraveRectShape,
  EngraveShape,
  EngraveShapeBase,
  EngraveSlotShape,
  EngraveSpherePrimitive,
  EngraveStrokeLabelItem,
  EngraveReliefSettings,
  EngraveSurfaceSettings,
  EngraveTargetObject,
  EngraveThread,
  EngraveTraceItem,
  EngraveVectorShape,
  FieldSource,
  FrozenPackage,
  JobRunLogEntry,
  JobSetup,
  JobSource,
  RotaryChuck,
  Sacrificial,
  TapeHold,
  ViseParams,
} from '@/types/engraveJob';
import { pruneRunLog } from '@/engine/cnc/engrave/package';
import { withSource } from '@/engine/cnc/engrave/jobSources';
import { parseEngraveJob, type ParseEngraveJobResult } from './engraveJobSchema';
import { machineForJob } from '@/platform/bedProfiles';
import { useLocationStore } from './locationStore';
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

/** A hand edit to one chamfer (#669). The whole item minus its discriminant, like `DrillPatch`. */
export type ChamferPatch = Partial<Omit<EngraveChamfer, 'kind'>>;

/**
 * A hand edit to one milled thread (#445). The whole item minus its discriminant, so a row can
 * patch just what it changed — the same shape as `DrillPatch`, and one object rather than a union
 * because phase 2 has exactly one thread kind.
 */
export type ThreadPatch = Partial<Omit<EngraveThread, 'kind'>>;

/**
 * A hand edit to one 3D primitive (#435). Every optional field of all four kinds is present, so a
 * row patches just what it changed without naming the discriminant — the same shape as
 * `DrillPatch`. `kind` is never patched (remove and re-add instead).
 */
export type PrimitivePatch = Partial<Omit<EngraveBoxPrimitive, 'kind' | 'position'>> &
  Partial<Omit<EngraveCylinderPrimitive, 'kind' | 'position'>> &
  Partial<Omit<EngraveConePrimitive, 'kind' | 'position'>> &
  Partial<Omit<EngraveSpherePrimitive, 'kind' | 'position'>> & {
    /** A partial placement: the store merges it into the primitive's own X/Y. */
    position?: Partial<EngravePrimitive['position']>;
  };

/**
 * A hand edit to the reference object (#435). Its bytes, hash and parsed size are the import's
 * facts and cannot be patched — placement, rotation, name and visibility are the row's fields.
 *
 * #535 — a goal's `surface` settings patch in the same way: a PARTIAL is merged, and a key set to
 * `undefined` is REMOVED, which is how the row's reset returns one number to the engine default.
 */
export type TargetObjectPatch = Partial<Pick<EngraveTargetObject, 'name' | 'rotation' | 'enabled' | 'goalMode'>> & {
  /** A partial placement: the store merges it into the object's own X/Y/Z. */
  position?: Partial<EngraveTargetObject['position']>;
  /** A partial of the goal operation's settings; `undefined` on a key clears it. */
  surface?: Partial<EngraveSurfaceSettings>;
  /** #672 — a partial of a picture goal's relief map; `undefined` on a key clears it. */
  relief?: Partial<EngraveReliefSettings>;
  /** #672 — a picture's placed size in millimetres (the width field; the aspect is the row's). */
  size?: EngraveTargetObject['size'];
  /**
   * #722 — a mesh's per-axis scale. `null` removes the key (back to the file's own size), so a
   * mesh at 100 % serialises exactly as one that never carried the field.
   */
  scale?: EngraveTargetObject['scale'] | null;
};

/**
 * A hand edit to one profile cut-out (#218). `tabs` is a partial of its own object and is MERGED,
 * like a position, so a row can change the count without restating width and height.
 */
export type CutoutPatch = Partial<Omit<EngraveCutout, 'kind' | 'tabs'>> & {
  tabs?: Partial<EngraveCutout['tabs']>;
};

/**
 * A hand edit to one under-surface void (#271). The same shape as `ShapePatch` — every optional
 * field of all four kinds, so a row patches just what it changed without naming the
 * discriminant, and the `kind` is never patched (remove and re-add instead).
 */
export type KeepOutPatch = Partial<Omit<EngraveKeepOutRect, 'kind'>> &
  Partial<Omit<EngraveKeepOutCircle, 'kind'>> &
  Partial<Omit<EngraveKeepOutSlot, 'kind'>> &
  Partial<Omit<EngraveKeepOutPolygon, 'kind'>>;

/**
 * The v3 document's autosave slot (#425). A v3 document is full of fields a v2 build does not
 * know, and zod strips what it does not name — so the new build writes a NEW key rather than
 * overwriting the one an older build reads. An older build therefore keeps its own v2 copy, and
 * this build keeps its v3 one; neither can mistake the other's payload for its own.
 */
export const ENGRAVE_JOB_KEY = 'casemaker.engraveJob.v3';
/**
 * Where every v1/v2 build wrote the job. Read once on an upgrade — and only when the v3 key is
 * empty — so the person's current job survives the version bump. Never written and never removed:
 * it is the downgrade copy.
 */
export const ENGRAVE_JOB_LEGACY_KEY = 'casemaker.engraveJob.v1';
/** Where a payload that failed validation is parked so it is not silently lost. */
export const ENGRAVE_JOB_REJECTED_KEY = `${ENGRAVE_JOB_KEY}.rejected`;

/**
 * #720 — the localStorage copy never carries target-mesh bytes. They live in the mesh blob store
 * (IndexedDB, keyed by SHA-256): a 12 MB model is ~16 MB base64'd, against a ~5 MB quota. The
 * OPEN job keeps them in memory, and the .cutjob file still embeds them (a saved job is
 * self-contained); a reload re-attaches them from the blob store by hash.
 */
function withoutMeshData(job: EngraveJob): EngraveJob {
  if (job.targetObject === undefined || job.targetObject.data === undefined) return job;
  const { data: _data, ...target } = job.targetObject;
  return { ...job, targetObject: target };
}

function persist(job: EngraveJob): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ENGRAVE_JOB_KEY, JSON.stringify(withoutMeshData(job)));
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
  // #726 W21 — the house's MEASURED vise seeds a new job when the operator's settings hold none:
  // the machine's own `fixtures.vise` is decision 28's measured tier, below the saved one. Without
  // this the Design panel read "shipped · not measured here" on a machine that HAD measured it.
  const machine = machineForJob(useLocationStore.getState().location, null);
  const houseVise = machine?.fixtures?.vise ?? undefined;
  const job = defaultEngraveJob(viseForNewJob(fixtures.vise ?? houseVise), margins);
  // #508 — a fresh job's default vise is seated on the stock it is about to cut: `viseForNewJob`
  // knows no stock, so without this the job would carry `DEFAULT_VISE`'s placeholder proud.
  const vise = seatedVise(jobVise(job), job.stock.thickness);
  return { ...job, workholding: { kind: 'vise', vise }, sacrificial: sacrificialForNewJob(fixtures.sacrificial) };
}

function loadJob(): EngraveJob {
  if (typeof localStorage === 'undefined') return newDefaultJob();
  let raw: string | null;
  let legacy = false;
  try {
    raw = localStorage.getItem(ENGRAVE_JOB_KEY);
    if (raw === null) {
      // One-time upgrade read (#425): a v1 or v2 job lives under the old key. It is parsed through
      // the same schema (migrating to v3) and then written to the v3 slot; the old payload is left
      // where it is, so an older build can still open the job it wrote.
      raw = localStorage.getItem(ENGRAVE_JOB_LEGACY_KEY);
      legacy = raw !== null;
    }
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
  if (parsed.ok) {
    if (legacy) persist(parsed.job);
    return parsed.job;
  }

  // Fall back to the default, but keep the bad payload under `.rejected` so a hand-edited
  // file or a newer-minor job is recoverable rather than gone.
  try {
    localStorage.setItem(ENGRAVE_JOB_REJECTED_KEY, raw);
  } catch {
    // ignore quota errors
  }
  return newDefaultJob();
}

/**
 * #451 — where a newly added item STARTS, out of the code and into the location's shop defaults
 * (`defaultsClient.ts` / `defaults.rs`: `engrave.newItemDepthMm`, `engrave.newDrillDepthMm`). Both
 * are CHOSEN, not measured: nobody measured what depth a new label should begin at, and the person
 * who just asked for it is about to set the number that matters.
 *
 * What is left here is the FALLBACK for a build with no location to read — the hosted web build.
 * `shopDefault` labels it, so a value read this way never passes as the shop's own.
 *
 * The readings happen HERE, in the store, for the same reason `newDefaultJob` reads the vise here:
 * `newLabel` and its siblings stay pure functions of their arguments.
 */
export const NEW_ITEM_DEPTH_KEY = 'engrave.newItemDepthMm';
export const NEW_DRILL_DEPTH_KEY = 'engrave.newDrillDepthMm';
export const NEW_THREAD_DEPTH_KEY = 'engrave.newThreadDepthMm';

/** The depth a new item of any kind but a hole starts at, mm. */
export function newItemDepthMm(): number {
  return shopDefault(NEW_ITEM_DEPTH_KEY).value;
}

/**
 * The depth a new item starts at on THIS blank (#492): the stock kind recommends, and the operator
 * changes it if they like.
 *
 * A laminate's field arrives at cap + the laminate margin (0.1 mm on the 0.075 mm fixture), a
 * printed blank's at the colour line + one layer, and plain stock at the shop's engraving-depth
 * default (#451). The pure arithmetic is `recommendedEngraveDepth`; this function only resolves the
 * location's fallback and the job's own margin, the way every other depth reader does.
 */
export function newItemDepthFor(job: EngraveJob): number {
  const shop = shopDefault(NEW_ITEM_DEPTH_KEY);
  return recommendedEngraveDepth(job.stock, {
    boundaryMargin: effectiveMargins(job, useSettingsStore.getState().margins).boundaryMargin,
    shopDepth: { value: shop.value, source: shop.source },
  }).depth;
}

/** The depth a new hole starts at, mm — its own starting point, and the reason is in `newDrill`. */
export function newDrillDepthMm(): number {
  return shopDefault(NEW_DRILL_DEPTH_KEY).value;
}

/** The threaded length a new thread item starts at, mm (#445); its own key, see `newThread`. */
export function newThreadDepthMm(): number {
  return shopDefault(NEW_THREAD_DEPTH_KEY).value;
}

/**
 * Which way a NEW line reads on this job's blank (#700).
 *
 * The badge route clamps the blank with its long side along Y and lays its name out along it
 * (#383); the badge's own pocket keep-out is what identifies that blank here. Everywhere else the
 * job's first line is the precedent — a line added beside a rotated one reads the same way — and a
 * job with no lines takes the default (along X). Pure, so the store action and any later caller
 * ask one question.
 */
function textAlongFor(job: EngraveJob): 'x' | 'y' {
  if ((job.keepOuts ?? []).some((k) => k.id === BADGE_POCKET_KEEP_OUT_ID && k.enabled)) return 'y';
  const face = job.labels[0];
  const rotation = face === undefined ? 0 : ((face.rotation % 180) + 180) % 180;
  return rotation === 90 ? 'y' : 'x';
}

/**
 * #700 — is this label still a blank route's UNTOUCHED placeholder? The seed stamp says so, and
 * the layout stamp must still be the route's: a person's edit turns `layout` into `user` and clears
 * `seed`, so neither a retyped nor a moved line can be mistaken for the placeholder.
 */
function isSeedPlaceholder(job: EngraveJob, id: string): boolean {
  const claim = job.sources?.labels?.[id];
  return claim?.seed === true && claim.layout === 'computed';
}

/**
 * The boxes already on the blank, in the job's frame, for `blankLabelSeed`'s avoid rule (#700).
 * The measured ink box is used where the face is parsed, with `inkBoxOf`'s documented upper bound
 * standing in where it is not — the same reading the layout itself sizes a line with.
 */
function labelAvoidBoxes(labels: readonly EngraveLabel[], measure: ReturnType<typeof labelGlyphMeasure>): JobBox[] {
  const boxes: JobBox[] = [];
  for (const label of labels) {
    if (!label.enabled || label.construction === true) continue;
    const ink = inkBoxOf(label.text, label.font, label.weight, label.size, measure);
    const halfWidth = ink.width / 2;
    const halfHeight = ink.height / 2;
    const radians = (label.rotation * Math.PI) / 180;
    const c = Math.abs(Math.cos(radians));
    const s = Math.abs(Math.sin(radians));
    const halfX = halfWidth * c + halfHeight * s;
    const halfY = halfWidth * s + halfHeight * c;
    boxes.push({
      x0: label.position.x - halfX,
      y0: label.position.y - halfY,
      x1: label.position.x + halfX,
      y1: label.position.y + halfY,
    });
  }
  return boxes;
}

function newLabel(job: EngraveJob, depth: number): EngraveLabel {
  return {
    id: newEngraveLabelId(),
    text: 'New text',
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    size: 10,
    // Centre of the stock; the caller moves it. Depth must be > 0 or the schema rejects it.
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
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
  // #240 — a rotary job has no vise of its own. The neutral seated vise stands in for the answer
  // the panel reads (`jobVise`), and `setStock` writes it back only when the job is a vise job.
  const vise = jobVise(job);
  if (thickness === undefined) return vise;
  if (vise.source !== 'default') return vise;
  // #508 — the seat, not just the thickness: a floor-seated blank sits `VISE_FLOOR_DEPTH` down.
  const stockProud = defaultStockProud(thickness, vise.seat);
  return stockProud === vise.stockProud ? vise : { ...vise, stockProud };
}

/**
 * The rod a job's box states — its diameter, and its length along the rod — whichever way the rod
 * lies (#240, #683, #713). A job's box is either the AXIS FRAME (`L × D × D`) or the stock step's
 * STANDING frame (`D × D × L`); {@link rodDimsOf} reads both. Null for stock that is not round.
 */
function rodSizeOf(stock: EngraveJob['stock']): { diameter: number; length: number } | null {
  return rodDimsOf(stock);
}

/**
 * #724 B3 — THE LAYOUT MOVES TO THE FREE SPAN when a job enters the chuck. A plate's item
 * positions are meaningless on the map: X is millimetres from the jaw face along the stick-out,
 * where the cuttable span runs from the jaws' keep-out to the tailstock's band. A layout centred
 * on the stock's own middle reaches into the longer band (10 mm at the free end against 3 mm at
 * the jaws) and the job is refused on every default. The layout keeps its arrangement and its Y —
 * only its X centre is re-stated, on the span the findings pass judges (`rotaryFreeSpan`).
 */
function centredOnRotaryFreeSpan(job: EngraveJob): EngraveJob {
  const map = rotaryMapOf(job);
  if (map === null) return job;
  const xs = [...job.labels, ...job.shapes].map((item) => item.position.x);
  if (xs.length === 0) return job;
  const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
  const shift = rotaryFreeSpan(map).centre - centre;
  if (!(Math.abs(shift) > 1e-9)) return job;
  const moved = <T extends { position: { x: number; y: number } }>(item: T): T => ({
    ...item,
    position: { ...item.position, x: item.position.x + shift },
  });
  return { ...job, labels: job.labels.map(moved), shapes: job.shapes.map(moved) };
}

/** The job with a source stamped on each of `keys` in `sources.stock` (#254). */
function withStockSource(
  job: EngraveJob,
  keys: readonly (keyof EngraveJob['stock'])[],
  source: FieldSource | Partial<Record<keyof EngraveJob['stock'], FieldSource>>,
): EngraveJobSources {
  const stock = { ...(job.sources?.stock ?? {}) };
  for (const key of keys) {
    stock[key] = typeof source === 'string' ? source : (source[key] ?? 'user');
  }
  return { ...(job.sources ?? {}), stock };
}

/**
 * A default shape of the given kind (#214). Every dimension is valid against the schema
 * (positive, `cornerRadius ≤ min(w,h)/2`, slot `length ≥ width`, ≥ 3 polygon points) so a
 * freshly added item never lands the job in a state that cannot be reloaded. Centred on the
 * stock like a new label; the caller moves it.
 */
function newShape(kind: EngraveShape['kind'], job: EngraveJob, depth: number): EngraveShape {
  const base: EngraveShapeBase = {
    id: newEngraveShapeId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
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
function newCombined(
  kind: EngraveCombinedShape['kind'],
  job: EngraveJob,
  depth: number,
): EngraveCombinedShape | null {
  const base: EngraveShapeBase = {
    id: newEngraveShapeId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
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
function newTrace(kind: EngraveTraceItem['kind'], job: EngraveJob, depth: number): EngraveTraceItem {
  const base = {
    id: newEngraveTraceId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
    enabled: true,
  };
  if (kind === 'line') {
    // A 20 mm horizontal line through the centre; the row editor replaces the points.
    return { ...base, kind: 'line', points: [[-10, 0], [10, 0]], closed: false };
  }
  return { ...base, kind: 'stroke-label', text: 'Line', font: DEFAULT_STROKE_FONT_ID, size: 8 };
}

/**
 * A brand-new plunge drill (#220), centred on the stock. An array starts as a 2 × 2 lattice at
 * 10 mm pitch, which the row editor then replaces. There is no diameter: the hole IS the cutter's
 * (#220), so a new drill just needs somewhere to be.
 *
 * Its starting depth is its own shop default (#451, `engrave.newDrillDepthMm`) rather than the
 * items' one: a hole that begins as shallow as a label shows nothing on the preview, so the two
 * start from different numbers and each says why.
 */
function newDrill(
  kind: EngraveDrill['kind'],
  job: EngraveJob,
  depth: number,
  mode: 'drill' | 'bore' = 'drill',
  diameter: number | null = null,
): EngraveDrill {
  const base = {
    id: newEngraveDrillId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
    enabled: true,
    through: false,
  };
  // #668 — a bore carries the two fields a drill has no use for. Absent on a drill, so the item
  // and every document written before this slice stay byte-identical.
  const bore = mode === 'bore' ? { mode: 'bore' as const, ...(diameter === null ? {} : { diameter }) } : {};
  if (kind === 'drill-array') {
    return { ...base, ...bore, kind: 'drill-array', count: { x: 2, y: 2 }, pitch: { x: 10, y: 10 } };
  }
  return { ...base, ...bore, kind: 'drill' };
}

/**
 * #668 — the hole diameter a NEW bore starts at: the job's cutter plus a millimetre, rounded UP to
 * the next half millimetre. That is a clearance hole rather than a press fit, and it is always
 * wider than the cutter, so a fresh row opens on a cut the engine can make instead of on
 * `bore-narrow`. A job with no cutter falls back to ⌀6 mm; the row states the real number either
 * way, and the finding refuses a hole that is not wider than the cutter.
 */
export function boreSeedDiameterMm(job: EngraveJob): number {
  const tool = jobTool(job);
  const cutter = tool === null ? null : cuttingDiameter(tool);
  if (cutter === null || !(cutter > 0)) return 6;
  return Math.ceil((cutter + 1) / 0.5) * 0.5;
}

/**
 * #669 — the rim a NEW chamfer starts on: the job's first enabled item with a profile (a shape,
 * an imported outline or a combined shape). Null when the job has none yet — the chamfer is still
 * added (a document may be built up in any order) and `chamfer-needs-edge` asks for one.
 */
export function defaultChamferTarget(job: EngraveJob): string | null {
  // A part's outline is usually a CONSTRUCTION item (the cut-out follows it), so `construction`
  // does not disqualify a rim; only `enabled` does.
  const shape = job.shapes.find((s) => s.enabled);
  if (shape !== undefined) return shape.id;
  const vector = (job.vectors ?? []).find((v) => v.enabled);
  if (vector !== undefined) return vector.id;
  const combined = (job.combined ?? []).find((c) => c.enabled);
  if (combined !== undefined) return combined.id;
  return null;
}

/**
 * #669 — a brand-new chamfer. `0.5 mm` is the starting width: the case-edge break the operation
 * was asked for, and small enough that every chamfer bit in the house reaches it. The rim is the
 * job's first, so a row opened on an existing job has a real edge under it.
 */
function newChamfer(job: EngraveJob): EngraveChamfer {
  const target = defaultChamferTarget(job);
  return {
    kind: 'chamfer',
    id: newEngraveChamferId(),
    enabled: true,
    // A part's edge is the operation's demand ("case lids/edges want a broken edge"); a pocket's
    // rim is one control away on the row.
    side: 'outside',
    width: 0.5,
    ...(target === null ? {} : { of: target }),
  };
}

/**
 * A brand-new milled thread (#445), centred on the stock like a new drill.
 *
 * `M3` is the starting size for the reason the bench plan gives (its pilot is the 2.5 mm drill
 * the shop owns) and not because M3 is special to the code. Its threaded length is its OWN shop
 * default (`engrave.newThreadDepthMm`), read in `addThread`: a thread that begins as deep as a
 * label shows a hole, not a thread, and the depth is the number the user is about to set anyway.
 */
function newThread(job: EngraveJob, depth: number): EngraveThread {
  return {
    kind: 'thread',
    id: newEngraveThreadId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    enabled: true,
    size: 'M3',
    standard: 'metric',
    classFit: '6H',
    depth,
    through: false,
  };
}

/**
 * A brand-new 3D primitive (#435), centred on the stock and starting at the same depth a new
 * region item does. Every number is valid against the schema: a box 20 × 10, a ⌀6 cylinder, a
 * cone ⌀8 → ⌀1, a ⌀8 sphere. The cone and sphere arrive with concrete dimensions because their
 * rows replace numbers rather than inventing a shape; the refusal findings explain that neither
 * is cut yet, so nothing is silently approximated.
 */
function newPrimitive(kind: EngravePrimitive['kind'], job: EngraveJob, depth: number): EngravePrimitive {
  const base = {
    id: newEngravePrimitiveId(),
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth,
    enabled: true,
  };
  switch (kind) {
    case 'box':
      return { ...base, kind: 'box', width: 20, height: 10 };
    case 'cylinder':
      return { ...base, kind: 'cylinder', diameter: 6 };
    case 'cone':
      return { ...base, kind: 'cone', diameter: 8, tipDiameter: 1 };
    case 'sphere':
      return { ...base, kind: 'sphere', diameter: 8 };
  }
}

/**
 * A default target-object id (#435). The object itself is built by the import, which already
 * holds the bytes, hash and parsed size; this helper exists so the id convention lives with every
 * other item id.
 */
export function newTargetObjectId(): string {
  return newEngraveTargetObjectId();
}

/**
 * A brand-new profile cut-out (#218), around the blank's own edge (`stock-inset`) — the shape a
 * "cut a part out of the blank" action starts from, and the only reference every job can supply.
 * The tab numbers are the shop's own (#218 three-edit rule) at the moment the row is created;
 * the job then keeps them even if the shop's change.
 */
function newCutout(tabs: TabSettings): EngraveCutout {
  return {
    kind: 'cutout',
    id: newEngraveCutoutId(),
    enabled: true,
    of: 'stock-inset',
    side: 'outside',
    inset: 0,
    tabs: { count: tabs.count, width: tabs.widthMm, height: tabs.heightMm },
  };
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

/**
 * A removal that can still be taken back (#411): what to say about it, and how to put it back.
 *
 * `restore` re-inserts the item AT ITS OLD INDEX rather than appending, so undoing a removal leaves
 * the list — and the run sheet built from it — as it was. The entry is off the stack by the time the
 * restore runs (`undoRemove` pops first, and `apply` retires the rest), so a restore cannot arm
 * another one.
 */
export interface PendingRemoval {
  /** What was removed, in the panel's words: `Label “CASE”`, `Rectangle “Face”`, `Void`. */
  what: string;
  /**
   * Which list it came out of — the panel draws the strip at the removal site, and a void removed
   * from "Voids under the face" must not have its undo offered under the item list below it.
   */
  section: 'items' | 'voids' | 'target';
  /** Puts it back, through `apply` like every other write. */
  restore: () => void;
}

/**
 * How long a removal may be taken back, ms — the design's 8 seconds and the maintainer's "the toast
 * stays for 8 s" (#411). It is when the strip goes away ON ITS OWN: the button and Ctrl-Z both read
 * the stack, and any other edit retires it immediately.
 */
export const REMOVAL_UNDO_MS = 8_000;

/**
 * The one timer that retires the strip.
 *
 * It is armed for the TOP of the stack and re-armed whenever the top changes, so a second removal
 * restarts the window instead of ending the first one's — which is the maintainer's "a quick second
 * removal never loses the first one's undo". When it fires the whole stack goes: what the person can
 * see is one strip, and leaving an undo behind that nothing on screen offers would be a lie about
 * what is still possible.
 */
let undoWindow: ReturnType<typeof setTimeout> | null = null;

/** Retire the strip's timer — a write, a pop or an empty stack all end the same window. */
function clearUndoWindow(): void {
  if (undoWindow !== null) clearTimeout(undoWindow);
  undoWindow = null;
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
   * A single word stamps every edited key; a per-key map is for the one case where they differ —
   * a laminate's cap can be `assumed` while the dimensions it sits beside are the user's typing
   * (#492).
   *
   * A patch that changes the thickness carries the SHIPPED-DEFAULT vise with it, re-deriving its
   * `stockProud` from the new blank (#344). A saved or measured vise is never touched.
   */
  setStock: (
    patch: Partial<EngraveJob['stock']>,
    source?: FieldSource | Partial<Record<keyof EngraveJob['stock'], FieldSource>>,
  ) => void;
  /** Add a default label and return its id. */
  addLabel: () => string;
  /**
   * #700 — an OPERATION's engrave text: laid out on the blank as it stands, and the blank route's
   * seeded placeholder is FILLED rather than printed over. Returns the label's id.
   *
   * `addLabel` is the generic door: a centre-of-stock line with a fixed 10 mm size, which is right
   * for a placeholder a person then drags. The wizard's step 4 is not a placeholder — the operator
   * typed the text and pressed Create — so the line it makes has to fit the blank it will be cut
   * on. That is `blankLabelSeed`'s own layout (the free band beside a blank's pocket, inset by the
   * edge margin, sized to the band and centred), which the badge route already uses for its seeded
   * name (#363/#383): a badge reads along Y, a bare blank along X.
   *
   * THE STARTER'S SEED IS STEP 4'S LINE. The badge starter (and a bare blank) leaves one seeded
   * placeholder — the "Name" / "Text" line, stamped `seed` by the route — and the operator's text
   * is exactly what it was for. An UNTOUCHED seed (its `seed` stamp still there, so no person has
   * edited it) has its text, depth and font replaced in place, same id, re-fitted; no second line.
   * A seed the operator has edited is theirs: the operation's line is ADDED, and the seed's avoid
   * rule sends it to the next free band rather than over the edited one (they overlap only when no
   * band has room left — the findings still say so, and the operator can move it).
   *
   * The line is stamped as the PERSON's (`layout: 'user'`, `depth: 'user'`), exactly as the
   * wizard's former `addLabel` + `updateLabel` pair stamped it, so a later blank change does not
   * re-lay their text. The fallback, when nothing fits at 1 mm or the blank is empty, keeps the
   * placeholder's placement (or `addLabel`'s centre): the findings report the blank honestly
   * rather than the action throwing.
   */
  addEngraveText: (text: string, opts: { depth: number; font: string; reads?: 'along' | 'around' }) => string;
  updateLabel: (id: string, patch: Partial<EngraveLabel>) => void;
  removeLabel: (id: string) => void;
  /** Set the cutter and stamp its source (#254). Defaults to `'user'`. */
  setTool: (key: string, source?: FieldSource) => void;
  /** #572 — record (or clear) the double-confirmed cutter/material override. */
  setMetalLineOverride: (override: boolean) => void;
  setVise: (patch: Partial<ViseParams>) => void;
  /**
   * #240 — hold the rod in the rotary module's three-jaw chuck, or return it to the vise, in ONE
   * undoable write.
   *
   * The workholding and the stock box are one fact, so one action writes both and they cannot
   * disagree: in the chuck the rod lies along the AXIS FRAME (`length` along X,
   * `width = thickness = diameter`, `shape: 'cylinder'`), while the same rod in the vise stands on
   * its END (`D × D × L`, #683). `rotary` null is the vise; the answers' vise and sacrificial are
   * written in the same step. A job that is not round stock is left unchanged — the Holding step's
   * own rule is what says the rotary needs a rod.
   */
  setRotaryHolding: (rotary: RotaryChuck | null, vise: ViseParams, sacrificial?: Sacrificial) => void;
  /**
   * #715 — hold the job on the BED (taped, or in the bracket with its clamps), or take it back to
   * the vise, in ONE undoable write. The workholding and the sacrificial are one fact: the board
   * under the part belongs to the mount it is taped to. `null` is the vise, with the answers'
   * vise and sacrificial. A rod lying in the rotary's axis frame is stood on its end again, so the
   * job never keeps a box that says it is in a chuck nobody selected.
   */
  setBedHold: (hold: TapeHold | BracketHold | null, vise: ViseParams, sacrificial: Sacrificial) => void;
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
  /**
   * #664 — add an imported open path as an Engrave (line) operation. The item is built by
   * `toLineTraces` (an id already minted); this is only the document write, like `addVector`.
   */
  addLine: (line: EngraveLineItem) => void;
  /**
   * Add a default hole of `kind` (#220) and return its id. `mode: 'bore'` (#668) makes it a HOLE
   * TO SIZE, seeded with a clearance diameter over the job's cutter; absent is a plunge drill.
   */
  addDrill: (kind: EngraveDrill['kind'], opts?: { mode?: 'drill' | 'bore' }) => string;
  /** Merge a hand edit into one drill (#220). A partial `position` is merged, not replaced. */
  updateDrill: (id: string, patch: DrillPatch) => void;
  removeDrill: (id: string) => void;
  /** Add a chamfer on the job's first rim (#669) and return its id. */
  addChamfer: () => string;
  /** Merge a hand edit into one chamfer (#669). */
  updateChamfer: (id: string, patch: ChamferPatch) => void;
  removeChamfer: (id: string) => void;
  /** Add a default milled thread (#445) and return its id. */
  addThread: () => string;
  /** Merge a hand edit into one thread (#445). A partial `position` is merged, not replaced. */
  updateThread: (id: string, patch: ThreadPatch) => void;
  removeThread: (id: string) => void;
  /** Add a default 3D primitive of `kind` (#435) and return its id. */
  addPrimitive: (kind: EngravePrimitive['kind']) => string;
  /** Merge a hand edit into one primitive (#435). A partial `position` is merged, not replaced. */
  updatePrimitive: (id: string, patch: PrimitivePatch) => void;
  removePrimitive: (id: string) => void;
  /**
   * Set the reference object the primitives are positioned against (#435), replacing any existing
   * one. The caller has already read, hashed and embedded the file (`targetObject.ts`); this is
   * only the document write.
   */
  setTargetObject: (target: EngraveTargetObject) => void;
  /** Merge a placement/visibility edit into the target object (#435). No-op when there is none. */
  updateTargetObject: (patch: TargetObjectPatch) => void;
  removeTargetObject: () => void;
  /** Add a profile cut-out (#218) with the shop's tab numbers and return its id. */
  addCutout: () => string;
  /** Merge a hand edit into one cut-out (#218). A partial `tabs` is merged, not replaced. */
  updateCutout: (id: string, patch: CutoutPatch) => void;
  removeCutout: (id: string) => void;
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
  removeKeepOut: (id: string, undoable?: boolean) => void;
  /**
   * Take a `BadgeBlank` as this job's blank (#271 route 1, #352) — the ONE owner of that write,
   * shared by the wizard's stock step / hand-off seed and every door starter, so two of them
   * cannot drift into two versions of "the badge is the blank". (#686 deleted the panel's own
   * button; the panel now only reads the blank this writes.)
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
   * Take a PrusaSlicer design as this job's blank, its items and its void (#410 item 4) — the third
   * source of a blank beside the badge and the bare blank, and the only one that also brings ITEMS.
   *
   * The patch is `designJobFor`'s, read out of the file in the sim worker: this method owns the
   * WRITE, exactly as `takeBadgeBlank` owns its own, so the panel and any future caller cannot drift
   * into two versions of "the file is the job". Three writes, in this order:
   *
   *   1. the STOCK, through `setStock` — the one place the `stockProud` re-derivation and the vise
   *      follow (#344) live, rather than a second copy of them here;
   *   2. the VOID the design brought, under its fixed id (`DESIGN_POCKET_KEEP_OUT_ID`), or that id
   *      removed when the file has no pocket. Voids under any other id are the person's and stay;
   *   3. the ITEMS — see `designReplacesItems`: over a job that is still the app's own, the design's
   *      vectors REPLACE the demo words (they are laid out for a 100 × 60 mm plank and would be cut
   *      into the badge); over a job a person has worked on, they are ADDED and the job reports what
   *      no longer fits. An item whose `importedFrom` is the same design source is the exception to
   *      both: re-importing that file REPLACES its own items rather than adding a second set (#437),
   *      and an identical hash is a no-op — `mergeDesignItems` holds that rule.
   *
   * The cutter and the feeds are untouched: a design states no cutter, and which bit cuts it is the
   * reachability decision the panel makes with the numbers in front of it (#410's second half).
   */
  takeDesign: (patch: DesignJobPatch) => void;
  /**
   * Record one file the job was made from (#425 §4), content-addressed by its SHA-256 so the same
   * file named twice stays one record. The caller has already hashed and embedded it
   * (`jobSources.ts`); this is only the document write, and it takes the same `apply` path as
   * every other edit. Never removes a record: a stale one is verification's to report, not a
   * write's to hide.
   */
  addSourceFile: (source: JobSource) => void;
  /**
   * Write (or clear) the package block the document owns (#425, R8).
   *
   * The document is the one authority: a freeze, a Save and an Open all agree because they read
   * `job.package`, not a browser cache. A package frozen for a DIFFERENT job id is ignored — the
   * document cannot describe someone else's run — and writing one PRUNES the run log to the
   * programs the new package carries (`pruneRunLog`), so an outcome for a program that no longer
   * exists cannot answer the resume question.
   *
   * `null` removes the key. Save never creates a package; only Cut's freeze does.
   */
  setPackage: (pkg: FrozenPackage | null) => void;
  /**
   * Append one program outcome to the document's run log (#425 §6). The one write a run end makes:
   * `finished` means done, `stopped`/`failed` means the program is played again. Appending does not
   * touch the package or its fingerprint (`jobFingerprint` excludes `runLog`), so it can never
   * stale a package it did not change.
   */
  appendRunLog: (entry: JobRunLogEntry) => void;
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
   * The removals the panel may still take back (#411), oldest first — a STACK, so each one can be
   * undone in turn. The panel draws a strip for the top, at the list it came out of.
   *
   * Removing an item is the one destructive press in this panel and it sits at the FRONT of every
   * row, where a slip is easy — so the removal leaves this behind and the panel draws an inline
   * strip at the removal site instead of a dialog (the maintainer's decision, and the reason it is
   * not an app-wide toast: the undo belongs where the thing was). It is cleared by the NEXT WRITE
   * of any kind, which is `apply`'s doing rather than a timer, and it is not part of the document:
   * `persist` writes `job` alone, so a reopen has nothing stale to offer.
   */
  removalUndo: readonly PendingRemoval[];
  /**
   * Put the most recently removed item back where it was, and retire that strip. The one under it
   * stays on the stack for its own undo — see `REMOVAL_UNDO_MS` for when the stack goes away.
   */
  undoRemove: () => void;
  /**
   * Replace the sacrificial material model (#213). The caller owns `source`: the panel passes
   * `'saved'` for an edit it made, a preset carries its own, `noneSacrificial()` clears it.
   */
  setSacrificial: (sacrificial: Sacrificial) => void;
  /**
   * The job's facing choice (#432 slice 4), replaced whole: the panel's toggle and depth field are
   * the only writers, and each one sends the complete `{ enabled, depth }`. `null` deletes the key,
   * which is the pre-#432 state — no facing section on the sheet and nothing faced.
   */
  setFacing: (facing: EngraveFacing | null) => void;
  /**
   * Replace the job's saved setups (#471). Once present the list is AUTHORITATIVE: the section
   * writes it whole on every authoring action, and no item edit rewrites it behind the person's
   * back — a removed item is surfaced as `setup-item-missing` and the person chooses. `null`
   * deletes the field, returning the job to the implicit single setup (the pre-#419 reading); it
   * does not store an empty list.
   *
   * Approvals (`registration`, `remount`) travel on the records the caller sends: the section
   * uses `applySetupChange` to drop the ones an edit invalidates. This action deliberately does
   * not prune or re-derive anything itself.
   */
  setSetups: (setups: JobSetup[] | null) => void;
  /**
   * #667 — pair a setup's rough cutter with a REST cutter: the region row's "Finish the corners
   * with a smaller cutter". The pair is the setup's `tools[1]`, the engine's own unit, and a job
   * with no stored setups MATERIALISES them first — the implicit single setup has no list to
   * write to, and a rest pass is a property of a setup. `null` returns the setup to one cutter.
   *
   * A no-op when the item is in no setup or the setup names no first cutter (there is nothing to
   * pair with). The control offers only smaller cutters; the rest measurement and the setup's
   * own findings are the authority on the pair, not this write.
   */
  setRestCutter: (itemId: string, restKey: string | null) => void;
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
  /**
   * Apply step 3's holding answers — the vise and the sacrificial — in one write (#254, #684).
   * The stock and its provenance are step 2's; they are left exactly as they are.
   */
  applyHoldAnswers: (answers: SetupAnswers) => void;
  /**
   * Set this job's own depth margins, or clear them back to the house setting (#345). The
   * panel's "use the recommendation" passes `{ ...rec, source: 'recommended' }`; `null` deletes
   * the key, which is the same state every stored job is in and the one a settings change then
   * reaches.
   */
  setJobMargins: (margins: EngraveMargins | null) => void;
  replace: (job: EngraveJob) => void;
  reset: () => void;
  /**
   * #720 — where the target mesh's bytes are: absent (no target), 'loading' (the persisted job
   * names a hash and the blob store is being asked), 'ready' (the open job holds them), or
   * 'missing' (this browser no longer has them — the job says so and asks for an import again),
   * or 'unstored' (#728: the open job holds them but the blob store refused the copy — quota, a
   * private window — so a reload would lose them; the job says so and asks for a file save).
   * Store state, never persisted: the document carries only hash, size and name.
   */
  targetBlob: TargetBlobState;
}

/** #720 — the target mesh's byte state in this session (see `EngraveJobState.targetBlob`). */
export type TargetBlobState = 'none' | 'loading' | 'ready' | 'missing' | 'unstored';

/**
 * #728 — write a mesh's bytes to the blob store, and say so when it is refused. The write was
 * fire-and-forget: a quota or private-window refusal lost the mesh at the next reload without a
 * word. A refusal now marks the open target 'unstored' (if it is still the one written), which
 * the findings turn into a sentence. A write that dies with the tab still reads 'missing' on the
 * next start-up, as before.
 */
function storeTargetMesh(sha256: string, data: string): void {
  void putMeshBlob(sha256, data).catch(() => {
    const s = useEngraveJobStore.getState();
    if (s.job.targetObject?.sha256 === sha256 && s.job.targetObject.data !== undefined) {
      useEngraveJobStore.setState({ targetBlob: 'unstored' });
    }
  });
}

/**
 * #728 — after a write that may have put a target back (an undo), the blob state follows the
 * target: bytes in hand are written to the store again (a refusal says so again, as at import), a
 * hash alone is fetched again, none is none. Undoing a removal made while the mesh was still
 * loading used to leave it detached for good.
 */
function syncTargetBlob(): void {
  const target = useEngraveJobStore.getState().job.targetObject;
  if (target === undefined) {
    useEngraveJobStore.setState({ targetBlob: 'none' });
  } else if (target.data === undefined) {
    useEngraveJobStore.setState({ targetBlob: 'loading' });
    void reattachTargetBlob();
  } else {
    useEngraveJobStore.setState({ targetBlob: 'ready' });
    storeTargetMesh(target.sha256, target.data);
  }
}

/**
 * #720 — ask the blob store for the mesh the persisted job names, and put it back into the open
 * job. Called at store start-up and whenever a document without bytes lands; a miss is a state
 * the findings read ('missing'), never a silent empty goal. Re-reads the job before writing, so a
 * reload or an edit in the meantime is not overwritten.
 */
export async function reattachTargetBlob(): Promise<void> {
  const target = useEngraveJobStore.getState().job.targetObject;
  if (target === undefined || target.data !== undefined) return;
  const sha = target.sha256;
  let data: string | null = null;
  try {
    data = await getMeshBlob(sha);
  } catch {
    data = null;
  }
  const current = useEngraveJobStore.getState().job.targetObject;
  if (current === undefined || current.sha256 !== sha || current.data !== undefined) return;
  if (data === null) {
    useEngraveJobStore.setState({ targetBlob: 'missing' });
    return;
  }
  useEngraveJobStore.setState((s) => ({
    job:
      s.job.targetObject !== undefined && s.job.targetObject.sha256 === sha
        ? { ...s.job, targetObject: { ...s.job.targetObject, data } }
        : s.job,
    targetBlob: 'ready',
  }));
  persist(useEngraveJobStore.getState().job);
}

/** The blob state a job's target starts in: the open job with bytes is ready, without is loading. */
function initialTargetBlob(job: EngraveJob): TargetBlobState {
  if (job.targetObject === undefined) return 'none';
  return job.targetObject.data === undefined ? 'loading' : 'ready';
}

/**
 * #720 — the job read at start-up, put in step with the blob store. A job WRITTEN before this
 * slice (or read from the v1 legacy slot) still embeds its mesh: its bytes must reach the store
 * BEFORE the next persist strips them, or the first reload after the upgrade loses the mesh. A
 * job that starts without bytes asks the store for them instead.
 */
export function adoptInitialTargetBlob(job: EngraveJob): void {
  const target = job.targetObject;
  if (target === undefined) return;
  if (target.data !== undefined) storeTargetMesh(target.sha256, target.data);
  else void reattachTargetBlob();
}

const initialJob = loadJob();

export const useEngraveJobStore = create<EngraveJobState>()((set, get) => {
  /** Arm the 8 s window for whatever is on top now; an empty stack has nothing to retire. */
  const armUndoWindow = (): void => {
    clearUndoWindow();
    if (get().removalUndo.length === 0) return;
    undoWindow = setTimeout(() => {
      undoWindow = null;
      set({ removalUndo: [] });
    }, REMOVAL_UNDO_MS);
  };

  const apply = (mutate: (job: EngraveJob) => EngraveJob): void => {
    // Every write retires the undo stack (#411) — the maintainer's "until the next edit", as a
    // consequence of the one path all writes take rather than a timer or a per-call-site rule.
    clearUndoWindow();
    set((s) => ({ job: mutate(s.job), removalUndo: [] }));
    persist(get().job);
  };

  /**
   * A person's removal (#411): take the item out, then leave the undo behind — ON TOP of whatever
   * undos are already there, so a second removal in quick succession does not throw the first one
   * away (the maintainer's decision on the review).
   *
   * `restore` is a whole-job function of its own rather than a re-insert through an `addX`, because
   * an add builds a DEFAULT item at the end of the list — that is a different item in a different
   * place, and the undo would silently lose the text, the depth and the row's position in the run
   * sheet. `at` is where the item sat; nothing can move in between, because any other write clears
   * the stack (see `apply`).
   */
  const removeWithUndo = (
    mutate: (job: EngraveJob) => EngraveJob,
    what: string,
    restore: (job: EngraveJob) => EngraveJob,
    section: PendingRemoval['section'] = 'items',
  ): void => {
    // Read the stack BEFORE `apply`, which is about to retire it: this removal's own write is one
    // of the writes that clears the stack, and the undos under it are not this press's to lose.
    const earlier = get().removalUndo;
    apply(mutate);
    set({ removalUndo: [...earlier, { what, section, restore: () => apply(restore) }] });
    armUndoWindow();
  };

  /** `Item at index 3` back into the list it came from, clamped for a list that has shrunk. */
  const insertAt = <T>(list: readonly T[], at: number, item: T): T[] => {
    const next = [...list];
    next.splice(Math.max(0, Math.min(at, next.length)), 0, item);
    return next;
  };

  /**
   * What the strip calls this item: the kind's word, and the item's own name when it has one —
   * `Label “CASE”`, `Rectangle “Face”`, `Hole array`. The words come from `itemKindWord` and
   * `itemRowName` (#411), the same two the collapsed line reads, so the strip cannot name a thing
   * differently from the row it took it from.
   */
  const removalWhat = (item: EngraveNamedItem, kindWord = itemKindWord(item)): string => {
    const name = itemRowName(item);
    return name === '' ? kindWord : `${kindWord} “${name}”`;
  };

  return {
    job: initialJob,
    targetBlob: initialTargetBlob(initialJob),

    // #347 — the id alone, and no other field. See the interface's own doc for why.
    setMachine: (id) => apply((job) => (job.machineId === id ? job : { ...job, machineId: id })),

    setStock: (patch, source = 'user') =>
      apply((job) => {
        const keys = (Object.keys(patch) as (keyof EngraveJob['stock'])[]).filter(
          (k) => patch[k] !== undefined,
        );
        const stock = { ...job.stock, ...patch };
        // #240/#713 — ONE BOX, WHICHEVER WAY THE ROD LIES. A rotary job's box is the axis frame
        // (`L × D × D`), while the stock step speaks a rod's or tube's own numbers in its standing
        // box (`D × D × L`, #683). Re-express a round-stock write in the frame the job is held in, so
        // the workholding and the box cannot disagree. Any other write is taken as stated: the
        // Holding step is where the mount is chosen, and its round-stock rule is what turns the
        // rotary off when the new stock is not round.
        //
        // #713 — the stock step RESTATES the whole round fact (shape, diameter, wall) with the box,
        // so such a write is taken as stated and never re-derived: its box is already the standing
        // frame. Only a partial edit (a panel's one number) keeps the cross-section invariant.
        const restatesRound = 'shape' in patch;
        const patchRod =
          patch.shape === 'cylinder' &&
          patch.length !== undefined &&
          patch.width !== undefined &&
          patch.thickness !== undefined &&
          Math.abs(patch.length - patch.width) <= 1e-9;
        const extraKeys: (keyof EngraveJob['stock'])[] = [];
        if (job.workholding.kind === 'rotary-chuck' && patchRod) {
          Object.assign(stock, rotaryBoxForRod(patch.width!, patch.thickness!));
          extraKeys.push('diameter');
        } else if (!restatesRound && stock.shape === 'cylinder') {
          // #240 — a round box's cross-section is ONE number: `width` and `diameter` move together,
          // and so does the other axis of the frame the box lies in — `thickness` in the axis frame,
          // `length` in the standing frame.
          const frame = cylinderFrameOf(stock) ?? 'axis';
          const diameter = patch.diameter ?? patch.width ?? (frame === 'standing' ? patch.length : patch.thickness);
          if (diameter !== undefined) {
            stock.width = diameter;
            stock.diameter = diameter;
            if (frame === 'standing') stock.length = diameter;
            else stock.thickness = diameter;
            extraKeys.push('width', 'diameter', frame === 'standing' ? 'length' : 'thickness');
          }
        }
        // `colour`, `flatness` and `fibre` are the stock fields a patch can CLEAR (#285 review,
        // #345, #464, #492). "Use the badge blank" on a badge that has lost its print must take the
        // colour facts away with it, or the stack limit goes on applying to a blank whose print is
        // no longer known — and the measured bow (`flatness`, #496) was taken on the SAME clamped
        // piece, so it goes with it too. The fibre flag goes for the same reason a design import
        // states it beside the material: re-importing a plain PETG file over a `PETG-CF` one must
        // stop the runs being weighed as abrasive. An explicit `undefined` says that; an OMITTED
        // key still means "leave it alone", which is what every other caller relies on — a laminate
        // imported from a design that states no print facts keeps the cap its stock entry gave it.
        // The provenance goes with it — a source for a value that is gone is a lie. #713 — the same
        // for the round facts: a stock-choice write states them as absent when the new piece is a
        // rectangle, and they must not survive a rod-to-plate edit.
        const sources = withStockSource(job, [...keys, ...extraKeys], source);
        for (const key of ['colour', 'flatness', 'fibre', 'shape', 'diameter', 'wall'] as const) {
          if (key in patch && patch[key] === undefined) {
            delete stock[key];
            if (sources.stock) delete sources.stock[key];
          }
        }
        // The vise follows a blank that changes size (#344) — see `viseAfterStockEdit`.
        const vise = viseAfterStockEdit(job, patch);
        const next = { ...job, stock, sources };
        // #240 — a rotary job keeps its workholding. The neutral vise above is the panel's
        // stand-in, not an answer; returning to the vise is the Holding step's own write.
        return job.workholding.kind !== 'vise' || vise === job.workholding.vise
          ? next
          : { ...next, workholding: { ...job.workholding, vise } };
      }),

    addLabel: () => {
      const label = newLabel(get().job, newItemDepthFor(get().job));
      apply((job) => ({ ...job, labels: [...job.labels, label] }));
      return label.id;
    },

    addEngraveText: (text, opts) => {
      const job = get().job;
      const measure = labelGlyphMeasure(job.customFonts ?? []);
      // #700 — the badge starter (or a bare blank) leaves ONE seeded placeholder line. Step 4's
      // text is what that line was for, so it FILLS it: same id, new text/depth/font, re-fitted —
      // never a second line printed on top of the first. A line the operator has touched is not a
      // placeholder (the seed stamp is cleared by `updateLabel`), and then the new line is added
      // and placed clear of it.
      const placeholder = job.labels.find((l) => isSeedPlaceholder(job, l.id)) ?? null;
      const others = job.labels.filter((l) => l.id !== placeholder?.id);
      const pocket = (job.keepOuts ?? []).find((k) => k.id === BADGE_POCKET_KEEP_OUT_ID);
      // #752 R-UI-4 — a ROTARY job's blank is its MAP: along is the stick-out, around is the
      // circumference. Laying a line out on the rod's diameter box put it in a 20 mm band; the map
      // is what the operator places text against (`rotary-flow.md` §3.7), so the seed reads it.
      const map = rotaryMapOf(job);
      const fit = blankLabelSeed({
        blank:
          map !== null
            ? { length: map.stickout, width: map.circumference, pocket: null }
            : {
                length: job.stock.length,
                width: job.stock.width,
                pocket: pocket?.kind === 'rect' ? pocket : null,
              },
        edgeMargin: job.edgeMargin,
        text,
        font: opts.font,
        weight: placeholder?.weight ?? others[0]?.weight ?? 'bold',
        depth: opts.depth,
        // #383/#700 — a badge's name reads along its long side; another blank follows its own line.
        // #752 — a ROTARY job's step asks Reads (along / around), and that answer wins: 'around'
        // turns the line 90° on the map (the same `rotation: 90` blankLabelSeed gives a badge).
        textAlong: opts.reads === 'around' ? 'y' : opts.reads === 'along' ? 'x' : textAlongFor(job),
        // The shop's band fill (#451), read here because `blankLabelSeed` is pure.
        bandFill: shopDefault('engrave.blankBandFill').value,
        measure,
        // A second line takes the next free band rather than printing over the first.
        avoid: labelAvoidBoxes(others, measure),
      });
      // Nothing at 1 mm fits, or the text is empty: keep the placeholder's own placement (or the
      // generic centre placement when there was none); the job's findings say why it is refused.
      const label =
        fit ??
        (placeholder !== null
          ? { ...placeholder, text, font: opts.font, depth: opts.depth }
          : { ...newLabel(job, opts.depth), text, font: opts.font });
      // The wizard's former `addLabel` + `updateLabel` pair stamped the text and its layout as the
      // person's; this write keeps that (the operator typed the text and pressed Create), and the
      // placeholder stamp is gone because the line is no longer a placeholder.
      const claim = { depth: 'user' as const, layout: 'user' as const };
      if (placeholder !== null) {
        const filled = { ...label, id: placeholder.id };
        apply((current) => ({
          ...current,
          labels: current.labels.map((l) => (l.id === placeholder.id ? filled : l)),
          sources: {
            ...(current.sources ?? {}),
            labels: { ...(current.sources?.labels ?? {}), [placeholder.id]: claim },
          },
        }));
        return placeholder.id;
      }
      apply((current) => ({
        ...current,
        labels: [...current.labels, label],
        sources: {
          ...(current.sources ?? {}),
          labels: { ...(current.sources?.labels ?? {}), [label.id]: claim },
        },
      }));
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
        // #700 — any person's edit takes the label out of the placeholder set, so the wizard's
        // operation text adds a second line rather than overwriting what they changed.
        if (patch.depth !== undefined || LAYOUT_FIELDS.some((key) => key in patch) || 'depthIntent' in patch) {
          delete claim.seed;
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

    removeLabel: (id) => {
      const at = get().job.labels.findIndex((l) => l.id === id);
      const label = get().job.labels[at];
      if (!label) return;
      // #411 — the undo has to bring the CLAIMS back too, not just the label: a depth the person
      // typed and a layout the app refused to re-lay are what the document says about this line, and
      // a restore that dropped them would hand the next blank change a label it may re-depth.
      const claim = get().job.sources?.labels?.[id];
      removeWithUndo(
        (job) => {
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
        },
        removalWhat(label, 'Label'),
        (job) => {
          if (!claim) return { ...job, labels: insertAt(job.labels, at, label) };
          return {
            ...job,
            labels: insertAt(job.labels, at, label),
            sources: {
              ...(job.sources ?? {}),
              labels: { ...(job.sources?.labels ?? {}), [label.id]: claim },
            },
          };
        },
      );
    },

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

    setMetalLineOverride: (override) => apply((job) => ({ ...job, metalLineOverride: override })),

    addShape: (kind) => {
      const shape = newShape(kind, get().job, newItemDepthFor(get().job));
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

    removeShape: (id) => {
      const at = get().job.shapes.findIndex((s) => s.id === id);
      const shape = get().job.shapes[at];
      if (!shape) return;
      removeWithUndo(
        (job) => ({ ...job, shapes: job.shapes.filter((s) => s.id !== id) }),
        removalWhat(shape),
        (job) => ({ ...job, shapes: insertAt(job.shapes, at, shape) }),
      );
    },

    addCombined: (kind) => {
      const item = newCombined(kind, get().job, newItemDepthFor(get().job));
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

    removeCombined: (id) => {
      const list = get().job.combined ?? [];
      const at = list.findIndex((c) => c.id === id);
      const item = list[at];
      if (!item) return;
      removeWithUndo(
        (job) => ({ ...job, combined: (job.combined ?? []).filter((c) => c.id !== id) }),
        removalWhat(item),
        (job) => ({ ...job, combined: insertAt(job.combined ?? [], at, item) }),
      );
    },

    addTrace: (kind) => {
      const trace = newTrace(kind, get().job, newItemDepthFor(get().job));
      apply((job) => ({ ...job, traces: [...(job.traces ?? []), trace] }));
      return trace.id;
    },

    // #664 — an imported polyline. One write per path, the same shape as `addVector`'s.
    addLine: (line) => apply((job) => ({ ...job, traces: [...(job.traces ?? []), line] })),

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

    removeTrace: (id) => {
      const list = get().job.traces ?? [];
      const at = list.findIndex((t) => t.id === id);
      const trace = list[at];
      if (!trace) return;
      removeWithUndo(
        (job) => ({ ...job, traces: (job.traces ?? []).filter((t) => t.id !== id) }),
        removalWhat(trace),
        (job) => ({ ...job, traces: insertAt(job.traces ?? [], at, trace) }),
      );
    },

    addDrill: (kind, opts) => {
      const job = get().job;
      const mode = opts?.mode ?? 'drill';
      // #668 — a new bore starts at a clearance hole over the job's own cutter (see
      // `boreSeedDiameterMm`); a drill stays exactly the item it was.
      const drill = newDrill(kind, job, newDrillDepthMm(), mode, mode === 'bore' ? boreSeedDiameterMm(job) : null);
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

    removeDrill: (id) => {
      const list = get().job.drills ?? [];
      const at = list.findIndex((d) => d.id === id);
      const drill = list[at];
      if (!drill) return;
      removeWithUndo(
        (job) => ({ ...job, drills: (job.drills ?? []).filter((d) => d.id !== id) }),
        removalWhat(drill),
        (job) => ({ ...job, drills: insertAt(job.drills ?? [], at, drill) }),
      );
    },

    addChamfer: () => {
      const chamfer = newChamfer(get().job);
      apply((job) => ({ ...job, chamfers: [...(job.chamfers ?? []), chamfer] }));
      return chamfer.id;
    },

    updateChamfer: (id, patch) =>
      apply((job) => ({
        ...job,
        chamfers: (job.chamfers ?? []).map((chamfer) =>
          chamfer.id === id ? ({ ...chamfer, ...patch } as EngraveChamfer) : chamfer,
        ),
      })),

    removeChamfer: (id) => {
      const list = get().job.chamfers ?? [];
      const at = list.findIndex((c) => c.id === id);
      const chamfer = list[at];
      if (!chamfer) return;
      removeWithUndo(
        (job) => ({ ...job, chamfers: (job.chamfers ?? []).filter((c) => c.id !== id) }),
        removalWhat(chamfer),
        (job) => ({ ...job, chamfers: insertAt(job.chamfers ?? [], at, chamfer) }),
      );
    },

    addThread: () => {
      const thread = newThread(get().job, newThreadDepthMm());
      apply((job) => ({ ...job, threads: [...(job.threads ?? []), thread] }));
      return thread.id;
    },

    updateThread: (id, patch) =>
      apply((job) => ({
        ...job,
        threads: (job.threads ?? []).map((thread) =>
          thread.id === id
            ? ({
                ...thread,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...thread.position, ...patch.position } : thread.position,
              } as EngraveThread)
            : thread,
        ),
      })),

    removeThread: (id) => {
      const list = get().job.threads ?? [];
      const at = list.findIndex((t) => t.id === id);
      const thread = list[at];
      if (!thread) return;
      removeWithUndo(
        (job) => ({ ...job, threads: (job.threads ?? []).filter((t) => t.id !== id) }),
        removalWhat(thread),
        (job) => ({ ...job, threads: insertAt(job.threads ?? [], at, thread) }),
      );
    },

    addPrimitive: (kind) => {
      const primitive = newPrimitive(kind, get().job, newItemDepthFor(get().job));
      apply((job) => ({ ...job, primitives: [...(job.primitives ?? []), primitive] }));
      return primitive.id;
    },

    updatePrimitive: (id, patch) =>
      apply((job) => ({
        ...job,
        primitives: (job.primitives ?? []).map((primitive) =>
          primitive.id === id
            ? ({
                ...primitive,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...primitive.position, ...patch.position } : primitive.position,
              } as EngravePrimitive)
            : primitive,
        ),
      })),

    removePrimitive: (id) => {
      const list = get().job.primitives ?? [];
      const at = list.findIndex((p) => p.id === id);
      const primitive = list[at];
      if (!primitive) return;
      removeWithUndo(
        (job) => ({ ...job, primitives: (job.primitives ?? []).filter((p) => p.id !== id) }),
        // A primitive has `kind`/`name` but is not an `EngraveAnyItem`; `primitiveLabel` is its own
        // namer, so a box still reads as a box rather than a generic "item".
        primitiveLabel(primitive),
        (job) => ({ ...job, primitives: insertAt(job.primitives ?? [], at, primitive) }),
      );
    },

    setTargetObject: (target) => {
      // #720 — the bytes go BESIDE the job in the same write: the open job holds them, the
      // persisted copy keeps the hash and the blob store keeps the mesh.
      if (typeof target.data === 'string') {
        set({ targetBlob: 'ready' });
        storeTargetMesh(target.sha256, target.data);
      } else {
        set({ targetBlob: 'loading' });
      }
      apply((job) => ({ ...job, targetObject: target }));
      if (target.data === undefined) void reattachTargetBlob();
    },

    updateTargetObject: (patch) =>
      apply((job) => {
        const target = job.targetObject;
        if (!target) return job;
        const { scale: scalePatch, ...rest } = patch;
        const next: EngraveTargetObject = {
          ...target,
          ...rest,
          // Merge a partial position rather than replacing the whole object.
          position: patch.position ? { ...target.position, ...patch.position } : target.position,
        };
        // #721 — 'item' is the default, so it is stored as an absent key, never `undefined` or 'item'.
        if ('goalMode' in patch && patch.goalMode !== 'mold') delete next.goalMode;
        // #722 — `null` (or a scale of exactly 1 on every axis) drops the key: the file's own size.
        if (scalePatch !== undefined) {
          const unit =
            scalePatch === null || (scalePatch.x === 1 && scalePatch.y === 1 && scalePatch.z === 1);
          if (unit) delete next.scale;
          else next.scale = scalePatch;
        }
        // #535 — merge a partial `surface` (a key set to `undefined` is REMOVED, the row's reset),
        // and drop the block entirely once every key is gone, so a goal back on its defaults
        // serialises exactly as one that never carried the block.
        if (patch.surface) {
          // #671 — the block carries booleans (the scallop/pencil choices) as well as millimetres.
          const merged: Record<string, number | boolean> = { ...(target.surface ?? {}) };
          for (const [key, value] of Object.entries(patch.surface)) {
            if (value === undefined) delete merged[key];
            else merged[key] = value;
          }
          if (Object.keys(merged).length === 0) delete next.surface;
          else next.surface = merged as EngraveSurfaceSettings;
        }
        // #672 — the same merge for a picture goal's relief map: `undefined` removes a key and the
        // block goes away once empty, so a relief back on its defaults serialises like one that
        // never carried the block.
        if (patch.relief) {
          const merged: Record<string, number | boolean> = { ...(target.relief ?? {}) };
          for (const [key, value] of Object.entries(patch.relief)) {
            if (value === undefined) delete merged[key];
            else merged[key] = value;
          }
          if (Object.keys(merged).length === 0) delete next.relief;
          else next.relief = merged as EngraveReliefSettings;
        }
        return { ...job, targetObject: next };
      }),

    removeTargetObject: () => {
      const target = get().job.targetObject;
      if (!target) return;
      removeWithUndo(
        (job) => {
          const next = { ...job };
          delete next.targetObject;
          return next;
        },
        `Target object “${target.name}”`,
        (job) => ({ ...job, targetObject: target }),
        'target',
      );
      set({ targetBlob: 'none' });
    },

    addCutout: () => {
      // The tab numbers are the SHOP's at the moment the row is created (#218); after this the
      // job keeps them, so reopening a document never silently re-specs a cut already made.
      const tabs = tabSettings(useShopDefaultsStore.getState().defaults).settings;
      const cutout = newCutout(tabs);
      apply((job) => ({ ...job, cutouts: [...(job.cutouts ?? []), cutout] }));
      return cutout.id;
    },

    updateCutout: (id, patch) =>
      apply((job) => ({
        ...job,
        cutouts: (job.cutouts ?? []).map((cutout) =>
          cutout.id === id
            ? ({
                ...cutout,
                ...patch,
                // Merge a partial tab spec rather than replacing it: a row that changes the count
                // must not blank the width and height.
                tabs: patch.tabs ? { ...cutout.tabs, ...patch.tabs } : cutout.tabs,
              } as EngraveCutout)
            : cutout,
        ),
      })),

    removeCutout: (id) => {
      const list = get().job.cutouts ?? [];
      const at = list.findIndex((c) => c.id === id);
      const cutout = list[at];
      if (!cutout) return;
      removeWithUndo(
        (job) => ({ ...job, cutouts: (job.cutouts ?? []).filter((c) => c.id !== id) }),
        removalWhat(cutout),
        (job) => ({ ...job, cutouts: insertAt(job.cutouts ?? [], at, cutout) }),
      );
    },

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

    /**
     * Remove one void (#271). The word "void" is this call's, not `itemKindWord`'s: the row's
     * collapsed line names the FOOTPRINT ("Rectangle"), but a removal is about the blank, and the
     * strip is the one place that says so.
     *
     * `undoable: false` is for the route writes (`takeBadgeBlank`, `takeDesign`), which clear a void
     * the app itself stamped under a fixed id: nobody declared it, so there is nothing of a person's
     * to take back, and a strip appearing out of a file import would be the panel talking about
     * something the person never did.
     */
    removeKeepOut: (id, undoable = true) => {
      const list = get().job.keepOuts ?? [];
      const at = list.findIndex((k) => k.id === id);
      const keepOut = list[at];
      if (!keepOut || !undoable) {
        apply((job) => ({ ...job, keepOuts: (job.keepOuts ?? []).filter((k) => k.id !== id) }));
        return;
      }
      removeWithUndo(
        (job) => ({ ...job, keepOuts: (job.keepOuts ?? []).filter((k) => k.id !== id) }),
        removalWhat(keepOut, 'Void'),
        (job) => ({ ...job, keepOuts: insertAt(job.keepOuts ?? [], at, keepOut) }),
        'voids',
      );
    },

    // #352 — the badge's blank, applied in one place. The stock goes through `setStock` rather than
    // being written here, so the `print`/`flatness` clearing and the vise follow (#344) stay
    // `setStock`'s rules and not a second copy of them. A badge with no pocket must also CLEAR a
    // pocket an earlier badge stamped — but only the one the badge owns (`BADGE_POCKET_KEEP_OUT_ID`);
    // a void the user typed carries a `ko-…` id and is never touched.
    takeBadgeBlank: (blank) => {
      get().setStock(blank.stock, 'computed');
      if (blank.pocket) get().upsertKeepOut(blank.pocket);
      else if ((get().job.keepOuts ?? []).some((k) => k.id === BADGE_POCKET_KEEP_OUT_ID)) {
        get().removeKeepOut(BADGE_POCKET_KEEP_OUT_ID, false);
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
          // #383 — the blank is on the bench with its long side along Y (the turn
          // `badgeBlankFor` makes), and a name reads along a blank's long side, so the seed lays
          // this line out along Y too. The bare-blank route keeps the default: that blank is the
          // operator's own stock in the operator's own frame.
          textAlong: 'y',
          // The shop's band fill (#451): how much of the free band the line takes. This module
          // reads the location; `blankLabelSeed` is pure and keeps only the labelled fallback.
          bandFill: shopDefault('engrave.blankBandFill').value,
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
              // #700 — `seed` marks the line as a PLACEHOLDER the wizard's operation text may fill
              // in place; `layout: computed` still says a route laid it out (the re-lay gate).
              labels: { [seed.id]: { layout: 'computed', seed: true } },
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

    // #410 item 4 — the design file's route into an open job. See the interface's doc for the order
    // of the three writes; the notes that came with the patch are the panel's to show, not the
    // document's to hold, which is why nothing here carries them.
    takeDesign: (patch) => {
      get().setStock(patch.stock, 'computed');

      // The void: `upsertKeepOut` under the id the design's own pocket is always declared with, so a
      // second design lands on the same void. `takeBadgeBlank` reads its pocket's id out the same way
      // and for the same reason — a design that states no pocket has said the job has no such void,
      // and only THAT void is taken away.
      if (patch.keepOut) get().upsertKeepOut(patch.keepOut);
      else if ((get().job.keepOuts ?? []).some((k) => k.id === DESIGN_POCKET_KEEP_OUT_ID)) {
        get().removeKeepOut(DESIGN_POCKET_KEEP_OUT_ID, false);
      }

      const replaces = designReplacesItems(get().job);
      apply((current) => {
        if (!replaces) {
          // The person's job, with the design's items added. The blank has changed under their own
          // items, and the findings say which of them no longer fit — reported, never moved. A
          // re-import of the same design file replaces its previous import instead of appending a
          // second copy of every volume (#437); `mergeDesignItems` owns which items that means.
          return { ...current, vectors: mergeDesignItems(current.vectors ?? [], patch) };
        }
        const sources: EngraveJobSources = { ...(current.sources ?? {}), ...patch.sources };
        // The claims on the lines this call just dropped are about lines that are gone. `takeBadgeBlank`
        // deletes its own label claim map for the same reason (#363 review).
        delete sources.labels;
        return {
          ...current,
          // The project's own title, over the name the job shipped with. This branch is only reached
          // by a job the app laid out, so there is no person's name to overwrite — and a design that
          // had one to overwrite is a job a person has worked on, which is the branch above.
          name: patch.name,
          labels: [],
          shapes: [],
          combined: [],
          traces: [],
          drills: [],
          // A cut-out names an item (`of`); the items it could name were just dropped, so its
          // reference would dangle (#218). The design's own items replace the job.
          cutouts: [],
          vectors: patch.vectors,
          sources,
        };
      });

      // #362 — a depth for each line the blank has not been told about, the same walk the other two
      // blank routes end with. A no-op on the replacement branch (the design's items are vectors and
      // carry their own measured depths), and load-bearing on the other: those lines were laid out
      // and depthed for a blank this call has just replaced.
      get().redepthLabelsForBlank();
    },

    addSourceFile: (source) => {
      apply((current) => ({
        ...current,
        sourceFiles: withSource(current.sourceFiles, source),
      }));
    },

    setPackage: (pkg) => {
      apply((current) => {
        if (pkg === null) {
          const { package: _removed, ...rest } = current;
          return rest;
        }
        // A package for another job is not this document's: writing it would make `job.package`
        // disagree with `job.id`, and the staleness check would then refuse it forever.
        if (pkg.jobId !== current.id) return current;
        return {
          ...current,
          package: pkg,
          ...(current.runLog === undefined
            ? {}
            : { runLog: pruneRunLog(current.runLog, pkg.programs) }),
        };
      });
    },

    appendRunLog: (entry) => {
      apply((current) => ({
        ...current,
        runLog: [...(current.runLog ?? []), entry],
      }));
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
          // The shop's band fill (#451), read here for the same reason as the badge route above.
          bandFill: shopDefault('engrave.blankBandFill').value,
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
              // #700 — `seed` marks the line as a PLACEHOLDER the wizard's operation text may fill
              // in place; `layout: computed` still says a route laid it out (the re-lay gate).
              labels: { [seed.id]: { layout: 'computed', seed: true } },
            },
          }));
        }
      }

      // Unconditional, and after either branch (#364): the walk is right at every thickness — the
      // demo plank's own three lines are re-depthed to 3/3/3 on a 100 × 60 × 12, and left exactly
      // as they ship on a 100 × 60 × 4, whose seated blank stands too little above the jaw tops for
      // any floor to clear them (#391) — and it is the only thing that writes the seeded line's
      // real depth (#362).
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
            // #369 — and the jaw bound only where a jaw can reach this line, so the walk stops
            // re-depthing a centred line to a jaw floor that has nothing to do with it. The box is
            // measured inside (#394), off the same faces the void bound above reads.
            jawReach: labelJawReach(job, label),
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
        // would come out of the walk looking as if nobody had ever placed it. #700's `seed` stamp
        // rides across for the same reason: this walk is the app's own re-depth, not a person's
        // edit, and the line is still the placeholder step 4's text may fill.
        const merged: NonNullable<EngraveJobSources['labels']> = { ...stated };
        for (const [id, stamp] of Object.entries(stamps)) {
          const { layout, seed } = stated[id] ?? {};
          merged[id] = {
            ...(layout === undefined ? {} : { layout }),
            ...(seed === undefined ? {} : { seed }),
            ...stamp,
          };
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

    removeVector: (id) => {
      const list = get().job.vectors ?? [];
      const at = list.findIndex((v) => v.id === id);
      const vector = list[at];
      if (!vector) return;
      removeWithUndo(
        (job) => ({ ...job, vectors: (job.vectors ?? []).filter((v) => v.id !== id) }),
        removalWhat(vector),
        (job) => ({ ...job, vectors: insertAt(job.vectors ?? [], at, vector) }),
      );
    },

    setSacrificial: (sacrificial) => apply((job) => ({ ...job, sacrificial })),

    // #432 slice 4 — replaced whole, never merged: the panel sends both fields every time, and a
    // field-by-field merge would let a stale `toolKey` (slice 2's own cutter) survive a toggle it
    // has no business surviving. `null` puts the job back to the pre-#432 state exactly.
    setFacing: (facing) =>
      apply((job) => {
        if (facing === null) {
          const { facing: _dropped, ...rest } = job;
          return rest;
        }
        return { ...job, facing };
      }),

    // #471 — the section's one write of the saved list. `null` is the absence the compatibility
    // reading has always meant, so it deletes the key rather than storing `[]`.
    setSetups: (setups) =>
      apply((job) => {
        if (setups === null) {
          const { setups: _dropped, ...rest } = job;
          return rest;
        }
        return { ...job, setups };
      }),

    // #667 — the rest pair, as the setup's second tool. Materialise on first choice: the implicit
    // setup is derived from `toolKey`, and a second cutter has nowhere to live without a stored
    // list (the same materialisation the Cut plan step and the setups section already perform).
    setRestCutter: (itemId, restKey) =>
      apply((job) => {
        const setups = materializeSetups(job);
        const index = setups.findIndex((setup) => setup.itemIds.includes(itemId));
        if (index === -1) return job;
        const setup = setups[index]!;
        const first = setup.tools[0];
        if (first === undefined) return job;
        if (restKey !== null && restKey === first) return job;
        const tools = restKey === null ? [first] : [first, restKey];
        if (setup.tools.length === tools.length && setup.tools[1] === tools[1]) return job;
        const next = [...setups];
        next[index] = { ...setup, tools };
        return { ...job, setups: next };
      }),

    // Any edit to the vise makes it a SAVED value, unless the patch states its own source
    // (e.g. a re-probe writing `measured`). A default is not a measurement (decision 28).
    // A non-default value records the day it was asserted ("I just measured these", #203),
    // unless the patch already carries a date.
    setVise: (patch) =>
      apply((job) => {
        // #240 — the vise answers are the VISE's. A job in the rotary chuck has no jaw numbers on
        // screen to edit; its return to the vise is `setRotaryHolding(null, …)`, which writes the
        // vise and the standing box together.
        if (job.workholding.kind !== 'vise') return job;
        // #508 — the SEAT is a mechanism, not a measurement: choosing it on a shipped-default vise
        // re-derives `stockProud` from the seat and leaves the source alone. A patch that states a
        // jaw number, or nothing at all (the panel's "save as my vise"), is the user's own exactly
        // as before and is stamped 'saved'.
        const keys = Object.keys(patch).filter((k) => patch[k as keyof ViseParams] !== undefined);
        const seatOnly = keys.length > 0 && keys.every((k) => k === 'seat');
        const source = patch.source ?? (seatOnly ? job.workholding.vise.source : 'saved');
        const vise: ViseParams = {
          ...job.workholding.vise,
          ...patch,
          source,
          ...(source !== 'default' && !patch.measuredAt ? { measuredAt: todayISODate() } : {}),
        };
        if (patch.seat !== undefined && source === 'default') {
          vise.stockProud = defaultStockProud(job.stock.thickness, vise.seat);
        }
        return { ...job, workholding: { ...job.workholding, vise } };
      }),

    // #240 — the rotary write owns BOTH halves of the one fact. `apply` makes it one undo entry,
    // so a Ctrl+Z puts the workholding and the box back together rather than leaving a rod lying
    // in a frame that says it stands on end.
    setRotaryHolding: (rotary, vise, sacrificial) =>
      apply((job) => {
        const size = rodSizeOf(job.stock);
        if (size === null) return job;
        const { shape: _shape, diameter: _diameter, ...box } = job.stock;
        if (rotary !== null) {
          const next: EngraveJob = {
            ...job,
            stock: { ...box, ...rotaryBoxForRod(size.diameter, size.length) },
            workholding: { kind: 'rotary-chuck', rotary: { ...rotary } },
          };
          // The layout is re-stated on the map ONCE, at the frame change. A later edit to the
          // chuck's own numbers (stick-out, jaw mode, tailstock) leaves items where the operator
          // has them: the findings then say which band a moved item entered.
          return job.workholding.kind === 'rotary-chuck' ? next : centredOnRotaryFreeSpan(next);
        }
        // Back in the vise: the standing rod again, with the answers' vise and sacrificial.
        if (job.workholding.kind !== 'rotary-chuck') return job;
        return {
          ...job,
          stock: { ...box, ...standingBoxForRod(size.diameter, size.length) },
          workholding: { kind: 'vise', vise: { ...vise } },
          ...(sacrificial === undefined ? {} : { sacrificial }),
        };
      }),

    // #715 — the bed-mount write. One store write, one undo entry: the workholding, the sacrificial
    // it is taped to, and (for a rod still in the axis frame) the standing box go together. A job
    // taken back to the vise writes the answers' vise and sacrificial with it.
    setBedHold: (hold, vise, sacrificial) =>
      apply((job) => {
        const size = rodSizeOf(job.stock);
        const { shape: _shape, diameter: _diameter, ...prism } = job.stock;
        const box: EngraveJob['stock'] =
          job.stock.shape === 'cylinder' && size !== null
            ? { ...prism, ...standingBoxForRod(size.diameter, size.length) }
            : job.stock;
        // #727 F1 — THE MOUNT HAS ONE SOURCE OF TRUTH. `jobMount` reads a stored setup's mount
        // before the workholding (#419), so a job with saved setups that moved from the vise to the
        // bed kept answering `vise`: no clamp or arm obstacles, no raised travel, the vise's
        // envelope in the simulation, and the jaw rule judging a bracket job. The physical holding
        // that was just written is the truth every stored setup follows.
        const kind = hold === null ? ('vise' as const) : 'clamps' in hold ? ('bracket' as const) : ('tape' as const);
        const setups =
          job.setups === undefined
            ? undefined
            : job.setups.map((s) => ({
                ...s,
                mount: { kind, ...(kind === 'vise' ? {} : { board: sacrificial.under !== null }) },
              }));
        const next = (workholding: EngraveJob['workholding']): EngraveJob => ({
          ...job,
          stock: box,
          workholding,
          sacrificial,
          ...(setups === undefined ? {} : { setups }),
        });
        if (hold !== null) {
          return next(
            'clamps' in hold
              ? { kind: 'bracket', bracket: { ...hold, clamps: hold.clamps.map((c) => ({ ...c })) } }
              : { kind: 'tape', tape: { ...hold, where: hold.where === null ? null : { ...hold.where } } },
          );
        }
        return next({ kind: 'vise', vise: { ...vise } });
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

    applyHoldAnswers: (answers) => apply((job) => applyHoldAnswers(job, answers)),

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

    replace: (job) => {
      const target = job.targetObject;
      if (target?.data !== undefined) {
        set({ targetBlob: 'ready' });
        storeTargetMesh(target.sha256, target.data);
      } else {
        set({ targetBlob: target === undefined ? 'none' : 'loading' });
      }
      apply(() => job);
      if (target !== undefined && target.data === undefined) void reattachTargetBlob();
    },

    reset: () => {
      set({ targetBlob: 'none' });
      apply(() => newDefaultJob());
    },

    removalUndo: [],

    undoRemove: () => {
      const stack = get().removalUndo;
      const top = stack[stack.length - 1];
      if (!top) return;
      // `restore` writes through `apply`, which retires the WHOLE stack and the window — so the
      // undos underneath are put back after it rather than being lost to a write that is this
      // undo's own. An undo cannot be undone into a second removal: the restore re-inserts the item
      // and arms nothing.
      top.restore();
      syncTargetBlob();
      set({ removalUndo: stack.slice(0, -1) });
      armUndoWindow();
    },
  };
});

/**
 * Ctrl-Z's precedence rule, in one place (#411): while a removal can still be taken back, the key
 * takes THAT back.
 *
 * A removal beats the project's undo because it is the more recent, more local thing — the person
 * pressed a `✕` beside an item, not something in the case geometry — and because the alternative is
 * an undo that does nothing visible where they are looking. Once the stack is empty the key is the
 * project's again, exactly as it was before this existed: no press is swallowed.
 *
 * A free function rather than a hook so the shortcut handler reads live state at keypress time; a
 * subscribed value would be a render behind, and the handler is not re-created per render.
 *
 * Returns whether it used the press.
 */
export function undoEngraveRemoval(): boolean {
  const { removalUndo, undoRemove } = useEngraveJobStore.getState();
  if (removalUndo.length === 0) return false;
  undoRemove();
  return true;
}

/**
 * Test seam (#411): forget any removal still waiting to be taken back, and its window.
 *
 * The stack is module-level and the window is a real timer, so a spec that removed an item would
 * hand the next one a live strip — or, worse, a timeout armed on the previous spec's clock that
 * fires into a stack this one just built.
 */
export function resetEngraveRemovalUndo(): void {
  clearUndoWindow();
  useEngraveJobStore.setState({ removalUndo: [] });
}


// #720 — the start-up job and the blob store are put in step: a pre-#720 document's embedded mesh
// is stored, and a hash-only document's bytes are fetched back, before anything reads the job.
adoptInitialTargetBlob(initialJob);
