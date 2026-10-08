import {
  TOOLBOX_FIT_CLEAR,
  TOOLBOX_FLOOR_T,
  TOOLBOX_FOOT_CAVITY_INSET,
  TOOLBOX_FOOT_H,
  TOOLBOX_FOOT_INSET,
  TOOLBOX_GRID_DEPTH,
  TOOLBOX_GRID_GAP,
  TOOLBOX_GRID_MARGIN,
  TOOLBOX_LEAD_IN,
  TOOLBOX_LEDGE_W,
  TOOLBOX_LID_H,
  TOOLBOX_WALL_T,
  toolboxParamsProblem,
  type Mm,
  type ToolboxParams,
  type ToolboxPeg,
} from '@/types';
import {
  difference,
  extrude,
  rotate,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';
import { rectProfile, type Profile } from './profile';
import {
  HOLE_GRID_PITCH,
  HOLE_GRID_SOCKET,
  holeGridCentres,
  holeGridPocket,
  type HoleGridOptions,
} from './holeGrid';
import { PEG_WIDTH_EAR, buildDividerPegOp } from './dividerPegs';

/**
 * Issue #155 — the stacking-toolbox archetype: one module builder, used twice.
 *
 * PROVENANCE, and the reasoning behind the shape, are in `types/toolbox.ts` —
 * read that header first. Two things worth repeating here because they explain
 * every line below:
 *
 *   - clean-room except for the floor's socket interface: the module — foot,
 *     ledge, flare, stacking joint — is ours, derived from the requirements in
 *     `/Toolbox.md`; the floor grid is the MEASURED 5 × 5 on 12 mm lattice from
 *     `holeGrid.ts`, reused on purpose (see that file's header, and
 *     `types/toolbox.ts` for the licensing reasoning). No compatibility with
 *     any reviewed product is claimed anywhere;
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
  /** The floor socket grid, or `null` when it is off or nothing fits. */
  grid: {
    pitch: Mm;
    /** Side of one square socket, mm. */
    socket: Mm;
    /** How deep each socket is cut into the floor, mm. */
    depth: Mm;
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
 * The lattice the bin's floor carries, as one `HoleGridOptions`.
 *
 * Kept in one place because four callers must agree on it exactly: the holes
 * the panel counts, the pocket the floor is cut with, the limits a divider is
 * checked against, and the context its tenons are built from. A second copy
 * here is a second thing to keep in step.
 *
 * `anchor: 'centre'` is the toolbox's own requirement, not a default — see
 * `toolboxGridHoles` and `HoleGridAnchor`.
 */
function toolboxGridOptions(): HoleGridOptions {
  return {
    pitch: HOLE_GRID_PITCH,
    socket: HOLE_GRID_SOCKET,
    margin: TOOLBOX_GRID_MARGIN,
    anchor: 'centre',
  };
}

/**
 * The socket centres in the bin's floor: symmetric about the module's centre,
 * with an ODD count, so the lattice is anchored on the centre line at whole
 * multiples of the pitch.
 *
 * Symmetric rather than corner-anchored (which is `holeGridCentres`' default,
 * for a one-off cavity): the module is centred, so a corner-anchored grid would
 * drift off-centre as the plan changes, and two modules of different sizes
 * would stop sharing a common hole line — which is the whole point of a
 * drop-in grid you can hang a partition from.
 *
 * Odd is the part that needs saying. An even count has no socket on the centre
 * line, so its sockets sit at ±half a pitch: still square, but every one of
 * them is half a pitch off the module's own centre, and two modules whose
 * counts differed in parity would share no hole line at all. Odd keeps the
 * lattice on the centre, at whole multiples of the pitch, which is what makes
 * one divider fit two different-sized modules.
 */
export function toolboxGridHoles(width: Mm, depth: Mm): GridHole[] {
  return holeGridCentres(centredRect(width, depth), toolboxGridOptions()).map(([x, y]) => ({
    x,
    y,
  }));
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

  if (opts.grid && toolboxGridHoles(width, depth).length > 0) {
    // BLIND, not through, and that is the whole point of the feature: the
    // socket is what a divider's tenon seats ON. A hole through the floor
    // gives the tenon nothing to bottom out on, so the divider's height would
    // be set by its plate resting on the floor, and the tenon would poke into
    // the module below — which for a stack is the cavity of the bin underneath.
    // It also leaves the bin sealed, which a toolbox wants.
    //
    // Cut from the floor's TOP face down `TOOLBOX_GRID_DEPTH`, so the pocket
    // runs z = FLOOR_T - DEPTH .. FLOOR_T and keeps half the floor under it.
    const pocket = holeGridPocket(centredRect(width, depth), toolboxGridOptions());
    op = difference([
      op,
      translate(
        [0, 0, TOOLBOX_FLOOR_T - TOOLBOX_GRID_DEPTH],
        extrude(pocket, TOOLBOX_GRID_DEPTH),
      ),
    ]);
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
            pitch: HOLE_GRID_PITCH,
            socket: HOLE_GRID_SOCKET,
            depth: TOOLBOX_GRID_DEPTH,
            columns,
            rows,
            holes,
          }
        : null,
  };
}

/**
 * How far from the module's centre a divider's END may reach, mm.
 *
 * NOT the same as the grid's own limit, and the difference is the foot. A
 * socket only has to clear the wall with its own outline — but a peg's plate
 * runs on `PEG_WIDTH_EAR` past its outer tenon before it ends, and at floor
 * level the wall it has to clear is the FOOT CAVITY face at
 * `TOOLBOX_FOOT_CAVITY_INSET`, not the thinner wall above the flare. So the
 * outermost socket column takes a socket and not a divider: a peg hung there
 * buries its end in the wall.
 *
 * The second bound is the seating ledge, which is what makes the LID's stack
 * work: it reaches `TOOLBOX_LEDGE_W` in from the cavity wall at the rim, so a
 * divider standing further out than its inner edge would foul the module above
 * as it lands. Keeping the ends inboard of the ledge also means a divider can
 * be as tall as the ledge — `toolboxPegProblem` allows exactly that — without
 * ever meeting the ledge's 45° underside, because the ledge does not reach
 * where the divider stands.
 *
 * On the default 300 × 200 floor neither bound costs anything: the ear still
 * clears at the 11th column out and the lattice is 11 columns either side, so
 * the grid count is unchanged. It bites on a small module, where a divider has
 * to be shorter-waisted than the socket count alone would suggest.
 */
function pegReach(width: Mm, depth: Mm): { x: Mm; y: Mm } {
  const keep = Math.max(
    TOOLBOX_FOOT_CAVITY_INSET + PEG_WIDTH_EAR + TOOLBOX_GRID_GAP,
    TOOLBOX_WALL_T + TOOLBOX_LEDGE_W + TOOLBOX_GRID_GAP,
  );
  return { x: width / 2 - keep, y: depth / 2 - keep };
}

/** The furthest tenon offset from the centre, in whole pitches, that is still
 *  in reach — the peg's own limit, not the lattice's. */
function maxPegIndex(reach: Mm): number {
  return Math.floor(reach / HOLE_GRID_PITCH + 1e-9);
}

/** The widest divider that fits across an axis, in sockets. Always odd, and at
 *  least 1 when the grid fits at all — the panel uses it to bound the input. */
export function toolboxPegSpanLimit(p: ToolboxParams, axis: 'x' | 'y'): number {
  return 2 * maxPegIndex(pegReach(p.width, p.depth)[axis]) + 1;
}

/**
 * The highest a divider may stand above the bin's floor, mm — the cavity up to
 * the seating ledge, which is as tall as the bin's interior actually is.
 *
 * Exported because the panel needs the same number to seed a new divider's
 * height: the alternative is the panel deriving "the ledge, minus the floor"
 * itself, which is the same formula written twice.
 */
export function toolboxPegHeadroom(p: ToolboxParams): Mm {
  return seatingLedge(p.height).z - TOOLBOX_FLOOR_T;
}

/**
 * Why one divider will not build, or `null` when it will.
 *
 * DELIBERATELY NOT folded into `toolboxParamsProblem`. That predicate gates the
 * WHOLE module — a non-null result makes `buildToolboxModule` return null and
 * the toolbox vanishes from the viewport. A divider with an impossible span
 * must drop the DIVIDER, not the bin it stands in, so this is a second
 * predicate, reported by the panel and consulted by `buildToolboxNodes` before
 * it emits a node.
 */
export function toolboxPegProblem(peg: ToolboxPeg, p: ToolboxParams): string | null {
  // The grid is a property of the BIN, not of this divider, so this one reason
  // carries no id — every divider in a grid-less bin would say the same thing,
  // and `toolboxPegProblems` collapses it to one line.
  if (!p.grid) return 'The floor grid is off, so a divider has no sockets to plug into';
  if (!(peg.spans >= 1)) return `Divider ${peg.id}: it must span at least one socket`;
  // A socket is the unit, so a fractional span is meaningless — and it is
  // REACHABLE: the panel's span input steps by one but a typed `2.5` passes
  // React's `Number()`. Caught here as well as in `dividerPegProblem` because
  // this predicate is what the panel reads; without it the divider would simply
  // vanish from the viewport with nothing said, since the builder drops a peg
  // whose op comes back null.
  if (!Number.isInteger(peg.spans)) {
    return `Divider ${peg.id}: ${peg.spans} sockets is not a whole number of sockets — its tenons would land between the holes`;
  }
  const across = peg.axis === 'x' ? 'width' : 'depth';
  const limit = maxPegIndex(pegReach(p.width, p.depth)[peg.axis]);
  // floor(spans / 2) is the outermost tenon's offset in pitches, for either
  // parity: odd spans put the tenons on whole pitches either side of the
  // module's centre, even ones half a pitch off it, and both reach the same
  // distance out.
  if (Math.floor(peg.spans / 2) > limit) {
    return `Divider ${peg.id}: ${peg.spans} sockets across the ${across} runs past the floor's usable sockets — at most ${2 * limit + 1} fit`;
  }
  if (!(peg.height > 0)) return `Divider ${peg.id}: height must be greater than zero`;
  const headroom = toolboxPegHeadroom(p);
  if (peg.height > headroom) {
    return `Divider ${peg.id}: ${peg.height} mm stands above the ${Math.round(headroom)} mm the bin holds under its seating ledge`;
  }
  if (!(peg.thickness > 0)) return `Divider ${peg.id}: thickness must be greater than zero`;
  return null;
}

/**
 * Every divider's reason for not building, in list order — `[]` when they all
 * build. The panel's form of `toolboxPegProblem`, and the only thing it and the
 * builder both read, so a divider that is reported is exactly one that is not
 * emitted.
 */
export function toolboxPegProblems(p: ToolboxParams): string[] {
  const reasons = (p.pegs ?? [])
    .map((peg) => toolboxPegProblem(peg, p))
    .filter((reason): reason is string => reason !== null);
  // Every other reason names its divider, so the only duplicate a Set can
  // collapse is the grid one — which is one fact about the bin, not one per
  // divider.
  return [...new Set(reasons)];
}

/**
 * Where a divider sits in the bin, and whether it is turned across the width.
 *
 * The peg is built in its own frame with the wall along X and centred on the
 * origin, so an `'x'` divider needs no turn and a `'y'` one takes a quarter
 * turn about Z. Either way the placement is `TOOLBOX_FLOOR_T`, the floor's top
 * face: the peg's wall starts at its own z = 0 and its tenons hang below it.
 *
 * The offset along the wall is the interesting part. The tenons sit
 * `(spans - 1) / 2` pitches either side of the peg's own centre and the sockets
 * are on whole pitches from the module's centre, so an ODD span centres the
 * divider on the module and an EVEN one has no choice but to sit half a pitch
 * off — that is the only position where both tenons find a socket. It looks
 * like an off-by-one and is not, which is why it is written down.
 */
function pegPlacement(peg: ToolboxPeg): { offset: [Mm, Mm, Mm]; spin: boolean } {
  const spin = peg.axis === 'y';
  const along = peg.spans % 2 === 1 ? 0 : HOLE_GRID_PITCH / 2;
  return {
    offset: spin ? [0, along, TOOLBOX_FLOOR_T] : [along, 0, TOOLBOX_FLOOR_T],
    spin,
  };
}

/**
 * The parts a toolbox prints: the bin, a lid which is the SAME module at
 * `TOOLBOX_LID_H`, and one free node per enabled divider.
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

  const nodes: BuildNode[] = [
    { id: TOOLBOX_BIN_NODE_ID, op: bin },
    { id: TOOLBOX_LID_NODE_ID, op: translate([0, 0, seatingLedge(p.height).z], lid) },
  ];

  // The dividers, as their OWN top-level nodes — free pieces you drop into the
  // finished bin, for the same reason `dividerPegs.ts` emits pegs separately:
  // fusing one into the bin would make it un-printable as something you take
  // out. The print layout re-lays every node by its own bounding box, so an
  // assembly position here is a picture, not a print position.
  //
  // Skipped when `toolboxPegProblem` objects, which is exactly when the panel
  // reports a reason — so the two never disagree about what exists.
  for (const peg of p.pegs ?? []) {
    if (!peg.enabled) continue;
    if (toolboxPegProblem(peg, p) !== null) continue;
    const op = buildDividerPegOp(
      { id: peg.id, spans: peg.spans, height: peg.height, thickness: peg.thickness, enabled: true },
      {
        grid: { pitch: HOLE_GRID_PITCH, socket: HOLE_GRID_SOCKET },
        socketDepth: TOOLBOX_GRID_DEPTH,
      },
    );
    if (!op) continue;
    const { offset, spin } = pegPlacement(peg);
    nodes.push({
      id: `divider-peg-${peg.id}`,
      op: translate(offset, spin ? rotate([0, 0, 90], op) : op),
    });
  }

  return nodes;
}
