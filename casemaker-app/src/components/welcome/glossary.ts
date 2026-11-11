/**
 * #1109 — THE WIZARD'S GLOSSARY. Every term a woodworker would not know either becomes plain words
 * in the label or gets a one-line *what this means* under the control, through `Explain`. The
 * strings live here so the sheet and the panel can reuse them, and so a new term without an entry
 * fails `wizardCopy.spec.tsx` (the checked-in list is the test's source).
 *
 * Approved on #1109 (the maintainer tweaked "boss": a raised post or stud, not a pocket island).
 */
export const GLOSSARY = {
  'v-carve': 'Carve with a V-bit — lines get wider as they go deeper',
  'variable-depth': 'Deeper where the drawing is wide, shallower where it is narrow',
  inlay: 'A pocket and the matching plug — the pocket is the female, the plug the male',
  prism: 'Raised letters with sloped sides',
  flute: 'A groove that ramps in and out',
  texture: 'A pattern of small marks, the same every run',
  'medial-axis': 'The line down the middle of a shape',
  relief: 'A surface you cut down into, not through',
  gerber: 'The file a circuit-board design comes as',
  boss: 'A raised post or stud (to thread on the outside)',
  helixed: 'A hole wider than the cutter, cut in a spiral down its wall',
  'simulate-only': 'Check it on screen; this build cannot run it on the machine',
  proud: 'standing above the jaw tops',
  'jaw-ledge': 'The step on the vise jaws a thin blank rests on',
  'stick-out': 'How far the rod sticks out of the chuck',
  'neck-for-parting': 'A thin groove that lets the finished part break off',
  'self-centring-scroll': 'The chuck jaws that close together as they turn',
  'run-out': 'How far the stock wobbles off true',
  'anchor-1': "The bracket's pin position, front-left",
  'reverse-teeth': 'The chuck jaws turned round for larger stock',
  broadcasts: 'Found on the network',
  'recorded-address': 'At the address you wrote',
  homed: 'The machine knows where it is',
  'house-stock': 'The stock this workshop keeps',
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** The plain line for a term, or null when it has no entry (a spec fails before the UI asks). */
export function glossFor(term: string): string | null {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, term) ? GLOSSARY[term as GlossaryTerm] : null;
}
