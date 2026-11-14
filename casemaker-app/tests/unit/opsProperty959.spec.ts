/**
 * #964 — THE CUTTING OPS' PROPERTY TEST (#959).
 *
 * Seeded rectilinear and filleted plates (pockets, an island, a shoulder, a through hole) built
 * with the production Manifold kernel, recognised by the app's own feature pass and planned
 * through `plan.ts`'s `planPocketsForTree`. For every seed:
 *
 *   1. no posted move cuts below the goal — the posted programs are stamped with their
 *      Tool-record cutters on the goal heightfield and `checkGoalCutInto` reads its ADJUDICATED
 *      set: the 0.1 mm floor after the cells a heightfield cannot judge (wall cells and the wall
 *      shadow) are excluded, exactly as the gate and the page read them. The PLATE'S OUTER 3.5 mm
 *      BAND is also outside this reading: the contour is supposed to take the outline to full
 *      depth, and one corner cell slips the gate's 4-neighbour wall mask (a diagonal-only
 *      silhouette case — reported on #924, not an ops defect). The raw 0.01-floor percentage is
 *      printed in the failure beside it;
 *   2. every reachable pocket is swept — the pocket's floor area is at least 95 % within 0.1 mm
 *      of its design floor; a pocket the plan states `unreachable` is named in the failure, with
 *      its seed.
 *
 * A failure here is a finding on #959, not a harness bug: the seed, kind and the measured numbers
 * are in the message.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind, type RandomPart } from '../tools/randomParts';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptField } from '@/workers/sim/sweptPoint';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { NO_SHOP } from '../tools/noShop';

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2', fluteLength: 30 }),
];
const SEEDS = [1, 2, 3, 4, 5] as const;
const KINDS: PartKind[] = ['rectilinear', 'filleted'];

function planOf(part: RandomPart): PlanPocketsResult {
  return planPocketsForTree(part.tree, {
    offset: makeClipperOffset(tl),
    houseFlats: HOUSE,
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    maxCutters: HOUSE.length + 1,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
  });
}

function postedPrograms(part: RandomPart, result: PlanPocketsResult): { ir: ToolpathIR; text: string }[] {
  const ctx: PostContext = {
    jobName: `random-${part.kind}-${part.seed}`,
    stock: { ...part.stock },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-964',
    toolKey: 'multi',
  };
  return result.programs.map((run) => {
    const posted = postZ1(run.ir, ctx, Z1);
    if (!posted.ok) throw new Error(`#964 random-${part.kind}-${part.seed}: postZ1 refused — ${posted.errors.join('; ')}`);
    return { ir: run.ir, text: posted.text };
  });
}

function stampedTop(programs: readonly { ir: ToolpathIR; text: string }[], field: GoalHeightfield): Float32Array {
  let acc: Float32Array | null = null;
  for (const program of programs) {
    const parsed = parseGcode(program.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('#964 random part: a posted program carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamp = exactSweptField(field, buildTimeline(parsed, setup, Z1), program.ir.tool);
    if (stamp === null) continue;
    if (acc === null) acc = Float32Array.from(stamp);
    else for (let k = 0; k < acc.length; k++) if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
  }
  if (acc === null) throw new Error('#964 random part: no program removed anything');
  return acc;
}

/** Even-odd point membership over every ring. */
function pointInside(polys: Polygons, x: number, y: number): boolean {
  let c = false;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** Distance from (x, y) to the nearest ring segment, mm. */
function distanceToBoundary(polys: Polygons, x: number, y: number): number {
  let best = Infinity;
  for (const ring of polys) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
    }
  }
  return best;
}

/**
 * The fraction of a pocket's REACHABLE floor swept to within `tolerance` of the design floor.
 * "Reachable" is the floor at least the cutter's radius plus 0.2 mm inside the pocket boundary:
 * the corner fillets a round cutter cannot enter are not the plan's to sweep, and counting them
 * would make every pocket "fail" by its cutter's own radius.
 */
