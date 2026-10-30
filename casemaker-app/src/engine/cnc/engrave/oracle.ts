/**
 * The volumetric oracle (#206, `/Simulation.md` §7). The last gate before a `.nc` is offered for
 * download: it compares what the SIMULATION removed against what the CAM PREDICTED, level by
 * level, and refuses the file when they disagree by more than the tolerance the pipeline's own
 * two approximations can explain.
 *
 * The prediction is the union of the OPENED regions of every item whose depth reaches a level —
 * the reachable region of a glyph for a given tool radius (`engravableProfile`, the morphological
 * opening `offset(offset(G, -r), +r)`). At a level with floor Z, the removal region is every point
 * the tool cut at or below Z; the predicted region is every point a cut SHOULD reach at that level.
 * They are the same set up to two tolerances.
 *
 * A V-BIT TRACE IS NOT AN OPENING (#408). A cone's cut is not a 2D region repeated at every level:
 * the material it removes at a level depends on how far below the tip that level is, so the
 * prediction for a trace is a GROOVE — a region that GROWS as the level rises, and the reason an
 * `OraclePredicted` entry may carry {@link OracleGroove} instead of a polygon set.
 *
 * The simulated side is a SLICER, not a solid (#408): the exact 2.5D sweeper answers with a slice
 * of its cumulative `removal` solid, and the column engine — which keeps its material as a sampled
 * height field, not a solid — answers with the cell squares its grid has been cut to at or below
 * that level. The comparison below is the same code for both, which is the point of the seam: a
 * groove is judged by the same rules as a pocket, on whatever the engine that swept it can say.
 *
 * The band is DERIVED, never hand-set (the whole point of `ARC_CHORD_TOLERANCE_MM`'s doc): the
 * sweep simplifies each union tree with `SWEEP_SIMPLIFY_EPS_MM` once per chunk and once per tree
 * level, and both the profile and the removal carry one arc-chord flattening each. So
 *
 *   band = levels x SWEEP_SIMPLIFY_EPS_MM + 2 x ARC_CHORD_TOLERANCE_MM
 *
 * A difference inside the band is expected float/approximation drift; a difference outside it is
 * a CAM bug — too coarse a step-over (the #191 rule, stepOver <= tool radius) leaves an uncut
 * spine, and the under-cut is exactly that spine's area.
 *
 * A column engine's band adds ITS OWN resolution term, for the same reason and by the same rule:
 * a cell is in the region when the material at its CENTRE is at or below the level, so the mask's
 * boundary is a staircase inside half a cell diagonal of the true one — {@link columnBandTerm}.
 */

import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM, segmentsForRadius } from '@/engine/compiler/arcResolution';
import { angleToArc, facetTerm } from '@/engine/cnc/rotary/wrap';
import { grooveRadiusAt, type VCone } from '@/engine/cnc/vProfile';
import { traceSweptProfile } from '@/engine/cnc/engrave/partPlan';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { CHUNK as SWEEP_CHUNK, FANOUT as SWEEP_FANOUT, SWEEP_TOLERANCES } from '@/workers/geometry/sweep';
import {
  cutterReach,
  rotaryFacetTerm,
  surfaceAboveTip,
  threadCutter,
  type ColumnCutter,
  type ColumnGrid,
} from '@/workers/geometry/columnEngine';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** A point in the work frame, mm. */
export type OraclePoint = [number, number];

/** An axis-aligned region in the work frame, mm. */
export interface OracleBbox {
  min: OraclePoint;
  max: OraclePoint;
}

/** A closed contour in the work frame, mm: outer contours CCW and holes CW. */
export type OraclePolygon = OraclePoint[];

/**
 * A V TRACE's cut, as the shape it is (#408): the cone, and the polylines it is dragged along.
 *
 * The region a trace removes at a cut level is its centreline dilated by the cone's XY reach at
 * that level, and the reach follows from the flank's own rise. With the tip at work Z `zTip` and
 * the level at `z`, a point at radial distance `rho` from the path is left at `zTip + rise(rho)`
 * for `rise(rho) = (rho - tipRadius)/tanHalf`, so it is cut AT OR BELOW the level exactly when
 *
 *   rise(rho) <= z - zTip   <=>   rho <= tipRadius + (z - zTip) * tanHalf
 *
 * which is `grooveRadiusAt(cone, z - zTip)` — the one statement of that geometry (`vProfile.ts`),
 * and the same reach `columnEngine` sweeps the cone with. At `z` at the top face it reduces to the
 * groove's mouth, i.e. `traceRadiusAt`, so a groove and the flat prediction of the same trace
 * agree where they should.
 *
 * Data only — this crosses a `postMessage` boundary to the sim worker, which is why the cone is
 * carried whole rather than as a closure over it.
 */
export interface OracleGroove {
  /**
   * The trace's polylines in the work frame, as `tracePaths` lays them out — the CAM's OWN passes,
   * so the prediction and the program describe the same strokes (a bold stroke is already widened
   * into parallel passes by the time it is here).
   */
  paths: OraclePoint[][];
  /** Parallel to `paths`: whether each polyline closes back on its first point. */
  closed: boolean[];
  /** The cone the cutter presents, from `vCone`. */
  cone: VCone;
}

/** One FEED segment of a thread program, reduced from the CAM plan's own moves. */
export interface OracleThreadMove {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The move's LOWEST tip Z in the work frame, the same reduction `flatMovesOf` makes. */
  z: number;
  /**
   * #758 — the tip at each end of the move, when the program ramps Z along it. The simulator
   * follows Z along the segment; the prediction does the same, so the two remain one model.
   */
  z0?: number;
  z1?: number;
}

/**
 * A MILLED THREAD's cut, as the shape it is (#445): the item's ISO geometry, the tool's cutting
 * diameter, and the program's own feed segments. The oracle sweeps the SAME column/cone profile
 * the simulator sweeps (`threadCutter`/`surfaceAboveTip`) over these segments on the column grid,
 * so the prediction and the simulation are two readings of one model rather than an annulus
 * guessed against an envelope.
 *
 * The segments are the CAM's FEED moves only. A rapid is at `HOP_Z`/above the top face and lowers
 * no column; the entry ramp and the plunge are feeds and are included.
 *
 * Data only — this crosses a `postMessage` boundary to the sim worker, so a plan's `CamMove`s are
 * reduced here to the five numbers the prediction needs, never the IR.
 */
