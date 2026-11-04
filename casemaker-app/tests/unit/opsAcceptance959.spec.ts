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
  const { ops, programs, sequence, unreachable } = result;

  const ctx: PostContext = {
    jobName: `${name}-959`,
    stock: { length: 0, width: 0, thickness: tree.frame.partTop - tree.frame.partBottom },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-959',
    toolKey: 'multi',
  };

  const factsByCutter = [...programs.entries()].map(([cutterKey, merged]) => ({
    cutterKey,
    merged,
    text: postedTextFor(cutterKey, merged, ctx),
  }));
  const facts = combinePostedFacts(factsByCutter.map((f) => measurePostedProgram(f.text)));

  const pocketOps = ops.filter((op) => op.kind === 'pocket').length;
  const contourOps = ops.filter((op) => op.kind === 'contour').length;
  console.log(
    `#959 ${name}: ${pocketOps} pocket + ${contourOps} contour op(s) planned (${unreachable.length} ` +
      `unreachable: ${unreachable.join('; ') || 'none'}), ${programs.size} cutter(s). Posted-text facts ` +
      `(pocket + contour ONLY — not comparable to Makera's full cycle): cycle ` +
      `${facts.cycleSeconds.toFixed(1)} s, air ${(facts.airFraction * 100).toFixed(1)} %, ` +
      `rapids/1000 ${facts.rapidsPer1000FeedLines.toFixed(0)}, cutters ${facts.cutters.length}. ` +
      `Coverage/cut-into: not measured here — needs the simulator sweep (next integration point).`,
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
        programs: factsByCutter.map((f) => f.merged),
        totalCostSeconds: facts.cycleSeconds,
      },
    ],
  };
  fs.writeFileSync(path.join(out, `${name}-plan.json`), JSON.stringify(plan));
  fs.writeFileSync(
    path.join(out, `${name}-posted-facts.json`),
    JSON.stringify({ unreachable, cutterKeys: [...programs.keys()], pocketOps, contourOps, ...facts }),
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

describe('#959 opsAcceptance plumbing (no STEP needed)', () => {
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
    const pocketResult = result.ops.find((op) => op.kind === 'pocket')!;
    // depth = stockTop(0) - floorZ(-4.2) = 4.2, not partTop(-1.2) - floorZ(-4.2) = 3: the root
    // pocket's own first pass now faces the skin instead of engaging 1.2 mm deeper than planned.
    expect(pocketResult.outcome.ir.operations[0]!.depth).toBeCloseTo(4.2, 6);
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
