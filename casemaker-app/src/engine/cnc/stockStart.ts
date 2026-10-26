/**
 * The material-first start (#418, `docs/design/cnc-job-workflow.md` §5.1): what a picked piece of
 * stock does to a new job, or the sentence it is refused with.
 *
 * Three doors lead here, and each one is a pure function from what was chosen to the job's stock:
 *
 *   - **the shelf** (#413) — {@link stockFromShelf}: an entry the location holds;
 *   - **made** — {@link stockFromMade}: a plate, block or sheet typed in the wizard, which can be put
 *     on the shelf as it goes ({@link shelfItemFromMade});
 *   - **a file** — `engine/import/meshStock.ts` reads an STL/3MF; {@link stockFromFile} takes its size.
 *
 * WHAT A JOB'S STOCK CAN BE. `EngraveJob.stock` is a rectangle held in the vise: length × width ×
 * thickness. A sheet, plate, block or printed blank IS that. A disc or a rod is round, and its face
 * job is cut on the flat face the rectangle works out to: a disc on its top, a rod STANDING ON ITS
 * END ({@link boxForForm}). The job still plans in the rectangle around it, and the form on the
 * entry keeps the round fact for the screens. A tube is refused by name: its hole leaves no face a
 * job can cut. A sphere is not offered at all (decision Q20); the shelf already refuses one
 * (`SPHERE_REFUSAL`).
 *
 * WHAT IS NOT CARRIED. A shelf entry's `layers` carry a name and a thickness but no layer height, and
 * its `domeHeight` has no axes. Neither is invented: `colour` stays absent and the notes say so;
 * `flatness` is not the shelf's at all — a bow belongs to the piece as clamped, so the job states
 * one only from its own measurement (#496). A laminate's `capMm` IS carried
 * (#492) — it is a stated fact about the sheet, and its provenance travels with it as `assumed` or
 * `measured`. (The two-colour badge is ~1 % of jobs, §8.)
 *
 * The facing default (decision Q6) is {@link facingDefault}; the facing operation itself is #432.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { StockItem } from '@/platform/stockClient';
import { isShippedDemoLabelSet } from './engrave/blankLabelSeed';
import { VISE_FLOOR_DEPTH } from './fixture';
import type { MillProfile } from './machine';
import { isMetalMaterial, isWoodMaterial, MATERIAL_LABELS } from './materials';
import type { EngraveFacing, EngraveJob, FieldSource, JobStockEntry, JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';

/** The forms a job's stock can take, in the order the wizard's pictures offer them. */
export const JOB_STOCK_FORMS: readonly JobStockForm[] = ['plate', 'block', 'sheet', 'printed-blank', 'disc', 'rod'];

/** The size of a rectangular stock, mm: length = X, width = Y, thickness = Z. */
export interface StockBox {
  length: number;
  width: number;
  thickness: number;
}

/** The fields a form is typed in, mm — a box's three axes, or a round form's diameter and one length. */
export type StockSizeKey = 'length' | 'width' | 'thickness' | 'diameter';
export type StockSize = Partial<Record<StockSizeKey, number | null>>;

/**
 * What each form asks for, in the order it is shown (#683). The rectangular forms ask for the
 * panel's three words; a disc asks for its diameter and thickness, a rod for its diameter and its
 * length — which is its height standing on end in the vise. The form's picture decides these fields
 * and nothing else about the cut.
 */
export const STOCK_SIZE_FIELDS: Readonly<Record<JobStockForm, readonly StockSizeKey[]>> = {
  plate: ['length', 'width', 'thickness'],
  block: ['length', 'width', 'thickness'],
  sheet: ['length', 'width', 'thickness'],
  'printed-blank': ['length', 'width', 'thickness'],
  disc: ['diameter', 'thickness'],
  rod: ['length', 'diameter'],
};

