/**
 * #783/#778 — HOW THE STOCK IS HELD, as one model for every form.
 *
 * The job's frame is the machine's: X between the jaw faces, Y along the jaws, Z up. The PART is
 * the piece the user brought: its own length, width and thickness, and (for a round form) a
 * diameter. WHICH WAY ROUND the part sits in that frame is a CHOICE, asked for every form —
 * nothing here decides it. A hold is the PERMUTATION of the part's own three axes into the job's:
 * which part dimension is up, which runs between the jaws, and which runs along them.
 *
 *   job.length   = part[hold.x]      (X, between the jaws)
 *   job.width    = part[hold.y]      (Y, along the jaws)
 *   job.thickness= part[hold.z]      (Z, up)
 *
 * The distinct holds are all the permutations that make sense for the form: a block's six, a
 * rod's three (ends in the jaws · standing on an end · lying across on the curve), a disc's two
 * (flat side up · on its edge). A suggestion is offered from the proportions and the mount, but
 * every hold stays visible and selectable — a suggestion is not a rule.
 *
 * ITEMS STAY ON THE PART'S FACES. The items a job cuts (labels, shapes, cut-outs…) are on a part
 * face — the part's TOP (+thickness) by default. A hold that leaves that face up keeps them where
 * they are, transformed with the part; a hold that turns the face to a SIDE states where it now
 * points (informed, never refused), and the operator may MOVE them to the face that is now up —
 * one press, their choice, never automatic. {@link moveItemToTopFace} is that remap: the part's
 * shared axis between the two faces keeps its offset, the other lands on the face's centre, and
 * the item's turn follows the face.
 */

import type { Mm } from '@/types/units';
import type { JobStockForm, PartAxis, StockHold } from '@/types/engraveJob';

export type { PartAxis, StockHold } from '@/types/engraveJob';

/** The part's own three dimensions, mm — its length, width and thickness, not the job box. */
export interface PartDims {
  length: Mm;
  width: Mm;
  thickness: Mm;
}

export const PART_AXES: readonly PartAxis[] = ['length', 'width', 'thickness'];

/** The shipped orientation: the part's length between the jaws, its thickness up (today's job). */
export const DEFAULT_HOLD: StockHold = { x: 'length', y: 'width', z: 'thickness' };

/** The job's hold, or the shipped orientation when it has not chosen one (#783). */
export function jobHold(job: { hold?: StockHold }): StockHold {
  return job.hold !== undefined && isStockHold(job.hold) ? job.hold : DEFAULT_HOLD;
}

/** The hold the job's ITEM POSITIONS are written in (#783); absent is the shipped orientation. */
export function jobItemsHold(job: { itemsHold?: StockHold }): StockHold {
  return job.itemsHold !== undefined && isStockHold(job.itemsHold) ? job.itemsHold : DEFAULT_HOLD;
}

/** The part face the items are cut on: the part's top (+thickness) unless the job says otherwise. */
export const DEFAULT_ITEM_FACE: PartAxis = 'thickness';

/** True when the three entries are a permutation of the part's axes — a hold, not a muddle. */
export function isStockHold(value: unknown): value is StockHold {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const seen = [v.x, v.y, v.z];
  return (
    seen.every((axis) => PART_AXES.includes(axis as PartAxis)) &&
    new Set(seen).size === 3
  );
}

/** The job's box for a part in a hold, mm: X = between the jaws, Y = along them, Z = up. */
export function holdBox(part: PartDims, hold: StockHold): { length: Mm; width: Mm; thickness: Mm } {
  return { length: part[hold.x], width: part[hold.y], thickness: part[hold.z] };
}

/**
 * The part's own dimensions from a job box and the hold it is in — the inverse of {@link holdBox}.
 * The store never keeps a second copy of the part: a hold change is this round trip.
 */
export function partDimsOf(box: PartDims, hold: StockHold): PartDims {
  const at = (partAxis: PartAxis): Mm => {
    const jobAxis = axisWhere(hold, partAxis);
    return jobAxis === 'x' ? box.length : jobAxis === 'y' ? box.width : box.thickness;
  };
  return { length: at('length'), width: at('width'), thickness: at('thickness') };
}

