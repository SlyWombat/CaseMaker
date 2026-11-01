/**
 * #829 — THE 3D CHAMFER CAM: a cone's flank along a target mesh's top rim.
 *
 * The 2D chamfer (`cam/chamfer.ts`, #669) traces a rim's edge at ONE z, because its top face is
 * the blank's. A mesh's rim is a curve in three dimensions, so the SAME bevel rule is applied
 * point by point: the cutter's centre stands one TIP RADIUS from the edge on the air side, and the
 * tip plane sits `depth` below that point's own top face — the 2D geometry's `d = r1` tangency and
 * `depth = width / tan α`, with the top face's height read off the mesh at every point instead of
 * assumed to be the blank's top.
 *
 * ONE OPERATION PER CHAIN, each a single bevel at one depth: the chain's depth is the caller's
 * (clamped by the cone's reach and the part's own height before this point — `chamfer-too-wide`
 * and `chamfer-too-deep`'s 3D clause state the shortfalls, and the CAM cuts the same numbers).
 * The tip's flat is tangent to the wall, so the flank — not the tip — makes the bevel, exactly as
 * in 2D; no offset, step-over or multi-pass exists here for the same reason.
 *
 * THE CUT IS A FEED, NEVER A RAPID, below the top face. Each chain plunges at its first point from
 * the hop height and closes back to that point when the ring is closed, so the bevel's last corner
 * is cut by the same pass as its first.
 */

import type { CutParams } from '../feeds';
import type { Tool } from '../tool';
import { vCone } from '../vProfile';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  toolNumberFor,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from './ir';
import type { RimChain } from '../engrave/targetRim';

/** One chain's bevel, with the depth the caller clamped for it. */
export interface Chamfer3dCut {
  /** The operation's `labelId` — the goal object the rim belongs to. */
  id: string;
  /** The operation's display name, without the `[T#]` prefix or the depth suffix. */
  name: string;
  chain: RimChain;
  /** The tip plane's depth below each point's top face, positive mm (`width / tan(halfAngle)`). */
  depth: number;
}

/**
 * The 3D chamfer CAM: one operation per rim chain, the cone's tip one radius off the edge on the
 * air side at each point's own bevel depth.
 *
 * Throws for a cutter that is not a resolvable cone — the goal's chamfer finding refuses the
 * program before this point, and a direct caller gets the error rather than a path cut by a
 * cutter that cannot make a bevel.
 */
export function generateChamfer3d(
  cuts: readonly Chamfer3dCut[],
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
): ToolpathIR {
  const cone = vCone(tool);
  if (cone === null) {
    throw new Error(
      `generateChamfer3d: a chamfer is one bevel cut by a cone's flank, and "${tool.name}" is a ` +
        `${tool.shape} cutter with none`,
    );
  }
  const toolNumber = toolNumberFor(tool);
  const operations: CamOperation[] = [];

  for (const cut of cuts) {
    const points = cut.chain.points;
    if (points.length < 2) continue;
    // The tip's own centre path: the edge point pushed one tip radius toward the AIR.
    const path = points.map((p, i) => {
      const air = cut.chain.outward[i] ?? { x: 0, y: 0 };
      return { x: p.x + air.x * cone.tipRadius, y: p.y + air.y * cone.tipRadius, z: p.z - cut.depth };
    });
    const first = path[0]!;
    const moves: CamMove[] = [];
    moves.push({ kind: 'rapid', x: first.x, y: first.y, z: HOP_Z });
    // A FEED to the tip plane: the plunge cuts the bevel's entry and must never be a rapid below
    // the top face.
    moves.push({ kind: 'feed', x: first.x, y: first.y, z: first.z, f: params.plungeFeed });
    for (const p of path.slice(1)) moves.push({ kind: 'feed', x: p.x, y: p.y, z: p.z, f: params.feed });
    if (cut.chain.closed) {
      // Close the ring, so the bevel's last corner is cut by the same pass as its first.
      moves.push({ kind: 'feed', x: first.x, y: first.y, z: first.z, f: params.feed });
    }
    moves.push({ kind: 'rapid', x: first.x, y: first.y, z: HOP_Z });
    operations.push({
      number: operations.length + 1,
      name: `[T${toolNumber}]${cut.name} ${cut.depth.toFixed(1)}mm`,
      labelId: cut.id,
      depth: cut.depth,
      // One bevel at one depth: a single depth pass, as the 2D chamfer's.
      depthPasses: 1,
      passStepMm: cut.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, rapid),
    });
  }

  const last = operations[operations.length - 1];
  const lastMove = last?.moves[last.moves.length - 1];
  if (last !== undefined && lastMove !== undefined) {
    last.moves.push({ kind: 'rapid', x: lastMove.x, y: lastMove.y, z: SAFE_Z });
  }

  return {
    frame: 'flat',
    tool,
    toolNumber,
    spindleRpm: params.rpm,
    air: params.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations,
  };
}
