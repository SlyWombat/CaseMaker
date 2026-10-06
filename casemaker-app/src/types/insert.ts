import type { Mm } from './units';
// Type-only, and `types/case.ts` imports this module back — the one cycle in
// `types/`, erased at compile time because neither direction emits a value.
import type { MagnetSize } from './case';

/**
 * Issue #158 — the parametric tool-insert holder (see /Toolbox.md Part II,
 * "Tool insert holders"): a plate carrying a grid of pockets sized to the
 * user's own sockets, bits, wrenches and drivers, generated as its own
 * archetype rather than a shell around a board.
 *
 * v1 ships the low-risk core the ecosystem has proven: round (OD) and hex
 * (across-flats) pockets on an auto-distributed grid, an entry chamfer, and
 * friction retention. Issue #262 added the first rung of the retention enum
 * (`magnet`, a disc pocket under each pocket — see {@link InsertRetention}).
 * Still deferred, per the issue's triage: twist-lock lobes and spring tabs,
 * the presentation-angle parameter, per-family preset libraries, and embossed
 * labels (textLabels cannot yet label a part that has no board and no shell).
 *
 * Everything is the user's own dimension — there is no interop target here
 * (/Toolbox.md decided "arbitrary dimensions, our own connector"), so no field
 * is copied from another system.
 */
export type InsertPocketShape = 'round' | 'hex';

/**
 * How the tools are held in their pockets.
 *
 *  - `friction` — the clearance-fit pocket alone; the tool is held by its
 *    walls. The default, and the only geometry every project saved before
 *    #262 has.
 *  - `magnet` — a disc pocket cut into the plate UNDER each pocket, so a steel
 *    shank is pulled down as well as gripped. The disc itself and its pocket
 *    come from the MAGNETS table (`fasteners.ts`, issue #152), which is
 *    PROVISIONAL — no magnet coupon has been printed, so the pocket is the
 *    table's glue fit and the holding force is unmeasured.
 *
 * The remaining rungs on the issue (twist-lock lobes, spring tabs) are
 * different geometry rather than another value here, so they wait.
 */
export type InsertRetention = 'friction' | 'magnet';

export interface InsertItem {
  /** Stable id; only used as a React key and in problem messages. */
  id: string;
  shape: InsertPocketShape;
  /**
   * Nominal size before clearance, mm. Round: outside diameter. Hex:
   * across-flats. Clearance is added by the compiler, so this stays the
   * number the user measured on the tool.
   */
  size: Mm;
  /** Pocket depth below the top face, mm. */
  depth: Mm;
}

export interface InsertParams {
  enabled: boolean;
  /** Plate plan width (X), depth (Y) and thickness (Z), mm. */
  width: Mm;
  depth: Mm;
  thickness: Mm;
  /** Corner radius of the plate outline, mm. 0 = square corners. */
  cornerRadius: number;
  /** Fit added to every pocket's nominal size, mm. Default 0.25. */
  clearance: number;
  /** Entry chamfer at each round pocket's mouth, mm. 0 = none. */
  chamfer: number;
  /** Minimum material left beneath the deepest pocket, mm. */
  floor: Mm;
  /** Gap between adjacent pockets, mm. */
  pitchGap: Mm;
  /** Absent = `friction`. See {@link InsertRetention}. */
  retention?: InsertRetention;
  /** The disc cut under each pocket when `retention` is `magnet`. Absent =
   *  `6x2`. A bigger disc needs a thicker plate — `insertProblem` says how
   *  thick, and the magnet pocket's diameter has to stay inside the pitch. */
  magnetSize?: MagnetSize;
  /** The pockets, in placement order (left-to-right, then wrapping). */
  items: InsertItem[];
}
