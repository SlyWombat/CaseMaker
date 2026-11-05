/**
 * Chamfering an edge (#669): ONE flat bevel along a profile's part edge or a pocket's rim, cut by
 * a cone's flank. Not a region CAM and not a trace: the cutter's centre follows a closed ring
 * exactly one TIP RADIUS from the edge on the air side, at a constant Z — the flank is the bevel,
 * so no ring is pocketed and no width is stepped.
 *
 * THE GEOMETRY IS FORCED, and it is why there is no offset or depth parameter here. A cone with
 * tip radius `r1` and half angle `α` has its flank on a plane only while the flank is tangent to
 * that plane; for a bevel of width `w` on the top face (bottom at the wall `h = w / tan α`), the
 * tangency holds when the axis is `d` from the edge and the tip plane is at `−(w + d − r1)/tan α`.
 * The tip's flat must not cross the wall (`d ≥ r1`) and the flank must reach the wall at the
 * bevel's bottom (`d ≤ r1`), so `d = r1` exactly: the tip's flat is tangent to the wall and the
 * tip plane sits at exactly the bevel's bottom. The caller has already offset the path by the tip
 * radius (`profilePath`), so this module only traces it at `−h`.
 *
 * THE CUT IS A FEED, NEVER A RAPID, below the top face. The path is over the material the target
 * cut removes — the offcut beside a part, or the air of a pocket already cut — and the plunge at
 * the start of every ring is a `plungeFeed` from the hop height. The order against the target is
 * the CALLER's (the worker places this CAM between the regions and the cut-outs), because a
 * pocket's rim must exist before its chamfer and an offcut must not be free when its part's edge
 * is chamfered.
 *
 * NO TABS, NO PASSES, NO CUTTER-RADIUS COMPENSATION: the bevel IS the cutter's envelope, and one
 * pass cuts it because a wider bevel than the cone reaches is refused before this point
 * (`chamfer-too-wide`), not approximated here.
 *
 * LINKING between rings and between cuts goes through #962's `link()` (the review's item 6): this
 * op has no material field of its own (a V bit tracing a rim's edge does not clear the stay-down
 * short hop's own territory the way a flat's pocketing does), so every transition retracts — but
 * through `link()`'s own `retract()`, whose vertical legs are FEEDS at `plungeFeed`, never a
 * rapid (#956 §5, Review B's F8). The op's own first form (every one of the three legs a rapid,
 * including the two pure-vertical ones) violated that; only the final, whole-op SAFE_Z retreat
 * stays a plain rapid, the same convention every op in this engine posts.
 */

import type { CutParams } from '../feeds';
import { cuttingDiameter, type Tool } from '../tool';
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
import { link, type LinkOptions, type LinkPoint } from './model/linking';
import type { Polygons } from './pocket';

/** One chamfer pass, with the centre path the caller has already offset by the tip radius. */
export interface ChamferCut {
  /** The chamfer item's id; becomes the operation's `labelId`. */
  id: string;
  /** The operation's display name, without the `[T#]` prefix or the depth suffix. */
  name: string;
  /**
   * The centre path, in the work frame — the rim's edge offset by the tip radius on the tool's
   * side, one closed ring per contour.
   */
  path: Polygons;
  /** The tip plane's depth below the top face, positive mm (`width / tan(halfAngle)`). */
  depth: number;
}

/**
 * The chamfer CAM: one operation per chamfer, every ring traced once at the tip plane.
 *
 * Throws for a cutter that is not a resolvable cone — the finding (`chamfer-needs-cone`) refuses
 * the job before this point, and a direct caller gets the error rather than a path cut by a
 * cutter that cannot make one.
 */
export function generateChamfer(
  cuts: readonly ChamferCut[],
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
): ToolpathIR {
  const cone = vCone(tool);
  if (cone === null) {
    throw new Error(
      `generateChamfer: a chamfer is one bevel cut by a cone's flank, and "${tool.name}" is a ` +
        `${tool.shape} cutter with none`,
    );
  }
  const toolNumber = toolNumberFor(tool);
  const operations: CamOperation[] = [];
  // No material field of its own (see the header): every link retracts, through `link()`'s own
  // `retract()` so the two vertical legs are feeds at `plungeFeed`, never a rapid.
  const toolRadius = (cuttingDiameter(tool) ?? 0) / 2;
  const linkOptions: LinkOptions = {
    material: { topAt: () => Number.POSITIVE_INFINITY },
    clearanceZ: HOP_Z,
    tool: { radiusMm: toolRadius },
    feeds: { feed: params.feed, plungeFeed: params.plungeFeed },
  };

  for (const cut of cuts) {
    const z = -cut.depth;
    const moves: CamMove[] = [];
    let prevExit: LinkPoint | null = null;
    for (const contour of cut.path) {
      const start = contour[0];
      if (start === undefined) continue;
      const entry: LinkPoint = { x: start[0], y: start[1], z };
      if (prevExit === null) {
        // Down at the ring's first point in the air, then a FEED to the tip plane: the plunge
        // cuts the bevel's entry and must never be a rapid below the top face.
        moves.push({ kind: 'rapid', x: start[0], y: start[1], z: HOP_Z });
        moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: params.plungeFeed });
      } else {
        moves.push(...link(prevExit, entry, linkOptions));
      }
      for (const p of contour.slice(1)) moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: params.feed });
      // Close the ring, so the bevel's last corner is cut by the same pass as its first.
      moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: params.feed });
      prevExit = entry;
    }
    const last = moves[moves.length - 1];
    if (last) moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
    operations.push({
      number: operations.length + 1,
      name: `[T${toolNumber}]${cut.name} ${cut.depth.toFixed(1)}mm`,
      labelId: cut.id,
      depth: cut.depth,
      // #735 — every ring of this cut is one bevel at one Z: a single depth pass.
      depthPasses: 1,
      passStepMm: cut.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, rapid),
    });
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
