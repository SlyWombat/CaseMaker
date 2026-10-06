/**
 * Plunge-drilled holes (#220): the cutter goes straight down at a fixed XY and the hole is the
 * cutter's OWN diameter. There is nothing to offset, nothing to spiral and no region to pocket —
 * which is why this is a sibling of `engraveJob.ts`, not a branch of `pocketLoops`.
 *
 * NO CANNED CYCLES. The Z1's controller does not accept `G81`/`G83`
 * (`MachineProfile.dialect.cannedCycles === false`; `/Fabrication.md` §2, #184), so a peck is
 * written out as plain `G1`/`G0` moves. The post (#173) never sees a cycle word because none is
 * ever emitted here: a peck is a feed down, a rapid out to clear chips, and a rapid back down
 * the already-drilled hole.
 *
 * EVERY CUTTING MOVE IS PURE-Z. Each `feed` above repeats the hole's X and Y, so the verifier's
 * rule 9 (#174) sees no XY motion below `hopZ`. The two re-entry `rapid`s are pure-Z as well —
 * the same axis, so the air-move gate judges them against the stock AS CUT SO FAR, where the
 * hole is already open (the case that produced false positives before, `/Simulation.md` §10
 * step 6).
 *
 * The conversions live in exactly one place, the same convention `engraveJob.ts` uses: `depth`
 * arrives POSITIVE (mm) from `EngraveJob`, and every emitted `z` is NEGATIVE work Z.
 */

import { HOP_Z, SAFE_Z, type CamMove } from './ir';
import type { CutParams } from '../feeds';

/**
 * How far above the previous peck's floor the tool rapids back to before feeding the next peck,
 * mm. Named and PROVISIONAL: it must clear the chips packed at the bottom of the last peck
 * without re-cutting them, and it is measured on the first real peck cycle (#208/#209).
 */
export const PECK_CLEARANCE = 0.5;

/**
 * The negative Z each peck bottoms out at, shallowest first, with the LAST exactly on `−depth`.
 *
 * The same float guard `zPasses` uses: a `ceil` that lands a final peck thinner than 1e-6 mm is
 * dropped, because the previous peck already sits on the floor.
 */
export function peckDepths(depth: number, peck: number): number[] {
  let n = Math.ceil(depth / peck);
  if (n > 0 && depth - (n - 1) * peck < 1e-6) n -= 1;
  const depths: number[] = [];
  for (let k = 1; k <= n; k++) depths.push(-Math.min(k * peck, depth));
  return depths;
}

/**
 * The hole centres in nearest-neighbour visiting order, starting from `from` (the work origin by
 * default, matching `orderNearest`'s convention). Ties break on the hole's own coordinates, so
 * the order is a pure function of the hole set. The first entry is what a drill operation's
 * `firstCut` must be, for the two to agree.
 */
export function orderHolesNearest(
  holes: readonly (readonly [number, number])[],
  from: readonly [number, number] = [0, 0],
): [number, number][] {
  const remaining = holes.map((h) => [h[0], h[1]] as [number, number]);
  const out: [number, number][] = [];
  let px = from[0];
  let py = from[1];
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const [x, y] = remaining[i]!;
      const distance = (x - px) ** 2 + (y - py) ** 2;
      const tie = Math.abs(distance - bestDistance) <= 1e-9 &&
        (x < remaining[best]![0] || (x === remaining[best]![0] && y < remaining[best]![1]));
      if (distance < bestDistance - 1e-9 || tie) {
        bestDistance = distance;
        best = i;
      }
    }
    const chosen = remaining.splice(best, 1)[0]!;
    out.push(chosen);
    px = chosen[0];
    py = chosen[1];
  }
  return out;
}

/**
 * The moves for one drill item: every hole, in the order given (the caller orders them —
 * nearest-neighbour, #220 work item 4). Per hole: rapid to XY at `hopZ`, rapid straight down to
 * the stock top (a pure-Z rapid, in air), then one feed per peck. Between pecks the tool rapids
 * out to `hopZ` to clear chips and back down to `PECK_CLEARANCE` above the floor it just cut.
 * The hole ends with the tool back at `hopZ`; the item ends with a retract to `safeZ`.
 */
export function drillMoves(
  holes: readonly (readonly [number, number])[],
  depth: number,
  peck: number,
  params: CutParams,
): CamMove[] {
  const moves: CamMove[] = [];
  const depths = peckDepths(depth, peck);
  for (const [x, y] of holes) {
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
    // Down to the surface in air, then cut. A pure-Z rapid to the stock top is not an XY move
    // below `hopZ`, so rule 9 has nothing to say about it.
    moves.push({ kind: 'rapid', x, y, z: 0 });
    for (let i = 0; i < depths.length; i++) {
      const z = depths[i]!;
      moves.push({ kind: 'feed', x, y, z, f: params.plungeFeed });
      if (i < depths.length - 1) {
        // Clear the chips, then rapid back down the hole to just above the floor just cut.
        moves.push({ kind: 'rapid', x, y, z: HOP_Z });
        moves.push({ kind: 'rapid', x, y, z: z + PECK_CLEARANCE });
      }
    }
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
  }
  const last = holes[holes.length - 1];
  if (last) moves.push({ kind: 'rapid', x: last[0], y: last[1], z: SAFE_Z });
  return moves;
}
