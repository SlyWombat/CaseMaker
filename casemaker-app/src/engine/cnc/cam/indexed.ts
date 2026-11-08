/**
 * Indexed rotary faces (#241, `/Rotary.md` §2 class I, §4.6): turn to an A, hold it, cut 2.5D at
 * constant Z levels, turn again.
 *
 * The IR produced here is a ROTARY-frame IR in the exact sense `ir.ts` defines (R6): X along the
 * stock axis, Z the distance ABOVE the rotary axis — so the surface is at `Z = radius` and a cut
 * `d` deep is at `radius − d` — and an `a` on every move (R5: the post refuses a rotary move
 * without one, because it has no angular position to write). Y is 0 except inside a FACE POCKET
 * (#241 slice 2), where it is an ordinary axis: A is held for the whole run, so the stock frame is
 * a rigid rotation and the machine is a 3-axis mill. A move that changes A is taken at Y 0 and in
 * the air — the post's narrowed rule — so no turn is ever made off the axis.
 *
 * ONE PASS PER OPERATION, and that is the frame's doing, not a simplification: with the tool held
 * over the axis (R1) the cutter can only reach the face under it, so a pass is as wide as the
 * cutter's diameter. A FLAT WIDER THAN THE CUTTER is several passes at neighbouring index angles,
 * which the caller lists as several faces — each one an ordinary constant-A run the exact sweep
 * takes, and the facets between them the honest picture of what an index-only machine cuts.
 * The caller also owns the X span: a pass that must cover a stock's full length starts and ends
 * one cutter radius outside it, or the cap's rounded ends leave the last radius uncut.
 *
 * OPERATION ORDER IS THE CALLER'S, and every operation states its A on its FIRST move, which is a
 * rapid at the safe height. That is what makes the job `indexed` rather than `wrapped` to the
 * timeline (see `TimelineSummary.rotaryClass`): A changes on a rapid between runs, never inside a
 * cut, and a turn is only ever taken with the tool clear of the stock.
 *
 * This module owns no feeds — the numbers come from `feedsFor` as every other producer's do — and
 * no post: it is pure IR, like `facing.ts`, `drill.ts` and the rest.
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

/** One face cut at one index angle: X passes at constant Z levels, across the face's width. */
export interface IndexedFace {
  /** The index angle, degrees. Unwound is allowed; the post writes it as given (R5). */
  a: number;
  /** The pass's X span in the rotary work frame, mm. Must differ. */
  fromX: Mm;
  toX: Mm;
  /** Total depth below the surface at this index, positive mm. */
  depth: Mm;
  /**
   * #241 slice 2 — THE FACE'S WIDTH ACROSS Y, mm, centred on Y 0, for a FACE POCKET. Absent (or
   * not wider than the cutter) is one pass over the axis, the shape every pre-slice-2 caller and
   * every §6 fixture states. Present and wider, the face is cut by several X passes stepping over
   * in Y at the SAME `Z = surface − depth`, which is a plane on a turned stock: A is held constant,
   * so the machine is an ordinary 3-axis mill for the whole run and Y is an ordinary axis.
   *
   * The CALLER owns the chord: a flat `d` deep on a rod of radius R is `2√(R² − (R − d)²)` wide
   * (`faceChordMm`), and on a BLOCK it is the section's own chord at that index
   * (`sectionFaceChordMm`). A width wider than the stock is clamped here rather than cutting air.
   */
  width?: Mm;
  /**
   * #1059 — THE STOCK'S OWN SURFACE AT THIS INDEX, mm: the radius the face cuts down FROM. Absent
   * is the spec's `radius`, which is every ROUND rod (a circle's surface is the envelope at every
   * angle) and every pre-#1059 caller. A BLOCK states it, because its surface is the section's
   * edge, not the turned envelope: at A 0 on a 44.5 mm square it is 22.25, and the envelope radius
   * 31.47 is air 9.22 mm above the face.
   *
   * It moves the CUT plane only, `Z = surfaceRadius − depth`. The safe and hop heights stay on the
   * spec's `radius` (the envelope): a turn is taken with the cutter clear of the stock's HIGHEST
   * point at any index, which on a block is the corner, not the flat.
   */
  surfaceRadius?: Mm;
}

/** A cross-feature at one index angle: a plunge on the axis plane, through the stock if deep enough. */
export interface IndexedHole {
  /** The index angle, degrees. */
  a: number;
  /** The plunging position along the axis, mm. */
  x: Mm;
  /**
   * Depth below the surface at this index, positive mm. A THROUGH hole on a stock of radius R at
   * this index is `R + R` deep from the surface (the far side is at `Z = −R`); a tool that stops
   * exactly on the far surface is a knife edge, so pass a little more.
   */
  depth: Mm;
  /**
   * #1059 — the stock's own surface at this index, mm (`IndexedFace.surfaceRadius`): a block's
   * cross-hole enters the section's edge, not the turned envelope. Absent = the spec's `radius`
   * (every round rod). The plunge runs from the surface down `depth`.
   */
  surfaceRadius?: Mm;
}