/**
 * The rectangular box a form's own numbers make, mm. The job plans in one rectangle, and the form
 * is held so its cut face is a FLAT one:
 *
 *   - a disc ⌀D × T is D wide, D deep and T tall, cut on its flat top;
 *   - a rod ⌀D × L stands on its end in the vise: D wide, D deep and L tall, cut on that ⌀D end.
 *     Lying on its side the top would be curved — a flat plan would cut full depth only on the
 *     centreline, and the vise would grip the rod on two lines ({@link ROD_VISE_MAX_LENGTH_MM}).
 *
 * Null when a number the form needs is missing. A tube is not a job form; `formProblem` refuses it.
 */
export function boxForForm(form: JobStockForm, size: StockSize): StockBox | null {
  const has = (key: StockSizeKey): number | null => {
    const v = size[key];
    return v === null || v === undefined ? null : v;
  };
  if (form === 'disc') {
    const diameter = has('diameter');
    const thickness = has('thickness');
    return diameter === null || thickness === null ? null : { length: diameter, width: diameter, thickness };
  }
  if (form === 'rod') {
    const diameter = has('diameter');
    const length = has('length');
    return diameter === null || length === null ? null : { length: diameter, width: diameter, thickness: length };
  }
  const length = has('length');
  const width = has('width');
  const thickness = has('thickness');
  return length === null || width === null || thickness === null ? null : { length, width, thickness };
}

/**
 * The tallest rod the vise holds standing on its end, mm: the jaws' grip, from the vise body's floor
 * to the tops of the jaws. The same number the vise model uses for its floor ({@link VISE_FLOOR_DEPTH}),
 * so a rod the wizard offers is one the holding model can seat. A longer rod is the rotary's (§3.3)
 * and the form says so; it is not offered here until the rotary is.
 */
export const ROD_VISE_MAX_LENGTH_MM: number = VISE_FLOOR_DEPTH;

/** Why a rod's length is past the vise's grip, or null. The length is its height standing on end. */
export function rodGripProblem(size: StockSize): string | null {
  const length = size.length;
  if (length === null || length === undefined || !Number.isFinite(length)) return null;
  if (length <= ROD_VISE_MAX_LENGTH_MM) return null;
  return (
    `A rod this long is held in the rotary — the vise holds one up to ${mm(ROD_VISE_MAX_LENGTH_MM)} mm tall ` +
    'standing on its end, and this one is ' + `${mm(length)} mm.`
  );
}

/** What a choice does to the new job: its stock, where it came from, and what to tell the user. */
export interface StockChoice {
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material' | 'colour'>;
  entry: JobStockEntry;
  /**
   * Where the entry's cap came from (#492), when it carried one. The stock's own dimensions and
   * material are the user's statement; a laminate cap may be the maintainer's ASSUMED 0.075 mm,
   * which must not be presented as measured.
   */
  colourSource?: FieldSource;
  notes: string[];
}

export type StockChoiceResult = { ok: true; choice: StockChoice } | { ok: false; reason: string };

function mm(v: number): string {
  return String(Number(v.toFixed(3)));
}

export function isJobForm(form: string): form is JobStockForm {
  return (JOB_STOCK_FORMS as readonly string[]).includes(form);
}

/**
 * Why a form cannot be a job's stock, or null. A disc and a rod ARE offered (#683). A rod longer
 * than the vise's grip is the rotary's: it is not refused here by name — the form's own sentence
 * says it ({@link rodGripProblem}) and that form's Next is blocked with the sentence at the button.
 * A tube is refused by name — its hole leaves no face to cut.
 */
export function formProblem(form: string): string | null {
  if (isJobForm(form)) return null;
  if (form === 'tube') {
    return 'a tube is round stock with a hole through it — there is no face a job can cut, and cutting around it needs the rotary';
  }
  if (form === 'sphere') return 'sphere stock is not offered — nothing at the location holds one and nothing here cuts one';
  return `"${form}" is not a stock form a job can start from`;
}

/** The machine's travel on each axis, mm. */
function travel(machine: MillProfile): StockBox {
  const e = machine.envelope;
  return {
    length: Number((e.x.max - e.x.min).toFixed(3)),
    width: Number((e.y.max - e.y.min).toFixed(3)),
    thickness: Number((e.z.max - e.z.min).toFixed(3)),
  };
}

