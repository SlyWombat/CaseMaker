/**
 * Plunge-drilled holes (#220): the cutter goes straight down at a fixed XY and the hole is the
 * cutter's OWN diameter. There is nothing to offset, nothing to spiral and no region to pocket —
 * which is why this is a sibling of `engraveJob.ts`, not a branch of `pocketLoops`.
 *
 * #668 adds the other hole: a BORE TO SIZE, cut by an end mill helixing down a hole wider than
 * itself (`boreMoves`). It shares this module because it is still a hole — the same item, the same
 * depth and through rules, the same order — and because both paths have to make the same promise
 * about rapids and pure-Z re-entry that the header above describes.
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
import { segmentsForRadius } from '@/engine/compiler/arcResolution';

/**
 * The labelled fallback for `drill.peckClearanceMm`, mm (#451): how far above the previous peck's
 * floor the tool rapids back to before feeding the next peck. Used only when the caller hands in
 * no value — the shop's own number is read on the main thread, which is the realm that can see the
 * location, and arrives here as a plain number. 0.5 is #220's PROVISIONAL value; the first real
 * peck cycle measures it (#208/#209).
 */
export const PECK_CLEARANCE_FALLBACK_MM = 0.5;

/** The caller's peck clearance when it is a usable length, else {@link PECK_CLEARANCE_FALLBACK_MM}. */
export function peckClearanceFrom(peckClearanceMm: number | null | undefined): number {
  return typeof peckClearanceMm === 'number' && Number.isFinite(peckClearanceMm) && peckClearanceMm > 0
    ? peckClearanceMm
    : PECK_CLEARANCE_FALLBACK_MM;
}

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
 * out to `hopZ` to clear chips and back down to `peckClearanceMm` above the floor it just cut —
 * the shop's `drill.peckClearanceMm`, or the labelled fallback when the caller passes none.
 * The hole ends with the tool back at `hopZ`; the item ends with a retract to `safeZ`.
 */
export function drillMoves(
  holes: readonly (readonly [number, number])[],
  depth: number,
  peck: number,
  params: CutParams,
  peckClearanceMm: number | null = null,
): CamMove[] {
  const moves: CamMove[] = [];
  const depths = peckDepths(depth, peck);
  const clearance = peckClearanceFrom(peckClearanceMm);
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
        moves.push({ kind: 'rapid', x, y, z: z + clearance });
      }
    }
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
  }
  const last = holes[holes.length - 1];
  if (last) moves.push({ kind: 'rapid', x: last[0], y: last[1], z: SAFE_Z });
  return moves;
}

/* ---------------------------------------------------------------------------------------------
 * Bores to size (#668)
 * -------------------------------------------------------------------------------------------*/

/**
 * The labelled fallback for the shop's `bore.rampAngleDeg`, degrees: how steeply a bore's helix
 * descends — the lead it gains per revolution, as an angle. Used only when the caller hands in no
 * number; the location's own reading is resolved on the main thread and arrives here as plain data
 * (the `drill.peckClearanceMm` pattern, #451).
 */
export const BORE_RAMP_ANGLE_FALLBACK_DEG = 2;

/** The caller's ramp angle when it is a usable angle, else {@link BORE_RAMP_ANGLE_FALLBACK_DEG}. */
export function boreRampAngleFrom(rampAngleDeg: number | null | undefined): number {
  return typeof rampAngleDeg === 'number' && Number.isFinite(rampAngleDeg) && rampAngleDeg > 0 && rampAngleDeg < 90
    ? rampAngleDeg
    : BORE_RAMP_ANGLE_FALLBACK_DEG;
}

/**
 * The helix's descent per revolution, mm: the run's step-down CAPS it, and the ramp angle sets how
 * fast the tool may drop while it travels round the wall — `2π·Rc·tan(angle)` is the lead one
 * revolution takes when the centre path runs at radius `Rc`. The tighter of the two wins, so a
 * steep angle cannot turn the row's step-down into one deep bite and a shallow one cannot make the
 * helix slower than the row wants.
 *
 * `rampAngleDeg` is a resolved angle — `boreRampAngleFrom` turns the caller's value into one. The
 * run sheet and the operation row call this same function, so the number they state is the number
 * the CAM cuts.
 */
export function borePitchMm(stepDown: number, centreRadius: number, rampAngleDeg: number): number {
  return Math.min(stepDown, 2 * Math.PI * centreRadius * Math.tan((rampAngleDeg * Math.PI) / 180));
}

