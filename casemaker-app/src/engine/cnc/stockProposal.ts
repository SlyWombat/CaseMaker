/**
 * #897 — THE STOCK THE WORK ASKS FOR.
 *
 * The wizard asks what is being cut before it asks for a blank, so the work can SIZE the blank:
 * a mesh gives its box plus a stated margin each side, a line of text gives its measured extent
 * plus the margin, and a board gives the blank its import laid it on (the board's outline plus
 * scrap when that blank had to be made for it). The operator can change every number; the
 * proposal is a starting point that says where it came from, never a rule.
 *
 * #898 (the underside styles) extends {@link proposedThickness}: the style decides what sits under
 * the work — today the flat-bottom style leaves the goal's height plus a stated skin.
 */

import { readDefault } from '@/platform/defaultsClient';
import type { StockItem } from '@/platform/stockClient';
import type { JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';
import { PCB_BLANK_MARGIN_MM, PCB_STANDARD_THICKNESS_MM } from './stockStart';

/** The skin left under a goal at the flat-bottom style, mm (#898 adds the other styles). */
export const WORK_STOCK_SKIN_MM = 1;

/**
 * #1098 — the house's plate stock, mm, when the shelf does not name one first. An outline cut
 * THROUGH needs a plate: the cut frees the part, so the blank must be the piece. It is a shop
 * setting (`stock.defaultPlateThicknessMm`, #1207), read here at its recommendation; a caller with
 * the shop's defaults passes the shop's own number as `ProposalContext.plateThicknessMm`.
 */
export const HOUSE_PLATE_THICKNESS_MM = readDefault(null, 'stock.defaultPlateThicknessMm').value;

/**
 * What the proposal may also read, beyond the work: the house's shelf (an outline takes the
 * smallest plate that holds it), the job's material, and the shop's default plate thickness.
 */
export interface ProposalContext {
  shelf?: readonly StockItem[];
  jobMaterial?: StockMaterial | null;
  plateThicknessMm?: number;
  /** #1100 item 3 — the margin a sign's proposed plate leaves around its line, mm. */
  signMarginMm?: number;
  /** #1207 — `stock.workMarginMm`: the scrap a mesh or line's plate leaves each side, mm. */
  workMarginMm?: number;
  /** #1259 — `stock.pocketFloorBodyMm`: the material left under a pocket's floor, mm. */
  pocketFloorBodyMm?: number;
  /** #1207 — `stock.presetMarginMm`: the scrap a preset's cut-out or pocket leaves each side, mm. */
  presetMarginMm?: number;
}

/** What the work is, in the terms a blank is sized from. */
export type WorkShape =
  | { kind: 'mesh'; size: { x: number; y: number; z: number } }
  /**
   * A board, its outline, and the blank the import actually laid it on. The import centres the
   * board's items on that blank; a different size here would leave them off the piece, so the
   * proposal states the blank the board is on rather than inventing a tighter one.
   */
  | { kind: 'pcb'; outline: { length: number; width: number }; laidOn?: { length: number; width: number } }
  | {
      kind: 'text';
      size: { length: number; width: number };
      depth: number;
      /** #1100 item 3 — the SIGN preset's line: it sizes its own plate, by the sign's margin. */
      sign?: boolean;
    }
  /**
   * #1098 — a vector outline (SVG/DXF) the question step read. `through` is the Cut it out
   * choice (a profile needs a plate the cut can free); Pocket it and Carve it leave it false.
   */
  | { kind: 'outline'; length: number; width: number; through: boolean; depthMm?: number }
  /** #1100 — a shape cut through the blank (Cut out a shape). */
  | { kind: 'cutout'; length: number; width: number }
  /** #1100 — a flat-floored recess (A pocket or tray). */
  | { kind: 'pocket'; length: number; width: number; depth: number }
  /** #1107 — a ROD answer (a rotary intent): the blank is the rod the chuck takes. */
  | { kind: 'rod'; diameter: number; length: number }
  | { kind: 'none' };

export interface StockProposal {
  form: JobStockForm;
  /** The blank's material: a piece's own, a board's, a stated one — or null, NOT CHOSEN (#1263: the app assumes none). */
  material: StockMaterial | null;
  length: number;
  width: number;
  thickness: number;
  finish: JobStockFinish;
  /** The sentence the step shows: what it was sized from, and the margin. */
  sentence: string;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function n(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * THE THICKNESS RULE, in one place. #898's underside styles are a new branch here, not a second
 * rule in the step: a style says how much material sits under the work.
 */
export function proposedThickness(work: WorkShape, ctx: ProposalContext = {}): number | null {
  const plateMm = ctx.plateThicknessMm ?? HOUSE_PLATE_THICKNESS_MM;
  const floorBodyMm = ctx.pocketFloorBodyMm ?? readDefault(null, 'stock.pocketFloorBodyMm').value;
  switch (work.kind) {
    case 'mesh':
      return round1(work.size.z + WORK_STOCK_SKIN_MM);
    case 'text':
      return round1(work.depth + WORK_STOCK_SKIN_MM);
    case 'pcb':
      return PCB_STANDARD_THICKNESS_MM;
    case 'outline':
      // #1098 — a through cut frees the part from a plate; Pocket it and Carve it bite into one.
      // Both start on the house's plate (the shop's default; the shelf's own plate wins in
      // `proposeStock`).
      return plateMm;
    case 'cutout':
      // #1100 — the cut frees the part, so the blank is a plate the profile can go through.
      return plateMm;
    case 'pocket':
      // #1100 — the floor needs its depth plus the shop's body under it (`stock.pocketFloorBodyMm`).
      return round1(Math.max(work.depth + floorBodyMm, plateMm));
    case 'rod':
      // #1107 — a rod's "thickness" is its own length in the standing box.
      return round1(work.length);
    default:
      return null;
  }
}

/**
 * WHAT THE WORK NEEDS (#1259): the smallest blank the work asks for, sized from the work and the
 * shop's margins, with the sentence that says where the numbers came from — or null when the work
 * does not size one. It never reads the shelf; {@link proposeBlank} decides whether the shelf
 * already holds it.
 */
function needFor(work: WorkShape, ctx: ProposalContext = {}): StockProposal | null {
  // #1207 — the two scrap margins are the shop's; a caller without them reads the recommendations.
  const workMarginMm = ctx.workMarginMm ?? readDefault(null, 'stock.workMarginMm').value;
  const presetMarginMm = ctx.presetMarginMm ?? readDefault(null, 'stock.presetMarginMm').value;
  const thickness = proposedThickness(work, ctx);
  if (thickness === null) return null;
  switch (work.kind) {
    case 'mesh': {
      const m = workMarginMm;
      const { x, y, z } = work.size;
      return {
        form: 'plate',
        material: null,
        length: round1(x + 2 * m),
        width: round1(y + 2 * m),
        thickness,
        finish: 'rough',
        sentence: `Sized from the mesh: ${n(x)} × ${n(y)} × ${n(z)} mm, plus ${m} mm each side and ${WORK_STOCK_SKIN_MM} mm under it.`,
      };
    }
    case 'pcb': {
      const m = PCB_BLANK_MARGIN_MM;
      const tight = {
        length: round1(work.outline.length + 2 * m),
        width: round1(work.outline.width + 2 * m),
      };
      const blank = work.laidOn ?? tight;
      const tightHere = blank.length === tight.length && blank.width === tight.width;
      return {
        form: 'plate',
        material: 'pcb',
        length: blank.length,
        width: blank.width,
        thickness,
        finish: 'rough',
        sentence: tightHere
          ? `Sized from the board: ${n(work.outline.length)} × ${n(work.outline.width)} mm outline, plus ${m} mm each side, at ${thickness} mm.`
          : `The board is ${n(work.outline.length)} × ${n(work.outline.width)} mm, laid on the ${n(blank.length)} × ${n(blank.width)} mm blank it came with, at ${thickness} mm.`,
      };
    }
    case 'text': {
      // #1100 item 3 — a SIGN's line sizes its own plate with the sign margin (the shop's number);
      // any other text keeps the historical 5 mm proposal.
      const m = work.sign === true ? (ctx.signMarginMm ?? workMarginMm) : workMarginMm;
      return {
        form: 'plate',
        material: null,
        length: round1(work.size.length + 2 * m),
        width: round1(work.size.width + 2 * m),
        thickness,
        finish: 'rough',
        sentence: `Sized from the text: ${n(work.size.length)} × ${n(work.size.width)} mm, plus ${m} mm each side.`,
      };
    }
    case 'outline': {
      // #1098 — the drawing's own extent, plus the same margin every mesh gets; the plate is the
      // house's, because an SVG carries no material of its own.
      const m = workMarginMm;
      return {
        form: 'plate',
        material: null,
        length: round1(work.length + 2 * m),
        width: round1(work.width + 2 * m),
        thickness,
        finish: 'rough',
        sentence: `Sized from the outline: ${n(work.length)} × ${n(work.width)} mm, plus ${m} mm each side.`,
      };
    }
    case 'cutout': {
      // #1100 — the shape's extent plus the preset margin (10 mm each side).
      const m = presetMarginMm;
      return {
        form: 'plate',
        material: null,
        length: round1(work.length + 2 * m),
        width: round1(work.width + 2 * m),
        thickness,
        finish: 'rough',
        sentence: `Sized from the cut-out: ${n(work.length)} × ${n(work.width)} mm, plus ${m} mm each side.`,
      };
    }
    case 'pocket': {
      const m = presetMarginMm;
      return {
        form: 'plate',
        material: null,
        length: round1(work.length + 2 * m),
        width: round1(work.width + 2 * m),
        thickness,
        finish: 'rough',
        sentence: `Sized from the pocket: ${n(work.length)} × ${n(work.width)} mm, plus ${m} mm each side; ${n(work.depth)} mm deep with ${n(thickness - work.depth)} mm under it.`,
      };
    }
    case 'rod': {
      // #1107 — the house's dowel: the starter's own ⌀20 × 100, in the STANDING box the stock
      // step asks a rod's numbers in (diameter as length and width, the rod's length as thickness).
      return {
        form: 'rod',
        material: null,
        length: round1(work.diameter),
        width: round1(work.diameter),
        thickness: round1(work.length),
        finish: 'rough',
        sentence: `Sized for the rotary chuck: a ⌀${n(work.diameter)} × ${n(work.length)} mm rod.`,
      };
    }
    default:
      return null;
  }
}

/**
 * The least thickness a SHELF item must have to hold the work. It is the proposal's own thickness
 * except where the proposal is a convenience, not a requirement: a cut that frees the part
 * (a through outline, a cut-out) goes through whatever plate it is cut from, so any thickness
 * holds it; a drawing pocketed or carved needs its depth plus the skin; a pocket its depth plus
 * the body under the floor.
 */
function holdThicknessFor(work: WorkShape, need: StockProposal, floorBodyMm: number): number {
  switch (work.kind) {
    case 'outline':
      return work.through ? 0 : (work.depthMm ?? 0) + WORK_STOCK_SKIN_MM;
    case 'cutout':
      return 0;
    case 'pocket':
      return work.depth + floorBodyMm;
    default:
      return need.thickness;
  }
}

/** Where a proposed blank came from (#1259). */
export type BlankSource =
  /** Case 1 — a stock entry the shop records holds the work. */
  | { case: 'shelf'; itemId: string }
  /** Case 2 — nothing recorded holds it, so the blank the work needs is recommended. `shelfEmpty` is case 3: no stock is recorded at all. */
  | { case: 'recommended'; shelfEmpty: boolean }
  /** #1263 — pieces of more than one material hold the work and the job states none: no proposal; the operator picks. The ids are the holding pieces, least waste first. */
  | { case: 'several'; itemIds: string[] };

export interface BlankProposal extends StockProposal {
  source: BlankSource;
}

const EPS = 1e-9;

function freeOf(i: StockItem): number {
  return i.quantity - i.reservations.reduce((a, r) => a + r.quantity, 0);
}

/** Volume of what the proposal needs, or of what an item is, mm³ — for "least waste". */
function itemVolume(i: StockItem): number {
  const { length: l, width: w, thickness: t, diameter: d } = i.size;
  if (i.form === 'rod') return Math.PI * ((d ?? 0) / 2) ** 2 * (l ?? 0);
  return (l ?? 0) * (w ?? 0) * (t ?? 0);
}
function needVolume(need: StockProposal): number {
  if (need.form === 'rod') return Math.PI * (need.length / 2) ** 2 * need.thickness;
  return need.length * need.width * need.thickness;
}

/** Whether a shelf item holds the need, with the same slack everywhere. */
function holds(need: StockProposal, i: StockItem, holdMm: number): boolean {
  const { length: l, width: w, thickness: t, diameter: d } = i.size;
  if (need.form === 'rod') {
    // The need states a rod in the standing box: diameter as length and width, the rod's length as thickness.
    return i.form === 'rod' && d != null && l != null && d >= need.length - EPS && l >= need.thickness - EPS;
  }
  if (i.form !== 'plate' && i.form !== 'sheet' && i.form !== 'block') return false;
  if (l == null || w == null || t == null || t + EPS < holdMm) return false;
  return (l >= need.length - EPS && w >= need.width - EPS) || (l >= need.width - EPS && w >= need.length - EPS);
}

/**
 * EVERY SHELF PIECE THAT HOLDS A NEED (#1259, generalising #1098's plate rule), least waste first
 * (item volume less the need's), the shelf's own order breaking ties — the sort is stable and adds
 * no tie-break of ours. A piece must have some left and none held back and hold the need (turned
 * either way; a flat need by a plate, sheet or block, a rod by a rod; circuit-board work only by
 * board material and nothing else by it). `onlyMaterial` is the FILTER a job that states a material
 * applies: a piece of another material does not hold it.
 */
export function holdingItemsFor(
  need: StockProposal,
  shelf: readonly StockItem[],
  holdMm: number = need.thickness,
  onlyMaterial: StockMaterial | null = null,
): StockItem[] {
  const wantsBoard = need.material === 'pcb';
  const vol = needVolume(need);
  return shelf
    .map((item, order) => ({ item, order }))
    .filter(
      ({ item: i }) =>
        freeOf(i) > 0 &&
        (i.material === 'pcb') === wantsBoard &&
        (onlyMaterial === null || i.material === onlyMaterial) &&
        holds(need, i, holdMm),
    )
    .sort((a, b) => itemVolume(a.item) - vol - (itemVolume(b.item) - vol) || a.order - b.order)
    .map((x) => x.item);
}

/** The first of {@link holdingItemsFor}, with a material PREFERRED when given (kept for the outline tests; the proposal itself prefers none). */
export function shelfItemFor(
  need: StockProposal,
  material: StockMaterial | null,
  shelf: readonly StockItem[],
  holdMm: number = need.thickness,
  onlyMaterial: StockMaterial | null = null,
): StockItem | null {
  const all = holdingItemsFor(need, shelf, holdMm, onlyMaterial);
  if (material === null) return all[0] ?? null;
  return all.find((i) => i.material === material) ?? all[0] ?? null;
}

function shelfSentence(i: StockItem): string {
  const { length: l, width: w, thickness: t, diameter: d } = i.size;
  return i.form === 'rod'
    ? `From your shelf: ${i.material} rod, ⌀${n(d ?? 0)} × ${n(l ?? 0)} mm.`
    : `From your shelf: ${i.material} ${i.form}, ${n(l ?? 0)} × ${n(w ?? 0)} × ${n(t ?? 0)} mm.`;
}

/** The ask when the shelf holds the work in more than one material and the job has not said which (#1263). */
export const SEVERAL_HOLD_SENTENCE =
  "Several pieces on your shelf hold this. Pick one, or choose the material and enter the piece's size.";

/**
 * THE BLANK THE WIZARD PROPOSES (#1259, #1263) — one rule, from the shop's own stock, and no
 * material of the app's own.
 *
 *  1. **The shelf** holds the work. The pieces that hold it (free, every size stated, big enough;
 *     only pieces of the job's material when the job states one):
 *       - all of ONE material → the least-waste piece is the blank (case 1: its own size,
 *         material, form and finish);
 *       - of MORE THAN ONE material and the job states none → **no proposal**: the operator picks
 *         (`several`, the holding pieces least waste first). The material decides the feeds, so the
 *         app does not choose it.
 *  2. **Nothing recorded holds it:** the size the work needs, recommended, never required; the
 *     material is the job's when it states one, otherwise NOT CHOSEN (`material: null`).
 *  3. **No stock at all** reads as case 2 and says so; it adds no built-in stock.
 *
 * Next is never blocked by the recommendation, and the operator can change every number. This
 * function does not test the HOLD (whether a mount the shop owns can grip the blank): the Holding
 * step that follows answers that for whatever blank was chosen.
 */
export function proposeBlank(work: WorkShape, ctx: ProposalContext = {}): BlankProposal | null {
  const need = needFor(work, ctx);
  if (need === null) return null;
  const shelf = ctx.shelf ?? [];
  const stated = need.material === 'pcb' ? null : (ctx.jobMaterial ?? null);
  const holders = holdingItemsFor(need, shelf, holdThicknessFor(work, need, ctx.pocketFloorBodyMm ?? readDefault(null, 'stock.pocketFloorBodyMm').value), stated);
  if (holders.length > 0) {
    const materials = new Set(holders.map((i) => i.material));
    if (stated === null && materials.size > 1) {
      return { ...need, sentence: SEVERAL_HOLD_SENTENCE, source: { case: 'several', itemIds: holders.map((i) => i.id) } };
    }
    const held = holders[0]!;
    const { length: l, width: w, thickness: t, diameter: d } = held.size;
    return {
      form: held.form,
      material: held.material as StockMaterial,
      length: held.form === 'rod' ? round1(d ?? 0) : (l as number),
      width: held.form === 'rod' ? round1(d ?? 0) : (w as number),
      thickness: held.form === 'rod' ? (l as number) : (t as number),
      finish: held.finish,
      sentence: shelfSentence(held),
      source: { case: 'shelf', itemId: held.id },
    };
  }
  const shelfEmpty = shelf.length === 0;
  const lead = shelfEmpty
    ? 'No stock is recorded for this shop yet.'
    : stated !== null
      ? `Nothing on your shelf holds this in ${stated}.`
      : 'Nothing on your shelf holds this.';
  const size = need.form === 'rod'
    ? `a ⌀${n(need.length)} × ${n(need.thickness)} mm rod`
    : `a blank of at least ${n(need.length)} × ${n(need.width)} × ${n(need.thickness)} mm`;
  const material = need.material === 'pcb' ? need.material : stated;
  return {
    ...need,
    material,
    sentence: `${lead} It needs ${size}${material === null ? '' : `, ${material}`}. ${need.sentence}`,
    source: { case: 'recommended', shelfEmpty },
  };
}

/** The proposal without its provenance — for callers that only need the blank. */
export function proposeStock(work: WorkShape, ctx: ProposalContext = {}): StockProposal | null {
  const p = proposeBlank(work, ctx);
  if (p === null) return null;
  const { source: _source, ...blank } = p;
  return blank;
}