/** Which JOB axis ('x' | 'y' | 'z') carries a part axis under a hold. */
export function axisWhere(hold: StockHold, partAxis: PartAxis): 'x' | 'y' | 'z' {
  if (hold.x === partAxis) return 'x';
  if (hold.y === partAxis) return 'y';
  return 'z';
}

/** The job-box dimension a part axis lands on under a hold: its name in the job frame. */
export function jobDimOf(hold: StockHold, partAxis: PartAxis): 'length' | 'width' | 'thickness' {
  const at = axisWhere(hold, partAxis);
  return at === 'x' ? 'length' : at === 'y' ? 'width' : 'thickness';
}

// ── The holds each form offers ──────────────────────────────────────────────────────────────────

/** All six permutations, ordered thickness-up first (the shipped hold), then width-up, then length-up. */
export function blockHolds(): StockHold[] {
  const upOrder: PartAxis[] = ['thickness', 'width', 'length'];
  const out: StockHold[] = [];
  for (const z of upOrder) {
    const rest = PART_AXES.filter((a) => a !== z);
    // The two orders of the remaining axes are two distinct holds (which one runs between the jaws).
    out.push({ x: rest[0]!, y: rest[1]!, z });
    out.push({ x: rest[1]!, y: rest[0]!, z });
  }
  return out;
}

/**
 * A rod's or tube's three holds, IN THE ORDER THE STEP OFFERS THEM: lying with its flat ends
 * against the jaws (the typical one), standing on an end, then lying across on the curve.
 * The part's "length" is the rod's own length; its width and thickness are both the diameter.
 */
export function rodHolds(): StockHold[] {
  return [
    { x: 'length', y: 'width', z: 'thickness' }, // ends in the jaws, cut on the curve's crest
    { x: 'width', y: 'thickness', z: 'length' }, // standing, cut on the ⌀ end face
    { x: 'width', y: 'length', z: 'thickness' }, // lying across Y, gripped on the curve
  ];
}

/** A disc's two holds: its flat face up (the default), or standing on its rim. */
export function discHolds(): StockHold[] {
  return [
    { x: 'length', y: 'width', z: 'thickness' }, // flat side up
    { x: 'length', y: 'thickness', z: 'width' }, // on edge
  ];
}

/** The holds a form offers. A rod is "length" along its axis; a disc's length and width are its diameter. */
export function formHolds(form: JobStockForm): StockHold[] {
  if (form === 'rod' || form === 'tube') return rodHolds();
  if (form === 'disc') return discHolds();
  return blockHolds();
}

/** The part's dimensions as the form states them (a disc and a rod carry their ⌀ twice). */
export function partDimsFor(
  form: JobStockForm,
  size: { length?: number | null; width?: number | null; thickness?: number | null; diameter?: number | null },
): PartDims | null {
  const n = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (form === 'disc') {
    const d = n(size.diameter) ?? n(size.length);
    const t = n(size.thickness);
    return d === null || t === null ? null : { length: d, width: d, thickness: t };
  }
  if (form === 'rod' || form === 'tube') {
    const d = n(size.diameter) ?? n(size.width);
    const l = n(size.length);
    return d === null || l === null ? null : { length: l, width: d, thickness: d };
  }
  const l = n(size.length);
  const w = n(size.width);
  const t = n(size.thickness);
  return l === null || w === null || t === null ? null : { length: l, width: w, thickness: t };
}

// ── The suggestion (never the decision) ─────────────────────────────────────────────────────────

export interface HoldSuggestionArgs {
  form: JobStockForm;
  part: PartDims;
  /** The vise's opening the stock must fit between the jaws, mm, when known. */
  openingMm?: Mm | null;
}

/**
 * The hold the stock's proportions and the vise's opening SUGGEST — pre-selected, never enforced.
 *
 *   - a plate, sheet or printed blank: its largest face up (the smallest dimension up), with the
 *     longest of the two remaining dimensions that fits the jaw opening between the jaws;
 *   - a block: the same rule, which for a cube is the shipped hold;
 *   - a rod: ends in the jaws when its length fits the opening; otherwise standing when it is
 *     short and fat (length ≤ twice its diameter), else lying across on the curve;
 *   - a disc: flat side up.
 *
 * When the opening is unknown the longest dimension goes between the jaws (today's default).
 */