export interface OracleThread {
  /** The hole's axis, work XY. */
  x: number;
  y: number;
  majorMm: number;
  minorMm: number;
  pitchMm: number;
  /** The threaded length below the top face. */
  threadDepthMm: number;
  /** `threadDepth + run-out`: how far below the top the tooth tip goes. */
  tipDepthMm: number;
  /** The cutter's cutting diameter. */
  cuttingDiameterMm: number;
  /** The CAM's feed moves, as segments, in program order. */
  moves: readonly OracleThreadMove[];
}

/** One item's predicted region at one depth (the opened region of a glyph, a shape, a groove or a thread). */
export interface OraclePredicted {
  /**
   * Floor of this item's cut, depth below the stock top face, mm (positive). For a groove this is
   * the TRACE'S TIP depth: the level its own floor is at, and the one its region has shrunk to the
   * tip radius by. For a thread it is the TIP depth: the deepest level the tooth reaches.
   *
   * ON AN INDEXED ROTARY JOB (#708) the "top face" is the FACE the item is cut on: the depth is
   * below that face, and {@link a} says which face it is.
   */
  depth: number;
  /**
   * #708 — the rotary index this prediction belongs to, degrees. Absent on a flat job; read as
   * `0` on an indexed one, which is the face a single-index program cuts at A 0. The per-face
   * oracle groups the predictions by it and compares each group with THAT face's removal turned
   * back into its own frame.
   */
  a?: number;
  /**
   * #667 — the document item this prediction describes, when it has one. The oracle does not read
   * it; a caller that must re-state the prediction for ONE program (a rest pair's rough-only file
   * splits only some entries) matches entries to items by it. Absent on a thread/groove entry a
   * caller builds without an item.
   */
  itemId?: string;
  /** Outer contours CCW and holes CW, as `measureLabels` / `toPartPlan` produce them. */
  polygons: OraclePolygon[];
  /**
   * Set instead of `polygons` when the item is a V TRACE (#408). Its region is derived per level
   * from the cone and the tip depth above, never from a fixed polygon set: a V cut as a flat
   * region — the mouth at every level — is the standing "do not" of #221.
   */
  groove?: OracleGroove;
  /**
   * Set instead of `polygons` when the item is a MILLED THREAD (#445). Its region is the column
   * grid swept with the same neck-plus-tooth profile the simulator uses, evaluated at the grid's
   * own cell centres; it is derived per level from the moves and the tip depth above.
   */
  thread?: OracleThread;
  /**
   * #669 — set when `polygons` is a V-CARVED region's FLOOR, so the entry can be read at levels
   * ABOVE its own. A V region's cross-section at a level `d` shallower than its floor is the floor
   * polygons grown by `(depth − d)·tanHalf` — the cone widening as it rises — and without this the
   * entry would contribute its narrow floor at a shallow level another item created (a V trace's
   * mouth, a chamfer's bevel) while the simulation removed the wider mouth: an over-cut that is
   * the prediction's fault, not the file's. `polygons` stays the floor, so the entry's OWN level is
   * unchanged and the common case pays no offset.
   *
   * #741 — `maxGrow` bounds that growth at the cutter's own flank: the radial run from the tip's
   * edge to the cylindrical body (`outerRadius − tipRadius`). Above the height where the cone
   * meets its body the bit cuts a VERTICAL wall, so the section stops growing there. Absent when
   * the record states no diameter wider than its tip, which is the pre-#741 open flank.
   */
  vRegion?: { tanHalf: number; maxGrow?: number };
}

/** The comparison at one distinct floor Z. */
export interface OracleLevel {
  /**
   * The floor in the WORK frame, mm. The work origin is the stock's top face, so a cut is at
   * NEGATIVE Z: `z = -depth`. This is the value `sliceAt(z + 0.001)` uses.
   */
  z: number;
  /** Area the prediction says is cut at this level, mm². */
  predictedArea: number;
  /** Area the simulation removed at this level, mm². */
  simulatedArea: number;
  /** Predicted but not simulated: area the file FAILED to cut, mm². */
  underCut: number;
  /** Simulated but not predicted: area the file cut OUTSIDE the plan, mm². */
  overCut: number;
  /**
   * #708 — on a per-face (indexed rotary) report, the rotary index this level belongs to,
   * degrees. Absent on the flat path, whose frame has one face.
   */
  a?: number;
  /**
   * #584 — the bbox (work/job mm) of the region predicted but not cut at this level, so a reader
   * can find the disagreement on the blank. `null` when there is no under-cut at this level (a
   * hand-built report may omit it).
   */
  underBbox?: OracleBbox | null;
  /** #584 — the bbox (work/job mm) of the region cut but not predicted at this level, or `null`. */
  overBbox?: OracleBbox | null;
}

/**
 * #623/#628 — the frame the comparison's numbers are in.
 *
 * `'work'` is the program's own frame: the stock's top is flat at the work Z0 (every program before
 * #608's surface re-post). `'surface'` means the session was loaded with a fitted surface frame: its
 * program was UN-LIFTED into the surface frame before the sweep (#625, #628), so the comparison is
 * the flat program's own — which for that program is the same numbers the work frame would give. A
 * reader (and the bench) still needs to know which frame the verdict speaks.
 */
export type OracleFrame = 'work' | 'surface';

export interface OracleReport {
  ok: boolean;
  /** The derived tolerance used, mm. */
  band: number;
  levels: OracleLevel[];
  /**
   * #623 — which frame the simulated side was read in. `computeOracle` itself is frame-agnostic (its
   * caller hands it the slices), so this is stamped by the session that owns the sweep; absent on a
   * hand-built report means the caller did not say.
   */
  frame?: OracleFrame;
  /** The worst under- and over-cut over every level, mm². */
  worst: {
    underCut: number;
    overCut: number;
    /**
     * #584 — the level Z and bbox (work/job mm) of the WORST under-cut, so the sentence can name
     * the place without scanning `levels`. `null`/absent when there is no under-cut. #708 — `a`
     * carries the rotary index on a per-face report, so the refusal names the face.
     */
    underAt?: { z: number; bbox: OracleBbox; a?: number } | null;
    /** #584 — the level Z and bbox of the WORST over-cut, or `null`/absent. #708 — as `underAt`. */
    overAt?: { z: number; bbox: OracleBbox; a?: number } | null;
  };
  /**
   * The area floor the verdict used, mm² — `ORACLE_AREA_FLOOR`, or the grid's cell area ×
   * {@link ORACLE_AREA_FLOOR_CELLS} when the column engine swept (#580). `computeOracle` always
   * sets it; OPTIONAL so a hand-built report (a test fixture) can omit it and readers fall back
   * to {@link ORACLE_AREA_FLOOR}.
   */
  areaFloor?: number;
}