/**
 * Why a box will not go on this machine, naming the axis, or null (§5.1 validation). A dimension that
 * is not a positive number is named first: it is the one a typed draft gets wrong.
 */
export function boxProblem(box: StockBox, machine: MillProfile): string | null {
  const names = { length: 'length', width: 'width', thickness: 'thickness' } as const;
  for (const key of ['length', 'width', 'thickness'] as const) {
    const v = box[key];
    if (!Number.isFinite(v) || v <= 0) return `the ${names[key]} needs a number in mm, above 0`;
  }
  const t = travel(machine);
  if (box.length > t.length) {
    return `${mm(box.length)} mm long is more than the ${machine.name}'s ${mm(t.length)} mm X travel`;
  }
  if (box.width > t.width) {
    return `${mm(box.width)} mm wide is more than the ${machine.name}'s ${mm(t.width)} mm Y travel`;
  }
  if (box.thickness > t.thickness) {
    return `${mm(box.thickness)} mm thick is more than the ${machine.name}'s ${mm(t.thickness)} mm Z travel`;
  }
  return null;
}

/** How many of an entry are free — on the shelf and not held for another job. */
function free(item: StockItem): number {
  return item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
}

/**
 * Why a form's own numbers will not do, naming the field the operator sees, or null. A missing
 * diameter must not be answered as "the length needs a number" — the screen has no length field for
 * a disc (#683).
 */
export function formSizeProblem(form: JobStockForm, size: StockSize, machine: MillProfile): string | null {
  for (const key of STOCK_SIZE_FIELDS[form]) {
    const v = size[key];
    if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) {
      return `the ${key} needs a number in mm, above 0`;
    }
  }
  if (form === 'rod') {
    const grip = rodGripProblem(size);
    if (grip !== null) return grip;
  }
  const box = boxForForm(form, size);
  return box === null ? null : boxProblem(box, machine);
}

/**
 * Why a shelf entry cannot start this job, or null. Shown beside the entry, which stays listed: a
 * piece that is used up or held is a fact about the shelf the operator should see, not a gap (§5.1).
 */
export function shelfPickProblem(item: StockItem, machine: MillProfile): string | null {
  if (item.quantity === 0) {
    const last = item.consumed[item.consumed.length - 1];
    return last ? `none left — consumed by ${last.jobId}` : 'none left on the shelf';
  }
  if (free(item) <= 0) return `all ${item.quantity} held for other jobs`;
  const form = formProblem(item.form);
  if (form !== null) return form;
  const box = boxForForm(item.form as JobStockForm, item.size);
  if (box === null) return `the ${item.form}'s size is not complete on the shelf`;
  if (item.form === 'rod') {
    const grip = rodGripProblem(item.size);
    if (grip !== null) return grip;
  }
  return boxProblem(box, machine);
}

/** A shelf entry as this job's stock, or why not. */
export function stockFromShelf(item: StockItem, machine: MillProfile): StockChoiceResult {
  const problem = shelfPickProblem(item, machine);
  if (problem !== null) return { ok: false, reason: problem };
  const form = item.form as JobStockForm;
  const box = boxForForm(form, item.size);
  if (box === null) return { ok: false, reason: `the ${form}'s size is not complete on the shelf` };
  // The fields on the step already say what the piece is, so the notes carry only what the step
  // cannot show: the facts the job does NOT take from the shelf (#683, A8).
  const notes: string[] = [];
  if (item.layers.length > 0) {
    notes.push(
      `Its ${item.layers.length} layers (${item.layers.map((l) => l.name).join(', ')}) are not carried onto the job: ` +
        'the shelf records no layer height, and the job will not invent one.',
    );
  }
  // #492 — a purchased two-colour laminate states its cap as a stock fact. It is NOT a print: no
  // layers and no filament travel with it. `capSource` says whether the number is the assumed one.
  const colour =
    item.capMm != null ? ({ kind: 'laminate', capMm: item.capMm } as const) : undefined;
  if (colour !== undefined) {
    notes.push(
      `Its colour cap is ${mm(colour.capMm)} mm` +
        (item.capSource === 'assumed'
          ? ' — ASSUMED (no datasheet); measure the sheet and correct the entry before trusting a depth.'
          : ' — measured and recorded on the shelf entry.') +
        ' The job treats it as a laminate: no printed layers, no filament.',
    );
  }
  if (item.flatness === 'domed') {
    notes.push(
      `It is recorded as domed ${item.domeHeight ?? '?'} mm; the job's bow is not copied from the shelf — it states one only after measuring its own clamped surface.`,
    );
  }
  return {
    ok: true,
    choice: {
      stock: {
        length: box.length,
        width: box.width,
        thickness: box.thickness,
        material: item.material,
        ...(colour !== undefined ? { colour } : {}),
      },
      ...(colour !== undefined
        ? { colourSource: item.capSource === 'measured' ? ('measured' as const) : ('assumed' as const) }
        : {}),
      entry: { kind: 'shelf', shelfId: item.id, file: null, form, finish: item.finish, conductive: item.conductive },
      notes,
    },
  };
}