export function suggestedHold({ form, part, openingMm }: HoldSuggestionArgs): StockHold {
  const holds = formHolds(form);
  const opening = typeof openingMm === 'number' && openingMm > 0 ? openingMm : null;
  if (form === 'rod' || form === 'tube') {
    if (opening !== null && part.length <= opening) return holds[0]!; // ends in the jaws
    if (part.length <= part.width * 2) return holds[1]!; // standing
    return holds[0]!; // a long rod lies with its ends in the jaws when it fits; the caller shows the over-opening sentence
  }
  if (form === 'disc') return holds[0]!;
  // The largest face up = the smallest dimension up.
  const up = [...PART_AXES].sort((a, b) => part[a] - part[b])[0]!;
  const rest = PART_AXES.filter((a) => a !== up).sort((a, b) => part[b] - part[a]);
  const first = rest[0]!;
  const second = rest[1]!;
  const between = opening !== null && part[first] > opening && part[second] <= opening ? second : first;
  const along = rest.find((a) => a !== between)!;
  return { x: between, y: along, z: up };
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The hold in the STOCK'S OWN NUMBERS, as the cards read it: `12 mm up · 100 mm between the jaws
 * (60 mm along them)`. The letter form (`T up · L between…`) made the operator decode axes; the
 * numbers are the piece they are holding.
 */
export function holdWords(hold: StockHold, part: PartDims): string {
  return `${num(part[hold.z])} mm up · ${num(part[hold.x])} mm between the jaws (${num(part[hold.y])} mm along them)`;
}

/**
 * The card's words for a FORM: a block's own numbers, a rod's or a disc's phrases — "flat ends
 * against the jaws", "standing on its end", "lying across, gripped on the curve"; "flat side up",
 * "on its edge". The picture beside them keeps the plan and its numbers.
 */
export function holdWordsFor(form: JobStockForm, hold: StockHold, part: PartDims): string {
  if (form === 'rod' || form === 'tube') {
    if (hold.z === 'length') return 'standing on its end';
    if (hold.y === 'length') return 'lying across, gripped on the curve';
    return 'flat ends against the jaws';
  }
  if (form === 'disc') return hold.z === 'thickness' ? 'flat side up' : 'on its edge';
  return holdWords(hold, part);
}

function num(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** The full sentence for a picture: the part's dimensions in the job's places. */
export function holdSentence(hold: StockHold): string {
  return `The part's ${axisLong(hold.z)} is up, its ${axisLong(hold.x)} runs between the jaws, and its ${axisLong(hold.y)} runs along them.`;
}

function axisLong(axis: PartAxis): string {
  return axis === 'length' ? 'length' : axis === 'width' ? 'width' : 'thickness';
}

/** A rod's or disc's hold also names its cut face, which the permutation alone does not say. */
export function holdCutFaceWords(form: JobStockForm, hold: StockHold): string {
  if (form === 'rod' || form === 'tube') {
    if (hold.z === 'length') return 'cut on the ⌀ end face';
    if (hold.x === 'length') return 'cut on the curved side, the crest on top';
    return 'cut on the curved side, lying across the jaws';
  }
  if (form === 'disc') return hold.z === 'thickness' ? 'cut on its flat face' : 'cut on its edge';
  return 'cut on its top face';
}

/**
 * WHERE THE ITEMS' PART FACE POINTS under a hold, or null when it is the job's top. The face's
 * outward normal is the part's +axis of `itemFace`; a hold turns that axis to a job direction.
 * The words name the direction the operator sees: +X is toward the moving jaw, +Y is away from
 * the operator (the back), −Y toward the operator.
 */
export function itemsFaceWords(hold: StockHold, itemFace: PartAxis = DEFAULT_ITEM_FACE): string | null {
  const at = axisWhere(hold, itemFace);
  if (at === 'z') return null;
  return at === 'x' ? 'now facing the moving jaw' : 'now facing the back of the machine';
}

