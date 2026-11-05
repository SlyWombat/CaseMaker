/**
 * #959 — four findings from A's review (#959 6622610124), pinned RED-FIRST as `it.fails` and now
 * fixed (flipped to plain `it`, this commit):
 *
 *   (1) a same-level link must stay in the tool centre's free space (no feed across an island or
 *       across the wall between two lobes) — `pocket.ts` now routes every same-level and
 *       level-to-level transition through #962's real `link()`
 *   (3) an open shoulder narrower than the cutter is still cleared (the tray's ~3 mm ledge) —
 *       `pocket.ts` extends an OPEN node's region across its open edge with a real Clipper2
 *       boolean before `pocketLoops` ever sees it
 *   (5) `cleared` never claims a sharp inside corner a round tool cannot reach — `pocket.ts`'s
 *       `cleared` is now the morphological OPENING (`dilate(erode(region, r), r)`), not a plain
 *       erosion frame
 *
 * Unlike `pocketOp959.spec.ts` (a rectangle-only fake offset), these run the REAL path: Manifold-built
 * solids → `recogniseFeatures` (#958) → `planPocketsForTree` / `pocket` with the real Clipper2
 * offset (`makeClipperOffset`). The expected numbers are the solids' own dimensions.
 */
import { describe, expect, it } from 'vitest';

import { tl, type ManifoldInstance } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { recogniseFeatures, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { HOP_Z, type RapidEstimate } from '@/engine/cnc/cam/ir';
import type { Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { assertFixtureMesh } from '../tools/fixtureMesh';
import { insideClosed } from '@/engine/cnc/cam/model/linkRoute';

function parsed(solid: ManifoldInstance): ParsedMesh {
  const m = solid.getMesh();
  const n = m.vertProperties.length / m.numProp;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[3 * v + k] = m.vertProperties[v * m.numProp + k]!;
  solid.delete();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  const mesh: ParsedMesh = { positions, indices: Uint32Array.from(m.triVerts), triangleCount: m.triVerts.length / 3, bbox: { min, max } };
  assertFixtureMesh(mesh, 'pocketRedFirst959 fixture');
  return mesh;
}

function flat(d: number, number: number): Tool {
  return {
    number, id: `flat-${d}`, name: `⌀${d} flat`, typeText: 'flat', shape: 'flat',
    handleDiameter: d, tipDiameter: null, diameter: d, cornerRadius: null,
    angle: null, halfAngle: null, fluteLength: 20, shoulderLength: null,
    stickout: null, centreCutting: true,
  };
}

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const offset = makeClipperOffset(tl);
const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };
const all = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);

function treeOf(solid: ManifoldInstance, stockTop: number): FeatureTree {
  return recogniseFeatures({ triangles: parsed(solid) }, { up: [0, 0, 1], stockTop, stockBottom: 0 }, tl);
}

function plan(tree: FeatureTree, houseFlats: Tool[]): PlanPocketsResult {
  return planPocketsForTree(tree, {
    offset,
    houseFlats,
    stepDownMm: 2,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid,
    toolChangeSeconds: 60,
    spindleRpm: 12000,
    air: true,
    maxCutters: houseFlats.length + 1,
    boolean,
  });
}

/** Signed-area sum of a Polygons (CCW outers positive, CW holes negative). */
function areaOf(polys: Polygons): number {
  let a = 0;
  for (const ring of polys) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      a += x0 * y1 - x1 * y0;
    }
  }
  return a / 2;
}

