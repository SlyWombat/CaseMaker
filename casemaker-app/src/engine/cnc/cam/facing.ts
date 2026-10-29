/**
 * Facing the stock's top: a raster skim to Z0 (#432, slices 1–2).
 *
 * The operation the `facingDefault` decision (Q6) implies: rough or unknown stock is skimmed
 * before anything else runs, so the top is flat, the finish is gone and Z0 lands on a cut surface
 * rather than on whatever the blank arrived as. The job's own facing depth is the TOTAL taken off
 * (the maintainer's decision of 2026-10-17); the passes and the step-over come from the feeds row
 * for the cutter and material, exactly as a pocket's do — this module owns no feeds.
 *
 * WHOLE TOP, NOT AN INSET RECTANGLE (decision 5). The raster covers the stock's full extent, and
 * "full extent" is read as the CUTTER'S DISC: the centre is held one radius in from every edge, so
 * the disc's edge lands on the boundary (a micron inside it, on the POSTED text — see
 * {@link FACING_EDGE_CLEARANCE_MM}) and the whole top is faced without a single move cutting air
 * outside the stock. That second half is not decoration — the verifier checks the tool edge
 * (`cut-outside-stock`, `verify.ts` check 5), so a centre-line raster to the edge is refused on
 * every line. Clamps, jaws and brackets are the verifier's to refuse (`mountObstacles`, #427); this
 * module never shrinks the patch to dodge one, because silently leaving a strip at the finish is
 * worse than a refusal.
 *
 * RASTER ALONG THE LONGER SIDE. Lines run down the stock's longer axis and step across the shorter
 * one: fewer passes, fewer direction changes, and the line order is what an operator can follow on
 * the sheet. A square blank rasters along X.
 *
 * FLAT END MILL ONLY, and the refusal is `cuttingRadiusForSweep`'s — the same gate the region CAM
 * uses for a sweep. A facing pass is a flat bottom over a plane; a V-bit's cone leaves a corrugated
 * surface by definition and a ball nose's contact patch is a point.
 *
 * The IR contract is `generateEngrave`'s: positive `depth` in, negative Z out, fully-resolved
 * moves, `[T#]<name> <depth>mm` operation names. It is pure — no Manifold, no offset — because the
 * region is the stock rectangle the caller already has. Operations are numbered from 1.
 *
 * ONE PROGRAM OF ITS OWN, posted against the PROBED top (Z = 0 is the blank as the probe found
 * it). The engraving program is written in the document's frame, whose Z = 0 is the FACED surface,
 * and the two files meet physically because the re-touch re-zeros Z on the faced surface between
 * them — so nothing here shifts anything, and no branch below lowers another program's moves.
 */

import type { Mm } from '@/types/units';
import type { CutParams } from '../feeds';
import { cuttingRadiusForSweep, type Tool } from '../tool';
import { zPasses } from './engraveJob';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
  toolNumberFor,
} from './ir';

/** The stock's top face, mm, in the work frame: length = X, width = Y, front-left at the origin. */
export interface FacingStock {
  length: Mm;
  width: Mm;
  /**
   * #743 D6 — set on a ROUND BLANK milled flat. The raster then covers the rim's circle rather
   * than the `D × D` box around it: the box's corners are air, and a box plan spends a fifth of
   * its time there (1 − π/4).
   */
  shape?: 'disc';
  /** The disc's outer diameter, mm; present exactly when `shape` is `'disc'`. */
  diameter?: Mm;
}

/**
 * What the facing program was cut with, for the run sheet (#432 slice 3).
 *
 * Carried out of the worker rather than re-derived beside the sheet: the sheet's rule is that the
 * numbers it prints are the numbers in the file, and the passes are `zPasses`' answer for this
 * depth and this feeds row — a second computation could print a pass count the file does not make.
 * The cutter is named here because the facing file runs with its OWN bit, and a sheet that sent the
 * operator to the engraving cutter would send them to the wrong station.
 */
export interface FacingCamSummary {
  /** The cutter's display name, as the tool registry has it. */
  toolName: string;
  /** Its cutting diameter, mm. */
  diameterMm: Mm;
  /** How many Z passes the file makes. */
  passes: number;
  stepDown: Mm;
  stepOver: Mm;
  rpm: number;
  feed: number;
  plungeFeed: number;
  air: boolean;
}

/** The offset of one raster line's start from the stock's front-left corner, and its direction. */
interface RasterLine {
  start: [number, number];
  end: [number, number];
}