/**
 * The depths a bore's helix steps down to, positive mm, ending exactly on `depth`. Each step is at
 * most `pitch`, so one revolution never takes a deeper bite than the ramp angle or the feeds row
 * allows.
 *
 * `bottomDepth` is the blank's bottom below the top face, mm, for a THROUGH bore: the level list
 * then includes it EXACTLY. That is not cosmetic. A core is cleared at its own level, and the slab
 * of core straddling the blank's bottom would come free of the blank the moment the cutter crossed
 * the bottom — with nothing under it to hold it — before that slab's own level could cut it. A
 * level landing on the bottom clears the core to the blank's underside first, so the descent below
 * the blank only ever cuts air and the sacrificial board. A hole that does not cut through passes
 * `null` and the levels are the plain `pitch` steps.
 */
export function boreLevels(depth: number, pitch: number, bottomDepth: number | null = null): number[] {
  const bottom = bottomDepth !== null && bottomDepth > 0 && bottomDepth < depth ? bottomDepth : null;
  const levels: number[] = [];
  let z = 0;
  while (z < depth - 1e-9) {
    const next = Math.min(z + pitch, depth);
    // Split the step at the blank's bottom rather than striding over it.
    if (bottom !== null && z < bottom - 1e-9 && next > bottom + 1e-9) {
      levels.push(bottom);
      z = bottom;
      continue;
    }
    levels.push(next);
    z = next;
  }
  return levels;
}

/**
 * The moves for one BORE TO SIZE (#668): a hole `holeRadius` wide cut by a cutter `cutterRadius`
 * wide, helixed down its wall.
 *
 * A HOLE NO WIDER THAN TWICE THE CUTTER is the plain case, and it is today's path untouched: the
 * continuous helical ramp at the wall, one `borePitchMm` per revolution from the top face to the
 * floor, then one full-depth cleanup lap. The helix at `Rc = holeRadius − cutterRadius` sweeps the
 * whole disc — its outer edge traces the hole exactly and its inner edge reaches the centre — so
 * there is no core to clear. (This is the case Fusion's own Bore stops at.)
 *
 * A WIDER HOLE — the centre path `Rc` leaves a core of radius `holeRadius − 2·cutterRadius` — is
 * cut LEVEL BY LEVEL, one `pitch` at a time, so the core never stands at full height and the bite
 * that cuts it is the pitch, never the whole depth:
 *
 *  1. THE HELICAL RAMP at the wall: one full turn per level, descending that level's step (≤ the
 *     pitch) — the arc is flattened by `segmentsForRadius` (#190) because the IR is linear.
 *  2. THE CORE CLEARING at that level's Z: a spiral inward from the wall until the centre path
 *     reaches the cutter's own radius, a full HUB LAP at that radius, and a feed back out to the
 *     wall at the same Z through material this level already cut. The hub lap is not decoration:
 *     a spiral is one continuous inward pass, so near its end it visits the smallest radii over
 *     only a fraction of a turn, and the hub points outside that arc stand as a small post — the
 *     simulator's oracle found exactly that on the first build of this path (a ~0.9 mm² uncovered
 *     column beside the centre). The full circle closes it.
 *  3. THE FINAL LEVEL keeps the issue's own step on top of that: the full-depth WALL LAP, one more
 *     full circle at `−depth`, because the ramp's last revolution leaves the wall band's floor as
 *     a helical ramp up to one pitch high, and its spiral and hub lap are the floor's clearing.
 *
 * WHY LEVEL BY LEVEL, and not the ramp to the floor and one spiral at the end (the first build):
 * the core would stand at FULL HEIGHT until that last spiral. A through hole would free it as a
 * puck on the sacrificial board the moment the helix passed the blank's underside, and the spiral
 * would then side-mill the loose puck from its base up the flutes; a blind hole would give the
 * spiral an axial bite of the whole depth — the feeds row's step-down, the number the run sheet
 * prints, ignored exactly where the material is heaviest. With the levels, the core is cut in
 * `pitch`-deep slices, and a through bore's levels include the blank's bottom (`boreLevels`), so
 * the core is cleared to the underside BEFORE the cutter crosses it.
 *
 * The ramps are fed at the row's PLUNGE feed — they are descents — while the laps, the spiral and
 * the outward feeds are XY cuts at depth, so they run at the row's cutting feed. No XY rapid ever
 * happens below `hopZ`: the cutter rapids down at the helix's start point, exactly as a drill does.
 *
 * Throws when the hole is not wider than the cutter (no centre path exists) or the pitch resolves
 * to zero. `validateJob` refuses both by name before the CAM is reached; a direct caller gets the
 * error rather than a path that cuts something else.
 */