/**
 * Areas below this are slivers: a `subtract` of two coincident boundaries leaves a
 * floating-point-thin ring with a tiny non-zero area. Not a CAM defect. mm².
 */
export const ORACLE_AREA_FLOOR = 1e-3;

/**
 * #580 — the resolution-aware floor's cell count. The column engine cannot resolve a region
 * smaller than its grid cell, so a "worst under-cut" of one dexel is a disagreement, not material
 * left standing. The verdict uses the greater of {@link ORACLE_AREA_FLOOR} and the grid's cell
 * area × this count — a 2×2 cell block, the smallest region the grid can actually represent.
 */
export const ORACLE_AREA_FLOOR_CELLS = 4;

/** Slice this far ABOVE a floor Z so the slice is inside the pocket cut toward that floor, mm. */
export const ORACLE_SLICE_LIFT_MM = 0.001;

/**
 * Where the extra level of a GROOVE prediction sits, as a fraction of the shallowest groove's own
 * depth (#408).
 *
 * A cone's region is widest just under the top face and closes to the tip's flat at the trace's
 * floor, so a set of levels made only of the FLOORS asks the narrowest question the job can ask:
 * for the bench bit (0.3 mm tip) a 1 mm-deep trace leaves a strip of exactly one column cell, and
 * the derived band is then nearly the whole of it. The check is not wrong — the band is honest —
 * but it certifies that the groove's floor is on the centreline, and nothing about the groove's
 * width. One level a tenth of the way down fixes that: at 0.1 mm the same groove is 0.78 mm wide,
 * three cells, and the comparison covers the shape the plan actually draws.
 *
 * A tenth, and not the top face itself: at `z = 0` a column's UNTOUCHED cells already read as cut
 * (`h = 0 <= 0 + lift`), which would report the whole stock as removed, and on the exact side the
 * slice would fall above the material. Clear of the top face by a tenth of a trace's depth, every
 * engine is answering the same question.
 */
export const ORACLE_SHALLOW_DEPTH_FRACTION = 0.1;

/** The derived oracle band for a sweep whose worst checkpoint saw `contours` 2D contours. */
export function oracleBand(contours: number): number {
  return SWEEP_TOLERANCES.simplifyLevels(contours) * SWEEP_SIMPLIFY_EPS_MM + 2 * ARC_CHORD_TOLERANCE_MM;
}

/**
 * What the engine that swept the run can say about one level, as a CrossSection the CALLER of
 * `sliceAt` owns and the oracle deletes. `null` means it cut nothing at or below this level — an
 * empty region, which the oracle reports as an area of 0 without asking a `CrossSection` to be
 * built from no polygons (`ofPolygons([])` throws).
 *
 * The argument is the SLICE height, i.e. the level's floor `z` plus `ORACLE_SLICE_LIFT_MM`: a
 * column whose floor is exactly the level must count, and float equality does not.
 */
export type OracleSliceAt = (zSlice: number) => CrossSectionInstance | null;

/** The exact sweeper's answer (#206): its cumulative removal solid, sliced. */
export const removalSliceAt =
  (removal: ManifoldInstance): OracleSliceAt =>
  (zSlice) =>
    removal.slice(zSlice);

/**
 * The column engine's answer (#408): the cell squares of its height field whose own floor is at or
 * below `zSlice`.
 *
 * `h` is the REMAINING TOP Z of a column, so "cut to at or below the level" is `h <= zSlice` — the
 * same test the removal solid answers with a `slice`, which is what makes the two engines
 * comparable at all. A cell's centre carries the column's own value (`buildGrid`'s `u0` is the
 * first centre), so the mask is the true region sampled at the centres: no interpolation, and the
 * band's grid term is exactly the staircase's own error.
 *
 * Columns are merged into horizontal RUNS before the union — a groove is a handful of cells across
 * and thousands long, and the union's cost is dominated by contour count — and the runs are
 * unioned in chunks the way `sweep.ts` unions its capsules, since that is the measured shape of
 * this operation.
 *
 * The grid is read in the frame it was SWEPT in. A surface-posted program is un-lifted before the
 * sweep (#625, #628), so the grid holds the flat program's own height field and no per-cell lift is
 * applied here: the level means the same thing in both frames, and `OracleReport.frame` says which
 * one the numbers speak.
 */
export function gridSliceAt(tl: ManifoldToplevel, grid: ColumnGrid): OracleSliceAt {
  const CS = tl.CrossSection;
  const { nu, nv, u0, du, v0, dv, h } = grid;
  return (zSlice) => {
    const runs: OraclePolygon[] = [];
    for (let j = 0; j < nv; j++) {
      let start = -1;
      for (let i = 0; i <= nu; i++) {
        const top = i < nu ? (h[j * nu + i] as number) : 0;
        const cut = i < nu && top <= zSlice;
        if (cut && start < 0) start = i;
        if (!cut && start >= 0) {
          // One rectangle for the whole run — the left edge of its first cell to the right edge of
          // its last. A run of one is that same rectangle (each column's square is centred on the
          // column), so it is not a case of its own.
          runs.push([
            [u0 + (start - 0.5) * du, v0 + (j - 0.5) * dv],
            [u0 + (i - 0.5) * du, v0 + (j - 0.5) * dv],
            [u0 + (i - 0.5) * du, v0 + (j + 0.5) * dv],
            [u0 + (start - 0.5) * du, v0 + (j + 0.5) * dv],
          ]);
          start = -1;
        }
      }
    }
    if (runs.length === 0) return null;
    // Chunks of `SWEEP_CHUNK`, unioned pairwise — the same shape as `unionCapsules`, minus its
    // simplify: these contours are already axis-aligned rectangles, and simplifying them would
    // throw away exactly the staircase the band is sized for. `Positive` rather than the even-odd
    // default because consecutive rows SHARE an edge, and a duplicated edge under even-odd is a
    // cancellation waiting to happen; the runs of one row are disjoint, so winding decides nothing
    // else.
    let level: CrossSectionInstance[] = [];
    for (let i = 0; i < runs.length; i += SWEEP_CHUNK) {
      level.push(CS.ofPolygons(runs.slice(i, i + SWEEP_CHUNK), 'Positive'));
    }
    while (level.length > 1) {
      const next: CrossSectionInstance[] = [];
      for (let i = 0; i < level.length; i += SWEEP_FANOUT) {
        const group = level.slice(i, i + SWEEP_FANOUT);
        if (group.length === 1) next.push(group[0] as CrossSectionInstance);
        else {
          const merged = CS.union(group);
          for (const g of group) g.delete();
          next.push(merged);
        }
      }
      level = next;
    }
    return level[0] ?? null;
  };
}