/**
 * The raster lines covering `[0, length] × [0, width]`, as cutter-CENTRE segments, held `inset`
 * mm in from every edge (the caller passes the cutter's radius, so the disc reaches the boundary).
 *
 * Line 0 sits `inset` from the front edge and the last line exactly `inset` from the far edge, with
 * `stepOver` between them and the penultimate line pulled in rather than overshooting. Directions
 * alternate, so a pass ends where the next one starts.
 *
 * A stock narrower than the cutter in a direction gets ONE line down its middle: the disc covers
 * that direction whole, and holding the centre a radius in from both sides is geometrically
 * impossible.
 *
 * Coverage is the disc, not the centre line: adjacent lines are `stepOver` apart, so the cut is
 * continuous wherever `stepOver ≤ 2 × radius`. The caller's feeds row already refuses a step-over
 * past the radius (`pocketLoops`, #191); {@link generateFacing} refuses past the diameter, which is
 * the point at which this raster would leave an uncut ridge.
 */
export function facingRasterLines(stock: FacingStock, stepOver: Mm, inset: Mm = 0): RasterLine[] {
  if (!(stock.length > 0) || !(stock.width > 0)) {
    throw new Error(`facingRasterLines: the stock needs a positive length and width, got ${stock.length} × ${stock.width} mm`);
  }
  if (!(stepOver > 0)) throw new Error(`facingRasterLines: stepOver must be > 0, got ${stepOver} mm`);
  if (!(inset >= 0)) throw new Error(`facingRasterLines: inset must be >= 0, got ${inset} mm`);
  if (stock.shape === 'disc') return discRasterLines(stock, stepOver, inset);

  const alongX = stock.length >= stock.width;
  /** Distance along the line, and the span the lines step across. */
  const run = alongX ? stock.length : stock.width;
  const across = alongX ? stock.width : stock.length;

  /** Where a centre may travel across `size`: `[inset, size − inset]`, collapsing to the middle. */
  const span = (size: number): [number, number] =>
    size <= 2 * inset ? [size / 2, size / 2] : [inset, size - inset];
  const [runLo, runHi] = span(run);
  const [acrossLo, acrossHi] = span(across);

  // Line offsets across the short side: lo, lo + stepOver, … and the far bound last. The `1e-9`
  // is what keeps a step that lands exactly on the bound from emitting a duplicate line.
  const offsets: number[] = [];
  for (let v = acrossLo; v < acrossHi - 1e-9; v += stepOver) offsets.push(v);
  offsets.push(acrossHi);

  return offsets.map((v, i) => {
    const forward = i % 2 === 0;
    const u0 = forward ? runLo : runHi;
    const u1 = forward ? runHi : runLo;
    return alongX
      ? { start: [u0, v], end: [u1, v] }
      : { start: [v, u0], end: [v, u1] };
  });
}

/**
 * #743 D6 — THE RASTER OF A DISC'S FACE. "The stock's full extent" is its RIM, so the cutter's
 * centre is held `inset` inside the circle (the caller passes its radius plus
 * {@link FACING_EDGE_CLEARANCE_MM}, exactly as for a rectangle) and each line is the circle's CHORD
 * at that Y: the cutter's disc then reaches the rim without ever hanging over its edge, which the
 * verifier's stock-outline check would refuse. The box's corners are air, and rastering them is
 * the fifth of the time this operation used to spend on nothing.
 *
 * Lines step across Y from the inner circle's bottom to its top, the far bound emitted last like a
 * rectangle's, and directions alternate. The two tangent lines have zero-length chords: they cover
 * the rim's own extreme points with the cutter's edge, and skipping them would leave the top and
 * bottom of the circle one step-over from the nearest pass. A disc no wider than the cutter gets
 * ONE line through its centre — the same degenerate answer a too-narrow rectangle gets.
 */
function discRasterLines(stock: FacingStock, stepOver: Mm, inset: Mm): RasterLine[] {
  const centre: [number, number] = [stock.length / 2, stock.width / 2];
  const diameter = stock.diameter ?? Math.min(stock.length, stock.width);
  const radius = diameter / 2 - inset;
  if (!(radius > 0)) return [{ start: [centre[0], centre[1]], end: [centre[0], centre[1]] }];
  const lo = centre[1] - radius;
  const hi = centre[1] + radius;
  const offsets: number[] = [];
  for (let v = lo; v < hi - 1e-9; v += stepOver) offsets.push(v);
  offsets.push(hi);
  return offsets.map((v, i) => {
    const half = Math.sqrt(Math.max(0, radius * radius - (v - centre[1]) ** 2));
    const forward = i % 2 === 0;
    const u0 = forward ? centre[0] - half : centre[0] + half;
    const u1 = forward ? centre[0] + half : centre[0] - half;
    return { start: [u0, v], end: [u1, v] };
  });
}

