/**
 * #959 acceptance on the Makerables reference parts — gated on env vars, same pattern as A's
 * #958 (`featureAcceptance958.spec.ts`):
 *
 *   CM_959_TRAY_STEP=…/modular-stackable-tool-trays/<tray 70>.step \
 *   CM_959_ORGANIZER_STEP=…/makera-tool-organizer/<organizer>.step \
 *   CM_959_OUT=…/959-acceptance/ \
 *   CM_MAKERABLES=…/.scratch/makerables   (optional: the vendor card beside ours) \
 *   npx vitest run tests/unit/opsAcceptance959.spec.ts
 *
 * **Partial by design, stated so rather than hidden**: #959 is four ops (pocket, contour, rough,
 * rest); as of this commit `pocket` and `contour` are real (`cam/model/ops/{pocket,contour}.ts`),
 * `rough`/`rest` are not. The manager's rule after E's a46f0358 run ("plans pockets only... each op
 * enters plan.ts AND the acceptance spec in the commit that adds it, so E's run measures what the
 * engine would post"): this spec plans the WHOLE non-through pocket set and the outer contour
 * TOGETHER, through `plan.ts`'s own `planPocketsForTree` (NOT a copy of it — advisor's "measure the
 * product, not the test harness"), using #961's real `chooseSequence` rest chain — one cutter
 * sequence priced against both ops at once, not pocket planned in isolation. It posts the
 * resulting program(s) with the existing Z1 post (`postZ1`), and measures ALL SEVEN lines of plan
 * v2 §3: cycle/air/rapids/cutters from the posted text (`measurePostedProgram`,
 * `tests/tools/postedFacts.ts`), and coverage/cut-into from the app's own goal check — the STEP's
 * mesh sampled through `engrave/goalHeightfield.ts`, every posted program's moves stamped with its
 * Tool-record cutter and accumulated across programs (`session.sweptFieldExact`, the same read the
 * gate uses), then `checkGoalCutInto` with the edge-break allowance from the job's stated edge
 * break and the chamfer Tool record (V2-2), scored through `tests/tools/sevenLines.ts` against the
 * Makerables vendor card. **Red-first, by design**: the tray's coverage is expected to be well
 * below Makera's 99.5 % until #960's ball finish lands — the number is the point, printed and
 * written to the posted facts, not asserted as a pass. Rough/rest are not in this program either,
 * so the cycle number is a LOWER BOUND on the real one, not a comparable total — printed as such,
 * never asserted against Makera's 47.6 min.
 *
 * `planPocketsForTree`'s cutter choice IS #961's real sequence now (`chooseSequence`'s rest chain,
 * `maxCutters` = the vendor's own reference-set count + 1, `cutters.house` = that same set — A's R5
 * ruling: "a simulation-only reference card prices on the VENDOR's own set"). A feature no cutter
 * in that budget covers is `result.unreachable`, stated by name, never a silent skip or a shrunk
 * primary.
 *
 * With `CM_959_OUT` set, writes `plan.json` (a partial `ModelPlanOutput`, pocket+contour ops only)
 * for F's `modelGolden.spec.ts` validator to check the shape against, and
 * `<name>-posted-facts.json` with all seven lines — the posted program facts, `coverage`, the
 * `cutInto` block (adjudicated plus the three excluded shares) and the scored `sevenLines` card —
 * for the manager/E to read off a real run.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingDiameter, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { pocket } from '@/engine/cnc/cam/model/ops/pocket';
import { clearMakeraCatalogue, installMakeraCatalogue } from '../tools/makeraCatalogue';
import { planPocketsForTree, planTreePrograms, type PlanPocketsResult, type SetupPlan } from '@/engine/cnc/cam/model/plan';
import type { SequenceStepFailure } from '@/engine/cnc/cam/model/sequence';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import {
  CHAMFER3175, EDGE_BREAK_LEG_MM, FLAT3175, FLAT6, RAPID, VENDOR_SET,
  edgeBreakAllowance, placedTree, postedTextFor, runsOf, writeAcceptance } from './helpers/trayAcceptance';
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';

/** Even-odd point membership over every ring (outers and holes alike) — the same rule
 * `pocketRedFirst959.spec.ts`'s own helper uses. */
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

/** The fraction of `area`'s points (0.5 mm grid) within `radius` of some FEED segment of
 * `regionId`'s own op(s) at `z` — read from the posted MOVES, never from the op's own `cleared`
 * (the same technique `pocketRedFirst959.spec.ts` uses for finding 5). */
function sweptFraction(ops: PlanPocketsResult['ops'], regionId: string, area: Polygons, z: number, radius: number): number {
  const segs: [number, number, number, number][] = [];
  for (const op of ops.filter((o) => o.region.id === regionId)) {
    for (const operation of op.outcome.ir.operations) {
      let at: [number, number, number] | null = null;
      for (const m of operation.moves) {
        if (!('x' in m) || m.x === undefined || m.y === undefined || m.z === undefined) continue;
        if (at !== null && m.kind === 'feed' && Math.abs(m.z - z) < 1e-6 && Math.abs(at[2] - z) < 1e-6) segs.push([at[0], at[1], m.x, m.y]);
        at = [m.x, m.y, m.z];
      }
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of area) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  let total = 0, hit = 0;
  const r2 = radius * radius;
  for (let y = minY + 0.25; y < maxY; y += 0.5) {
    for (let x = minX + 0.25; x < maxX; x += 0.5) {
      if (!pointInside(area, x, y)) continue;
      total++;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const ex = ax + t * dx - x, ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= r2) { hit++; break; }
      }
    }
  }
  return total === 0 ? 0 : hit / total;
}

/** Sum of XY distance across every FEED move (never a rapid/hop) — the real posted path length
 * a step-over change should shrink, same move-reading discipline `sweptFraction` above uses. */
function totalFeedLength(ir: ToolpathIR): number {
  let total = 0;
  for (const operation of ir.operations) {
    let at: [number, number] | null = null;
    for (const m of operation.moves) {
      if (!('x' in m) || m.x === undefined || m.y === undefined) { at = null; continue; }
      if (at !== null && m.kind === 'feed') total += Math.hypot(m.x - at[0], m.y - at[1]);
      at = [m.x, m.y];
    }
  }
  return total;
}


// This helper serves the OPERATOR-OPTION tests (the facing stage's own behaviour): it asks for
// facing explicitly. The PRODUCT default is off — planFacingOff959 pins that, and the real-part
// cases go through `planModelCam` with no option, so they plan no facing stage.
function planTray(tree: FeatureTree): PlanPocketsResult {
  return planPocketsForTree(tree, {
    tabs: DEFAULT_RELEASE_TABS, facing: 'on',
    offset: makeClipperOffset(tl),
    houseFlats: VENDOR_SET,
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: RAPID,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    maxCutters: VENDOR_SET.length + 1,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
  });
}

