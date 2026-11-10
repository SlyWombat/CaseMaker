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
import type { JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';
import { PCB_BLANK_MARGIN_MM, PCB_STANDARD_THICKNESS_MM } from './stockStart';

/** The scrap the proposal leaves each side of a mesh or a line of text, mm. */
export const WORK_STOCK_MARGIN_MM = 5;

/** The skin left under a goal at the flat-bottom style, mm (#898 adds the other styles). */
export const WORK_STOCK_SKIN_MM = 1;

/**
 * #1098 — the house's plate stock, mm, when the shelf does not name one first. An outline cut
 * THROUGH needs a plate: the cut frees the part, so the blank must be the piece. 12 mm is the
 * wizard's stock plate (`stockStart.ts`'s shelf forms); the shelf's own plate wins when present.
 */
export const HOUSE_PLATE_THICKNESS_MM = 12;

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
  | { kind: 'text'; size: { length: number; width: number }; depth: number }
  /**
   * #1098 — a vector outline (SVG/DXF) the question step read. `through` is the Cut it out
   * choice (a profile needs a plate the cut can free); Pocket it and Carve it leave it false.
   */
  | { kind: 'outline'; length: number; width: number; through: boolean }
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
export function proposedThickness(work: WorkShape): number | null {
  switch (work.kind) {
    case 'mesh':
      return round1(work.size.z + WORK_STOCK_SKIN_MM);
    case 'text':
      return round1(work.depth + WORK_STOCK_SKIN_MM);
    case 'pcb':
      return PCB_STANDARD_THICKNESS_MM;
    case 'outline':
      // #1098 — a through cut frees the part from a plate; Pocket it and Carve it bite into one.
      // Both start on the house's plate (12 mm; the shelf's own plate wins in the step).
      return HOUSE_PLATE_THICKNESS_MM;
    default:
      return null;
  }
}

/**
 * The blank the work proposes, or null when it does not size one (a pocket, a profile or a hole
 * keeps today's default).
 */
export function proposeStock(work: WorkShape): StockProposal | null {
  const thickness = proposedThickness(work);
  if (thickness === null) return null;
  switch (work.kind) {
    case 'mesh': {
      const m = WORK_STOCK_MARGIN_MM;
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
      const m = WORK_STOCK_MARGIN_MM;
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
      const m = WORK_STOCK_MARGIN_MM;
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
    default:
      return null;
  }
}