/** A piece typed in the wizard. */
export interface MadeStock extends StockBox {
  form: JobStockForm;
  material: StockMaterial;
  finish: JobStockFinish;
}

/** A typed piece as this job's stock, or why not. `shelfId` is the entry it was also saved as. */
export function stockFromMade(made: MadeStock, machine: MillProfile, shelfId: string | null = null): StockChoiceResult {
  const problem = formProblem(made.form) ?? boxProblem(made, machine);
  if (problem !== null) return { ok: false, reason: problem };
  return {
    ok: true,
    choice: {
      stock: { length: made.length, width: made.width, thickness: made.thickness, material: made.material },
      entry: {
        kind: 'made',
        shelfId,
        file: null,
        form: made.form,
        finish: made.finish,
        conductive: isMetalMaterial(made.material),
      },
      // The size fields are on the screen and the shelf tick is beside them; repeating them as a
      // sentence was the prose #683 removes (A8).
      notes: [],
    },
  };
}

/**
 * The shelf entry a typed piece becomes when "also put it on the shelf" is ticked. Quantity 1, and
 * flatness `unknown`: nobody has said how flat it is, and `unknown` is its own answer (#345).
 * Conductive follows the material — a metal is, a plastic or wood is not — as the shelf's own
 * editor seeds it.
 */
export function shelfItemFromMade(made: MadeStock, id: string, now: string): StockItem {
  // A round form goes back on the shelf as a round entry — its own fields, not the box around it.
  // A rod's box is D × D × L (standing on its end), so its diameter is the box's length and its
  // own length is the box's thickness.
  const size =
    made.form === 'disc'
      ? { diameter: made.length, thickness: made.thickness }
      : made.form === 'rod'
        ? { diameter: made.length, length: made.thickness }
        : { length: made.length, width: made.width, thickness: made.thickness };
  return {
    id,
    material: made.material,
    form: made.form,
    size,
    layers: [],
    capMm: null,
    capSource: null,
    finish: made.finish,
    flatness: 'unknown',
    domeHeight: null,
    conductive: isMetalMaterial(made.material),
    quantity: 1,
    reservations: [],
    consumed: [],
    source: made.form === 'printed-blank' ? 'printed' : 'purchased',
    notes: null,
    addedAt: now,
  };
}

/** A file read as stock (`meshAsStock`), with the material the operator chose. */
export interface FileStock extends StockBox {
  name: string;
  sha256: string;
  material: StockMaterial;
  finish: JobStockFinish;
}

