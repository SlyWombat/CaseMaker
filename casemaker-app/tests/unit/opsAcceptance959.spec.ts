/**
 * #959 acceptance on the Makerables reference parts — gated on env vars, same pattern as A's
 * #958 (`featureAcceptance958.spec.ts`):
 *
 *   CM_959_TRAY_STEP=…/modular-stackable-tool-trays/<tray 70>.step \
 *   CM_959_ORGANIZER_STEP=…/makera-tool-organizer/<organizer>.step \
 *   CM_959_OUT=…/959-acceptance/ \
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
 * resulting program(s) with the existing Z1 post (`postZ1`), and measures cycle/air/rapids/cutters
 * from the posted text (`measurePostedProgram`, `tests/tools/postedFacts.ts`) — the four of the
 * seven lines that need only the posted `.nc`, not the simulator. **Coverage and cut-into are NOT
 * reported here**: those two need a goal-check sweep against the posted program
 * (`measurePageCard`'s `goalcheck.json`), which needs the simulator run on this engine's output —
 * not built yet, named as the next integration point rather than faked. Rough/rest are not in this
 * program either, so the cycle number is a LOWER BOUND on the real one, not a comparable total —
 * printed as such, never asserted against Makera's 47.6 min.
 *
 * `planPocketsForTree`'s cutter choice IS #961's real sequence now (`chooseSequence`'s rest chain,
 * `maxCutters` = the vendor's own reference-set count + 1, `cutters.house` = that same set — A's R5
 * ruling: "a simulation-only reference card prices on the VENDOR's own set"). A feature no cutter
 * in that budget covers is `result.unreachable`, stated by name, never a silent skip or a shrunk
 * primary.
 *
 * With `CM_959_OUT` set, writes `plan.json` (a partial `ModelPlanOutput`, pocket+contour ops only)
 * for F's `modelGolden.spec.ts` validator to check the shape against, and
 * `<name>-posted-facts.json` with the measured numbers for the manager/E to read off a real run.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { measurePostedProgram, combinePostedFacts } from '../tools/postedFacts';
import { planPocketsForTree, type PlanPocketsResult, type SetupPlan } from '@/engine/cnc/cam/model/plan';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import type { Polygons } from '@/engine/cnc/cam/pocket';

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

async function placedTree(file: string, stock: [number, number], modelTop: number): Promise<{ tree: FeatureTree; mesh: { positions: Float32Array; indices: Uint32Array } }> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
  const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
  const dz = modelTop - max[2];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  const mesh = { ...read.mesh, positions };
  const tree = recogniseFeatures({ triangles: mesh, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
  return { tree, mesh: { positions, indices: read.mesh.indices } };
}

// Makera's own pattern on these parts (plan v2 §1): the largest flat roughs, a smaller flat rests
// the corners it cannot enter. A's R5 ruling: a simulation-only reference card prices on the
// VENDOR's own set.
const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const VENDOR_SET = [FLAT6, FLAT3175];
const RAPID = Z1.rapidEstimate;

function planTray(tree: FeatureTree): PlanPocketsResult {
  return planPocketsForTree(tree, {
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

function postedTextFor(cutterKey: string, merged: ToolpathIR, ctx: PostContext): string {
  const posted = postZ1(merged, ctx, Z1);
  if (!posted.ok) throw new Error(`#959 ${cutterKey}: postZ1 refused — ${posted.errors.join('; ')}`);
  return posted.text;
}

function writeAcceptance(name: string, tree: FeatureTree, result: PlanPocketsResult): void {
  const { ops, programs, sequence, unreachable, notes } = result;

  const ctx: PostContext = {
    jobName: `${name}-959`,
    // The TRUE stock thickness — `partTop - partBottom` undercounts by any skin between the
    // stock's own top and the recognised part top (advisor's review on 108e120c): the contour now
    // correctly cuts to `stockTop - zTo`, deeper than a `partTop`-based thickness would state.
    stock: { length: 0, width: 0, thickness: tree.frame.stockTop - tree.frame.partBottom },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-959',
    toolKey: 'multi',
  };

  // One posted text per RUN (not per cutter key — advisor's review on ab6b2827: a cutter #961
  // returns to for the freeing cut posts as its OWN run, never merged into its first one).
  const factsByRun = programs.map((run) => ({
    cutterKey: run.cutterKey,
    merged: run.ir,
    text: postedTextFor(run.cutterKey, run.ir, ctx),
  }));
  const facts = combinePostedFacts(factsByRun.map((f) => measurePostedProgram(f.text)));

  const pocketOps = ops.filter((op) => op.kind === 'pocket').length;
  const contourOps = ops.filter((op) => op.kind === 'contour').length;
  console.log(
    `#959 ${name}: ${pocketOps} pocket + ${contourOps} contour op(s) planned (${unreachable.length} ` +
      `unreachable: ${unreachable.join('; ') || 'none'}), ${programs.length} run(s) on ${new Set(programs.map((p) => p.cutterKey)).size} cutter(s). Posted-text facts ` +
      `(pocket + contour ONLY — not comparable to Makera's full cycle): cycle ` +
      `${facts.cycleSeconds.toFixed(1)} s, air ${(facts.airFraction * 100).toFixed(1)} %, ` +
      `rapids/1000 ${facts.rapidsPer1000FeedLines.toFixed(0)}, cutters ${facts.cutters.length}. ` +
      `Coverage/cut-into: not measured here — needs the simulator sweep (next integration point).` +
      (notes.length > 0 ? ` Notes: ${notes.join('; ')}` : ''),
  );

  const out = process.env.CM_959_OUT;
  if (out === undefined) return;
  fs.mkdirSync(out, { recursive: true });

  const plan: { perSetup: Partial<SetupPlan>[] } = {
    perSetup: [
      {
        setupIndex: 0,
        features: tree,
        clGrid: [],
        ops,
        sequence,
        linking: { rapidsCount: 0, hopsCount: 0, airFractionPct: facts.airFraction * 100 },
        programs: factsByRun.map((f) => f.merged),
        totalCostSeconds: facts.cycleSeconds,
      },
    ],
  };
  fs.writeFileSync(path.join(out, `${name}-plan.json`), JSON.stringify(plan));
  fs.writeFileSync(
    path.join(out, `${name}-posted-facts.json`),
    JSON.stringify({ unreachable, notes, cutterKeys: programs.map((p) => p.cutterKey), pocketOps, contourOps, ...facts }),
  );
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

describe('#959 opsAcceptance plumbing (no STEP needed)', () => {
  it('a region that fails to plan does not crash the whole plan — it is a named finding, the rest still posts', () => {
    const tree = syntheticTreeTwoPockets();
    const result = planPocketsForTree(tree, {
      offset: offsetThrowingFor(7, makeClipperOffset(tl)),
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
    expect(result.notes.some((n) => n.startsWith('bad-1:') && n.includes('not cut')), `notes: ${result.notes.join('; ')}`).toBe(true);
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


  it('a skin between the stock top and the part top is faced by the pocket, and the contour still reaches the full depth down from the STOCK top', () => {
    const tree = syntheticTreeWithSkin(1.2);
    const result = planTray(tree);
    const contourResult = result.ops.find((op) => op.kind === 'contour')!;
    const deepestContourZ = Math.min(
      ...contourResult.outcome.ir.operations.flatMap((o) => o.moves.map((m) => m.z)),
    );
    // -4.2 (zTo, already expressed relative to the stock top): the old `partTop - zTo` depth
    // (3, not 4.2) stopped the contour 1.2 mm short of the real floor.
    expect(deepestContourZ).toBeCloseTo(tree.contour.zTo, 6);
    // By region id, not kind: facing is ALSO a 'pocket'-kind op now (it covers the whole
    // outline, not just `top.floors`' own leftover land — advisor's review on 9a5cc607), and
    // this fixture's skin means facing exists here too, even though it has no separate land.
    const pocketResult = result.ops.find((op) => op.region.id === 'synthetic-1')!;
    // depth = stockTop(0) - floorZ(-4.2) = 4.2, not partTop(-1.2) - floorZ(-4.2) = 3: the root
    // pocket's own first pass now faces the skin instead of engaging 1.2 mm deeper than planned.
    expect(pocketResult.outcome.ir.operations[0]!.depth).toBeCloseTo(4.2, 6);
    // Advisor's review on 108e120c: this is the FIRST time a program deeper than `partTop -
    // partBottom` (3) is actually posted — `postZ1` must accept the real 4.2 mm cut, not just
    // plan it. A refusal here (a stock/depth mismatch, say) is exactly E's condition on both the
    // tray and the organizer, so it must be caught here, not on dave-1.
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
    const pocketOp = result.ops.find((op) => op.region.id === 'p')!;
    expect(pocketOp.outcome.ir.operations[0]!.depth).toBeCloseTo(4.2, 6);
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

  // The manager's #959 ruling: facing must not re-sweep a pocket's own deep interior — a root
  // pocket's own first pass already engages it from the stock top, so facing it again is pure
  // waste (E's organizer run on b37d6356: the facing pass alone cost 5,034 s, 24 % of why the
  // part came in at 2.15x Makera, over the <= 2x line).
  it('facing excludes a pocket big enough to erode cleanly — not re-sweeping what the pocket already removes', () => {
    const { tree } = syntheticTreeFacingCoverage(1.2);
    const result = planTray(tree);
    const facing = result.ops.find((op) => op.region.id === 'facing')!;
    expect(facing, 'facing is planned').toBeDefined();
    // Pocket B spans (21,2)-(38,18): deep centre (29.5, 10) is 8+ mm from every wall, well past
    // any cutter's own 2r exclusion margin (2 x 3 = 6 for a ⌀6 flat, 2 x 1.5875 = 3.175 for ⌀3.175).
    const deepInB: [number, number] = [29.5, 10];
    const moves = facing.outcome.ir.operations.flatMap((o) => o.moves);
    const nearDeepPoint = moves.some((m) => m.x !== undefined && m.y !== undefined && Math.hypot(m.x - deepInB[0], m.y - deepInB[1]) < 1);
    expect(nearDeepPoint, 'a facing move swept deep inside pocket B, which its own first pass already removes').toBe(false);
  });

  // The same exclusion, but for a pocket SMALLER than 2 cutter radii — erode(pocket, 2r) is
  // empty, so excluding `eroded` alone would exclude nothing and face the whole small pocket
  // anyway. The fallback must exclude the pocket's own RAW region instead.
  it('facing excludes a pocket TOO SMALL to erode by 2r — the fallback excludes the raw region, not nothing', () => {
    const tree = syntheticTreeWithLand(1.2); // the 10x10 pocket: erode(10x10, 6) for a ⌀6 flat is empty
    const result = planTray(tree);
    const facing = result.ops.find((op) => op.region.id === 'facing')!;
    expect(facing, 'facing is planned').toBeDefined();
    const deepInPocket: [number, number] = [5, 5]; // the small pocket's own centre
    const moves = facing.outcome.ir.operations.flatMap((o) => o.moves);
    const nearDeepPoint = moves.some((m) => m.x !== undefined && m.y !== undefined && Math.hypot(m.x - deepInPocket[0], m.y - deepInPocket[1]) < 1);
    expect(nearDeepPoint, 'a facing move swept the small pocket\'s own centre, which its own first pass already removes').toBe(false);
  });

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
    expect(pocketOp?.outcome.cutter).toBe('flat-3.175');
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

describe.skipIf(TRAY === undefined)('#959 acceptance — tool tray 70, pocket + contour', () => {
  it('plans and posts every non-through floored pocket and the outer contour, cycle/air/rapids/cutters measured from the posted text', async () => {
    const { tree } = await placedTree(TRAY!, [110, 140], -1.2);
    const result = planTray(tree);
    expect(result.ops.length, `unreachable: ${result.unreachable.join('; ')}`).toBeGreaterThan(0);
    expect(result.ops.some((op) => op.kind === 'contour'), `unreachable: ${result.unreachable.join('; ')}`).toBe(true);
    writeAcceptance('tray', tree, result);
  });
});

describe.skipIf(ORGANIZER === undefined)('#959 acceptance — tool organizer, pocket + contour', () => {
  it('plans and posts every non-through floored pocket and the outer contour, cycle/air/rapids/cutters measured from the posted text', async () => {
    const { tree } = await placedTree(ORGANIZER!, [170, 170], -0.8);
    const result = planTray(tree);
    expect(result.ops.length, `unreachable: ${result.unreachable.join('; ')}`).toBeGreaterThan(0);
    expect(result.ops.some((op) => op.kind === 'contour'), `unreachable: ${result.unreachable.join('; ')}`).toBe(true);
    writeAcceptance('organizer', tree, result);
  });
});

describe.skipIf(TRAY !== undefined || ORGANIZER !== undefined)('#959 acceptance — not run', () => {
  it('states why: needs CM_959_TRAY_STEP / CM_959_ORGANIZER_STEP (the licensed Makerables STEPs, on dave-1)', () => {
    expect(TRAY ?? ORGANIZER).toBeUndefined();
  });
});