export interface IndexedSpec {
  /** The stock's radius, mm — the rotary frame's `Z` of the surface (R6). */
  radius: Mm;
  /** Face passes, in the order they are cut. */
  faces?: readonly IndexedFace[];
  /** Holes, after the faces, in the order they are cut. */
  holes?: readonly IndexedHole[];
  tool: Tool;
  params: CutParams;
  /** The machine's rapid model, for each operation's cycle estimate (#281). */
  rapid: RapidEstimate;
}

function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new Error(`generateIndexed: ${name} must be a finite number, got ${String(v)}`);
}

/**
 * The Y centres of a face pocket's passes, mm — one at 0 when the face is no wider than the
 * cutter, otherwise as many passes as the step-over needs, the outermost two tangent to the
 * face's edges so the whole chord is cut. `stepOver` is the feeds row's own number (the design
 * keeps it at or under the cutter's radius).
 */
export function facePassYs(width: Mm, cutterRadius: Mm, stepOver: Mm): number[] {
  const half = Math.abs(width) / 2;
  // A face no wider than the cutter, or a caller with no width, is the one pass over the axis.
  if (!(width > 0) || half <= cutterRadius) return [0];
  const reach = half - cutterRadius; // where the outermost pass's centre must sit
  const step = Number.isFinite(stepOver) && stepOver > 0 ? Math.min(stepOver, cutterRadius) : cutterRadius;
  const moves = Math.ceil((2 * reach) / step);
  if (moves <= 1) return [0];
  return Array.from({ length: moves + 1 }, (_, k) => -reach + (2 * reach * k) / moves);
}

/**
 * The moves of one face: at each Z level, a pass at every Y the width needs.
 *
 * The first move states the index at Y 0 and the safe height — a turn is taken with the cutter
 * over the axis and in the air. Every X traverse ALSO happens at the safe height, because the
 * verifier refuses an X rapid below the rotary clearance; each pass then drops to the hop, cuts,
 * and lifts back. Y itself moves only at the safe height, so no Y travel is made at cutting depth.
 */
function faceMoves(face: IndexedFace, radius: Mm, params: CutParams, cutterRadius: Mm): CamMove[] {
  const { a, fromX, toX } = face;
  // #1059 — the cut plane is the SECTION's surface at this index; safe and hop are the ENVELOPE's,
  // which is the stock's highest point as the chuck turns (see `IndexedFace.surfaceRadius`).
  const surface = face.surfaceRadius ?? radius;
  const safe = radius + SAFE_Z;
  const hop = radius + HOP_Z;
  const ys = facePassYs(face.width ?? 0, cutterRadius, params.stepOver);
  const moves: CamMove[] = [{ kind: 'rapid', x: fromX, y: 0, z: safe, a }];
  let atX = fromX;
  let atY = 0;
  let atZ = safe;
  for (const z of zPasses(face.depth, params.stepDown)) {
    for (const y of ys) {
      // Lift clear of the stock, move over the axis plane at the safe height, then drop.
      if (atZ !== safe) moves.push({ kind: 'rapid', x: atX, y: atY, z: safe, a });
      moves.push({ kind: 'rapid', x: fromX, y, z: safe, a });
      moves.push({ kind: 'rapid', x: fromX, y, z: hop, a });
      moves.push({ kind: 'feed', x: fromX, y, z: surface + z, f: params.plungeFeed, a });
      moves.push({ kind: 'feed', x: toX, y, z: surface + z, f: params.feed, a });
      moves.push({ kind: 'rapid', x: toX, y, z: hop, a });
      atX = toX;
      atY = y;
      atZ = hop;
    }
  }
  // Home in Y before the next operation's turn, which must start over the axis.
  if (atZ !== safe) moves.push({ kind: 'rapid', x: atX, y: atY, z: safe, a });
  if (atY !== 0) moves.push({ kind: 'rapid', x: atX, y: 0, z: safe, a });
  return moves;
}

/** The moves of one hole: rapid in at the safe height, one plunge, retract. */
function holeMoves(hole: IndexedHole, radius: Mm, params: CutParams): CamMove[] {
  const { a, x } = hole;
  // #1059 — the plunge starts at the SECTION's surface at this index; the safe height stays the
  // envelope's (the stock's highest point as the chuck turns).
  const surface = hole.surfaceRadius ?? radius;
  const safe = radius + SAFE_Z;
  return [
    { kind: 'rapid', x, y: 0, z: safe, a },
    { kind: 'feed', x, y: 0, z: surface - hole.depth, f: params.plungeFeed, a },
    { kind: 'rapid', x, y: 0, z: safe, a },
  ];
}