export function boreMoves(
  holes: readonly (readonly [number, number])[],
  depth: number,
  holeRadius: number,
  cutterRadius: number,
  params: CutParams,
  rampAngleDeg: number | null = null,
  bottomDepth: number | null = null,
): CamMove[] {
  const centreRadius = holeRadius - cutterRadius;
  if (!(centreRadius > 0)) {
    throw new Error(
      `boreMoves: a ⌀${holeRadius * 2} mm hole is not wider than the ⌀${cutterRadius * 2} mm cutter — ` +
        'a bore needs a hole wider than the cutter',
    );
  }
  const pitch = borePitchMm(params.stepDown, centreRadius, boreRampAngleFrom(rampAngleDeg));
  if (!(pitch > 0)) {
    throw new Error(`boreMoves: the helix pitch resolved to ${pitch} mm per revolution; it must be > 0`);
  }
  const segments = segmentsForRadius(centreRadius);
  const TAU = 2 * Math.PI;
  const spiralNeeded = centreRadius > cutterRadius;
  if (spiralNeeded && !(params.stepOver > 0)) {
    throw new Error(`boreMoves: the floor spiral's step-over resolved to ${params.stepOver} mm; it must be > 0`);
  }
  const spiralSegments = spiralNeeded
    ? Math.ceil(((centreRadius - cutterRadius) / params.stepOver) * segments)
    : 0;
  const hubRadius = spiralNeeded
    ? Math.max(cutterRadius, centreRadius - (params.stepOver * spiralSegments) / segments)
    : centreRadius;

  const moves: CamMove[] = [];
  const at = (cx: number, cy: number, r: number, angle: number): [number, number] => [
    cx + r * Math.cos(angle),
    cy + r * Math.sin(angle),
  ];
  for (const [cx, cy] of holes) {
    let [x, y] = at(cx, cy, centreRadius, 0);
    // Down to the surface at the helix's start point, in air — the same pure-Z rapid a drill makes.
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
    moves.push({ kind: 'rapid', x, y, z: 0 });
    let angle = 0;
    if (!spiralNeeded) {
      // The plain case: one continuous ramp to the floor, then the lap. Byte for byte the path a
      // hole no wider than twice the cutter has always had.
      const helixSegments = Math.max(1, Math.ceil((depth / pitch) * segments));
      for (let k = 1; k <= helixSegments; k++) {
        angle = (TAU * k) / segments;
        [x, y] = at(cx, cy, centreRadius, angle);
        moves.push({ kind: 'feed', x, y, z: -(depth * k) / helixSegments, f: params.plungeFeed });
      }
      for (let k = 1; k <= segments; k++) {
        angle += TAU / segments;
        [x, y] = at(cx, cy, centreRadius, angle);
        moves.push({ kind: 'feed', x, y, z: -depth, f: params.feed });
      }
    } else {
      // The wide case: the core is cut one level at a time.
      const levels = boreLevels(depth, pitch, bottomDepth);
      let previous = 0;
      for (let l = 0; l < levels.length; l++) {
        const level = levels[l]!;
        const step = level - previous;
        const isLast = l === levels.length - 1;
        const z = -level;
        // 1. The ramp: one full turn at the wall, descending this level's step.
        for (let k = 1; k <= segments; k++) {
          angle += TAU / segments;
          [x, y] = at(cx, cy, centreRadius, angle);
          moves.push({ kind: 'feed', x, y, z: -(previous + (step * k) / segments), f: params.plungeFeed });
        }
        // 2. The final level's wall lap: one more full turn at the floor, levelling the wall band.
        if (isLast) {
          for (let k = 1; k <= segments; k++) {
            angle += TAU / segments;
            [x, y] = at(cx, cy, centreRadius, angle);
            moves.push({ kind: 'feed', x, y, z, f: params.feed });
          }
        }
        // 3. Clear this level's core: inward to the hub, the hub lap, then back out to the wall.
        for (let k = 1; k <= spiralSegments; k++) {
          const r = Math.max(cutterRadius, centreRadius - (params.stepOver * k) / segments);
          angle += TAU / segments;
          [x, y] = at(cx, cy, r, angle);
          moves.push({ kind: 'feed', x, y, z, f: params.feed });
        }
        for (let k = 1; k <= segments; k++) {
          angle += TAU / segments;
          [x, y] = at(cx, cy, hubRadius, angle);
          moves.push({ kind: 'feed', x, y, z, f: params.feed });
        }
        if (!isLast) {
          // Back out to the wall at the same Z, through material this level has already cleared,
          // ready for the next level's ramp. The last level ends at the hub and retracts.
          [x, y] = at(cx, cy, centreRadius, angle);
          moves.push({ kind: 'feed', x, y, z, f: params.feed });
        }
        previous = level;
      }
    }
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
  }
  const last = holes[holes.length - 1];
  if (last) moves.push({ kind: 'rapid', x: last[0], y: last[1], z: SAFE_Z });
  return moves;
}
