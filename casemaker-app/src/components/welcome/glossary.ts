/**
 * #1109 — THE WIZARD'S GLOSSARY. Every term a woodworker would not know either becomes plain words
 * in the label or gets a one-line *what this means* under the control, through `Explain`. The
 * strings live here so the sheet and the panel can reuse them, and so a new term without an entry
 * fails `wizardCopy.spec.tsx` (the checked-in list is the test's source).
 *
 * Approved on #1109 (the maintainer tweaked "boss": a raised post or stud, not a pocket island).
 *
 * #1109 item 9 — ONLY TERMS A STEP SHOWS: a term whose word was replaced by the approved plain copy
 * is not in this table (the wizard says "knows where it is", "the address you wrote", "the stock
 * this workshop keeps"; the bore chip's blurb carries "helixed" in plain words; no
 * wizard step says "medial axis" or "run-out"). `tests/unit/glossaryTerms.json` is the
 * checked-in list, and `wizardCopy.spec.tsx` fails if a step renders a listed term without this
 * table's line beside it, or if this table has a term no step renders.
 */
export const GLOSSARY = {
  'v-carve': 'Carve with a V-bit — lines get wider as they go deeper',
  'variable-depth': 'Deeper where the drawing is wide, shallower where it is narrow',
  inlay: 'A pocket and the matching plug — the pocket is the female, the plug the male',
  prism: 'Raised letters with sloped sides',
  flute: 'A groove that ramps in and out',
  texture: 'A pattern of small marks, the same every run',
  relief: 'A surface you cut down into, not through',
  gerber: 'The file a circuit-board design comes as',
  boss: 'A raised post or stud (to thread on the outside)',
  'simulate-only': 'Check it on screen; this build cannot run it on the machine',
  proud: 'standing above the jaw tops',
  'jaw-ledge': 'The step on the vise jaws a thin blank rests on',
  'stick-out': 'How far the rod sticks out of the chuck',
  'neck-for-parting': 'A thin groove that lets the finished part break off',
  'self-centring-scroll': 'The chuck jaws that close together as they turn',
  'anchor-1': "The bracket's pin position, front-left",
  'reverse-teeth': 'The chuck jaws turned round for larger stock',
  broadcasts: 'Found on the network',
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** The plain line for a term, or null when it has no entry (a spec fails before the UI asks). */
export function glossFor(term: string): string | null {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, term) ? GLOSSARY[term as GlossaryTerm] : null;
}