/**
 * The toolpath IR for one indexed job: one operation per face, then one per hole.
 *
 * Refuses (rather than posting a move the machine would refuse) a face or hole whose depth is not
 * positive, a pass whose X span is empty, and a non-flat tool — a face is a flat bottom over a
 * plane, and a cone's or a ball's contact patch is not a face (`cuttingRadiusForSweep`, the same
 * gate the region CAM and the facing pass use).
 */
export function generateIndexed(spec: IndexedSpec): ToolpathIR {
  const { radius, tool, params, rapid } = spec;
  assertFinite('radius', radius);
  if (!(radius > 0)) throw new Error(`generateIndexed: the stock radius must be > 0, got ${radius} mm`);
  const radiusResult = cuttingRadiusForSweep(tool);
  if (!radiusResult.ok) throw new Error(`generateIndexed: ${radiusResult.reason}`);
  const cutterRadius = radiusResult.radius;
  if (!(params.stepDown > 0)) throw new Error(`generateIndexed: stepDown must be > 0, got ${params.stepDown} mm`);

  const toolNumber = toolNumberFor(tool);
  const operations: CamOperation[] = [];
  let number = 1;

  for (const face of spec.faces ?? []) {
    assertFinite('face.a', face.a);
    assertFinite('face.fromX', face.fromX);
    assertFinite('face.toX', face.toX);
    if (face.fromX === face.toX) {
      throw new Error(`generateIndexed: the face at A${face.a} has an empty X span (${face.fromX} to ${face.toX})`);
    }
    if (!(face.depth > 0)) throw new Error(`generateIndexed: the face at A${face.a} must cut a positive depth, got ${face.depth} mm`);
    if (face.width !== undefined) {
      assertFinite('face.width', face.width);
      if (!(face.width > 0)) throw new Error(`generateIndexed: the face at A${face.a} states a width of ${face.width} mm; a face pocket is wider than nothing`);
      if (face.width > 2 * radius) throw new Error(`generateIndexed: the face at A${face.a} is ${face.width} mm wide, wider than the stock (⌀2×${radius} mm)`);
    }
    if (face.surfaceRadius !== undefined) {
      assertFinite('face.surfaceRadius', face.surfaceRadius);
      if (!(face.surfaceRadius > 0)) throw new Error(`generateIndexed: the face at A${face.a} states a surface radius of ${face.surfaceRadius} mm; a stock's surface is above its axis`);
      // #1059 — the section's surface can never be outside the turned envelope.
      if (face.surfaceRadius > radius + 1e-6) {
        throw new Error(`generateIndexed: the face at A${face.a} states a ${face.surfaceRadius} mm surface radius, outside the ${radius} mm envelope the stock turns in`);
      }
      // A face whose floor is at or below the axis has no plane to cut to (the caller refuses
      // this in operator words; here it is the move that would be written).
      if (face.depth >= face.surfaceRadius) {
        throw new Error(`generateIndexed: the face at A${face.a} is ${face.depth} mm deep on a ${face.surfaceRadius} mm surface radius, so its floor is at or below the axis`);
      }
    }
    const moves = faceMoves(face, radius, params, cutterRadius);
    operations.push({
      number: number++,
      // Named for the machine's screen: the index the operator hears the chuck turn to.
      name: `[T${toolNumber}]Index A${face.a} face ${face.depth.toFixed(1)}mm`,
      labelId: '',
      depth: face.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, rapid),
    });
  }

  for (const hole of spec.holes ?? []) {
    assertFinite('hole.a', hole.a);
    assertFinite('hole.x', hole.x);
    if (!(hole.depth > 0)) throw new Error(`generateIndexed: the hole at A${hole.a} must cut a positive depth, got ${hole.depth} mm`);
    if (hole.surfaceRadius !== undefined) {
      assertFinite('hole.surfaceRadius', hole.surfaceRadius);
      if (!(hole.surfaceRadius > 0)) throw new Error(`generateIndexed: the hole at A${hole.a} states a surface radius of ${hole.surfaceRadius} mm; a stock's surface is above its axis`);
      // #1059 — the section's surface can never be outside the turned envelope.
      if (hole.surfaceRadius > radius + 1e-6) {
        throw new Error(`generateIndexed: the hole at A${hole.a} states a ${hole.surfaceRadius} mm surface radius, outside the ${radius} mm envelope the stock turns in`);
      }
    }
    const moves = holeMoves(hole, radius, params);
    operations.push({
      number: number++,
      name: `[T${toolNumber}]Index A${hole.a} hole ${hole.depth.toFixed(1)}mm`,
      labelId: '',
      depth: hole.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, rapid),
    });
  }

  if (operations.length === 0) throw new Error('generateIndexed: nothing to cut — the job lists no faces and no holes');

  return {
    frame: 'rotary',
    rotary: { radius },
    tool,
    toolNumber,
    spindleRpm: params.rpm,
    air: params.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations,
  };
}