/**
 * How far inside the cutter's radius the raster is held, mm.
 *
 * The post writes axis values on the machine's decimal grid (`dialect.axisPrecision`, 3 places on
 * the Z1), and the verifier reads the POSTED text — so a centre placed exactly one radius in from
 * the stock's edge can print half a step INSIDE that edge, and the disc then reads half a micron
 * outside the stock. One micron of stock left round the rim is nothing a skim is judged on; an
 * unverified facing file is everything. (The raster function itself stays exact — this is the
 * caller's choice of inset, not the geometry's.)
 */
export const FACING_EDGE_CLEARANCE_MM = 0.001;

/** Every move for one facing depth pass: each raster line hopped to, plunged, fed and retracted. */
function buildFacingMoves(stock: FacingStock, params: CutParams, depth: Mm, radius: Mm): CamMove[] {
  const moves: CamMove[] = [];
  const lines = facingRasterLines(stock, params.stepOver, radius + FACING_EDGE_CLEARANCE_MM);
  for (const z of zPasses(depth, params.stepDown)) {
    for (const line of lines) {
      const [sx, sy] = line.start;
      const [ex, ey] = line.end;
      moves.push({ kind: 'rapid', x: sx, y: sy, z: HOP_Z });
      moves.push({ kind: 'feed', x: sx, y: sy, z, f: params.plungeFeed });
      moves.push({ kind: 'feed', x: ex, y: ey, z, f: params.feed });
      moves.push({ kind: 'rapid', x: ex, y: ey, z: HOP_Z });
    }
  }
  const last = moves[moves.length - 1];
  if (last !== undefined) moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
  return moves;
}

/**
 * The toolpath IR for one facing operation.
 *
 * `depth` is the TOTAL material taken off the top, positive mm (the job's `facing.depth`);
 * `params` arrive from `feedsFor` (#202), so the pass step and the step-over are the row's own
 * numbers for this cutter in this material. `rapid` is the machine's rapid model for the
 * operation's `estimatedSeconds` (#281), required like every other number a caller owns.
 *
 * A job whose faced top is a zero-depth skim is refused rather than silently emitting a
 * zero-removal air pass: the caller decides whether a job faces, and a depth of 0 means it does
 * not (`toPartPlan` reports `null`).
 */
export function generateFacing(
  stock: FacingStock,
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
  depth: Mm,
): ToolpathIR {
  const radiusResult = cuttingRadiusForSweep(tool);
  if (!radiusResult.ok) throw new Error(`generateFacing: ${radiusResult.reason}`);
  if (!(depth > 0)) throw new Error(`generateFacing: the facing depth must be > 0, got ${depth} mm`);
  if (!(params.stepDown > 0)) throw new Error(`generateFacing: stepDown must be > 0, got ${params.stepDown} mm`);
  if (params.stepOver > 2 * radiusResult.radius) {
    // A raster covers the stock only where the cutter's discs overlap. Past a diameter they do
    // not: two `stepOver`-wide strip boundaries leave a ridge of untouched stock down the face.
    throw new Error(
      `generateFacing: step-over ${params.stepOver} mm is wider than the ${radiusResult.radius * 2} mm ` +
        `cutting diameter, which would leave an uncut ridge across the faced top`,
    );
  }

  const toolNumber = toolNumberFor(tool);
  const moves = buildFacingMoves(stock, params, depth, radiusResult.radius);
  const operation: CamOperation = {
    number: 1,
    // Named for what the operator sees on the machine's own screen: the top coming off. The
    // `labelId` is empty because facing is not an item — nothing in the document selects it.
    name: `[T${toolNumber}]Face stock top ${depth.toFixed(1)}mm`,
    labelId: '',
    depth,
    moves,
    estimatedSeconds: estimateCycleSeconds(moves, rapid),
  };

  return {
    frame: 'flat', // the 3-axis work frame. No rotary IR exists yet (#237).
    tool,
    toolNumber,
    spindleRpm: params.rpm,
    air: params.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations: [operation],
  };
}

