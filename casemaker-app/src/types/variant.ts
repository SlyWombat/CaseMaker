/**
 * Issue #148 — an ALTERNATIVE way to print parts that already exist, rather
 * than a part of its own.
 *
 * The examples: the rack welded into one piece instead of a bolt-together
 * assembly; a shell cut into bed-sized pieces when the whole one is too big
 * for the printer. In both cases the geometry is the same object printed
 * differently, so it must be kept out of the viewport (it sits exactly on top
 * of what it replaces), out of the parts list, and out of Save All (which
 * would hand the user the part twice) — while still being offered, by name,
 * where the choice is made.
 *
 * It lives in `types/` rather than in the compiler because BOTH the build plan
 * (`BuildNode`) and the built mesh (`MeshNode`) carry it, and neither should
 * have to reach across into the other to say so.
 *
 * `replaces` is what makes the offer legible: the UI can say "the shell does
 * not fit your bed; here is the 2-piece version" without the generator knowing
 * which archetype it cut.
 */
export interface NodeVariant {
  /** Node ids this one stands in for. Empty = stands in for nothing named. */
  replaces: string[];
  /** One line naming the trade, e.g. "Shell split for a 220×220 bed — 2 pieces". */
  label: string;
}
