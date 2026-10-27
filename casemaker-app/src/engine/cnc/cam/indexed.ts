/**
 * Indexed rotary faces (#241, `/Rotary.md` §2 class I, §4.6): turn to an A, hold it, cut 2.5D at
 * constant Z levels, turn again.
 *
 * The IR produced here is a ROTARY-frame IR in the exact sense `ir.ts` defines (R6): X along the
 * stock axis, Z the distance ABOVE the rotary axis — so the surface is at `Z = radius` and a cut
 * `d` deep is at `radius − d` — Y ≡ 0 on every move, and an `a` on every move (R5: the post
 * refuses a rotary move without one, because it has no angular position to write).
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

/** One face cut at one index angle: a single pass along X at constant Z levels. */
export interface IndexedFace {
  /** The index angle, degrees. Unwound is allowed; the post writes it as given (R5). */
  a: number;
  /** The pass's X span in the rotary work frame, mm. Must differ. */
  fromX: Mm;
  toX: Mm;
  /** Total depth below the surface at this index, positive mm. */
  depth: Mm;
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

/** The moves of one face: a rapid in at the safe height, then a pass at each Z level. */
function faceMoves(face: IndexedFace, radius: Mm, params: CutParams): CamMove[] {
  const { a, fromX, toX } = face;
  const safe = radius + SAFE_Z;
  const hop = radius + HOP_Z;
  const moves: CamMove[] = [{ kind: 'rapid', x: fromX, y: 0, z: safe, a }];
  for (const z of zPasses(face.depth, params.stepDown)) {
    moves.push({ kind: 'rapid', x: fromX, y: 0, z: hop, a });
    moves.push({ kind: 'feed', x: fromX, y: 0, z: radius + z, f: params.plungeFeed, a });
    moves.push({ kind: 'feed', x: toX, y: 0, z: radius + z, f: params.feed, a });
    moves.push({ kind: 'rapid', x: toX, y: 0, z: hop, a });
  }
  moves.push({ kind: 'rapid', x: toX, y: 0, z: safe, a });
  return moves;
}

/** The moves of one hole: rapid in at the safe height, one plunge, retract. */
function holeMoves(hole: IndexedHole, radius: Mm, params: CutParams): CamMove[] {
  const { a, x } = hole;
  const safe = radius + SAFE_Z;
  return [
    { kind: 'rapid', x, y: 0, z: safe, a },
    { kind: 'feed', x, y: 0, z: radius - hole.depth, f: params.plungeFeed, a },
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
    const moves = faceMoves(face, radius, params);
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
