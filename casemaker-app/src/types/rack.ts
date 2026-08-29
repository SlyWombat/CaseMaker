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
   * Offer the fused one-piece exports (see assembledNodes in rack.ts).
   *
   * Off by default and deliberately so: building them means unioning the whole
   * rack twice, which measured ~2.4 s and 70k extra triangles on the sample —
   * a cost every slider drag would pay, for an export most people never take.
   * Only shown when the rack actually fits the selected printer.
   */
  assembledExport?: boolean;
  /**
   * Cable / power pass-through notches cut into the REAR edge of the plates.
   *
   * Note this costs the "one printed plate, installed twice" property: the top
   * plate is the bottom one turned over, and that flip maps the rear edge to
   * the front, so a rear-only notch cannot be shared. With notches on you
   * print two different plates.
   */
  /**
   * Stiffening ribs under the floor plate. Undefined = automatic, on once the
   * plate span is wide enough to sag under load.
   *
   * The floor is NOT supported by the ground: it sits 5 mm up, held by its
   * tabs, and only the two END tabs per side bear downward (they land on the
   * stacking feet — the mid tab has nothing beneath it and only resists
   * uplift). So anything heavy on the rack floor is carried on four corners.
   * At 350 mm wide that is ~9 mm of centre sag under 10 kg, before PLA creep.
   */
  floorRibs?: boolean;
  cableNotches?: {
    /** Which plate(s) carry them. */
    plate: 'top' | 'bottom' | 'both';
    /** How many, spread evenly across the plate. */
    count: number;
    /** Opening width across the rack. */
    width: Mm;
    /** How far forward the notch cuts from the rear edge. */
    depth: Mm;
  };
  /**
   * 'none' (default): freestanding, stackable feet.
   * 'ears':  each side panel grows a gusseted rear flange with countersunk
   *          wall-screw holes — load path runs straight from the structural
   *          sides into the wall.
   * 'cleat': a separate french-cleat strip screws to the wall; the sides'
   *          rear band is relieved below a 45° hook at each rear-top edge
   *          and the rack slides down onto the strip. Strong in shear,
   *          removable without tools — but the strips are a 15 mm standoff
   *          plane by geometric necessity (a protruding wall strip and a
   *          flush back are mutually exclusive).
   * 'keyhole': the FLUSH option — two keyhole hangers cut into each side's
   *          rear face drop over pan-head screws in the wall. No extra
   *          printed parts, back sits dead flat on the wall.
   * Every wall style also solidifies the sides' rear band (no vent window
   * or relief pocket near the wall joint) for strength.
   */
  wallMount?: 'none' | 'ears' | 'cleat' | 'keyhole';
  /** Printable accessories; each entry compiles to one part/STL. */
  accessories?: RackAccessory[];
  /**
   * Axial case fans mounted through the side panels. Each fan gets a solid
   * full-height band fused onto the panel's outer face (so the mount is
   * always anchored to the frame, never floating in a vent window), with
   * the standard round opening + 4-bolt pattern for its size cut through.
   */
  fans?: RackFan[];
}

export interface RackFan {
  id: string;
  /** Which side panel carries the fan. */
  side: 'left' | 'right';
  /** Standard fan frame size. Bolt spacing follows the industry standard
   *  (40→32, 60→50, 80→71.5, 92→82.5, 120→105). */
  size: 40 | 60 | 80 | 92 | 120;
  /** Fan center, mm from the rack FRONT along the panel. */
  y: Mm;
  /** Fan center, mm above the bottom of the panel body. */
  z: Mm;
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
  /**
   * Shelf depth in mm, or 'full' to track the rack's own depth — a full-depth
   * shelf re-sizes itself whenever the rack does, and picks up a third screw
   * at the very back rather than cantilevering off the mid column.
   */
  shelfDepth?: Mm | 'full';
  /** Shelf only — add a 4 mm faceplate closing the shelf's front opening. */
  frontPlate?: boolean;
  /** Shelf only — deck vent slots + rib side vents. Default true; false
   *  gives a solid deck and solid rib walls (dust/EMI/looks). */
  vented?: boolean;
}