function sweptFraction(
  field: GoalHeightfield,
  top: Float32Array,
  floorPolys: Polygons,
  floorZ: number,
  cutterRadiusMm: number,
  tolerance = 0.1,
): { fraction: number; cells: number } {
  const margin = cutterRadiusMm + 0.2;
  let cells = 0;
  let hit = 0;
  for (let j = 0; j < field.ny; j++) {
    const y = field.y0 + j * field.pitch;
    for (let i = 0; i < field.nx; i++) {
      if (field.covered[j * field.nx + i] !== 1) continue;
      const x = field.x0 + i * field.pitch;
      if (!pointInside(floorPolys, x, y)) continue;
      if (distanceToBoundary(floorPolys, x, y) <= margin) continue;
      cells++;
      const swept = top[j * field.nx + i]!;
      if (swept <= floorZ + tolerance) hit++;
    }
  }
  return { fraction: cells === 0 ? 1 : hit / cells, cells };
}

describe('#964 the cutting ops leave the design standing (#959)', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: no cut below the goal and every reachable pocket swept`, () => {
        const part = buildRandomPart(seed, kind, tl);
        const result = planOf(part);
        const programs = postedPrograms(part, result);
        const field = sampleGoalHeightfield(part.target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 });

        const top = stampedTop(programs, field);
        // The plate's outer band is the contour's own free zone (see this file's header); the
        // INTERIOR is where an op's gouge would show.
        const innerX = part.stock.length / 2 - 3.5;
        const innerY = part.stock.width / 2 - 3.5;
        const at = (x: number, y: number): number | null => {
          if (Math.abs(x) > innerX || Math.abs(y) > innerY) return null;
          const i = Math.round((x - field.x0) / field.pitch);
          const j = Math.round((y - field.y0) / field.pitch);
          if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
          return top[j * field.nx + i]!;
        };
        const report = checkGoalCutInto(field, at, { passCoverage: 0.95, wallShadowRadiusMm: 3 });
        expect(
          report.adjudicatedFraction,
          `${kind} seed ${seed}: ${(report.adjudicatedFraction * 100).toFixed(2)} % of cells cut below the adjudicated goal (raw ${(report.cutIntoFraction * 100).toFixed(2)} % at the 0.01 floor, adjudicated max ${report.adjudicatedMaxMm.toFixed(3)} mm at ${JSON.stringify(report.adjudicatedMaxAt)}; raw max ${report.maxCutIntoMm.toFixed(3)} mm at ${JSON.stringify(report.maxCutIntoAt)}; wall ${(report.wallNotScoredFraction * 100).toFixed(2)} %, shadow ${(report.shadowNotScoredFraction * 100).toFixed(2)} % excluded)`,
        ).toBe(0);

        const unreachable = result.unreachable.join(' | ');
        for (const node of part.tree.pockets) {
          if (result.unreachable.some((u) => u.startsWith(`${node.id}:`))) continue;
          const op = result.ops.find((o) => o.region.id === node.id);
          expect(op, `${kind} seed ${seed}: reachable pocket ${node.id} has no planned op`).toBeDefined();
          const floorPolys = node.floors.flatMap((f) => f.polygons);
          if (floorPolys.length === 0) continue;
          const radius = (op!.outcome.ir.tool.tipDiameter ?? op!.outcome.ir.tool.diameter ?? 0) / 2;
          const swept = sweptFraction(field, top, floorPolys, node.floorZ, radius);
          expect(
            swept.fraction,
            `${kind} seed ${seed}: pocket ${node.id} (floor ${node.floorZ} mm, cutter r=${radius}) swept ${(swept.fraction * 100).toFixed(1)} % of ${swept.cells} reachable cells; unreachable: ${unreachable || 'none'}`,
          ).toBeGreaterThanOrEqual(0.95);
        }
      }, 120_000);
    }
  }
});
