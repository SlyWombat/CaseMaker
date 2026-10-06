import type { Vec2 } from '@/types';
import type {
  InsertItem,
  InsertParams,
  InsertRetention,
  MagnetSize,
} from '@/types';
import { circleProfile, poly, rectProfile, roundedRect, type Profile } from './profile';
import {
  cylinder,
  difference,
  extrude,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';
import { segmentsForRadius } from './arcResolution';
import { magnetPocket, magnetPocketDepth, magnetPocketDiameter } from './fasteners';

/**
 * Issue #158 — the tool-insert holder archetype's geometry.
 *
 * One plate, pockets subtracted from its top face. The plate is generated in
 * its OWN frame with the plan origin at a corner: X ∈ [0, width], Y ∈ [0,
 * depth], Z ∈ [0, thickness], mouths up — the same convention `roundedRect`
 * and `rectProfile` already use, so no translate is needed on the solid and a
 * host can lay it on the bed as modelled.
 *
 * Pure op-tree construction (no wasm): the layout that decides WHERE the
 * pockets go is a plain function of the parameters (`insertLayout`), so it can
 * be asserted without an evaluator, and only the resulting solids need one.
 *
 * The numbers here are DEFAULTS, not standards. `pitchGap`, `clearance`,
 * `chamfer` and `floor` are all the user's to change, and the panel exposes
 * them; the friction fit is the one a coupon should settle (#157), exactly as
 * #140 did for the M5 pilot.
 *
 * Issue #262 — `retention: 'magnet'` adds a disc pocket under every pocket,
 * cut DOWNWARD from the pocket's floor with `fasteners.ts`'s `magnetPocket`
 * (#152), so the disc finishes flush with the floor the tool rests on. The
 * plate then has to carry pocket + disc + a web under that, which is the one
 * new constraint the user can trip (`magnetFloorThickness`).
 */

/** Minimum material from a pocket's edge to the plate's side, mm. */
const WALL_EDGE = 3;

/** Solid left under a magnet pocket, mm. The same floor `fasteners.ts`
 *  defaults to, passed explicitly so the two cannot drift apart: a thinner web
 *  than this and the disc breaks through the plate's underside. */
const MAGNET_WEB = 1;

const SQRT3 = Math.sqrt(3);

/** The starter plate — 120 × 80 × 6 with one Ø10 pocket.
 *
 *  The pocket is `thickness − floor` deep, i.e. exactly what `starterItem` in
 *  the panel would add: a default that its own `insertProblem` rejects (a
 *  deeper pocket leaving less than the stated floor) would greet the user with
 *  an error the moment they enabled the archetype. That is also why it stays
 *  friction-retained: a 6 mm plate cannot carry a 4.5 mm pocket AND a disc
 *  under it, and the panel's magnet option says so in the same terms. */
export function defaultInsert(): InsertParams {
  return {
    enabled: true,
    width: 120,
    depth: 80,
    thickness: 6,
    cornerRadius: 4,
    clearance: 0.25,
    chamfer: 0.8,
    floor: 1.5,
    pitchGap: 3,
    items: [{ id: 'item-1', shape: 'round', size: 10, depth: 4.5 }],
  };
}

/**
 * The circumradius a pocket occupies, mm — the spacing and keep-in measure.
 *
 * For a round pocket that is half its diameter. For a hex pocket it is the
 * circumradius (across-corners ÷ 2 = across-flats ÷ √3), NOT half its
 * across-flats: a hexagon is wider corner-to-corner than flat-to-flat, and it
 * is the corners that would collide with a neighbour.
 */
export function pocketRadius(item: InsertItem, clearance: number): number {
  const s = item.size + clearance;
  return item.shape === 'round' ? s / 2 : s / SQRT3;
}

/** The retention in force. Absent = `friction`: the geometry every project
 *  saved before #262 has, so an old file prints exactly what it always did. */
export function retentionOf(insert: InsertParams): InsertRetention {
  return insert.retention ?? 'friction';
}

/** The disc cut under each pocket when retention is `magnet`. */
export function magnetSizeOf(insert: InsertParams): MagnetSize {
  return insert.magnetSize ?? '6x2';
}

/** How far the disc pocket reaches below each pocket's floor, mm — 0 when the
 *  tools are held by friction alone. */
export function magnetDepth(insert: InsertParams): number {
  return retentionOf(insert) === 'magnet' ? magnetPocketDepth(magnetSizeOf(insert)) : 0;
}

/**
 * The thickness a magnet floor needs — deepest pocket + disc pocket + web — or
 * null when there is nothing to fit.
 *
 * Exported so the panel and `insertProblem` state the same number in the same
 * terms: this is the one constraint the user can trip that the pocket depth
 * check alone does not catch (a 4.5 mm pocket in a 6 mm plate is a legal
 * friction plate and an impossible magnet one).
 */
export function magnetFloorThickness(insert: InsertParams): number | null {
  const depth = magnetDepth(insert);
  if (depth === 0 || insert.items.length === 0) return null;
  const deepest = Math.max(...insert.items.map((it) => it.depth));
  return deepest + depth + MAGNET_WEB;
}

/** Regular hexagon profile with across-flats = `acrossFlats`, centred on the origin. */
function hexProfile(acrossFlats: number): Profile {
  const R = acrossFlats / SQRT3;
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    // Vertices at 30°, 90°, … so the flats face ±X and ±Y-as-flats: the
    // across-flats measure then runs along X and Y as the user set it.
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return poly(pts);
}

export interface InsertGrid {
  /** Pockets that fit across the width and the depth. */
  cols: number;
  rows: number;
  /** Centre-to-centre spacing, mm (largest pocket + pitchGap). */
  pitch: number;
  /** Material from the plate edge to the outer pocket's centre, mm. */
  margin: number;
  /** Circumradius of the largest pocket, mm. */
  maxRadius: number;
}

/**
 * How many pockets of this set fit on the plate, and at what pitch.
 *
 * The pitch is uniform — sized to the LARGEST pocket — so mixed tool sets do
 * not pack tightly. That is deliberate for v1: a per-size packing algorithm is
 * a different feature (bin packing), and a predictable grid is what the
 * reviewed generators expose and what the user can reason about.
 */
export function insertGrid(insert: InsertParams): InsertGrid {
  const maxRadius = Math.max(
    0,
    ...insert.items.map((it) => pocketRadius(it, insert.clearance)),
  );
  const pitch = 2 * maxRadius + insert.pitchGap;
  // The edge keeps the outer pocket clear of a rounded corner and leaves room
  // for the widest chamfer flare the user has asked for.
  const edge = Math.max(WALL_EDGE, insert.chamfer);
  const margin = insert.cornerRadius + maxRadius + edge;
  const usableW = insert.width - 2 * margin;
  const usableD = insert.depth - 2 * margin;
  if (pitch <= 0) return { cols: 0, rows: 0, pitch: 0, margin, maxRadius };
  const cols = usableW < 0 ? 0 : Math.floor(usableW / pitch + 1e-9) + 1;
  const rows = usableD < 0 ? 0 : Math.floor(usableD / pitch + 1e-9) + 1;
  return { cols, rows, pitch, margin, maxRadius };
}

/**
 * Where each item lands, centred on the plate, in placement order
 * (left-to-right, wrapping to the next row).
 *
 * Returns [] when nothing fits. The used grid is centred rather than anchored,
 * so adding the last item that completes a row shifts nothing already placed;
 * a full row's worth is what moves.
 */
export function insertLayout(
  insert: InsertParams,
): { item: InsertItem; cx: number; cy: number }[] {
  const { cols, rows, pitch } = insertGrid(insert);
  if (cols < 1 || rows < 1 || insert.items.length === 0) return [];
  const usedCols = Math.min(cols, insert.items.length);
  const usedRows = Math.ceil(insert.items.length / cols);
  if (usedRows > rows) return [];
  const gridW = (usedCols - 1) * pitch;
  const gridH = (usedRows - 1) * pitch;
  const x0 = (insert.width - gridW) / 2;
  const y0 = (insert.depth - gridH) / 2;
  return insert.items.map((item, k) => {
    const col = k % cols;
    const row = Math.floor(k / cols);
    return { item, cx: x0 + col * pitch, cy: y0 + row * pitch };
  });
}

/** Why these parameters will not make the plate the user asked for, or null. */
export function insertProblem(insert: InsertParams): string | null {
  if (!(insert.width > 0)) return 'Insert width must be greater than zero';
  if (!(insert.depth > 0)) return 'Insert depth must be greater than zero';
  if (!(insert.thickness > 0)) return 'Insert thickness must be greater than zero';
  if (insert.clearance < 0) return 'Clearance cannot be negative';
  if (insert.chamfer < 0) return 'Chamfer cannot be negative';
  if (insert.floor < 0) return 'Floor cannot be negative';
  if (insert.pitchGap < 0) return 'Pitch gap cannot be negative';
  if (insert.cornerRadius < 0) return 'Corner radius cannot be negative';
  if (insert.items.length === 0) return 'Add at least one pocket';

  const floorDepth = insert.thickness - insert.floor;
  for (const it of insert.items) {
    if (!(it.size > 0)) return `Pocket ${it.id}: size must be greater than zero`;
    if (!(it.depth > 0)) return `Pocket ${it.id}: depth must be greater than zero`;
    if (it.depth > floorDepth + 1e-9) {
      return `A ${it.depth} mm pocket leaves no floor in a ${insert.thickness} mm plate (max ${round2(floorDepth)} mm)`;
    }
  }

  const needThickness = magnetFloorThickness(insert);
  if (needThickness !== null && needThickness > insert.thickness + 1e-9) {
    return (
      `A ${magnetSizeOf(insert)} magnet floor needs a ${round2(needThickness)} mm plate` +
      ` (pocket + disc + ${MAGNET_WEB} mm web); this one is ${insert.thickness} mm`
    );
  }

  const { cols, rows, pitch } = insertGrid(insert);
  if (cols < 1) {
    const r = Math.max(0, ...insert.items.map((it) => pocketRadius(it, insert.clearance)));
    return `A ${insert.width} mm plate is too narrow for a ${round2(2 * r)} mm pocket`;
  }
  if (cols * rows < insert.items.length) {
    return `The plate holds ${cols * rows} pockets, not ${insert.items.length}`;
  }
  // A disc pocket wider than the pitch would open into its neighbour's and the
  // two would cut as one slot — geometry the user did not ask for, and no other
  // check catches it (the pitch itself is legal at any gap down to zero).
  const discD = magnetPocketDiameter(magnetSizeOf(insert));
  if (magnetDepth(insert) > 0 && pitch > 0 && discD > pitch + 1e-9) {
    return (
      `A ${round2(discD)} mm magnet pocket is wider than the ${round2(pitch)} mm pitch —` +
      ' adjacent magnets would merge; widen the pitch gap or pick a smaller disc'
    );
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One ROUND pocket's cutting op, anchored at the pocket FLOOR on its own axis:
 * the straight bore runs z ∈ [0, `depth`] and the entry flare caps it, rising
 * 1:1 from the bore radius and reaching `radius + chamfer` at z = `depth`. A
 * caller places it with a single `translate([cx, cy, floorZ], …)`.
 *
 * Exported because this is the INTERFACE, not an implementation detail. The fit
 * coupons (#157) cut their ladder with the pocket the compiler ships — the same
 * discipline `magnetPocket` and `buildBoardSnapOps` follow — so a coupon cannot
 * certify a pocket this file no longer draws. It is also what a future pocket
 * carrier (#151) needs to cut a tool footprint into a wall.
 *
 * The chamfer is clamped to the depth so a shallow pocket cannot have its flare
 * eat the floor, and to zero because a negative flare is meaningless.
 */
export function roundPocketCutter(diameter: number, depth: number, chamfer: number): BuildOp {
  const r = diameter / 2;
  const c = Math.min(Math.max(chamfer, 0), depth);
  const bore = cylinder(depth, r, segmentsForRadius(r));
  if (c <= 0) return bore;
  const flare = extrude(circleProfile(r, segmentsForRadius(r)), c, {
    scaleTop: (r + c) / r,
  });
  return union([bore, translate([0, 0, depth - c], flare)]);
}

/**
 * One pocket's cutting op at (cx, cy), in the plate's frame.
 *
 * Round pockets get their entry chamfer as a conical flare unioned onto the
 * straight bore; hex pockets are cut straight, because a tapered hexagon is a
 * different (rotational) fit and no bit needs one.
 */
function pocketCutter(item: InsertItem, insert: InsertParams, cx: number, cy: number): BuildOp {
  const s = item.size + insert.clearance;
  const zBase = insert.thickness - item.depth;
  const body =
    item.shape === 'round'
      ? roundPocketCutter(s, item.depth, insert.chamfer)
      : extrude(hexProfile(s), item.depth);
  return translate([cx, cy, zBase], body);
}

/**
 * The finished plate as one solid, or null when the plate has no extent.
 *
 * Always returns a solid for a positive-width plate: items that are too big to
 * fit are simply not cut, and the panel's `insertProblem` says so. Building
 * the plate first and subtracting what fits is what keeps the archetype from
 * vanishing to an empty viewport while the user is mid-edit.
 */
export function buildInsertOp(insert: InsertParams): BuildOp | null {
  if (!(insert.width > 0) || !(insert.depth > 0) || !(insert.thickness > 0)) return null;
  const outline =
    insert.cornerRadius > 0
      ? roundedRect(insert.width, insert.depth, insert.cornerRadius)
      : rectProfile(insert.width, insert.depth);
  const plate = extrude(outline, insert.thickness);
  const placements = insertLayout(insert).filter(
    ({ item }) => item.size > 0 && item.depth > 0,
  );
  if (placements.length === 0) return plate;
  const cutters: BuildOp[] = placements.map(({ item, cx, cy }) =>
    pocketCutter(item, insert, cx, cy),
  );
  const disc = magnetDepth(insert);
  if (disc > 0) {
    const size = magnetSizeOf(insert);
    for (const { item, cx, cy } of placements) {
      // The slab under this pocket's floor is what the disc pocket cuts into.
      const slab = insert.thickness - item.depth;
      // No room for the disc AND its web: skip the cut rather than break
      // through the plate — or throw out of `magnetPocket`, which would take
      // the whole viewport down mid-edit. `insertProblem` reports the number.
      if (slab - disc < MAGNET_WEB - 1e-9) continue;
      cutters.push(
        magnetPocket({
          size,
          // Entry face = the pocket's floor, so the disc finishes flush with
          // the surface the tool rests on and eats none of its depth.
          at: [cx, cy, slab],
          axis: '-z',
          material: slab,
          floor: MAGNET_WEB,
        }),
      );
    }
  }
  return difference([plate, ...cutters]);
}

/** The single `insert-plate` node, or null when the plate has no extent. */
export function buildInsertNodes(insert: InsertParams): BuildNode[] | null {
  const op = buildInsertOp(insert);
  return op ? [{ id: 'insert-plate', op }] : null;
}