/**
 * The column engine's own term of the band, mm (#408): half the diagonal of one grid cell.
 *
 * A cell is in the mask when the material at its CENTRE is at or below the level, so the mask's
 * boundary is the true boundary quantised to cell edges. Every mask point is within half a cell
 * diagonal of the centre that put it there, and that centre is inside the true region — so the
 * mask is inside the region grown by this much. The other direction is the same argument read
 * backwards: a point of the region further than this from the region's edge lies in a cell whose
 * centre is inside, so the mask contains it. Both halves of the comparison are therefore satisfied
 * by this term, and nothing wider is needed — a wider band would only hide under-cuts the grid
 * could resolve.
 *
 * The term is DERIVED from the grid the run actually swept with (`du`, `dv` are its own pitches,
 * in mm for the flat parameterisation), never hand-set — the same rule the sweep's term follows.
 */
export function columnBandTerm(grid: ColumnGrid): number {
  return Math.hypot(grid.du, grid.dv) / 2;
}

/** The oracle band for a run the COLUMN engine swept: the sweep's term plus the grid's. */
export function columnOracleBand(contours: number, grid: ColumnGrid): number {
  return oracleBand(contours) + columnBandTerm(grid);
}

/**
 * The region a groove removes at one level: the trace's polylines dilated by the cone's XY reach
 * there, evaluated to a CrossSection the caller owns. `null` when nothing is cut — the reach has
 * closed down to a point (a sharp tip at its own floor), or the trace has no path.
 */
function grooveRegionAt(tl: ManifoldToplevel, groove: OracleGroove, tipDepth: number, depth: number): CrossSectionInstance | null {
  if (groove.paths.length === 0) return null;
  // The tip sits `tipDepth` below the top face and the level sits `depth` below it, so the level
  // is `tipDepth - depth` mm above the tip — the rise the cone's flank is asked for.
  const radius = grooveRadiusAt(groove.cone, tipDepth - depth);
  if (!(radius > 0)) return null;
  return executeProfile(tl, traceSweptProfile(groove.paths, groove.closed, radius));
}

/**
 * #669 — a V region's cross-section at a level ABOVE its floor: the floor polygons grown by the
 * cone's rise over the difference (`(depth − level)·tanHalf`, see {@link OraclePredicted.vRegion}).
 * The offset is the same round join and chord resolution `makeClipperOffset` uses, so the grown
 * boundary matches the cutter's own polygonisation at that level.
 */
function vRegionAt(
  tl: ManifoldToplevel,
  floor: readonly OraclePolygon[],
  grow: number,
  segments: number,
): CrossSectionInstance {
  const CS = tl.CrossSection;
  const cs = CS.ofPolygons(floor as OraclePolygon[]);
  if (!(grow > 0)) return cs;
  const grown = cs.offset(grow, 'Round', 2, segments);
  cs.delete();
  return grown;
}

/**
 * The extra level a GROOVE prediction is judged at, or none (`[]`) when there is no groove.
 *
 * Derived from the shallowest groove's own depth rather than set to a millimetre, so a job of
 * 0.2 mm traces is judged as close to its own mouth as a job of 2 mm ones. Zero entries and
 * non-positive depths are excluded like everywhere else, so a degenerate entry cannot invent a
 * level at the top face.
 */
function shallowGrooveLevel(predicted: readonly OraclePredicted[]): number[] {
  const grooveDepths = predicted.filter((p) => p.groove !== undefined && p.depth > 0).map((p) => p.depth);
  if (grooveDepths.length === 0) return [];
  return [Math.min(...grooveDepths) * ORACLE_SHALLOW_DEPTH_FRACTION];
}

/**
 * The predicted HEIGHT FIELD a milled thread leaves, sampled at the column grid's own cell centres
 * and returned as a level slicer (#445).
 *
 * The simulator and this prediction must answer with the same model: the profile is `threadCutter`/
 * `surfaceAboveTip` (including the engine's half-cell pad) and the moves are the CAM plan's own
 * feed segments — ALL of them. A later turn of the helix is dominated by the first one at the same
 * angle, so filtering to the first revolution is tempting, but it is only sound while the entry
 * ramp is no longer than one pitch: a 0.5 mm ramp over M2's 0.4 mm pitch climbs above the first
 * turn's top, the simulator still sweeps those upper ramp segments, and a prediction that dropped
 * them would report an over-cut on a correct program (#445 review). Every move is swept here
 * instead; the extra work is one pass over the plan's own segments.
 *
 * The window is the move extent grown by the cutter's reach. Cells outside the cut keep the top
 * face, so a level slices them as untouched, exactly as the simulated grid does.
 */