/** A mesh's box as this job's stock, or why not. Its form is a block (a printed one when printed). */
export function stockFromFile(file: FileStock, machine: MillProfile): StockChoiceResult {
  const problem = boxProblem(file, machine);
  if (problem !== null) return { ok: false, reason: problem };
  const form: JobStockForm = file.finish === 'printed' ? 'printed-blank' : 'block';
  return {
    ok: true,
    choice: {
      stock: { length: file.length, width: file.width, thickness: file.thickness, material: file.material },
      entry: {
        kind: 'file',
        shelfId: null,
        file: { name: file.name, sha256: file.sha256 },
        form,
        finish: file.finish,
        conductive: isMetalMaterial(file.material),
      },
      notes: [
        `${mm(file.length)} × ${mm(file.width)} × ${mm(file.thickness)} mm, read from ${file.name} — its bounding box, ` +
          `in ${MATERIAL_LABELS[file.material]}.`,
      ],
    },
  };
}

/**
 * The finish the job's stock states (#432 slice 4), or null when nothing says.
 *
 * The named entry is the first word; a job that carries a `print` was taken from a printed part —
 * the badge's blank, a design file — and that IS its finish even when no entry was named (the
 * panel's "Use the badge blank" writes no `stockEntry`). With neither, the finish is unknown, and
 * the panel and the run sheet must say so rather than guess from the material.
 */
export function finishOf(job: Pick<EngraveJob, 'stockEntry' | 'stock'>): JobStockFinish | null {
  return (
    job.stockEntry?.finish ??
    (job.stock.colour?.kind === 'printed' ? 'printed' : null)
  );
}

/**
 * Why this material is never faced, or null (#474, widened by #493). The maintainer's rule of
 * 2026-10-17: facing is for **wood and metal only**. A flat cutter pushed into a plastic smears the
 * top rather than cutting it, so no finish, no depth and no cutter choice makes a facing pass work
 * — the material alone refuses it, and the sentence names the material rather than calling every
 * one of them "printed plastic".
 *
 * #493 widened the predicate from the printed blanks to the CLASS: anything that is neither wood
 * (softwood, hardwood, MDF) nor metal is refused, which covers purchased acrylic, ABS, PC, PP, TPU
 * and the acrylic/ABS-based engraving laminates of #492 — a laminate does not need a stock kind of
 * its own to be caught, because its material is a plastic.
 */
export function facingRefusal(material: StockMaterial): string | null {
  return isWoodMaterial(material) || isMetalMaterial(material)
    ? null
    : `facing is not offered on ${MATERIAL_LABELS[material]}: a flat cutter smears a plastic top`;
}

/**
 * The facing choice a NEW job is seeded with (#432 slice 4, decision Q6): whether to face, from the
 * material ({@link facingRefusal}) and the finish's own default, and the depth the shop fills in
 * ({@link facingDepthDefault}).
 *
 * Seeded rather than interpreted at generate time: a job with no `facing` key must keep planning
 * exactly as it did before #432, so "rough stock is faced by default" has to be WRITTEN onto a job
 * when the job is made. An absent key means nobody has asked, and the panel offers the default with
 * its reason instead of acting on it.
 *
 * A material {@link facingRefusal} refuses always seeds OFF with a zero depth (#474, #493): the
 * refusal is not a finish default that a finish could override, so there is no number to fill in
 * either. Wood and metal keep the rough/unknown seeds.
 */
export function facingSeed(
  finish: JobStockFinish | null,
  material: StockMaterial,
  shop?: Partial<FacingDepthShop>,
): Pick<EngraveFacing, 'enabled' | 'depth'> {
  if (facingRefusal(material) !== null) return { enabled: false, depth: 0 };
  const def = facingDefault(finish ?? 'unknown', material);
  return { enabled: def.on, depth: facingDepthDefault(finish ?? 'unknown', { shop }).depthMm };
}

/**
 * Whether the job should face the stock first, from its material and finish (decision Q6): a plastic
 * is never faced (#474, #493); for wood and metal, rough or unknown → on and a finished sheet → off.
 * Always overridable where it is offered — this is the DEFAULT, and the reason is part of the answer
 * so the screen can say why.
 */
export function facingDefault(finish: JobStockFinish, material: StockMaterial): { on: boolean; reason: string } {
  const refused = facingRefusal(material);
  if (refused !== null) return { on: false, reason: refused };
  switch (finish) {
    case 'rough':
      return { on: true, reason: 'rough stock is faced first, so the top is flat and Z0 is on a cut surface' };
    case 'unknown':
      return { on: true, reason: 'the finish is not known, so it is faced first' };
    case 'finished':
      return { on: false, reason: 'a finished face is cut as it is' };
    case 'printed':
      return { on: false, reason: 'a printed blank is cut as printed — facing would cut into its top layer' };
  }
}