/** Even-odd point membership over every ring (outers and holes alike). */
function inside(polys: Polygons, x: number, y: number): boolean {
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

/**
 * Every horizontal FEED segment at `z` must keep the tool's centre inside the node's free space,
 * the region eroded by the cutter radius (less a 0.01 mm grace for offset chords), AND no lateral
 * rapid may run below `hopZMm` (advisor's review on dd150a9b and 9e976f0b: a datum error turns a
 * SHOULD-retract into a feed at depth, which this file's own `floorZ` comparison can only catch
 * when it is itself looking at the right Z — hence `feedsChecked`, so a datum bug cannot pass
 * this check vacuously by finding nothing at `floorZ`). `node.floorZ` is on `recogniseFeatures`'s
 * own mesh axis; `planPocketsForTree` rebases every move onto `Z 0 = stockTop` (plan.ts's header
 * note on dd150a9b), so the floor it actually posts is `floorZ - stockTop`.
 */
function linksOutsideFreeSpace(
  result: PlanPocketsResult,
  node: PocketNode,
  radius: number,
  stockTop: number,
  hopZMm: number,
  openOutline?: Polygons,
): { bad: string[]; feedsChecked: number } {
  // #962 ruling — the free space is erode(EXTENDED region, R): `pocket.ts` extends an open node by
  // the band between the outline and itself (clipped near the node), and the guard computes the
  // same union ITSELF from the same inputs — an independent check, never the op's recorded output.
  const base =
    node.open && openOutline !== undefined
      ? boolean.union(
          node.region,
          (() => {
            const wholeBand = boolean.subtract(offset(openOutline, 2 * radius), openOutline);
            const near = offset(node.region, 2 * radius);
            return boolean.subtract(wholeBand, boolean.subtract(wholeBand, near));
          })(),
        )
      : node.region;
  const free = offset(base, -radius);
  const op = result.ops.find((o) => o.region.id === node.id);
  if (op === undefined) return { bad: [`no op for ${node.id}`], feedsChecked: 0 };
  const floorZ = node.floorZ - stockTop;
  const bad: string[] = [];
  let feedsChecked = 0;
  let at: [number, number, number] | null = null;
  for (const operation of op.outcome.ir.operations) {
    for (const m of operation.moves) {
      if (!('x' in m) || m.x === undefined || m.y === undefined || m.z === undefined) continue;
      const next: [number, number, number] = [m.x, m.y, m.z];
      if (at !== null && m.kind === 'rapid' && (at[0] !== next[0] || at[1] !== next[1]) && Math.min(at[2], next[2]) < hopZMm - 1e-9) {
        bad.push(`a lateral rapid runs at z as low as ${Math.min(at[2], next[2]).toFixed(2)}, below hopZ ${hopZMm}: (${at[0].toFixed(2)}, ${at[1].toFixed(2)}, ${at[2].toFixed(2)}) → (${next[0].toFixed(2)}, ${next[1].toFixed(2)}, ${next[2].toFixed(2)})`);
      }
      if (at !== null && m.kind === 'feed' && Math.abs(at[2] - next[2]) < 1e-9 && Math.abs(next[2] - floorZ) < 1e-6) {
        feedsChecked++;
        const len = Math.hypot(next[0] - at[0], next[1] - at[1]);
        const n = Math.max(1, Math.ceil(len / 0.05));
        for (let i = 1; i < n; i++) {
          const x = at[0] + ((next[0] - at[0]) * i) / n;
          const y = at[1] + ((next[1] - at[1]) * i) / n;
          if (!insideClosed(free, x, y)) {
            bad.push(`(${at[0].toFixed(2)}, ${at[1].toFixed(2)}) → (${next[0].toFixed(2)}, ${next[1].toFixed(2)}) leaves free space at (${x.toFixed(2)}, ${y.toFixed(2)})`);
            break;
          }
        }
      }
      at = next;
    }
  }
  return { bad, feedsChecked };
}

/**
 * The fraction of `area`'s points (0.1 mm grid) the cutter actually swept: within `radius` of some
 * FEED segment at `z`. Read from the moves themselves, never from the op's own `cleared` (finding 5).
 */
function sweptFraction(result: PlanPocketsResult, nodeId: string, area: Polygons, z: number, radius: number): number {
  const segs: [number, number, number, number][] = [];
  for (const op of result.ops.filter((o) => o.region.id === nodeId)) {
    for (const operation of op.outcome.ir.operations) {
      let at: [number, number, number] | null = null;
      for (const m of operation.moves) {
        if (!('x' in m) || m.x === undefined || m.y === undefined || m.z === undefined) continue;
        if (at !== null && m.kind === 'feed' && Math.abs(m.z - z) < 1e-6 && Math.abs(at[2] - z) < 1e-6) segs.push([at[0], at[1], m.x, m.y]);
        at = [m.x, m.y, m.z];
      }
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of area) for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  let total = 0;
  let hit = 0;
  const r2 = radius * radius;
  for (let y = minY + 0.05; y < maxY; y += 0.1) {
    for (let x = minX + 0.05; x < maxX; x += 0.1) {
      if (!inside(area, x, y)) continue;
      total++;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const ex = ax + t * dx - x;
        const ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= r2) {
          hit++;
          break;
        }
      }
    }
  }
  return total === 0 ? 0 : hit / total;
}