function threadPredictedSlice(tl: ManifoldToplevel, grid: ColumnGrid, thread: OracleThread): OracleSliceAt | null {
  const pad = columnBandTerm(grid);
  const cutter = threadCutter(thread.cuttingDiameterMm, thread.majorMm, thread.minorMm, pad);
  const reach = cutterReach(cutter, 0);
  // Every move the simulator sweeps, not just the first revolution: the ramp can rise above the
  // first turn's top when it is longer than the pitch (#445 review), and later turns are dominated
  // but harmless to sweep.
  const moves = thread.moves.filter((m) => m.z < grid.initial - 1e-9);
  if (moves.length === 0) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const m of moves) {
    if (m.x0 < xMin) xMin = m.x0;
    if (m.x1 < xMin) xMin = m.x1;
    if (m.x0 > xMax) xMax = m.x0;
    if (m.x1 > xMax) xMax = m.x1;
    if (m.y0 < yMin) yMin = m.y0;
    if (m.y1 < yMin) yMin = m.y1;
    if (m.y0 > yMax) yMax = m.y0;
    if (m.y1 > yMax) yMax = m.y1;
  }
  const i0 = Math.max(0, Math.ceil((xMin - reach - grid.u0) / grid.du));
  const i1 = Math.min(grid.nu - 1, Math.floor((xMax + reach - grid.u0) / grid.du));
  const j0 = Math.max(0, Math.ceil((yMin - reach - grid.v0) / grid.dv));
  const j1 = Math.min(grid.nv - 1, Math.floor((yMax + reach - grid.v0) / grid.dv));
  if (i1 < i0 || j1 < j0) return null;

  const nu = i1 - i0 + 1;
  const nv = j1 - j0 + 1;
  const h = new Float32Array(nu * nv);
  h.fill(grid.initial);
  for (let j = 0; j < nv; j++) {
    const y = grid.v0 + (j0 + j) * grid.dv;
    for (let i = 0; i < nu; i++) {
      const x = grid.u0 + (i0 + i) * grid.du;
      let floorHere = grid.initial;
      for (const m of moves) {
        // #758 — the same along-the-move Z the simulator follows, read the same way: the column's
        // floor is the DEEPEST tip over the part of the move that covers it, and its candidates
        // are the perpendicular foot and the segment's two ends. A pure plunge passes through
        // every Z at one point, so its deepest end is the floor.
        const dxs = m.x1 - m.x0;
        const dys = m.y1 - m.y0;
        const len2 = dxs * dxs + dys * dys;
        const z0 = m.z0 ?? m.z;
        const z1 = m.z1 ?? m.z;
        for (let c = 0; c < 3; c++) {
          let t = 0;
          if (c === 0) {
            if (len2 > 0) {
              t = ((x - m.x0) * dxs + (y - m.y0) * dys) / len2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
            }
          } else {
            t = c === 1 ? 0 : 1;
          }
          const rho = Math.hypot(x - (m.x0 + t * dxs), y - (m.y0 + t * dys));
          const zt = len2 > 0 ? z0 + (z1 - z0) * t : m.z;
          if (rho > cutterReach(cutter, Math.max(0, grid.initial - zt))) continue;
          const f = zt + surfaceAboveTip(cutter, rho);
          const floor = f < grid.base ? grid.base : f;
          if (floor < floorHere) floorHere = floor;
        }
      }
      h[j * nu + i] = floorHere;
    }
  }
  const window: ColumnGrid = {
    kind: 'flat',
    nu,
    nv,
    u0: grid.u0 + i0 * grid.du,
    du: grid.du,
    v0: grid.v0 + j0 * grid.dv,
    dv: grid.dv,
    initial: grid.initial,
    base: grid.base,
    h,
  };
  return gridSliceAt(tl, window);
}

/**
 * The levels a THREAD prediction is judged at, beside its own tip depth (#445).
 *
 * The tip depth is where the tooth's first move sits, and at that level the predicted region has
 * shrunk to a sliver at the helix's start — the narrowest question the item can be asked. The
 * threaded depth is the bottom of the functional thread; the shallow level (the groove rule,
 * `ORACLE_SHALLOW_DEPTH_FRACTION`) checks the flank and pitch across the annulus; and HALF A PITCH
 * ABOVE THE TIP cuts the first revolution in half, which is the level a wrong pitch changes first.
 * Deduplicated by `computeOracle`'s Set.
 */
function threadLevels(predicted: readonly OraclePredicted[]): number[] {
  const out: number[] = [];
  for (const p of predicted) {
    if (p.thread === undefined || !(p.thread.threadDepthMm > 0)) continue;
    out.push(p.thread.threadDepthMm, p.thread.threadDepthMm * ORACLE_SHALLOW_DEPTH_FRACTION);
    const halfPitchUp = p.thread.tipDepthMm - p.thread.pitchMm / 2;
    if (halfPitchUp > 0) out.push(halfPitchUp);
  }
  return out;
}

/**
 * #584 — the axis-aligned bounds of a disagreement CrossSection, in work/job mm. Only asked of a
 * section with positive area, so the result is always finite.
 */
function bboxOf(cs: CrossSectionInstance): OracleBbox {
  const b = cs.bounds();
  return { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] };
}

/**
 * Compare the simulated side against `predicted`, level by level. Every CrossSection is deleted
 * exactly once, on both the success and the throw path.
 */