/**
 * The facing depth seeds (#432): the two fallbacks, and the margin added to a probed spread, mm.
 *
 * The maintainer's decision of 2026-10-17: the depth is ASKED every time facing is on, and the
 * field arrives filled in — the probed top's high-to-low spread plus the margin when the blank has
 * been probed, otherwise 0.5 mm for rough stock and 0.2 mm when the finish is unknown (general
 * practice is a light 0.2–0.5 mm skim; the repo has no measured figure). Each of these is a shop
 * setting (`facing.roughMm`, `facing.unknownMm`, `facing.marginMm`), so the three are stored here
 * only as the no-service fallbacks — the caller reads the location and passes the values in.
 */
export const FACING_DEPTH_FALLBACK_MM = { rough: 0.5, unknown: 0.2, margin: 0.1 } as const;

/**
 * The most a facing pass may claim to remove, mm. A skim is a skim: the schema's bound for a hand-
 * edited document. The job's own thickness check is `facing-too-deep` (`validateJob`), not this.
 */
export const FACING_DEPTH_MAX_MM = 10;

/**
 * #473 — the fallback tolerance of the post-facing re-touch, mm. The shop setting
 * (`facing.retouchToleranceMm`) is the number used; this is what a build with no house service
 * reads. A skim never removes exactly its nominal depth (spindle growth, deflection, a blank
 * clamped a little tilted), so the re-touch's measurement is checked against the expected top
 * ± this band rather than assumed to equal it.
 */
export const FACING_RETOUCH_TOLERANCE_FALLBACK_MM = 0.1;

/**
 * #473 — the ± band the post-facing re-touch accepts, from the location's
 * `facing.retouchToleranceMm`. One reader, so the executor and the screen that explains the band
 * cannot come from two different numbers.
 */
export function facingRetouchTolerance(defaults: ShopDefaults | null): number {
  return readDefault(defaults, 'facing.retouchToleranceMm').value;
}

/** The shop's three facing depth figures, as the caller reads them from the location. */
export interface FacingDepthShop {
  rough: number;
  unknown: number;
  margin: number;
}

/**
 * The shop's facing figures from a defaults map — the three `facing.*` keys, each falling back to
 * its labelled seed (`FACING_DEPTH_FALLBACK_MM`). One reader, so the panel's filled-in number and
 * the reason under it can never come from two different sets of keys.
 */
export function facingShopFrom(defaults: ShopDefaults | null): FacingDepthShop {
  return {
    rough: readDefault(defaults, 'facing.roughMm').value,
    unknown: readDefault(defaults, 'facing.unknownMm').value,
    margin: readDefault(defaults, 'facing.marginMm').value,
  };
}

/**
 * The measured high-to-low spread of the job's blank top, mm — or null when nobody measured it
 * (#432 review R9).
 *
 * The facing depth's probed branch ({@link facingDepthDefault}) needs a measurement, and the job
 * carries one only as `stock.flatness`, which since #496 is written by the extents touches alone
 * and is a drop per stock axis. The larger of the two is the high-to-low a skim has to clear.
 *
 * Only a material facing is offered on can answer (#474/#493): on any plastic this returns null
 * even if a measured flatness is recorded, so the wood/metal-only rule is enforced here as well
 * as at the toggle.
 *
 * Direction is irrelevant to a skim beyond taking the larger drop: it has to clear the high point
 * whichever side of the blank it is across.
 */
export function measuredTopSpreadMm(job: Pick<EngraveJob, 'stock'>): number | null {
  if (facingRefusal(job.stock.material) !== null) return null;
  const flatness = job.stock.flatness;
  if (flatness === undefined) return null;
  const spread = Math.max(flatness.xMm, flatness.yMm);
  return Number.isFinite(spread) && spread >= 0 ? spread : null;
}

