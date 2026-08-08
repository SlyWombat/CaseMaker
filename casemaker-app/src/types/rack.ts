import type { Mm } from './units';

/**
 * Parametric 10"-class mini rack (emulates "Mini Rack" by Meuon, Printables
 * model 1307276, CC-BY 4.0 — see /Mini-Rack.md and samples/Rack/).
 *
 * The rack is an ASSEMBLY of printable parts, not a shell around a PCB:
 *
 *   SIDE PANELS (left/right mirror pair) — vertical structural plates carrying
 *   two columns of lateral M5 screw holes on the 16.5 mm slot pitch. Shelves
 *   and faceplates clamp between them; the screws hold the rack together.
 *   TOP + BOTTOM PLATES — identical parts that snap into the side panels'
 *   top/bottom rails via rectangular tabs.
 *   ACCESSORIES — any mix of N-slot blank faceplates, vented shelves,
 *   keystone patch plates, and cable trays, each its own printed part.
 *
 * Resizing is PARAMETRIC REGENERATION, never mesh scaling: width / depth /
 * slot-count change the envelope while functional features stay fixed-size
 * (slot pitch, screw holes, keystone openings, snap tabs, wall thicknesses).
 * Every part is fit-checked against the selected printer's build volume.
 */
export interface RackParams {
  enabled: boolean;
  /** Exterior width across the front — the faceplate span. Sample: 252. */
  width: Mm;
  /** Front-to-back depth of the side panels. Sample: 250. */
  depth: Mm;
  /** Rack height in 16.5 mm mounting slots. Sample: 16 (≈275 mm tall). */
  slots: number;
  /**
   * Printer build volume for the per-part fit check (see rackFit.ts).
   * `preset` is informational (which preset filled in x/y/z); the numbers
   * are authoritative. Absent = no fit checking.
   */
  printer?: { preset?: string; x: Mm; y: Mm; z: Mm };
  /**
   * 'none' (default): freestanding, stackable feet.
   * 'ears':  each side panel grows a gusseted rear flange with countersunk
   *          wall-screw holes — load path runs straight from the structural
   *          sides into the wall.
   * 'cleat': a separate french-cleat strip screws to the wall; the side
   *          panels get a matching 45° notch at their rear-top edge and the
   *          rack hooks on. Strong in shear, removable without tools.
   * Either wall style also solidifies the sides' rear band (no vent window
   * near the wall joint) for strength.
   */
  wallMount?: 'none' | 'ears' | 'cleat';
  /** Printable accessories; each entry compiles to one part/STL. */
  accessories?: RackAccessory[];
}

export type RackAccessoryType = 'blank' | 'shelf' | 'keystone' | 'cable-tray';

export interface RackAccessory {
  id: string;
  type: RackAccessoryType;
  /**
   * Faceplate height in slots (blank / shelf / keystone). Defaults:
   * blank + shelf 3, keystone 2. Ignored for cable-tray (fixed profile).
   */
  slots?: number;
  /**
   * Shelf only — deck depth front-to-back. Sample presets: 86 (short,
   * pairs back-to-back with a rear-mounted one) and 123 (long, gains a
   * second screw column). Clamped to the rack's usable depth.
   */
  shelfDepth?: Mm;
}