export function computeOracle(
  tl: ManifoldToplevel,
  sliceAt: OracleSliceAt,
  predicted: readonly OraclePredicted[],
  band: number,
  threadGrid?: ColumnGrid | null,
  /**
   * #708 — the work-frame Z of the part's TOP face: 0 on a flat job (the work origin IS the face),
   * and the stock's RADIUS on an indexed rotary one (the work origin is on the axis). A level's
   * slice is at `zTop - depth`, so the same depth means the same distance below whichever face the
   * comparison is about.
   */
  zTop = 0,
): OracleReport {
  const CS = tl.CrossSection;
  // The offsets are by `band` itself, so the arc being flattened has radius ≈ band.
  const roundSegments = segmentsForRadius(band);

  // #445 — a THREAD prediction is a grid-shaped height field, and the only grid it can be compared
  // on is the column grid the run was swept with. It is built once per thread, outside the level
  // loop; each level asks it only for the cells at or below that level. A caller with a thread
  // entry and no grid would be comparing against nothing, which is a bug rather than a verdict.
  const threadSlices: (OracleSliceAt | null)[] = predicted.map((p) => {
    if (p.thread === undefined) return null;
    if (threadGrid === undefined || threadGrid === null || threadGrid.kind !== 'flat') {
      throw new Error('oracle: a thread prediction needs the FLAT column grid it will be compared on');
    }
    return threadPredictedSlice(tl, threadGrid, p.thread);
  });

  // One level per distinct depth that actually carries geometry — a polygon set, a groove, or a
  // thread, whose vertices are worked out below. Ascending so the report reads shallow-first.
  const depths = [
    ...new Set([
      ...predicted
        .filter((p) => p.depth > 0 && (p.polygons.length > 0 || p.groove !== undefined || p.thread !== undefined))
        .map((p) => p.depth),
      // #408 — a groove is judged at its MOUTH as well as at its floor, and only a groove needs it:
      // a flat cutter's region is the same set at every level above its floor, so an extra level
      // there would re-ask the same question (and it is not a level the plan cuts to).
      ...shallowGrooveLevel(predicted),
      // #445 — a thread's annulus changes at every level (the flank and the run-out), so its
      // threaded depth and a shallow slice are asked too.
      ...threadLevels(predicted),
    ]),
  ].sort((a, b) => a - b);

  const levels: OracleLevel[] = [];
  let worstUnder = 0;
  let worstOver = 0;
  let worstUnderAt: { z: number; bbox: OracleBbox } | null = null;
  let worstOverAt: { z: number; bbox: OracleBbox } | null = null;

  for (const depth of depths) {
    // The work-frame floor Z: the origin is the top face, so a cut is at NEGATIVE Z (and on a
    // rotary face, `zTop - depth` — `zTop` is the radius there).
    const z = zTop - depth;
    // The predicted region at this level: every item whose floor is at or below it — a flat item
    // unchanged, a groove dilated to where its cone reaches at THIS depth. Union of CrossSections
    // (not one `ofPolygons` of concatenated contours) so a hole inside one item is preserved when
    // another item overlaps it.
    const parts: CrossSectionInstance[] = [];
    for (let pi = 0; pi < predicted.length; pi++) {
      const p = predicted[pi] as OraclePredicted;
      if (!(p.depth + 1e-9 >= depth)) continue;
      const cs = p.groove
        ? grooveRegionAt(tl, p.groove, p.depth, depth)
        : p.thread !== undefined
          ? (threadSlices[pi]?.(z + ORACLE_SLICE_LIFT_MM) ?? null)
          : p.polygons.length > 0
            ? p.vRegion !== undefined && p.depth > depth + 1e-9
              ? vRegionAt(
                  tl,
                  p.polygons,
                  // #741 — the flank rises only until it meets the body; past that the section is
                  // the body's own vertical wall, so the growth stops at the flank's radial run.
                  Math.min((p.depth - depth) * p.vRegion.tanHalf, p.vRegion.maxGrow ?? Infinity),
                  roundSegments,
                )
              : CS.ofPolygons(p.polygons)
            : null;
      if (cs) parts.push(cs);
    }
    if (parts.length === 0) continue;

    // #642 — the promise above ("deleted exactly once, on both the success and the throw path") was
    // kept only on the success path: a throw from `union`/`offset`/`sliceAt`/`area` leaked the
    // sections already built, in wasm memory nothing frees. EVERY section this level owns is held
    // here and deleted in ONE `finally`, which runs on both paths; a section is never deleted twice.
    let predictedCS: CrossSectionInstance | null = null;
    let shrunk: CrossSectionInstance | null = null;
    let grown: CrossSectionInstance | null = null;
    let sliceCS: CrossSectionInstance | null = null;
    let underCS: CrossSectionInstance | null = null;
    let overCS: CrossSectionInstance | null = null;
    try {
      if (parts.length === 1) {
        predictedCS = parts.shift() as CrossSectionInstance; // ownership moved out of `parts`
      } else {
        predictedCS = CS.union(parts);
      }

      shrunk = predictedCS.offset(-band, 'Round', 2, roundSegments);
      grown = predictedCS.offset(band, 'Round', 2, roundSegments);
      // The slice that sits just inside the material cut toward this floor. `null` means the engine
      // removed nothing at or below the level: every predicted point is then an under-cut, and
      // nothing can be an over-cut — the two `difference` calls below would both be answering a
      // question about an empty set, so they are not asked.
      sliceCS = sliceAt(z + ORACLE_SLICE_LIFT_MM);

      const predictedArea = predictedCS.area();
      const simulatedArea = sliceCS === null ? 0 : sliceCS.area();

      let underCut: number;
      let overCut: number;
      let underBbox: OracleBbox | null = null;
      let overBbox: OracleBbox | null = null;
      if (sliceCS === null) {
        underCut = Math.max(0, shrunk.area());
        overCut = 0;
        if (underCut > 0) underBbox = bboxOf(shrunk);
      } else {
        underCS = CS.difference([shrunk, sliceCS]);
        overCS = CS.difference([sliceCS, grown]);
        underCut = Math.max(0, underCS.area());
        overCut = Math.max(0, overCS.area());
        if (underCut > 0) underBbox = bboxOf(underCS);
        if (overCut > 0) overBbox = bboxOf(overCS);
      }

      levels.push({ z, predictedArea, simulatedArea, underCut, overCut, underBbox, overBbox });
      if (underCut > worstUnder) {
        worstUnder = underCut;
        worstUnderAt = underBbox === null ? null : { z, bbox: underBbox };
      }
      if (overCut > worstOver) {
        worstOver = overCut;
        worstOverAt = overBbox === null ? null : { z, bbox: overBbox };
      }
    } finally {
      // `parts` is emptied only by the single-section branch; a throw from `union` leaves them here.
      for (const p of parts) p.delete();
      predictedCS?.delete();
      shrunk?.delete();
      grown?.delete();
      sliceCS?.delete();
      underCS?.delete();
      overCS?.delete();
    }
  }

  // #580 — the floor is resolution-aware: below the grid's own cell pitch, a "worst under/over-cut"
  // is one dexel of disagreement, not material left standing. `ORACLE_AREA_FLOOR` stays the lower
  // bound for a job whose resolution is finer (or one swept by the exact engine, with no grid).
  const cellArea = threadGrid === null || threadGrid === undefined ? 0 : threadGrid.du * threadGrid.dv;
  const areaFloor = Math.max(ORACLE_AREA_FLOOR, cellArea * ORACLE_AREA_FLOOR_CELLS);
  return {
    ok: worstUnder <= areaFloor && worstOver <= areaFloor,
    band,
    levels,
    worst: { underCut: worstUnder, overCut: worstOver, underAt: worstUnderAt, overAt: worstOverAt },
    areaFloor,
  };
}

// ---------------------------------------------------------------------------------------------
// #240 §4.5 — THE ROTARY ORACLE. A COLUMN prediction, never a flat area comparison.
// ---------------------------------------------------------------------------------------------