/** Whether the items' part face is the job's top under this hold (the only face cuts reach). */
export function itemsOnTop(hold: StockHold, itemFace: PartAxis = DEFAULT_ITEM_FACE): boolean {
  return axisWhere(hold, itemFace) === 'z';
}

// ── Moving the items to the face that is now up ────────────────────────────────────────────────

/** A point on the job's top face, mm from its front-left corner. */
export interface FacePoint {
  x: Mm;
  y: Mm;
}

/** Two holds are the same way round when all three axes agree. */
export function sameHold(a: StockHold, b: StockHold): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Move a list of items from one job top face to another — the automatic remap when a hold keeps
 * the items' part face up, and the one-press "Move them to the new top face" when it does not.
 * Every item's position is moved by {@link moveItemToTopFace}; an item that carries a `rotation`
 * turns with the face. Items without a position (a cut-out, a chamfer — they reference another
 * item's outline) are returned unchanged.
 */
export function moveItemsToTop<T extends { position: { x: Mm; y: Mm } }>(
  items: readonly T[],
  from: StockHold,
  to: StockHold,
  part: PartDims,
): T[] {
  return items.map((item) => {
    const moved = moveItemToTopFace({ x: item.position.x, y: item.position.y }, from, to, part);
    const next = { ...item, position: { ...item.position, x: moved.point.x, y: moved.point.y } } as T;
    const turned = next as unknown as { rotation?: number };
    if (typeof turned.rotation === 'number') turned.rotation = round6(turned.rotation + moved.turnDeg);
    return next;
  });
}

/** Six decimal places — enough for a layout, and it keeps a turn from accumulating float dust. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
export function moveItemToTopFace(
  point: FacePoint,
  from: StockHold,
  to: StockHold,
  part: PartDims,
): { point: FacePoint; turnDeg: number } {
  const fromBox = holdBox(part, from);
  const toBox = holdBox(part, to);
  // The item's offsets from the OLD face's centre, along the part's own axes.
  const offsetX = point.x - fromBox.length / 2;
  const offsetY = point.y - fromBox.width / 2;
  const offsets: Record<PartAxis, Mm> = {
    [from.x]: offsetX,
    [from.y]: offsetY,
    [from.z]: 0,
  } as Record<PartAxis, Mm>;
  // The new face's two in-plane part axes carry their own offsets when the axes are shared; the
  // third belongs to the old face's normal and has no in-plane counterpart → the centre (0).
  const shared = (axis: PartAxis): boolean => axis === from.x || axis === from.y;
  const nx = shared(to.x) ? offsets[to.x] : 0;
  const ny = shared(to.y) ? offsets[to.y] : 0;
  // The turn: the old face's +X direction (its part axis `from.x`) expressed on the new face.
  const turnDeg = turnOf(from, to);
  return {
    point: { x: toBox.length / 2 + nx, y: toBox.width / 2 + ny },
    turnDeg,
  };
}

/**
 * How far an item's orientation turns when the top face changes, degrees (0, 90, 180 or 270).
 * The old face's +X runs along part axis `from.x`; if that axis is the new face's +X the turn is
 * 0, if it is the new +Y the turn is 90, and if it is the new face's normal the face was turned
 * edge-on and the item keeps its angle (0).
 */
export function turnOf(from: StockHold, to: StockHold): number {
  if (to.x === from.x) return 0;
  if (to.y === from.x) return 90;
  if (to.z === from.x) return 0;
  return 0;
}

// ── The curved top (#778) ──────────────────────────────────────────────────────────────────────

/**
 * How much a cut of width `w` across a cylinder of radius `r` loses at its edges, mm:
 * `R − √(R² − (w/2)²)` (#778). This is the number the step states per item, only when it is
 * over that item's own depth tolerance.
 */
export function curvatureLossMm(radiusMm: Mm, widthMm: Mm): Mm {
  const r = Math.max(0, radiusMm);
  const half = Math.min(Math.abs(widthMm) / 2, r);
  if (r <= 0) return 0;
  return r - Math.sqrt(r * r - half * half);
}
