import type { Mm } from './units';

/**
 * Issue #158 — the parametric tool-insert holder (see /Toolbox.md Part II,
 * "Tool insert holders"): a plate carrying a grid of pockets sized to the
 * user's own sockets, bits, wrenches and drivers, generated as its own
 * archetype rather than a shell around a board.
 *
 * v1 ships the low-risk core the ecosystem has proven: round (OD) and hex
 * (across-flats) pockets on an auto-distributed grid, an entry chamfer, and
 * friction retention. Retained out of v1 on purpose, per the issue's triage:
 * the retention ENUM (magnet floor / twist-lock lobes / spring-tab), the
 * presentation-angle parameter, per-family preset libraries, and embossed
 * labels (textLabels cannot yet label a part that has no board and no shell).
 *
 * Everything is the user's own dimension — there is no interop target here
 * (/Toolbox.md decided "arbitrary dimensions, our own connector"), so no field
 * is copied from another system.
 */
export type InsertPocketShape = 'round' | 'hex';

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
  /** The pockets, in placement order (left-to-right, then wrapping). */
  items: InsertItem[];
}
