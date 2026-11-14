/**
 * #1100 — WHAT ARE YOU MAKING? The step's eight preset cards, in one table.
 *
 * The maintainer's words: "as an end user do I know the difference between a flute and a prism."
 * So the question becomes intents — a sign, a design from a file, a cut-out, a pocket, a part from
 * a 3D model, a circuit board, something else — and each card asks only its own questions. (The
 * rod's cards are #1107's own group; the old dowel card was dead once that landed.) The sixteen engine chips stay available under *Something else…*: they are the panel's
 * vocabulary, not the first-job door's.
 *
 * The answers are one flat record, because the cards are one form: a selected card shows its
 * questions in place and the rest are not on the page.
 */

import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { TextFont } from '@/types/textLabel';
import type { OperationChoice } from './OperationStep';
import type { WorkShape } from '@/engine/cnc/stockProposal';

export type PresetId =
  | 'sign'
  | 'design-file'
  | 'cutout'
  | 'pocket'
  | 'part-3d'
  | 'pcb'
  | 'something-else'
  /** #1107 — the rod intents, folded into the card list when the house owns a rotary. */
  | 'rod-dowel'
  | 'rod-faces'
  | 'rod-relief';

export interface PresetDef {
  id: PresetId;
  title: string;
  /** The visible one-liner (never a `title` attribute — touch has no hover). */
  blurb: string;
  /** The card exists only where the shop owns a rotary: a rod is the chuck's job. */
  rotaryOnly?: boolean;
}

/** The eight cards, in the mockup's order (Wizard-Making.dc.html). */
export const WIZARD_PRESETS: readonly PresetDef[] = [
  { id: 'sign', title: 'A sign or name plate', blurb: 'Letters cut into a board' },
  { id: 'part-3d', title: 'A part from a 3D model', blurb: 'Rough and finish an STL or STEP' },
  { id: 'cutout', title: 'Cut out a shape', blurb: 'Through the blank, held by tabs' },
  { id: 'pocket', title: 'A pocket or tray', blurb: 'A flat-floored recess' },
  { id: 'design-file', title: 'A design from a file', blurb: 'SVG, DXF or a picture, cut or carved' },
  { id: 'pcb', title: 'A circuit board', blurb: 'Copper, holes and outline from Gerbers' },
  { id: 'something-else', title: 'Something else…', blurb: 'Every operation the panel knows' },
];

/** The letter sizes the sign card offers: the line's cap height, mm. */
export const LETTER_SIZES = [
  { id: 'small', label: 'Small', mm: 20 },
  { id: 'medium', label: 'Medium', mm: 35 },
  { id: 'large', label: 'Large', mm: 60 },
] as const;

export type LetterSizeId = (typeof LETTER_SIZES)[number]['id'];

export interface PresetAnswers {
  /** The sign's (or dowel's) text. */
  text: string;
  /**
   * #1100 item 3 (ruling b) — UNCHOSEN by default: the line is then measured at the shop's default letter size and
   * fitted to the blank the shelf gives (#1259). Only CHOOSING a size asks for the plate sized from the line.
   */
  letterSize: LetterSizeId | null;
  font: TextFont;
  /** The dowel's reading (#752). */
  reads: 'along' | 'around';
  /** Cut out a shape: a rectangle or a circle. */
  shape: 'rect' | 'circle';
  /** The cut-out's / pocket's size, mm. */
  lengthMm: number;
  widthMm: number;
  /** The corner radius, mm (rectangles only). */
  radiusMm: number;
  /** The pocket's floor depth, mm. */
  depthMm: number;
}

export function defaultPresetAnswers(): PresetAnswers {
  return {
    text: '',
    letterSize: null,
    font: DEFAULT_FONT_ID,
    reads: 'along',
    shape: 'rect',
    lengthMm: 60,
    widthMm: 40,
    radiusMm: 3,
    depthMm: 6,
  };
}

export function letterSizeMm(id: LetterSizeId): number {
  return LETTER_SIZES.find((s) => s.id === id)?.mm ?? 35;
}

/**
 * #1100 item 2 — the size id a stored line's cap height came from, for a Back: the exact match
 * when the number is one of the card's, else the card's default (the line was not the card's own).
 */
export function letterSizeIdFor(mm: number | undefined): LetterSizeId | null {
  // Ruling b — no stored size (an unchosen card, or any other text route) stays unchosen.
  if (mm === undefined) return null;
  return LETTER_SIZES.find((s) => s.mm === mm)?.id ?? 'medium';
}

/**
 * The choice a card's answers make, or null where the card is a door to a file flow rather than an
 * answer of its own (the design file, the 3D part and the board are read by their fields).
 */
export function presetChoice(id: PresetId, answers: PresetAnswers): OperationChoice | null {
  switch (id) {
    case 'sign':
      // The empty text still yields the engrave choice, so the step's own gate can say "Type the
      // text to engrave." rather than the footer silently offering an empty job.
      // Ruling b — no size chosen: the line is measured at the shop's default letter size (#1259) and fitted to the blank.
      return {
        type: 'engrave',
        text: answers.text,
        depth: 0.5,
        font: answers.font,
        ...(answers.letterSize === null ? {} : { sizeMm: letterSizeMm(answers.letterSize) }),
      };
    case 'cutout':
      return {
        type: 'cutout',
        shape: answers.shape,
        length: answers.lengthMm,
        width: answers.shape === 'circle' ? answers.lengthMm : answers.widthMm,
        radius: answers.shape === 'circle' ? 0 : answers.radiusMm,
      };
    case 'pocket':
      return {
        type: 'pocket',
        length: answers.lengthMm,
        width: answers.widthMm,
        depth: answers.depthMm,
        radius: answers.radiusMm,
      };
    default:
      return null;
  }
}

/** The work a card's answers size a blank from. */
export function presetWorkShape(id: PresetId, answers: PresetAnswers): WorkShape | null {
  switch (id) {
    case 'sign': {
      if (answers.text.trim() === '') return null;
      // Ruling b — the size is optional; without one the work shape does NOT size the blank
      // (the blank comes from the shelf, #1259), so only a chosen size carries the sign marker.
      const sized = answers.letterSize !== null;
      const size = answers.letterSize === null ? 10 : letterSizeMm(answers.letterSize);
      // The line's extent is measured per character conservatively: the real measure runs where a
      // face is loaded (the wizard's `workShapeFor` owns that). A card's own estimate keeps the
      // blank this preset promises, not a different one.
      const length = Math.max(1, answers.text.length * size * 0.62);
      return { kind: 'text', size: { length, width: size }, depth: 0.5, ...(sized ? { sign: true } : {}) };
    }
    case 'cutout':
      return {
        kind: 'cutout',
        length: answers.lengthMm,
        width: answers.shape === 'circle' ? answers.lengthMm : answers.widthMm,
      };
    case 'pocket':
      return { kind: 'pocket', length: answers.lengthMm, width: answers.widthMm, depth: answers.depthMm };
    default:
      return null;
  }
}
