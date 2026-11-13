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

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
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
  /** #1207 — `stock.presetMarginMm`: the scrap a preset's cut-out or pocket leaves each side, mm. */
  presetMarginMm?: number;
}

/**
 * #1098 — THE SHELF PLATE FOR A DRAWING. Among the shelf's plates that are free (some left, none
 * held back) and hold the drawing's extent plus the margin each side (turned either way), with a
 * thickness of at least `needMm`: the job's material first when one is set, then the smallest
 * area, then the thinnest. Null when none holds it.
 */
export function shelfPlateFor(
  extent: { length: number; width: number },
  needMm: number,
  material: StockMaterial | null,
  shelf: readonly StockItem[],
  marginMm: number = readDefault(null, 'stock.workMarginMm').value,
): StockItem | null {
  const m = marginMm;
  const needL = extent.length + 2 * m;
  const needW = extent.width + 2 * m;
  const free = (i: StockItem): number => i.quantity - i.reservations.reduce((a, r) => a + r.quantity, 0);
  const candidates = shelf.filter((i) => {
    if (i.form !== 'plate' || free(i) <= 0) return false;
    const { length: l, width: w, thickness: t } = i.size;
    if (l == null || w == null || t == null || t + 1e-9 < needMm) return false;
    return (l >= needL - 1e-9 && w >= needW - 1e-9) || (l >= needW - 1e-9 && w >= needL - 1e-9);
  });
  const area = (i: StockItem): number => (i.size.length ?? 0) * (i.size.width ?? 0);
  candidates.sort(
    (a, b) =>
      Number(material !== null && b.material === material) - Number(material !== null && a.material === material) ||
      area(a) - area(b) ||
      (a.size.thickness ?? 0) - (b.size.thickness ?? 0),
  );
  return candidates[0] ?? null;
}

/**
 * #1100 — the margin a preset's cut-out or pocket leaves each side, mm. Ten, not the mesh rule's
 * five: the profile needs room for the cutter beside the part and for the clamps that hold the
 * offcut. (Mockup/acceptance: a 60 × 40 shape proposes 80 × 60.)
 */

/**
 * The material the work proposes for a blank it sized itself: the house default (#879 — the
 * hardwood name plate). READ from the default rather than written a second time, so the proposal
 * and the job the app opens cannot drift apart.
 */
export const WORK_STOCK_MATERIAL: StockMaterial = defaultEngraveJob().stock.material;

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
  material: StockMaterial;
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
      // #1100 — the floor needs its depth plus six millimetres of body under it.
      return round1(Math.max(work.depth + 6, plateMm));
    case 'rod':
      // #1107 — a rod's "thickness" is its own length in the standing box.
      return round1(work.length);
    default:
      return null;
  }
}

/**
 * The blank the work proposes, or null when it does not size one (a pocket, a profile or a hole
 * keeps today's default).
 */
export function proposeStock(work: WorkShape, ctx: ProposalContext = {}): StockProposal | null {
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
        material: WORK_STOCK_MATERIAL,
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
      // any other text keeps the historical 5 mm proposal, and the stock step opens the house stick.
      const m = work.sign === true ? (ctx.signMarginMm ?? workMarginMm) : workMarginMm;
      return {
        form: 'plate',
        material: WORK_STOCK_MATERIAL,
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
      // The shelf's own plate wins: a pocket needs its depth plus the skin; a cut-out no thickness.
      const need = work.through ? 0 : (work.depthMm ?? 0) + WORK_STOCK_SKIN_MM;
      const held = shelfPlateFor(work, need, ctx.jobMaterial ?? null, ctx.shelf ?? []);
      if (held !== null) {
        const { length: l, width: w, thickness: t } = held.size as { length: number; width: number; thickness: number };
        return {
          form: 'plate',
          material: held.material,
          length: l,
          width: w,
          thickness: t,
          finish: 'rough',
          sentence: `From your shelf: ${held.material} plate, ${n(l)} × ${n(w)} × ${n(t)} mm.`,
        };
      }
      return {
        form: 'plate',
        material: WORK_STOCK_MATERIAL,
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
        material: WORK_STOCK_MATERIAL,
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
        material: WORK_STOCK_MATERIAL,
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
        material: WORK_STOCK_MATERIAL,
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