/**
 * The depth filled into a facing job's depth field (#432): the answer to "how far", not the choice
 * of whether to face — that is `facingDefault`'s, from the finish.
 *
 * When the blank's top has been MEASURED — a measured `stock.flatness` handed in through
 * {@link measuredTopSpreadMm}, or a probe's own spread — that high-to-low figure is the measured
 * out-of-flat, and the shop's margin is added so the skim clears the highest point rather than
 * grazing it. Without a measurement the finish decides: rough stock takes the rough figure,
 * unknown stock the light one. A finished or printed blank is not faced by default, so nobody has
 * said what its skim should be — a person who switches facing on for one gets the light figure
 * and a sentence saying it was the fallback, rather than a number invented for a finish that
 * implies no skim at all.
 */
export function facingDepthDefault(
  finish: JobStockFinish,
  opts: {
    /** High-to-low spread a measurement found on the top, mm; null/absent = not measured. */
    probedSpreadMm?: number | null;
    /** The shop's figures; absent keys fall back to {@link FACING_DEPTH_FALLBACK_MM}. */
    shop?: Partial<FacingDepthShop>;
  } = {},
): { depthMm: number; reason: string } {
  const shop = { ...FACING_DEPTH_FALLBACK_MM, ...opts.shop };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const spread = opts.probedSpreadMm;
  if (typeof spread === 'number' && Number.isFinite(spread) && spread >= 0) {
    return {
      depthMm: round2(spread + shop.margin),
      reason: `the blank's measured top varies by ${round2(spread)} mm, plus the shop's ${shop.margin} mm margin`,
    };
  }
  switch (finish) {
    case 'rough':
      return { depthMm: shop.rough, reason: `rough stock, so the shop's ${shop.rough} mm skim is filled in — measure or change it` };
    case 'unknown':
      return { depthMm: shop.unknown, reason: `the finish is not known, so the light ${shop.unknown} mm skim is filled in — measure or change it` };
    case 'finished':
    case 'printed':
      return { depthMm: shop.unknown, reason: `a ${finish} face implies no skim, so the lightest fallback (${shop.unknown} mm) is filled in — change it if this face should come off` };
  }
}

const FORM_LABELS: Record<JobStockForm, string> = {
  plate: 'Plate',
  block: 'Block',
  sheet: 'Sheet',
  'printed-blank': 'Printed blank',
  disc: 'Disc',
  rod: 'Rod',
};

/** `Plate`, `Printed blank` — the form as a sentence starts it. */
export function formLabel(form: JobStockForm): string {
  return FORM_LABELS[form];
}

/** The shelf entries for this material, in shelf order — the list the wizard's shelf door shows. */
export function shelfFor(items: readonly StockItem[], material: StockMaterial): StockItem[] {
  return items.filter((i) => i.material === material);
}

/**
 * How many items the job holds that a person put there — what starting a new job would throw away
 * (#418 review). The shipped demo lines are the app's own, not the person's, so they do not count.
 */
export function jobItemCount(job: EngraveJob): number {
  const labels = isShippedDemoLabelSet(job) ? 0 : job.labels.length;
  return (
    labels +
    job.shapes.length +
    (job.combined?.length ?? 0) +
    (job.traces?.length ?? 0) +
    (job.vectors?.length ?? 0) +
    (job.drills?.length ?? 0) +
    // #435 — a primitive is an item even when its form is refused by name; validation says so.
    (job.primitives?.length ?? 0) +
    (job.keepOuts?.length ?? 0)
  );
}

/**
 * Does `next` still hold the stock `prev` named an entry for? (#418 review) The entry describes a
 * size and a material; an edit to any of the four means the job's stock is no longer that entry.
 * Provenance, print and flatness are not the piece's identity and do not count.
 */
export function stockStillNamed(prev: EngraveJob['stock'], next: EngraveJob['stock']): boolean {
  return (
    prev.length === next.length &&
    prev.width === next.width &&
    prev.thickness === next.thickness &&
    prev.material === next.material
  );
}