describe('#959 red-first (A’s review 6622610124)', () => {
  it('(1) a same-level link stays in free space: a pocket with an island', () => {
    // 40 × 40 × 10 block; a 30 × 30 pocket 4 deep (floor z 6) with two 5 × 5 islands standing to
    // the top, on its diagonal.
    const s = tl.Manifold.cube([40, 40, 10])
      .subtract(tl.Manifold.cube([30, 30, 4]).translate([5, 5, 6]))
      .add(tl.Manifold.cube([5, 5, 4]).translate([11, 11, 6]))
      .add(tl.Manifold.cube([5, 5, 4]).translate([24, 24, 6]));
    const tree = treeOf(s, 10);
    const node = all(tree.pockets).find((n) => Math.abs(n.floorZ - 6) < 1e-6 && n.islands.length === 2)!;
    expect(node, 'the floor node holds the island').toBeDefined();
    const { bad, feedsChecked } = linksOutsideFreeSpace(plan(tree, [flat(3, 1)]), node, 1.5, tree.frame.stockTop, HOP_Z);
    expect(feedsChecked, 'the check actually looked at some feeds — a datum bug must not pass by finding none').toBeGreaterThan(0);
    expect(bad, `feeds/rapids that leave free space or run below hopZ:\n${bad.slice(0, 5).join('\n')}`).toEqual([]);
  });

  it('(1) a same-level link stays in free space: a U pocket whose erosion splits into two lobes', () => {
    // 40 × 30 × 10 block; a 30 × 20 pocket (floor z 6) with a 4 mm-wide wall rising from its
    // bottom edge to 4 mm short of its top edge: a U. Eroded past 2 mm, the U splits into its arms.
    const s = tl.Manifold.cube([40, 30, 10])
      .subtract(tl.Manifold.cube([30, 20, 4]).translate([5, 5, 6]))
      .add(tl.Manifold.cube([4, 16, 4]).translate([18, 5, 6]));
    const tree = treeOf(s, 10);
    const node = all(tree.pockets).find((n) => Math.abs(n.floorZ - 6) < 1e-6)!;
    expect(node).toBeDefined();
    const { bad, feedsChecked } = linksOutsideFreeSpace(plan(tree, [flat(2, 1)]), node, 1, tree.frame.stockTop, HOP_Z);
    expect(feedsChecked, 'the check actually looked at some feeds — a datum bug must not pass by finding none').toBeGreaterThan(0);
    expect(bad, `feeds/rapids that leave free space or run below hopZ:\n${bad.slice(0, 5).join('\n')}`).toEqual([]);
  });

  it('(3) an open shoulder narrower than the cutter is cleared (the tray’s ~3 mm ledge)', () => {
    // A 40 × 30 × 7 base with a 34 × 24 × 3 plateau on top: a 3 mm-wide open ledge at z 7 all round.
    const s = tl.Manifold.cube([40, 30, 7]).add(tl.Manifold.cube([34, 24, 3]).translate([3, 3, 7]));
    const tree = treeOf(s, 10);
    const ledge = all(tree.pockets).find((n) => n.open && Math.abs(n.floorZ - 7) < 1e-6)!;
    expect(ledge, 'the tree reads an open shoulder at z 7').toBeDefined();
    const ledgeArea = 40 * 30 - 34 * 24;
    const result = plan(tree, [flat(6, 1), flat(3.175, 2)]);
    expect(result.unreachable.filter((s) => s.startsWith(ledge.id)), 'the ledge is not unreachable').toEqual([]);
    const op = result.ops.find((o) => o.region.id === ledge.id);
    expect(op, 'an op cuts the ledge').toBeDefined();
    // Swept, read from the moves (the op's own `cleared` overclaims, finding 5): ≥ 95 % of the ledge.
    const cutter = op!.outcome.cutter.includes('3.175') ? 3.175 / 2 : 3;
    const swept = sweptFraction(result, ledge.id, ledge.floors.flatMap((f) => f.polygons), 7 - tree.frame.stockTop, cutter);
    expect(swept, `swept ${(100 * swept).toFixed(1)} % of the ${ledgeArea} mm² ledge`).toBeGreaterThanOrEqual(0.95);
    // #962 — the guard on the OPEN fixture: every feed must stay inside erode(extended region, R),
    // the extension computed here, not read from the op. Red before the extension was mirrored.
    const { bad, feedsChecked } = linksOutsideFreeSpace(result, ledge, cutter, tree.frame.stockTop, HOP_Z, tree.contour.outline);
    expect(feedsChecked, 'the open-node guard looked at some feeds').toBeGreaterThan(0);
    expect(bad, `open-node feeds outside the extended free space:\n${bad.slice(0, 5).join('\n')}`).toEqual([]);
  });

  it('(5) cleared never claims the sharp inside corners a round tool cannot reach', () => {
    // A 20 × 20 pocket 4 deep with sharp corners, cut with a ⌀6 flat. Reachable = the opening:
    // 400 − 4·(r² − πr²/4) with r 3 = 400 − (36 − 9π) ≈ 392.27 mm².
    const s = tl.Manifold.cube([30, 30, 10]).subtract(tl.Manifold.cube([20, 20, 4]).translate([5, 5, 6]));
    const tree = treeOf(s, 10);
    const node = all(tree.pockets).find((n) => Math.abs(n.floorZ - 6) < 1e-6)!;
    const result = plan(tree, [flat(6, 1)]);
    const op = result.ops.find((o) => o.region.id === node.id)!;
    const floor = op.outcome.cleared!.filter((c) => Math.abs(c.z - (6 - tree.frame.stockTop)) < 1e-6).at(-1)!;
    const reachable = 400 - (36 - 9 * Math.PI);
    expect(areaOf(floor.boundary)).toBeLessThanOrEqual(reachable + 0.05);
  });

  // #962 — THE ROW-END LEG LEVER (D's air attribution, 2026-11-05): a same-level join inside the
  // pocket's own open area must ride the floor instead of lifting. RED before the caller change
  // (the tray's flat-6 pocket pass alone carries 151 such legs).
  it('(6) a same-level pocket join rides the floor — no retract rapid between passes', () => {
    const s = tl.Manifold.cube([40, 30, 10]).subtract(tl.Manifold.cube([30, 20, 4]).translate([5, 5, 6]));
    const tree = treeOf(s, 10);
    const result = plan(tree, [flat(6, 1)]);
    const legs: string[] = [];
    for (const op of result.ops.filter((o) => o.kind === 'pocket')) {
      const moves = op.outcome.ir.operations.flatMap((o) => o.moves);
      let prev: { x: number; y: number; z: number } | null = null;
      let seenFeed = false;
      moves.forEach((m, i) => {
        if (m.x === undefined || m.y === undefined || m.z === undefined) return;
        if (m.kind === 'feed') seenFeed = true;
        // The op's FINAL retract to the safe plane is not a join — it is how every op ends.
        const isFinalRetract = i === moves.length - 1 && m.kind === 'rapid';
        if (m.kind === 'rapid' && !isFinalRetract && prev !== null && seenFeed && Math.hypot(m.x - prev.x, m.y - prev.y) < 0.05) {
          legs.push(`pocket join z ${prev.z.toFixed(2)} -> ${m.z.toFixed(2)}`);
        }
        prev = { x: m.x, y: m.y, z: m.z };
      });
    }
    expect(legs, `same-level retract rapids:\n${legs.slice(0, 8).join('\n')}`).toEqual([]);
  });
});