/**
 * The columns a rotary run is judged on (#240 slice 2, `/Rotary.md` §4.5).
 *
 * A rotary sweep is a height field over (X, θ): each column holds the material's remaining RADIUS.
 * The prediction is correspondingly per column, and it is not the flat oracle's question. A flat
 * pocket repeats the same 2D region at every level above its floor, so comparing AREAS at a level
 * is the same question as comparing the region. On a round stock the tool's flat tip is a wedge
 * (R-2): at angular offset φ from a pass the floor it leaves is `Z_t / cos φ`, so only the
 * centreline reaches the nominal floor `R − d` and the stroke edges sit up to the FACET term
 * `√(Z_t² + r_t²) − Z_t` higher. A level's area is therefore a thin, model-shaped sliver of the
 * region, and slicing at the nominal floor would call almost the whole region an under-cut.
 *
 * The design's test is the honest one:
 *
 *   - inside the opened region the floor radius is between `R − d` and `R − d + e` (e = the facet
 *     term at the level's own `Z_t = R − d`), outside it is `R`;
 *   - the tolerance is ONE GRID CELL each way (a cell's centre carries its whole square, so a
 *     column whose centre is within half a cell diagonal of the region's boundary may be on either
 *     side — {@link columnBandTerm}) plus the facet term in Z;
 *   - under-cut is material left standing INSIDE the region (a step-over gap along the arc, a
 *     stroke the passes missed); over-cut is material removed OUTSIDE it (a wrong `A = s/R`
 *     mapping, which no flat test can catch). Both report.
 *
 * The region polygons are in MAP millimetres (`rotary/wrap.ts`): x along the axis from the jaws, y
 * the surface arc at `R`. The map wraps at the seam, so a prediction authored across 0/C is tested
 * at `y`, `y − C` and `y + C` — the same one-turn fold the session applies for the flat area path,
 * here as three contour copies instead of three Clipper sections.
 *
 * The report keeps the flat oracle's shape (`ok`, per-level areas and bboxes, the worst pair, the
 * band); only the meaning of a level's numbers changes: they are sums of whole columns' squares,
 * with `predictedArea` the analytic opened region and `simulatedArea` the columns the sweep cut to
 * that level. `band` is the cell term plus the largest facet term over the levels.
 */
export interface RotaryOracleInput {
  /** The grid the run was swept with: `u` = work X mm, `v` = θ degrees, `h` = remaining radius mm. */
  grid: ColumnGrid;
  /** The stock's radius, mm — R6's Z datum; every column is measured against it. */
  radius: number;
  /** The cutter's radius at the tip, mm — `r_t` of the facet term. */
  toolRadius: number;
  /**
   * #763 — the cutter profile the run was swept with. When present the facet term is the CUTTER's
   * (`rotaryFacetTerm`): a flat's wedge rise, a ball's sphere-cap edge, a V's cone edge. Absent
   * keeps the flat-only term every pre-#763 caller had.
   */
  cutter?: ColumnCutter;
  /** The predictions, in MAP millimetres: x along the axis from the jaws, y the surface arc at R. */
  predicted: readonly OraclePredicted[];
}

/**
 * One polygon of a periodic region: its points, the map shift applied to its second axis, and the
 * bbox that shift puts it in — the point tests reject on the bbox before touching an edge.
 */
interface ContourBox {
  pts: readonly OraclePoint[];
  shiftY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function contourBoxOf(pts: readonly OraclePoint[], shiftY: number): ContourBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    const yy = y + shiftY;
    if (yy < minY) minY = yy;
    if (yy > maxY) maxY = yy;
  }
  return { pts, shiftY, minX, maxX, minY, maxY };
}

/** A region's contours at the three periodic images a one-turn map can put a column on. */
function periodicContours(polygons: readonly OraclePolygon[], circumference: number): ContourBox[] {
  const contours: ContourBox[] = [];
  for (const shift of [-circumference, 0, circumference]) {
    for (const pts of polygons) {
      if (pts.length >= 3) contours.push(contourBoxOf(pts, shift));
    }
  }
  return contours;
}

/**
 * Even-odd point test over a region's contours. CrossSection's polygons are outers and holes, which
 * even-odd reads correctly. The three periodic copies are the SAME region seen wrapped, so the
 * answer is their UNION — and they are not always disjoint: a region that spans the seam (its map
 * `y` crosses 0/360) overlaps its own ±C image by that span. Running one even-odd parity over every
 * copy would cancel exactly those overlapped cells and call the middle of a wrapped cut "outside".
 * So each shift is tested on its own (even-odd is right within one copy, holes included) and the
 * answers are OR-ed.
 */