/** A minimal, hand-built tree: one 20×10 pocket, floor at −3, no STEP needed — proves the plan →
 * post → measure plumbing itself, independent of the licensed Makerables parts this file otherwise
 * needs. A failure here means this spec is broken; a failure on the real tray/organizer means the
 * geometry is. */
function syntheticTree(narrowest = 10): FeatureTree {
  const rect: [number, number][][] = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
  const node: PocketNode = {
    id: 'synthetic-1', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rect, floors: [{ polygons: rect, area: 200 }],
    islands: [], children: [], remainder: [], narrowest,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -3 },
    levels: [-3],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: rect, area: 200, zTo: -3, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 200, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** Same tree, but with a 1.2 mm skin between the stock's own top (Z 0, the post's `zDatum` —
 * every move in this whole program is read on that one absolute axis) and the recognised part
 * top — the tray's own real gap (A's review 6622610124, finding 2 and the contour-depth defect
 * it named most severe). `partTop`/`floorZ`/`zTo` are negative offsets DOWN from that same Z 0,
 * exactly as `recogniseFeatures`'s real callers place a mesh (`placedTree` in this file, `treeOf`
 * in `pocketRedFirst959.spec.ts`) — no existing fixture had a NON-ZERO skin before this test. */
function syntheticTreeWithSkin(skinMm: number): FeatureTree {
  const rect: [number, number][][] = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const node: PocketNode = {
    id: 'synthetic-1', floorZ, mouthZ: partTop, open: false, through: false,
    region: rect, floors: [{ polygons: rect, area: 200 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [], area: 0 },
    contour: { outline: rect, area: 200, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 200, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** A 30x20 part with a 10x10 pocket in one corner and a skin above it — a plain smoke test that
 * the facing op runs at all, at the right depth. `top.floors` (the L-shaped land, excluding the
 * pocket's own outline) is NOT what facing actually cuts from (advisor's review on 9a5cc607: see
 * `syntheticTreeFacingCoverage` for the real coverage case — a thin wall, a narrow rim, an island
 * top). */
function syntheticTreeWithLand(skinMm: number): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [30, 0], [30, 20], [0, 20]]];
  const pocketRect: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const landRect: [number, number][][] = [[[10, 0], [30, 0], [30, 20], [0, 20], [0, 10], [10, 10]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const node: PocketNode = {
    id: 'p', floorZ, mouthZ: partTop, open: false, through: false,
    region: pocketRect, floors: [{ polygons: pocketRect, area: 100 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [{ polygons: landRect, area: 500 }], area: 500 },
    contour: { outline, area: 600, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 600, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/**
 * Advisor's review on 9a5cc607, red-first: `tree.top.floors` alone would miss ALL THREE of a
 * wall narrower than 2 cutter radii, a rim the same, and an island's own top (features/tree.ts's
 * own "top land" step excludes an island's top from the land by design). A 40x20 part, two 16x16
 * pockets with a 3 mm wall between them and a 2 mm rim to every outer edge, one 4x4 island inside
 * the first pocket topped at the part's own top (so its skin needs facing too), and a 1.2 mm
 * skin. `landArea` is everything a facing pass must reach: the rim/wall land AND the island top.
 */
function syntheticTreeFacingCoverage(skinMm: number): { tree: FeatureTree; landArea: Polygons } {
  const outline: [number, number][][] = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
  // Pocket A's region has the island as a hole — outer CCW, hole CW (pocket.ts's own convention).
  const aOuter: [number, number][] = [[2, 2], [18, 2], [18, 18], [2, 18]];
  const islandOutline: [number, number][] = [[8, 8], [8, 12], [12, 12], [12, 8]];
  const aRegion: [number, number][][] = [aOuter, islandOutline];
  const bRegion: [number, number][][] = [[[21, 2], [38, 2], [38, 18], [21, 18]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const a: PocketNode = {
    id: 'a', floorZ, mouthZ: partTop, open: false, through: false,
    region: aRegion, floors: [{ polygons: aRegion, area: 240 }],
    islands: [{ outline: [islandOutline], topZ: partTop }], children: [], remainder: [], narrowest: 12,
  };
  const b: PocketNode = {
    id: 'b', floorZ, mouthZ: partTop, open: false, through: false,
    region: bRegion, floors: [{ polygons: bRegion, area: 256 }],
    islands: [], children: [], remainder: [], narrowest: 16,
  };
  // The rim (2 mm wide, all round) + the wall (3 mm, between the pockets) + the island top (4x4)
  // — everything a facing pass must reach, read back out in the test via sweptFraction.
  const landArea: [number, number][][] = [
    [[0, 0], [40, 0], [40, 20], [0, 20]], // the rim/wall land is the outline minus both pockets' outers
    [[2, 2], [2, 18], [18, 18], [18, 2]], // (reversed) hole for pocket A's own outer
    [[21, 2], [21, 18], [38, 18], [38, 2]], // (reversed) hole for pocket B's own outer
    [islandOutline[0]!, islandOutline[3]!, islandOutline[2]!, islandOutline[1]!], // but the island top IS land
  ];
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [], area: 0 }, // deliberately NOT used by facing any more; see the fixture's own doc
    contour: { outline, area: 800, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [a, b],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, landArea };
}


/** Two pockets and an outline; `region` distinguishes them by width so a wrapped offset can throw
 * for one specific region on demand (below) — the manager's #959 ruling: a region that fails to
 * plan must not crash the whole plan. */
function syntheticTreeTwoPockets(): FeatureTree {
  const rectOk: [number, number][][] = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
  const rectBad: [number, number][][] = [[[30, 0], [37, 0], [37, 7], [30, 7]]];
  const outline: [number, number][][] = [[[0, 0], [37, 0], [37, 10], [0, 10]]];
  const ok: PocketNode = {
    id: 'ok-1', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rectOk, floors: [{ polygons: rectOk, area: 200 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  const bad: PocketNode = {
    id: 'bad-1', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rectBad, floors: [{ polygons: rectBad, area: 49 }],
    islands: [], children: [], remainder: [], narrowest: 7,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -3 },
    levels: [-3],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline, area: 370, zTo: -3, frees: true, shoulders: [] },
    pockets: [ok, bad],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 370, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** Two pockets that force a REST chain: 'a' (narrowest 10) fits the house ⌀6, 'b' (narrowest 4)
 * does not and needs the ⌀3.175 rest cutter — so the primary (⌀6) covers 'a' and the contour,
 * the rest (⌀3.175) covers 'b', exactly the shape where the OLD contour-rides-in-the-primary
 * ordering would free the part before 'b' was even cut. */
/** A root pocket plus one through hole, sized by `holeSide` — ruling 2: a through hole wider than
 * ~2 cutter diameters is CLEARED like a pocket (no slug), profile-only when it is not. */
function syntheticTreeWithThroughHole(holeSide: number): FeatureTree {
  const rectPocket: [number, number][][] = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
  const rectHole: [number, number][][] = [[[30, 0], [30 + holeSide, 0], [30 + holeSide, holeSide], [30, holeSide]]];
  const outline: [number, number][][] = [[[0, 0], [30 + holeSide, 0], [30 + holeSide, 10], [0, 10]]];
  const pocketNode: PocketNode = {
    id: 'p', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rectPocket, floors: [{ polygons: rectPocket, area: 200 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  const hole: PocketNode = {
    id: 'hole', floorZ: -5, mouthZ: 0, open: false, through: true,
    region: rectHole, floors: [], islands: [], children: [], remainder: [], narrowest: holeSide,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -5 },
    levels: [-3, -5],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline, area: (30 + holeSide) * 10, zTo: -5, frees: true, shoulders: [] },
    pockets: [pocketNode, hole],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: (30 + holeSide) * 10, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function syntheticTreeRestChain(): FeatureTree {
  // 'a' is large enough that FLAT3175 roughing it alone costs far more than FLAT6 roughing it
  // plus a tool change to FLAT3175 for 'b' — the chain's own cost ranking must pick the two-cutter
  // plan, not just happen to put the contour last within one cutter's own single step.
  const rectA: [number, number][][] = [[[0, 0], [60, 0], [60, 40], [0, 40]]];
  const rectB: [number, number][][] = [[[70, 0], [74, 0], [74, 4], [70, 4]]];
  const outline: [number, number][][] = [[[0, 0], [74, 0], [74, 40], [0, 40]]];
  const a: PocketNode = {
    id: 'a', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rectA, floors: [{ polygons: rectA, area: 2400 }],
    islands: [], children: [], remainder: [], narrowest: 40,
  };
  const b: PocketNode = {
    id: 'b', floorZ: -3, mouthZ: 0, open: false, through: false,
    region: rectB, floors: [{ polygons: rectB, area: 16 }],
    islands: [], children: [], remainder: [], narrowest: 4,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -3 },
    levels: [-3],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline, area: 2416, zTo: -3, frees: true, shoulders: [] },
    pockets: [a, b],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 2416, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** Wraps a real offset to throw for any region whose bounding width is `badWidth` — a stand-in
 * for a real Clipper failure on a specific region (an extended open shoulder, a degenerate
 * through hole), without needing a fixture that actually breaks Clipper. */
function offsetThrowingFor(badWidth: number, real: ReturnType<typeof makeClipperOffset>): ReturnType<typeof makeClipperOffset> {
  return (region, delta) => {
    let minX = Infinity, maxX = -Infinity;
    for (const ring of region) for (const [x] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (Math.abs(maxX - minX - badWidth) < 1e-6) throw new Error('synthetic Clipper failure for test');
    return real(region, delta);
  };
}

/**
 * #962 — A DROPPED STAGE IS STATED THE GROUPED WAY, NOT PER REGION. The operator's contract is one
 * sentence per cause — the kind, the count and the deepest ground — so no region id appears in it;
 * per-region detail (ids, kind, reason) is the structured `unplanned` list. A stage that emitted no
 * moves at all is stated ONLY by the grouped sentence (there is no failure to carry); a stage that
 * THREW is in `unplanned`. This accepts either, and judges the grouped sentence's own form when it
 * is the one present.
 */
function expectStageStated(kind: 'rough' | 'pencil' | 'rest', notes: readonly string[], unplanned: readonly SequenceStepFailure[]): void {
  const grouped = notes.find((n) => n.startsWith(`${kind}: `) && n.includes('emitted no moves'));
  const thrown = unplanned.filter((f) => f.kind === kind);
  if (grouped === undefined && thrown.length === 0) {
    throw new Error(
      `${kind} was dropped without a statement — notes: ${notes.join(' | ')}; unplanned: ${JSON.stringify(unplanned.map((f) => ({ kind: f.kind, regionIds: f.regionIds })))}`,
    );
  }
  if (grouped !== undefined) {
    expect(grouped).toMatch(
      new RegExp(`^${kind}: \\d+ regions? emitted no moves — nothing for it to cut(?:; the deepest ground among them is [\\d.]+ mm below the part top)?$`),
    );
    expect(Number(/^[^:]+: (\d+)/.exec(grouped)![1])).toBeGreaterThan(0);
  }
  for (const failure of thrown) {
    expect(failure.regionIds.length).toBeGreaterThan(0);
    expect(failure.reason.length).toBeGreaterThan(0);
  }
}

describe('#959 opsAcceptance plumbing (no STEP needed)', () => {
  it('a region that fails to plan does not crash the whole plan — it is a named finding, the rest still posts', () => {
    const tree = syntheticTreeTwoPockets();
    const result = planPocketsForTree(tree, {
      tabs: DEFAULT_RELEASE_TABS, offset: offsetThrowingFor(7, makeClipperOffset(tl)),
      houseFlats: VENDOR_SET,
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      rapid: RAPID,
      toolChangeSeconds: TOOL_CHANGE_SECONDS,
      spindleRpm: 12000,
      air: true,
      maxCutters: VENDOR_SET.length + 1,
      boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    });
    expect(result.ops.some((op) => op.region.id === 'ok-1'), 'the OTHER pocket still plans').toBe(true);
    expect(result.ops.some((op) => op.kind === 'contour'), 'the contour still plans').toBe(true);
    expect(result.ops.some((op) => op.region.id === 'bad-1'), 'the failing region is not planned').toBe(false);
    // #962 — THE STRUCTURED RECORD CARRIES THE REGION; the note states the CAUSE once, grouped.
    expect(
      result.unplanned.some((f) => f.kind === 'pocket' && f.regionIds.includes('bad-1') && f.reason.includes('synthetic Clipper failure')),
      `unplanned: ${JSON.stringify(result.unplanned.map((f) => ({ kind: f.kind, regionIds: f.regionIds, reason: f.reason })))}`,
    ).toBe(true);
    expect(result.notes, `notes: ${result.notes.join('; ')}`).toContain('pocket: 1 region could not be cut — synthetic Clipper failure for test');
  });

  // The manager's #959 ruling: the freeing cut runs LAST, after every rest/finish/chamfer step —
  // never while a smaller rest cutter still has pockets of its own left to touch.
  it('the freeing cut (contour) is posted LAST, after the rest chain\'s own pocket — never before it', () => {
    const tree = syntheticTreeRestChain();
    const result = planTray(tree);
    expect(result.unreachable).toEqual([]);
    // Confirms this actually exercises the cross-step reorder, not a one-cutter plan where the
    // contour was already last within its own single step regardless.
    expect(result.choice.steps.length, `steps: ${JSON.stringify(result.choice.steps.map((s) => ({ kind: s.kind, cutter: s.cutter.key, regionIds: s.regionIds })))}`).toBeGreaterThan(1);
    expect(result.ops).toHaveLength(3); // a, b, contour
    expect(result.ops.at(-1)!.kind).toBe('contour');
    expect(result.ops.slice(0, -1).some((op) => op.kind === 'contour')).toBe(false);
    const contourOp = result.ops.at(-1)!;
    // Advisor's review on ab6b2827: #961 may legitimately RETURN to an earlier cutter for the
    // freeing cut (cheaper than its last cutter taking the profile) — `programs` is grouped by
    // RUN, not by cutter key, so a return posts as its OWN last entry, never merged into that
    // cutter's first run (which would free the part before the step in between it ever ran).
    expect(result.programs.length, `programs: ${JSON.stringify(result.programs.map((p) => p.cutterKey))}`).toBeGreaterThan(1);
    const lastRun = result.programs.at(-1)!;
    expect(lastRun.cutterKey).toBe(contourOp.outcome.cutter);
    expect(lastRun.ir.operations.at(-1)!.labelId).toBe('contour');
    for (const run of result.programs.slice(0, -1)) {
      expect(run.ir.operations.some((o) => o.labelId === 'contour'), `an earlier run (${run.cutterKey}) already posts the contour`).toBe(false);
    }
    // #961 prices the freeing cutter choice itself; confirm `choice.freeing` agrees with which
    // cutter actually got it, and that a priced return is stated as a note.
    expect(result.choice.freeing).not.toBeNull();
    expect(result.choice.freeing!.cutterKey).toBe(contourOp.outcome.cutter);
    if (result.choice.freeing!.extraToolChange) {
      expect(result.notes.some((n) => n.includes('RETURN tool change')), `notes: ${result.notes.join('; ')}`).toBe(true);
    }
  });

  // The manager's #959 ruling 2.
  it('a through hole wider than ~2 cutter diameters is CLEARED like a pocket, not left with a slug', () => {
    const tree = syntheticTreeWithThroughHole(20); // ⌀6: narrowest 20 >= 2 x 6 = 12
    const result = planTray(tree);
    const hole = result.ops.find((op) => op.region.id === 'hole')!;
    expect(hole, 'the hole is planned').toBeDefined();
    const levels = new Set(hole.outcome.passes.map((p) => p.z)).size;
    // A cleared pocket traces MORE than one ring per level (concentric step-over rings); a bare
    // profile cut traces exactly one ring per level.
    expect(hole.outcome.passes.length, `${hole.outcome.passes.length} passes over ${levels} level(s)`).toBeGreaterThan(levels);
  });

  it('a through hole narrower than ~2 cutter diameters stays profile-only', () => {
    const tree = syntheticTreeWithThroughHole(8); // ⌀6: narrowest 8 < 2 x 6 = 12
    const result = planTray(tree);
    const hole = result.ops.find((op) => op.region.id === 'hole')!;
    expect(hole, 'the hole is planned').toBeDefined();
    const levels = new Set(hole.outcome.passes.map((p) => p.z)).size;
    expect(hole.outcome.passes.length, `${hole.outcome.passes.length} passes over ${levels} level(s)`).toBe(levels);
  });


  it('a skin between the stock top and the part top is faced separately, and the contour still reaches the full depth down from the STOCK top', () => {
    const tree = syntheticTreeWithSkin(1.2);
    const result = planTray(tree);
    const contourResult = result.ops.find((op) => op.kind === 'contour')!;
    const deepestContourZ = Math.min(
      ...contourResult.outcome.ir.operations.flatMap((o) => o.moves.map((m) => m.z)),
    );
    // -4.2 (zTo, already expressed relative to the stock top): the old `partTop - zTo` depth
    // (3, not 4.2) stopped the contour 1.2 mm short of the real floor.
    expect(deepestContourZ).toBeCloseTo(tree.contour.zTo, 6);
    // The manager's own ruling: facing takes the skin, a root pocket's own mouth starts at
    // `tree.top.z` (not the stock top) so it does not re-face the same layer a second time.
    const facing = result.ops.find((op) => op.region.id === 'facing')!;
    expect(facing, `ops: ${result.ops.map((o) => o.region.id).join(', ')}`).toBeDefined();
    expect(facing.outcome.ir.operations[0]!.depth).toBeCloseTo(1.2, 6);
    const pocketResult = result.ops.find((op) => op.region.id === 'synthetic-1')!;
    // depth = top.z(-1.2) - floorZ(-4.2) = 3, not stockTop(0) - floorZ(-4.2) = 4.2: facing
    // already took the skin, so the pocket's own first pass starts below it, not at the stock top.
    expect(pocketResult.outcome.ir.operations[0]!.depth).toBeCloseTo(3, 6);
    // Advisor's review on 108e120c: a program deeper than `partTop - partBottom` (3) is posted
    // here (the contour's 4.2 mm) — `postZ1` must accept it, not just plan it. A refusal here
    // (a stock/depth mismatch, say) is exactly E's condition on both the tray and the organizer,
    // so it must be caught here, not on dave-1.
    expect(() => writeAcceptance('skin', tree, result)).not.toThrow();
  });

  // The manager's #959 ruling: the facing op clears the top land outside every pocket's
  // footprint — the other coverage gap E's run named (the tray's 1.2 mm skin, the organizer's
  // 0.8 mm, never cut outside the pockets that happen to engage it as a side effect).
  it('facing runs at the right depth on a part with a skin above a pocket', () => {
    const tree = syntheticTreeWithLand(1.2);
    const result = planTray(tree);
    expect(result.unreachable).toEqual([]);
    const facing = result.ops.find((op) => op.region.id === 'facing');
    expect(facing, `ops: ${result.ops.map((op) => op.region.id).join(', ')}`).toBeDefined();
    // depth = stockTop(0) - top.z(-1.2) = 1.2 — just the skin, not the pocket's own 4.2 mm.
    expect(facing!.outcome.ir.operations[0]!.depth).toBeCloseTo(1.2, 6);
    // The manager's own clarification of "stop at each land's own Z": facing removes ONLY the
    // skin between the stock top and the part's top land, one level, NEVER deeper — everything
    // below the top land belongs to the pockets and the contour. Checked directly on the deepest
    // move's own Z, not just the `depth` magnitude (which stockTop(0) - top.z(-1.2) and a
    // double-counted depth could both satisfy by coincidence).
    const deepestFacingZ = Math.min(...facing!.outcome.ir.operations.flatMap((o) => o.moves.map((m) => m.z)));
    expect(deepestFacingZ).toBeCloseTo(tree.top.z, 6);
    // depth = top.z(-1.2) - floorZ(-4.2) = 3, not stockTop(0) - floorZ(-4.2) = 4.2: facing
    // already took the skin, so the pocket's own first pass starts below it.
    const pocketOp = result.ops.find((op) => op.region.id === 'p')!;
    expect(pocketOp.outcome.ir.operations[0]!.depth).toBeCloseTo(3, 6);
    expect(() => writeAcceptance('land', tree, result)).not.toThrow();
  });

  // Advisor's review on 9a5cc607: `tree.top.floors` alone misses a wall/rim narrower than the
  // cutter and an island's own top. Facing from `offset(outline, +2r)` instead (this commit)
  // must reach all three — measured from the MOVES (never the op's own `cleared`, A's finding 5
  // pattern), not just "an op exists".
  it('facing reaches the rim, the wall between two pockets, AND an island top — not just an open floor', () => {
    const { tree, landArea } = syntheticTreeFacingCoverage(1.2);
    const result = planTray(tree);
    expect(result.unreachable).toEqual([]);
    const facing = result.ops.find((op) => op.region.id === 'facing');
    expect(facing, `ops: ${result.ops.map((op) => op.region.id).join(', ')}`).toBeDefined();
    const cutter = facing!.outcome.cutter;
    const radius = (cutter.includes('3.175') ? 3.175 : 6) / 2;
    const swept = sweptFraction(result.ops, 'facing', landArea, tree.top.z, radius);
    expect(swept, `facing cutter ${cutter}, swept ${(100 * swept).toFixed(1)} % of the rim/wall/island-top land`).toBeGreaterThanOrEqual(0.95);
  });

  // The manager's instruction after E's faf7ad78 measurement: the real lever is the STEP-OVER
  // (facing ran at 25 % of the cutter's own diameter where the raster allows 50 %) — red-first
  // on the posted feed length before trusting it, not just "an op exists" (same discipline as
  // the coverage test above).
  it("facing posts a measurably SHORTER feed path at the cutter's own 50% step-over than it would at the old 25% one", () => {
    const tree = syntheticTreeWithLand(1.2);
    const result = planTray(tree);
    const facingOp = result.ops.find((op) => op.region.id === 'facing')!;
    expect(facingOp, `ops: ${result.ops.map((o) => o.region.id).join(', ')}`).toBeDefined();

    const toolRadius = cuttingDiameter(FLAT6)! / 2; // 3 mm — the 50% ceiling `pocketLoops` allows
    const facingRegionPolys = makeClipperOffset(tl)(tree.contour.outline, 2 * toolRadius);
    const baseOpts = {
      cutter: FLAT6,
      node: {
        id: 'facing', floorZ: tree.top.z, mouthZ: 0, open: false, through: false,
        region: facingRegionPolys, floors: [], islands: [], children: [], remainder: [], narrowest: Infinity,
      },
      region: facingOp.region,
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: makeClipperOffset(tl),
      safeZMm: 5, hopZMm: 1, toolNumber: 1, spindleRpm: 12000, air: true, rapid: RAPID,
    };
    const atHalf = pocket({ ...baseOpts, stepOverMm: toolRadius });
    const atOldQuarter = pocket({ ...baseOpts, stepOverMm: cuttingDiameter(FLAT6)! / 4 });
    const halfLength = totalFeedLength(atHalf.ir);
    const oldQuarterLength = totalFeedLength(atOldQuarter.ir);
    expect(
      halfLength,
      `50% step-over posts ${halfLength.toFixed(1)} mm of feed vs the old 25%'s ${oldQuarterLength.toFixed(1)} mm — expected roughly half the rows, not a wash`,
    ).toBeLessThan(oldQuarterLength);

    // Tied to the real wiring, not just the lemma above: plan.ts's own facing op must actually
    // BE the 50%-step-over program, not the old 25% one re-measured here by coincidence.
    const postedLength = totalFeedLength(facingOp.outcome.ir);
    expect(
      postedLength,
      `posted ${postedLength.toFixed(1)} mm; direct 50% call ${halfLength.toFixed(1)} mm; direct old-25% call ${oldQuarterLength.toFixed(1)} mm`,
    ).toBeCloseTo(halfLength, 4);
  });

  // Advisor's review on this revert: a root pocket's/wide through hole's own mouth is now
  // `tree.top.z`, not the stock top — it ASSUMES facing already cleared the skin everywhere.
  // That makes "facing posts first" a safety requirement, not just an efficiency nicety (a
  // pocket posted before facing would take a first stepdown pass deeper than `stepDownMm`
  // expects). Proven by the real `ops` array — which is also the real move order within a run,
  // the same loop that builds `programs` — not by trusting `features`' own push order.
  it('facing is posted BEFORE every pocket/through-hole whose mouth now assumes the skin is already gone', () => {
    const tree = syntheticTreeWithLand(1.2);
    const result = planTray(tree);
    const facingIndex = result.ops.findIndex((op) => op.region.id === 'facing');
    expect(facingIndex, `ops: ${result.ops.map((o) => o.region.id).join(', ')}`).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < result.ops.length; i++) {
      const op = result.ops[i]!;
      if (op.region.id === 'facing' || op.kind === 'contour') continue;
      expect(
        i,
        `facing at ${facingIndex}, '${op.region.id}' at ${i} — posted order: ${result.ops.map((o) => o.region.id).join(', ')}`,
      ).toBeGreaterThan(facingIndex);
    }
  });

  // E's measurement on faf7ad78: excluding each pocket's own interior made BOTH reference parts
  // SLOWER (the holed raster is many short feed segments, +58 %/+27 %) — reverted; facing covers
  // the whole grown outline again, no exclusion (see the 'facing' dispatch's own comment). The
  // three regressions this interior-exclusion fix (4355f5ef, faf7ad78) added — "excludes a pocket
  // big enough to erode cleanly", "still reaches a wall between two pockets too small to erode
  // individually", "still reaches an island top when the pocket around it is narrower than 2r" —
  // guarded ONLY that exclusion logic, now reverted, so they are dropped rather than kept
  // vacuously green (a pocket's own deep interior, a thin wall, a narrow island gap are all
  // trivially "reached" once nothing is excluded at all).

  it('plans, posts and measures a synthetic one-pocket tree end to end — the pocket AND the contour', () => {
    const tree = syntheticTree();
    const result = planTray(tree);
    expect(result.unreachable).toEqual([]);
    expect(result.ops).toHaveLength(2); // one pocket node + the outer contour, planned together
    expect(result.ops.map((op) => op.kind).sort()).toEqual(['contour', 'pocket']);
    writeAcceptance('synthetic', tree, result);
  });

  // E's run on 9421a64b, regression 1: a node that only the SMALLER house flat fits used to crash
  // (stepOverFor was fixed at a value sized for ⌀6, handed to ⌀3.175 too).
  it('a node too narrow for the ⌀6 flat is cut with ⌀3.175, step-over scaled to ITS radius, not ⌀6’s', () => {
    const tree = syntheticTree(4); // < 6, so FLAT6 is excluded; ≥ 3.175, so FLAT3175 fits
    const result = planTray(tree);
    expect(result.unreachable).toEqual([]);
    expect(result.ops).toHaveLength(2);
    const pocketOp = result.ops.find((op) => op.kind === 'pocket');
    expect(pocketOp?.outcome.cutter).toBe(FLAT3175.id);
  });

  // E's run on 9421a64b, regression 2: a node too narrow for every house cutter is a stated
  // finding naming the limiting number, not a silent skip — the chain still plans the contour.
  it('a node too narrow for every house flat is a stated finding, not a silent skip', () => {
    const tree = syntheticTree(0.95);
    const result = planTray(tree);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]!.kind).toBe('contour');
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]).toContain('not cut');
    expect(result.unreachable[0]).toContain('0.95');
  });
});

const TRAY = process.env.CM_959_TRAY_STEP;
const ORGANIZER = process.env.CM_959_ORGANIZER_STEP;

// #964 ruling (2026-11-04): the acceptance installs the FULL Makera catalogue, so the real parts
// are priced on the vendor's own rows (⌀6 flat 111031606032 at F1000, the ⌀6 ball at F500) rather
// than the compiled table's 3.2 mm fallback. Local-only data; when it is absent the real-part
// cases skip with the reason instead of silently planning on the fallback.
const CATALOGUE = installMakeraCatalogue();
afterAll(() => clearMakeraCatalogue());

describe.skipIf(TRAY === undefined || (!CATALOGUE.installed && !CATALOGUE.optedOut))('#959 acceptance — tool tray 70, the WHOLE tree through the one interface', () => {
  it('plans pockets, the curved remainder and rims together, with the freeing contour last and every program posted', async () => {
    const { tree, mesh } = await placedTree(TRAY!, [110, 140], -1.2);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < mesh.positions.length; v += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, mesh.positions[v + a] as number);
        max[a] = Math.max(max[a]!, mesh.positions[v + a] as number);
      }
    }
    const geometry = { triangles: { positions: mesh.positions, indices: mesh.indices, triangleCount: mesh.indices.length / 3, bbox: { min, max } } };
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
    const ball = flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6', shape: 'ball', typeText: 'Ball End', fluteLength: 30 });
    const vbit = flatEndMill(3.175, { number: 3, id: 'v90', name: '91 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1, fluteLength: 30 });
    const result = planTreePrograms(tree, {
      offset: makeClipperOffset(tl),
      pockets: {
        tabs: DEFAULT_RELEASE_TABS,
        houseFlats: [flat, flatEndMill(3.175, { number: 4, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 })],
        // #975 — the V bits are the chain's last resort for pockets no flat enters (the digits).
        houseVs: [vbit],
        stepDownMm: 1.5,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        rapid: Z1.rapidEstimate,
        toolChangeSeconds: TOOL_CHANGE_SECONDS,
        spindleRpm: 12000,
        air: true,
      },
      curved: {
        geometry, flat, ball, vbit,
        stepDownMm: 1.5, bandMm: 0.3, stepOverMm: 3,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        rapid: Z1.rapidEstimate, spindleRpm: 12000, air: true,
        edgeBreak: { legMm: 0.5 },
        toolNumberFor: (t: Tool) => t.number ?? 1,
      },
    });
    const kinds = result.ops.map((op) => op.kind);
    expect(kinds, `unreachable: ${result.unreachable.join('; ')}`).toContain('pocket');
    expect(kinds).toContain('finish');
    // A STAGE THAT FINDS NOTHING IS DROPPED WITH A NOTE (#964) — the project path states an empty
    // stage rather than listing one that posts nothing. #962: one grouped sentence per stage
    // (kind, count, deepest ground), never a line per region.
    for (const stage of ['rough', 'pencil'] as const) {
      if (!kinds.includes(stage)) {
        expectStageStated(stage, result.notes, result.unplanned);
      }
    }
    if (tree.rims.length > 0) expect(kinds).toContain('chamfer');
    // THE FREEING CUT IS LAST: nothing cuts a part the contour has just released.
    expect(kinds[kinds.length - 1]).toBe('contour');
    expect(result.programs.size).toBeGreaterThan(0);
    const ctx: PostContext = {
      jobName: 'tray-tree', stock: { length: 110, width: 140, thickness: 27.2 },
      materialName: 'hardwood', zDatum: 'probed-top-face', origin: 'topFrontLeft',
      camVersion: 'test-959', toolKey: 'multi',
    };
    for (const [key, ir] of result.programs) {
      const text = postedTextFor(key, ir, ctx);
      expect(text.length, `${key} posted no text`).toBeGreaterThan(100);
    }
    console.log(`whole tree: ${result.ops.length} ops (${[...new Set(kinds)].join(', ')}), ${result.programs.size} programs, rims ${tree.rims.length}, remainder ${tree.remainder.length}`);
  }, 900_000);
});
/**
 * #989 — THE TRAY THROUGH THE APP PATH. `generateGoalProgram` is the entry the app calls for a
 * goal job; the cards above pass `edgeBreak` to `planModelCam` directly, which is the
 * spec-vs-app divergence #985 named. The tray target here carries its own `chamfer` (width
 * `EDGE_BREAK_LEG_MM` on the vendor's 90° V), so the seam must derive `legMm` and pin that V —
 * and the posted run must carry the V's chamfer program. Before #989 the seam handed
 * `legMm: 0` and a real app tray job lost the chamfer the cards show.
 * The #966 setups override is the card's own single setup, so this measures the seam's
 * edge-break fields alone, not the setup decision.
 */
describe.skipIf(TRAY !== undefined || ORGANIZER !== undefined)('#959 acceptance — not run', () => {
  it('states why: needs CM_959_TRAY_STEP / CM_959_ORGANIZER_STEP (the licensed Makerables STEPs, on dave-1)', () => {
    expect(TRAY ?? ORGANIZER).toBeUndefined();
  });
});

describe('#964 harness self-tests — the defects that consumed engine rounds', () => {
  // RUNSOF. The harness once re-derived "runs" from `setup.ops` (the region-by-region REPORTING
  // order). Since `batchSameCutterRuns`, a plan's own posted programs group the same cutter's ops,
  // so an alternating A/B/A/B reporting order posts as TWO runs. Deriving runs from `ops` counted
  // four, inflating the bit-change count and the cycle line. `runsOf` reads `SetupPlan.programs`
  // (the execution order) and this case fails if that ever changes back.
  it('runsOf is the plan’s posted programs, never the un-batched reporting order', () => {
    const ir = (cutter: string): ToolpathIR => ({ tool: { id: cutter, name: cutter } }) as unknown as ToolpathIR;
    const alternatingOps = ['A', 'B', 'A', 'B'].map((cutter) => ({
      kind: 'pocket',
      outcome: { cutter },
    }));
    const setup = {
      ops: alternatingOps,
      programs: [ir('A'), ir('B')],
    } as unknown as SetupPlan;
    expect(runsOf(setup).map((run) => run.cutterKey)).toEqual(['A', 'B']);
    expect(runsOf(setup)).toHaveLength(setup.programs.length);
    expect(runsOf(setup).map((run) => run.ir)).toEqual(setup.programs);
  });

  // THE V GATE (#948/v4). A card that states an edge break must hand the check an allowance that
  // names the job's chamfer tool number; without it `checkGoalCutInto` silently takes the
  // geometry-only path and the card measures a different rule from the one it reports. This case
  // fails if the V bit has no number or the allowance drops it.
  it('a card with a stated edge break never builds its allowance without the V tool number', () => {
    expect(EDGE_BREAK_LEG_MM, 'this card states an edge break').toBeGreaterThan(0);
    expect(CHAMFER3175.number ?? null, 'the V bit must state its tool number').not.toBeNull();
    const allowance = edgeBreakAllowance();
    expect(allowance.edgeBreak, 'a stated edge break must produce an allowance').toBeDefined();
    expect(
      allowance.edgeBreak?.toolNumber,
      'the allowance must name the V bit — without it the v4 who gate is off and the card measures the geometry-only rule',
    ).toBe(CHAMFER3175.number);
  });
});

describe.skipIf(CATALOGUE.installed || CATALOGUE.optedOut)('#964 — the catalogue default (the maintainer’s 11-05 order)', () => {
  it('FAILS when the licensed STEPs are set and the full catalogue is missing with no opt-out', () => {
    // The door is the DEFAULT of every acceptance run: a machine with the STEPs set must either
    // find the catalogue or state CM_NO_CATALOGUE. Skipping the real parts here would look green.
    if (TRAY === undefined && ORGANIZER === undefined) return; // no STEPs: the not-run case covers it
    throw new Error(
      `the acceptance did not run its real parts: no full Makera catalogue was found and no opt-out was stated — ${CATALOGUE.note}`,
    );
  });
});

// #959 integration — THE CURVED PIPELINE'S EVERY OP, entered here in the same commit that wired it
// into `plan.ts` (the manager's rule after E's a46f0358 run). A ramp is the remainder region: the
// flat roughs it, the ball runs one final level, the pencil follows its (nonexistent) creases
// without posting a cut, the V breaks the tree's rim — and with a rest flat offered, the rest pass
// joins before the ball.
describe('#959 acceptance — the curved pipeline (every op entered)', () => {
  /** A plane z = slope * x over the region, margin-extended so the drop-cutter sees no edge. */
  function rampGeometry(slope: number): { geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } }; footprint: Polygons } {
    const x0 = -10, x1 = 50, y0 = -20, y1 = 20;
    const z0 = slope * x0, z1 = slope * x1;
    return {
      geometry: {
        triangles: {
          positions: Float32Array.from([x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0]),
          indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
          triangleCount: 2,
          bbox: { min: [x0, y0, Math.min(z0, z1)], max: [x1, y1, Math.max(z0, z1)] },
        },
      },
      footprint: [[[2, -12], [42, -12], [42, 12], [2, 12]]],
    };
  }

  it('roughs, optionally rests, finishes one level, pencils, and breaks the rim', async () => {
    const { planCurvedForTree } = await import('@/engine/cnc/cam/model/plan');
    // The slope is steep enough that the smaller rest flat has REAL work: the two flats' CL
    // surfaces differ by tan(theta) x (R6 - R3.175) = 0.5 x 1.41 = 0.71 mm on this ramp, above the
    // 0.3 mm band — at 0.2 it was 0.28 mm and the rest was right to find nothing (the restored
    // assertion asks for a fixture that gives it something to cut, not a weaker assertion).
    // Slope 0.4 across the footprint's 40 mm spans Z 0 to −16, and the tree's own Z range is the
    // ramp's: the rest pass masks by Z LEVEL, and a region that stops at −8 cannot see a band that
    // lies below it (at 0.2 the two flats' CL difference, 0.28 mm, is under the 0.3 band too — the
    // fixture has to ask the rest to have work, not the assertion be weakened for it).
    const { geometry, footprint } = rampGeometry(-0.4);
    const rim = { id: 'rim-1', polyline: [[[2, -12], [42, -12], [42, 12], [2, 12], [2, -12]] as [number, number][]][0]!, z: 0, of: 'contour' as const, kind: 'sharp' as const };
    const tree: FeatureTree = {
      frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -16 },
      levels: [-16],
      top: { z: 0, floors: [], area: 0 },
      contour: { outline: footprint, area: 800, zTo: -16, frees: true, shoulders: [] },
      pockets: [],
      rims: [rim],
      remainder: [{
        id: 'scoop', footprint, area: 800, zTop: 0, zBottom: -16,
        triangles: new Uint32Array(), slopeDeg: [0, 22], slopeMedianDeg: 20, in: 'top',
      }],
      unreachable: [],
      report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 800, tolerances: {} as never, slivers: [], notes: [] },
    };
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
    const ball = flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6', shape: 'ball', typeText: 'Ball End', fluteLength: 30 });
    const small = flatEndMill(3.175, { number: 3, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 });
    const vbit = flatEndMill(3.175, { number: 4, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1, fluteLength: 30 });
    const base = {
      geometry, offset: makeClipperOffset(tl),
      flat, ball, vbit,
      stepDownMm: 1.5, bandMm: 0.3, stepOverMm: 3,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: Z1.rapidEstimate, spindleRpm: 12000, air: true, safeZMm: 10, hopZMm: 3,
      edgeBreak: { legMm: 0.5 },
      toolNumberFor: (t: Tool) => (t.number ?? 1),
    };
    const noRest = planCurvedForTree(tree, base);
    // A STAGE THAT FINDS NOTHING IS DROPPED WITH A NOTE (#964): an op with no moves is not a
    // program — `postZ1` refuses one — so the pipeline states it instead of posting an empty file.
    // The ramp has no crease on the ball's own CL, so the pencil is the stage that says so here.
    const noRestKinds = noRest.ops.map((o) => o.kind);
    for (const stage of ['rough', 'finish'] as const) expect(noRestKinds).toContain(stage);
    // THE COVERED-RIM RULE (#959): this fixture's rim sits at the edge of a plane that CONTINUES
    // beyond it (its mesh was margin-extended so the drop-cutter sees no edge) — there is no drop
    // on its air side, so it is exactly a rim the rule says not to break, and the plan states it.
    // The chamfer's real cut lives on the tray/organizer cases, real parts with real edges.
    if (noRestKinds.includes('chamfer')) {
      expect(noRest.notes.join(' ')).not.toContain('rim "rim-1" not broken');
    } else {
      expect(noRest.notes.join(' '), 'the rim was skipped without a note').toContain('rim "rim-1" not broken: covered from above');
    }
    for (const op of noRest.ops) {
      expect(op.outcome.ir.operations[0]!.moves.length, `${op.kind} posted no moves`).toBeGreaterThan(0);
    }
    if (!noRestKinds.includes('pencil')) {
      expectStageStated('pencil', noRest.notes, noRest.unplanned);
    }
    const chamferOp = noRest.ops.find((o) => o.kind === 'chamfer');
    if (chamferOp !== undefined) {
      const chamferZ = chamferOp.outcome.ir.operations[0]!.moves.filter((m) => m.kind === 'feed').map((m) => m.z);
      expect(Math.min(...chamferZ)).toBeCloseTo(-0.5, 6);
    }

    const withRest = planCurvedForTree(tree, { ...base, restFlat: small });
    const withRestKinds = withRest.ops.map((o) => o.kind);
    for (const stage of ['rough', 'finish'] as const) expect(withRestKinds).toContain(stage);
    if (!withRestKinds.includes('pencil')) {
      expectStageStated('pencil', withRest.notes, withRest.unplanned);
    }
    if (!withRestKinds.includes('rest')) {
      expectStageStated('rest', withRest.notes, withRest.unplanned);
    }
    expect(withRest.notes.join(' ')).toContain('curved pipeline follows the ruling');
  }, 120_000);
});

// #960 — THE MANAGER'S PRICED ACCEPTANCE (2026-11-05): the ball's per-band scallop spacing, up to
// the vendor's ~0.8 mm, with the origin row kept and the rows phased from that same origin. The
// acceptance is the CARD'S LINES, not per-cell identity: tray coverage ≥ 98.52 %, organizer
// ≥ 98.98 % − 1 point, cut-into no worse than the base, and any risen cell must sit WITHIN the
// 0.1 mm band (no new cell above it). Two runs' own programs stamped onto the same goal grid by
// `tests/tools/acceptancePics.ts`; `tests/tools/risen-cells-960.ts` draws where they rise.
//
//   CM_960_BEFORE_PICS=<dir> CM_960_AFTER_PICS=<dir> \
//     npx vitest run tests/unit/opsAcceptance959.spec.ts -t '#960'
//
// Each dir is one `acceptancePics.ts` output root (`<card>/grid.json|goal.f32|union.f32`), with the
// acceptance's own `<card>-posted-facts.json` beside the card dir (coverage, cut-into, cycle).
const BEFORE_PICS = process.env.CM_960_BEFORE_PICS;
const AFTER_PICS = process.env.CM_960_AFTER_PICS;
/** The coverage band the leftover line uses, mm — a risen cell at or under this is still "covered". */
const LEFT_OVER_BAND_MM = 0.1;

describe.skipIf(BEFORE_PICS === undefined || AFTER_PICS === undefined)('#960 — the card’s lines, measured on the real parts', () => {
  const readCard = (root: string, card: string) => {
    const grid = JSON.parse(fs.readFileSync(path.join(root, card, 'grid.json'), 'utf8')) as { nx: number; ny: number; x0: number; y0: number; pitch: number };
    const f32 = (name: string): Float32Array => {
      const b = fs.readFileSync(path.join(root, card, name));
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const facts = JSON.parse(fs.readFileSync(path.join(root, `${card}-posted-facts.json`), 'utf8')) as {
      cycleSeconds: number;
      coverage: number;
      cutInto: { adjudicatedFraction: number; maxMm: number };
    };
    return { grid, goal: f32('goal.f32'), union: f32('union.f32'), facts };
  };
  // The card's coverage lines: the tray must stay ≥ 98.52 %; the organizer is within one point of
  // the vendor's 98.98 %.
  const COVERAGE_FLOOR: Record<string, number> = { tray: 0.9852, organizer: 0.9798 };
  for (const card of ['tray', 'organizer']) {
    it(`${card}: coverage ≥ ${(COVERAGE_FLOOR[card]! * 100).toFixed(2)} %, cut-into no worse, no risen cell above the band`, () => {
      const before = readCard(BEFORE_PICS!, card);
      const after = readCard(AFTER_PICS!, card);
      expect(after.grid, 'the two runs were not measured on the same goal grid').toEqual(before.grid);
      expect(after.goal, 'the goal fields differ — not the same STEP, sampler and placement').toEqual(before.goal);
      let risen = 0;
      let aboveBand = 0;
      let worstRise = 0;
      let worstLeftover = 0;
      let worstAt = '';
      for (let k = 0; k < before.goal.length; k++) {
        // Leftover is the swept surface standing ABOVE the goal (designCheck's own sign: d = top - goal).
        const base = Math.max(0, before.union[k]! - before.goal[k]!);
        const now = Math.max(0, after.union[k]! - after.goal[k]!);
        if (now > base + 1e-6) {
          risen++;
          if (now > worstLeftover) worstLeftover = now;
          if (now - base > worstRise) {
            worstRise = now - base;
            const i = k % before.grid.nx;
            const j = Math.floor(k / before.grid.nx);
            worstAt = `(${(before.grid.x0 + i * before.grid.pitch).toFixed(1)}, ${(before.grid.y0 + j * before.grid.pitch).toFixed(1)})`;
          }
          // 'Newly above' — the cell was within the band and is now above it. A pre-existing
          // residue that rises by a hair is not the rule's failure.
          if (now > LEFT_OVER_BAND_MM + 1e-6 && base <= LEFT_OVER_BAND_MM + 1e-6) aboveBand++;
        }
      }
      console.log(
        `#960 ${card}: coverage ${(before.facts.coverage * 100).toFixed(2)} % → ${(after.facts.coverage * 100).toFixed(2)} %` +
          `; cycle ${before.facts.cycleSeconds.toFixed(1)} s → ${after.facts.cycleSeconds.toFixed(1)} s` +
          `; cut-into adjudicated ${(before.facts.cutInto.adjudicatedFraction * 100).toFixed(2)} % → ${(after.facts.cutInto.adjudicatedFraction * 100).toFixed(2)} %` +
          `; ${risen} risen cell(s), worst +${worstRise.toFixed(3)} mm at ${worstAt || '—'}, highest risen leftover ${worstLeftover.toFixed(3)} mm` +
          `, above the ${LEFT_OVER_BAND_MM} mm band: ${aboveBand}`,
      );
      expect(after.facts.coverage, 'the card’s coverage line').toBeGreaterThanOrEqual(COVERAGE_FLOOR[card]!);
      expect(after.facts.cutInto.adjudicatedFraction, 'cut-into rose above the base run').toBeLessThanOrEqual(before.facts.cutInto.adjudicatedFraction + 1e-9);
      expect(aboveBand, `a risen cell stands above the ${LEFT_OVER_BAND_MM} mm band`).toBe(0);
    });
  }
});
