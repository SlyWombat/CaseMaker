import {
  TOOLBOX_FIT_CLEAR,
  TOOLBOX_FLOOR_T,
  TOOLBOX_FOOT_CAVITY_INSET,
  TOOLBOX_FOOT_H,
  TOOLBOX_FOOT_INSET,
  TOOLBOX_GRID_HOLE,
  TOOLBOX_GRID_MARGIN,
  TOOLBOX_GRID_PITCH,
  TOOLBOX_LEAD_IN,
  TOOLBOX_LEDGE_W,
  TOOLBOX_LID_H,
  TOOLBOX_WALL_T,
  toolboxParamsProblem,
  type Mm,
  type ToolboxParams,
} from '@/types';
import {
  cylinder,
  difference,
  extrude,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';
import { rectProfile, type Profile } from './profile';

/**
 * Issue #155 — the stacking-toolbox archetype: one module builder, used twice.
 *
 * PROVENANCE, and the reasoning behind the shape, are in `types/toolbox.ts` —
 * read that header first. Two things worth repeating here because they explain
 * every line below:
 *
 *   - clean-room: the numbers are ours, derived from the requirements in
 *     `/Toolbox.md`, not measured off any reviewed product;
 *   - the registration FOOT points up in print orientation. It is the module's
 *     own flat base, inset `TOOLBOX_FOOT_INSET`, which drops into the module
 *     below and lands on that module's seating LEDGE. A skirt hanging *below*
 *     the floor — the obvious alternative, and the first draft — cannot be
 *     printed in one piece at all.
 *
 * FRAME: the outline is CENTRED on the XY origin like `blankOutline`; `z = 0` is
 * the seating plane AND the print-bed face, and the module rises from it to
 * `height`. So the bounding box is `[-W/2, W/2] × [-D/2, D/2] × [0, height]`,
 * and a stack of N modules is N copies at N offsets.
 *
 * HOW A STACK REGISTERS, with no connector at all:
 *
 *   Module B's foot drops into module A's opening, guided by its 45° nose and
 *   squared by `TOOLBOX_FIT_CLEAR` of sliding clearance against A's wall. It
 *   stops when the foot's bottom face meets A's seating ledge, which sits
 *   `TOOLBOX_FOOT_H` below A's rim — so B's rim lands exactly `TOOLBOX_FOOT_H`
 *   closer to A's than a bare rim-on-rim stack would put it. That is the whole
 *   joint: no screw, no clip, no orientational key, and the last few millimetres
 *   are forgiving enough to drop a loaded bin on by feel.
 */

/** The bin — the deep, open module with the floor grid. */
export const TOOLBOX_BIN_NODE_ID = 'toolbox-bin';
/** The lid — a shallow module that closes the bin and still carries a rim. */
export const TOOLBOX_LID_NODE_ID = 'toolbox-lid';

/** A hole centre on the floor grid, relative to the module's centre. */
export interface GridHole {
  x: Mm;
  y: Mm;
}

/** The module's derived numbers — what the panel reports and the tests pin. */
export interface ToolboxDims {
  /** External plan and box height above the seating plane. */
  outer: { width: Mm; depth: Mm; height: Mm };
  /** The main cavity's plan (outer plan minus two walls). */
  inner: { width: Mm; depth: Mm };
  /** Cavity depth above the floor. */
  innerDepth: Mm;
  foot: {
    /** Inset of the foot's outer face from the module's outer face. */
    outerInset: Mm;
    /** Inset of the foot's cavity face. */
    cavityInset: Mm;
    /** Height of the foot — the depth a module nests into the one below. */
    height: Mm;
    leadIn: Mm;
    /** Sliding clearance per side against the receiving wall. */
    clearance: Mm;
  };
  /**
   * Where the module above's foot lands: the top of the seating ledge, and how
   * far in from the module's outer face it reaches.
   */
  seat: { z: Mm; innerInset: Mm };
  /** The floor grid, or `null` when it is off or nothing fits. */
  grid: {
    pitch: Mm;
    hole: Mm;
    centreInset: Mm;
    columns: number;
    rows: number;
    holes: GridHole[];
  } | null;
}

/**
 * The z of the seating ledge, and its inner inset — the same for every module
 * at a given height, so the panel and the builder cannot disagree.
 *
 * For a module only just taller than its own foot, the ledge IS the floor: the
 * floor's top face is already at `TOOLBOX_FLOOR_T`, which the next foot can land
 * on directly. Only a deeper module needs a ledge ring built above its floor.
 */
export function seatingLedge(height: Mm): { z: Mm; innerInset: Mm; ring: boolean } {
  const z = height - TOOLBOX_FOOT_H;
  return {
    z: Math.max(z, TOOLBOX_FLOOR_T),
    innerInset: TOOLBOX_WALL_T + TOOLBOX_LEDGE_W,
    ring: z > TOOLBOX_FLOOR_T + 0.5,
  };
}

/**
 * The hole centres on a `pitch` grid, symmetric about the origin, whose OUTLINE
 * clears the foot's wall on every side.
 *
 * Symmetric rather than corner-anchored: the module is centred, so an anchored
 * grid would drift off-centre as the plan changes, and two modules of different
 * sizes would stop sharing a common hole line — which is the whole point of a
 * drop-in grid you can hang a partition from.
 *
 * The count is deliberately taken to the nearest ODD number. An even count has
 * no hole on the centre line, so its holes sit at ±half a pitch — the lattice
 * would still be square, but every hole would be 12.5 mm off the module's own
 * centre and two modules whose counts differed parity would share no hole line
 * at all. Odd keeps the lattice anchored on the centre, at whole multiples of
 * the pitch, which is what makes a partition fit two different-sized modules.
 */
export function toolboxGridHoles(width: Mm, depth: Mm): GridHole[] {
  const spanX = width - 2 * TOOLBOX_GRID_MARGIN;
  const spanY = depth - 2 * TOOLBOX_GRID_MARGIN;
  if (spanX < 0 || spanY < 0) return [];
  const columns = 2 * Math.floor(spanX / (2 * TOOLBOX_GRID_PITCH)) + 1;
  const rows = 2 * Math.floor(spanY / (2 * TOOLBOX_GRID_PITCH)) + 1;
  const holes: GridHole[] = [];
  for (let c = 0; c < columns; c++) {
    for (let r = 0; r < rows; r++) {
      holes.push({
        x: (c - (columns - 1) / 2) * TOOLBOX_GRID_PITCH,
        y: (r - (rows - 1) / 2) * TOOLBOX_GRID_PITCH,
      });
    }
  }
  return holes;
}

/** A centred rectangle profile of the given plan. */
function centredRect(width: Mm, depth: Mm): Profile {
  return rectProfile(width, depth, true);
}

/**
 * A centred rectangle profile inset `inset` on every side.
 *
 * The whole module is expressed this way — every face is "so many mm in from
 * the module's outer face" — which is why the geometry below reads as insets
 * rather than as coordinates.
 */
function insetRect(width: Mm, depth: Mm, inset: Mm): Profile {
  return centredRect(width - 2 * inset, depth - 2 * inset);
}

/**
 * The registration FOOT: the module's bottom `TOOLBOX_FOOT_H` mm, inset
 * `TOOLBOX_FOOT_INSET`, with a 45° nose on its bottom edge.
 *
 * A deliberate 1 mm more than the foot's nominal height, so it overlaps the
 * outward flare above it by volume rather than meeting it face-to-face —
 * touching faces union into one component but leave a zero-thickness seam,
 * which is not a joint.
 *
 * EXPORTED for issue #157: a fit coupon must slice the compiler's own feature
 * rather than redraw it (`fitCoupons.ts:13-23`), and this is that feature —
 * `insert.ts`'s `roundPocketCutter` is the precedent.
 */
export function toolboxFootOps(width: Mm, depth: Mm): BuildOp {
  const noseInset = TOOLBOX_FOOT_INSET + TOOLBOX_LEAD_IN;
  const outerW = width - 2 * TOOLBOX_FOOT_INSET;
  const outerD = depth - 2 * TOOLBOX_FOOT_INSET;
  const noseW = width - 2 * noseInset;
  const noseD = depth - 2 * noseInset;

  // Nose first: its base is the fully-inset plan and `scaleTop` brings the far
  // face out to the foot's plan, so each face climbs at exactly 45°.
  return union([
    extrude(centredRect(noseW, noseD), TOOLBOX_LEAD_IN, {
      scaleTop: [outerW / noseW, outerD / noseD],
    }),
    translate(
      [0, 0, TOOLBOX_LEAD_IN],
      extrude(centredRect(outerW, outerD), TOOLBOX_FOOT_H + 1 - TOOLBOX_LEAD_IN),
    ),
  ]);
}

/**
 * The height over which the foot's outer face flares out to the module's full
 * plan. Equal to the inset, so the flare is exactly 45° — the steepest an FDM
 * printer will hold without supports.
 */
const FLARE = TOOLBOX_FOOT_INSET;

/** The outward solid: foot, flare, then the full-width box. */
function moduleOuterSolid(width: Mm, depth: Mm, height: Mm): BuildOp {
  return union([
    toolboxFootOps(width, depth),
    translate(
      [0, 0, TOOLBOX_FOOT_H],
      extrude(insetRect(width, depth, TOOLBOX_FOOT_INSET), FLARE, {
        scaleTop: [width / (width - 2 * FLARE), depth / (depth - 2 * FLARE)],
      }),
    ),
    translate(
      [0, 0, TOOLBOX_FOOT_H + FLARE],
      extrude(centredRect(width, depth), height - TOOLBOX_FOOT_H - FLARE),
    ),
  ]);
}

/**
 * The cavity, as one cutter that follows the wall: narrow inside the foot,
 * flaring with it, then full width.
 *
 * A single cutter rather than three, because Manifold fuses coplanar neighbours
 * into one solid and the three sections share their end faces exactly — so the
 * wall keeps its constant `TOOLBOX_WALL_T` thickness through the flare with no
 * seam to leave a sliver at.
 */
function cavityCutter(width: Mm, depth: Mm, height: Mm): BuildOp {
  const footCavW = width - 2 * TOOLBOX_FOOT_CAVITY_INSET;
  const footCavD = depth - 2 * TOOLBOX_FOOT_CAVITY_INSET;
  const cavW = width - 2 * TOOLBOX_WALL_T;
  const cavD = depth - 2 * TOOLBOX_WALL_T;
  return union([
    translate(
      [0, 0, TOOLBOX_FLOOR_T],
      extrude(centredRect(footCavW, footCavD), TOOLBOX_FOOT_H - TOOLBOX_FLOOR_T),
    ),
    translate(
      [0, 0, TOOLBOX_FOOT_H],
      extrude(centredRect(footCavW, footCavD), FLARE, {
        scaleTop: [cavW / footCavW, cavD / footCavD],
      }),
    ),
    translate(
      [0, 0, TOOLBOX_FOOT_H + FLARE],
      extrude(centredRect(cavW, cavD), height - TOOLBOX_FOOT_H - FLARE),
    ),
  ]);
}

/**
 * The seating ledge: a 45° wedge growing in from the cavity wall, whose flat
 * top at `z = seatingLedge(height).z` is what the module above's foot lands on.
 *
 * The 45° underside is not decoration — it is what makes the ledge printable
 * pointing up. A square-shouldered ledge would be an unsupported inward
 * overhang; the wedge starts at zero width against the wall and grows inward as
 * it rises, which is the same "no support needed" rule as the module's own
 * flare.
 *
 * The operand order matters and is easy to get backwards. It is a straight
 * block MINUS an inward-tapering frustum: the block supplies the material, and
 * the frustum carves away everything the ledge should not occupy — leaving the
 * wedge the taper did not reach. Subtracting the other way round (a tapering
 * block minus the straight cavity) gives a wedge that *shrinks* as it rises
 * and vanishes entirely by the top, which is a 0.5 mm sliver at the wall and
 * no ledge at all.
 *
 * The block's outer face sits `LEDGE_EMBED` inside the wall so the two are
 * joined by volume rather than by a face, and the knife edge at the block's
 * bottom corner is buried in the wall for the same reason.
 */
const LEDGE_EMBED = 0.5;
function seatingLedgeOps(width: Mm, depth: Mm, ledgeZ: Mm): BuildOp {
  const cavW = width - 2 * TOOLBOX_WALL_T;
  const cavD = depth - 2 * TOOLBOX_WALL_T;
  const outerW = cavW + 2 * LEDGE_EMBED;
  const outerD = cavD + 2 * LEDGE_EMBED;
  const topW = cavW - 2 * TOOLBOX_LEDGE_W + 2 * LEDGE_EMBED;
  const topD = cavD - 2 * TOOLBOX_LEDGE_W + 2 * LEDGE_EMBED;
  return translate(
    [0, 0, ledgeZ - TOOLBOX_LEDGE_W],
    difference([
      extrude(centredRect(outerW, outerD), TOOLBOX_LEDGE_W),
      extrude(centredRect(outerW, outerD), TOOLBOX_LEDGE_W, {
        scaleTop: [topW / outerW, topD / outerD],
      }),
    ]),
  );
}

/**
 * One module: foot, box, cavity, seating ledge, optionally the floor grid.
 *
 * `height` is separate from the params because the lid is the same module at
 * `TOOLBOX_LID_H` — one builder, two callers. Returns `null` when the module
 * would have no extent, which is the compiler's fall-through signal (the panel
 * reports the reason from `toolboxParamsProblem` instead of a blank viewport).
 */
export function buildToolboxModule(
  params: ToolboxParams,
  height: Mm,
  opts: { grid: boolean },
): BuildOp | null {
  const { width, depth } = params;
  if (toolboxParamsProblem(params) !== null) return null;
  if (!(height >= TOOLBOX_FOOT_H + FLARE)) return null;

  const ledge = seatingLedge(height);
  let op = difference([moduleOuterSolid(width, depth, height), cavityCutter(width, depth, height)]);
  if (ledge.ring) op = union([op, seatingLedgeOps(width, depth, ledge.z)]);

  const holes = opts.grid ? toolboxGridHoles(width, depth) : [];
  if (holes.length > 0) {
    // One cut per hole, through the whole floor with a little overhang at both
    // ends so neither face keeps a zero-thickness skin.
    const cutters = holes.map((h) =>
      translate([h.x, h.y, -1], cylinder(TOOLBOX_FLOOR_T + 2, TOOLBOX_GRID_HOLE / 2, 24)),
    );
    op = difference([op, ...cutters]);
  }

  return op;
}

/** The derived numbers for a module — what the panel reads and the tests pin. */
export function computeToolboxDims(
  params: ToolboxParams,
  height: Mm,
  opts: { grid: boolean },
): ToolboxDims {
  const holes = opts.grid ? toolboxGridHoles(params.width, params.depth) : [];
  // Counted off the holes themselves rather than re-derived from the span:
  // a second copy of the layout rule is a second thing to keep in step, and it
  // drifted the moment the count went odd.
  const columns = new Set(holes.map((h) => h.x)).size;
  const rows = new Set(holes.map((h) => h.y)).size;
  const ledge = seatingLedge(height);
  return {
    outer: { width: params.width, depth: params.depth, height },
    inner: {
      width: params.width - 2 * TOOLBOX_WALL_T,
      depth: params.depth - 2 * TOOLBOX_WALL_T,
    },
    innerDepth: height - TOOLBOX_FLOOR_T,
    foot: {
      outerInset: TOOLBOX_FOOT_INSET,
      cavityInset: TOOLBOX_FOOT_CAVITY_INSET,
      height: TOOLBOX_FOOT_H,
      leadIn: TOOLBOX_LEAD_IN,
      clearance: TOOLBOX_FIT_CLEAR,
    },
    seat: { z: ledge.z, innerInset: ledge.innerInset },
    grid:
      holes.length > 0
        ? {
            pitch: TOOLBOX_GRID_PITCH,
            hole: TOOLBOX_GRID_HOLE,
            centreInset: TOOLBOX_GRID_MARGIN,
            columns,
            rows,
            holes,
          }
        : null,
  };
}

/**
 * The two printed parts: the bin, and a lid which is the SAME module at
 * `TOOLBOX_LID_H`.
 *
 * The lid is deliberately not a dead-flat cap. A cap has to present a seating
 * surface for the next module up and a rim to square it against; a plain plate
 * can do neither, and a stack with a flat lid simply stops registering there. A
 * 16 mm module does both — and because the lid is barely taller than its own
 * foot, its floor *is* its seating ledge, so it needs no ledge ring at all.
 *
 * `null` when the module is unbuildable, so the compiler falls through to the
 * shell exactly as the badge and blank archetypes do.
 *
 * EMITTED IN ASSEMBLY SPACE, as `buildRackNodes` does. Each module is BUILT in
 * its own print frame — `z = 0` is its own seating plane — but the lid is the
 * module that seats on the bin, so it is placed at the bin's seating ledge
 * rather than left at the origin. Without that, both parts occupy `z = 0..` and
 * the lid renders buried inside the bin's foot, which is what a toolbox looked
 * like before this: the picture said the lid was part of the bin.
 *
 * Placement only; no geometry moves. The print-ready layout re-lays every part
 * by its own bounding box, so neither frame is what reaches the bed.
 */
export function buildToolboxNodes(p: ToolboxParams): BuildNode[] | null {
  const bin = buildToolboxModule(p, p.height, { grid: p.grid });
  const lid = buildToolboxModule(p, TOOLBOX_LID_H, { grid: false });
  if (!bin || !lid) return null;
  return [
    { id: TOOLBOX_BIN_NODE_ID, op: bin },
    { id: TOOLBOX_LID_NODE_ID, op: translate([0, 0, seatingLedge(p.height).z], lid) },
  ];
}