function pointInContours(contours: readonly ContourBox[], x: number, y: number): boolean {
  const shifts = new Set<number>();
  for (const c of contours) shifts.add(c.shiftY);
  for (const shift of shifts) {
    let inside = false;
    for (const c of contours) {
      if (c.shiftY !== shift) continue;
      if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) continue;
      const yl = y - c.shiftY;
      const pts = c.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = (pts[i] as OraclePoint)[0];
        const yi = (pts[i] as OraclePoint)[1];
        const xj = (pts[j] as OraclePoint)[0];
        const yj = (pts[j] as OraclePoint)[1];
        if ((yi > yl) !== (yj > yl)) {
          const at = xj + ((yl - yj) * (xi - xj)) / (yi - yj);
          if (x < at) inside = !inside;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}

/**
 * The rotary oracle (#240 slice 2, `/Rotary.md` §4.5, `rotary-flow.md` §3.9). See
 * {@link RotaryOracleInput} for the model and the tolerances.
 */
export function computeRotaryOracle(tl: ManifoldToplevel, input: RotaryOracleInput): OracleReport {
  const CS = tl.CrossSection;
  const { grid, radius, toolRadius, predicted } = input;
  // The map's pitches for this grid: a θ cell is an arc at the DESIGN radius, which is the length
  // the prediction's Y is in.
  const dvArc = angleToArc(grid.dv, radius);
  const circumference = angleToArc(360, radius);
  const cellBand = Math.hypot(grid.du, dvArc) / 2;
  const cellArea = grid.du * dvArc;
  const areaFloor = Math.max(ORACLE_AREA_FLOOR, cellArea * ORACLE_AREA_FLOOR_CELLS);
  const roundSegments = segmentsForRadius(cellBand);

  for (const p of predicted) {
    if (p.groove !== undefined || p.thread !== undefined) {
      throw new Error(
        "oracle: a rotary prediction is a cutter's opened region in map millimetres; a groove or thread has no rotary column form",
      );
    }
  }

  const entries = predicted.filter((p) => p.depth > 0 && p.polygons.length > 0);
  const depths = [...new Set(entries.map((p) => p.depth))].sort((a, b) => a - b);
  // #763 — the facet term is the CUTTER's when the run's profile is known: a flat's wedge rise,
  // a ball's sphere-cap edge, a V's cone edge. `toolRadius` alone keeps the flat reading for every
  // pre-#763 caller.
  const facetAt = (depth: number): number =>
    input.cutter !== undefined ? rotaryFacetTerm(input.cutter, radius - depth, depth) : facetTerm(radius - depth, toolRadius);
  // #763 — the REACH allowance is not the cutter's edge rise for a curved cutter. A flat's pocket
  // floor is level at `R − d`, and its edge rises by the facet term, so the level's cut set is
  // that much deeper. A ball's or a V's cut has no level floor: the *region* at a level is where
  // the curved groove is at least that deep (the cone's/ sphere's cross-section), and the floor at
  // that region's own edge IS the level — its edge rise is carried by the BAND (`facetAt`), not by
  // the reach, or a V's 0.5 mm flank would reach the stock's surface and call every untouched
  // column "cut".
  const reachAllowance = (depth: number): number =>
    input.cutter !== undefined && (input.cutter.cornerRadius !== undefined || input.cutter.tanHalf !== null)
      ? 0
      : facetTerm(radius - depth, toolRadius);
  // The DEEPEST level has the smallest `Z_t` and so the largest facet term; the report's single
  // band carries the largest, exactly as the flat report carries the worst checkpoints' term.
  let maxFacet = 0;
  for (const p of entries) maxFacet = Math.max(maxFacet, facetAt(p.depth));
  const band = cellBand + maxFacet;

  const levels: OracleLevel[] = [];
  let worstUnder = 0;
  let worstOver = 0;
  let worstUnderAt: { z: number; bbox: OracleBbox } | null = null;
  let worstOverAt: { z: number; bbox: OracleBbox } | null = null;

  for (const depth of depths) {
    const z = -depth;
    // The highest radius a column cut to THIS level may read: the nominal floor plus the level's
    // own facet term, plus the slice lift so a floor exactly on the level counts as cut.
    const reach = radius - depth + reachAllowance(depth) + ORACLE_SLICE_LIFT_MM;
    const parts: CrossSectionInstance[] = [];
    for (const p of entries) {
      if (!(p.depth + 1e-9 >= depth)) continue;
      // #763 — a V region opens wider as the level rises; the growth is the cone's radial run at
      // this level, the same map-space dilation the flat oracle applies (#741's body cap too).
      parts.push(
        p.vRegion !== undefined && p.depth > depth + 1e-9
          ? vRegionAt(tl, p.polygons, Math.min((p.depth - depth) * p.vRegion.tanHalf, p.vRegion.maxGrow ?? Infinity), roundSegments)
          : CS.ofPolygons(p.polygons),
      );
    }
    if (parts.length === 0) continue;

    let region: CrossSectionInstance | null = null;
    let inner: CrossSectionInstance | null = null;
    let outer: CrossSectionInstance | null = null;
    let predictedArea: number;
    let simulatedCells = 0;
    let underCells = 0;
    let overCells = 0;
    let uMinX = Infinity;
    let uMaxX = -Infinity;
    let uMinY = Infinity;
    let uMaxY = -Infinity;
    let oMinX = Infinity;
    let oMaxX = -Infinity;
    let oMinY = Infinity;
    let oMaxY = -Infinity;
    try {
      region = parts.length === 1 ? (parts.shift() as CrossSectionInstance) : CS.union(parts);
      predictedArea = region.area();
      // The two shells of ambiguity: inside `inner` a column is certainly in the region; outside
      // `outer` it is certainly not. Between them one cell could have gone either way.
      inner = region.offset(-cellBand, 'Round', 2, roundSegments);
      outer = region.offset(cellBand, 'Round', 2, roundSegments);
      const innerContours = periodicContours(inner.toPolygons() as OraclePolygon[], circumference);
      const outerContours = periodicContours(outer.toPolygons() as OraclePolygon[], circumference);

      for (let j = 0; j < grid.nv; j++) {
        // The column's position on the MAP. The map's y is the surface arc at R, and the engine's
        // θ is the program's A, so this is `s = R·A_rad` read back (wrap.ts's `angleToArc`).
        const y = angleToArc(grid.v0 + j * grid.dv, radius);
        for (let i = 0; i < grid.nu; i++) {
          const x = grid.u0 + i * grid.du;
          const rho = grid.h[j * grid.nu + i] as number;
          const cutToLevel = rho <= reach;
          if (cutToLevel) simulatedCells++;
          if (pointInContours(innerContours, x, y)) {
            // Inside the region: every column within one cell of the boundary that could not be
            // reached is expected (the shell above), so anything here above the facet allowance is
            // material the passes left standing.
            if (rho > reach) {
              underCells++;
              if (x - grid.du / 2 < uMinX) uMinX = x - grid.du / 2;
              if (x + grid.du / 2 > uMaxX) uMaxX = x + grid.du / 2;
              if (y - dvArc / 2 < uMinY) uMinY = y - dvArc / 2;
              if (y + dvArc / 2 > uMaxY) uMaxY = y + dvArc / 2;
            }
          } else if (!pointInContours(outerContours, x, y) && cutToLevel) {
            // Outside the region, nothing should reach this level at all.
            overCells++;
            if (x - grid.du / 2 < oMinX) oMinX = x - grid.du / 2;
            if (x + grid.du / 2 > oMaxX) oMaxX = x + grid.du / 2;
            if (y - dvArc / 2 < oMinY) oMinY = y - dvArc / 2;
            if (y + dvArc / 2 > oMaxY) oMaxY = y + dvArc / 2;
          }
        }
      }
    } finally {
      for (const p of parts) p.delete();
      region?.delete();
      inner?.delete();
      outer?.delete();
    }

    const predictedAreaValue = predictedArea;
    const simulatedArea = simulatedCells * cellArea;
    const underCut = underCells * cellArea;
    const overCut = overCells * cellArea;
    const underBbox: OracleBbox | null =
      underCells > 0 ? { min: [uMinX, uMinY], max: [uMaxX, uMaxY] } : null;
    const overBbox: OracleBbox | null =
      overCells > 0 ? { min: [oMinX, oMinY], max: [oMaxX, oMaxY] } : null;
    levels.push({
      z,
      predictedArea: predictedAreaValue,
      simulatedArea,
      underCut,
      overCut,
      underBbox,
      overBbox,
    });
    if (underCut > worstUnder) {
      worstUnder = underCut;
      worstUnderAt = underBbox === null ? null : { z, bbox: underBbox };
    }
    if (overCut > worstOver) {
      worstOver = overCut;
      worstOverAt = overBbox === null ? null : { z, bbox: overBbox };
    }
  }

  return {
    ok: worstUnder <= areaFloor && worstOver <= areaFloor,
    band,
    levels,
    worst: { underCut: worstUnder, overCut: worstOver, underAt: worstUnderAt, overAt: worstOverAt },
    areaFloor,
  };
}
