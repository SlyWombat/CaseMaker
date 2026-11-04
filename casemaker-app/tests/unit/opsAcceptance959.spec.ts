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
 * rest); as of this commit only `pocket` is real (`cam/model/ops/pocket.ts`). This spec runs every
 * non-through `PocketNode` with floors through it, posts the resulting program(s) with the
 * existing Z1 post (`postZ1`), and measures cycle/air/rapids/cutters from the posted text
 * (`measurePostedProgram`, `tests/tools/postedFacts.ts`) — the four of the seven lines that need
 * only the posted `.nc`, not the simulator. **Coverage and cut-into are NOT reported here**: those
 * two need a goal-check sweep against the posted program (`measurePageCard`'s `goalcheck.json`),
 * which needs the simulator run on this engine's output — not built yet, named as the next
 * integration point rather than faked. Contour/rough/rest are not in this program either, so the
 * cycle number is a LOWER BOUND on the real one, not a comparable total — printed as such, never
 * asserted against Makera's 47.6 min.
 *
 * With `CM_959_OUT` set, writes `plan.json` (a partial `ModelPlanOutput`, pocket ops only) for
 * F's `modelGolden.spec.ts` validator to check the shape against, and `<name>-posted-facts.json`
 * with the measured numbers for the manager/E to read off a real run.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, regionRefs, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import { pocket } from '@/engine/cnc/cam/model/ops/pocket';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { concatToolpathIR, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { measurePostedProgram, combinePostedFacts } from '../tools/postedFacts';
import type { PlannedOp, SetupPlan } from '@/engine/cnc/cam/model/plan';

const all = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);

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

const RAPID = Z1.rapidEstimate;

/** A conventional roughing step-over: half the cutter's radius, never past `pocketLoops`' own ceiling (the full radius). */
function stepOverFor(cutter: { diameter: number | null; tipDiameter: number | null }): number {
  const diameter = cutter.diameter ?? cutter.tipDiameter ?? 0;
  const radius = diameter / 2;
  return Math.min(radius * 0.5, radius);
}

/**
 * Every non-through floored pocket, cut with #961's own rule (the largest flat that fits, a
 * smaller one only when a node's narrowest corner needs it — simplified here to "fits or not",
 * since #961's real picker is C's `sequence.ts`, not re-implemented in this spec).
 *
 * E's run on 9421a64b found two defects here, both fixed: (1) a fixed `stepOverMm` was handed to
 * every cutter regardless of its own radius — ⌀3.175's 1.5875 mm radius crashed on a step-over
 * sized for ⌀6. The step-over is now `stepOverFor(cutter)`, computed from the cutter actually
 * assigned. (2) A node too narrow for every candidate cutter was a silent array push; it is now a
 * stated finding in the exact words E asked for, so a reader (or #961's real sequencing, later)
 * knows the limiting number, not just that something was skipped.
 */
function planPockets(tree: FeatureTree, stepDownMm: number): { plans: { node: PocketNode; outcome: ReturnType<typeof pocket> }[]; skipped: string[] } {
  const offset = makeClipperOffset(tl);
  const refs = regionRefs(tree);
  const plans: { node: PocketNode; outcome: ReturnType<typeof pocket> }[] = [];
  const skipped: string[] = [];
  for (const node of all(tree.pockets)) {
    if (node.through || node.floors.length === 0) continue;
    const ref = refs.find((r) => r.id === node.id);
    if (ref === undefined) { skipped.push(`${node.id}: no RegionRef`); continue; }
    const cutter = node.narrowest >= 6 ? FLAT6 : node.narrowest >= 3.175 ? FLAT3175 : null;
    if (cutter === null) {
      // The finding #961's real sequencing reads: a smaller flat, in the house or the catalogue
      // (A's R5), is what resolves this — not this spec's job to invent one.
      skipped.push(`${node.id}: not cut — needs a cutter ≤ ${node.narrowest.toFixed(2)} mm (house offers ⌀6, ⌀3.175)`);
      continue;
    }
    const outcome = pocket({
      cutter,
      node,
      region: { ...ref, obstacles: [], regionClearanceZ: tree.frame.partTop + 5 },
      stepOverMm: stepOverFor(cutter),
      stepDownMm,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset,
      safeZMm: tree.frame.partTop + 10,
      hopZMm: tree.frame.partTop + 3,
      toolNumber: cutter.number ?? 1,
      spindleRpm: 12000,
      air: true,
      rapid: RAPID,
    });
    plans.push({ node, outcome });
  }
  return { plans, skipped };
}

function mergedProgramFor(outcomes: readonly ToolpathIR[]): ToolpathIR {
  return outcomes.reduce((a, b) => concatToolpathIR(a, b));
}

function postedTextFor(cutterKey: string, merged: ToolpathIR, ctx: PostContext): string {
  const posted = postZ1(merged, ctx, Z1);
  if (!posted.ok) throw new Error(`#959 ${cutterKey}: postZ1 refused — ${posted.errors.join('; ')}`);
  return posted.text;
}

function writeAcceptance(name: string, tree: FeatureTree, plans: { node: PocketNode; outcome: ReturnType<typeof pocket> }[], skipped: string[]): void {
  const byCutter = new Map<string, ToolpathIR[]>();
  for (const { outcome } of plans) byCutter.set(outcome.cutter, [...(byCutter.get(outcome.cutter) ?? []), outcome.ir]);

  const ctx: PostContext = {
    jobName: `${name}-959`,
    stock: { length: 0, width: 0, thickness: tree.frame.partTop - tree.frame.partBottom },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-959',
    toolKey: 'multi',
  };

  const factsByCutter = [...byCutter.entries()].map(([cutterKey, irs]) => {
    const merged = mergedProgramFor(irs);
    return { cutterKey, merged, text: postedTextFor(cutterKey, merged, ctx) };
  });
  const facts = combinePostedFacts(factsByCutter.map((f) => measurePostedProgram(f.text)));

  console.log(
    `#959 ${name}: ${plans.length} pocket node(s) planned (${skipped.length} skipped: ${skipped.join('; ') || 'none'}), ` +
      `${byCutter.size} cutter(s). Posted-text facts (pocket ONLY — not comparable to Makera's full ` +
      `cycle): cycle ${facts.cycleSeconds.toFixed(1)} s, air ${(facts.airFraction * 100).toFixed(1)} %, ` +
      `rapids/1000 ${facts.rapidsPer1000FeedLines.toFixed(0)}, cutters ${facts.cutters.length}. ` +
      `Coverage/cut-into: not measured here — needs the simulator sweep (next integration point).`,
  );

  const out = process.env.CM_959_OUT;
  if (out === undefined) return;
  fs.mkdirSync(out, { recursive: true });

  const ops: PlannedOp[] = plans.map(({ node, outcome }) => ({
    kind: 'pocket',
    region: { id: node.id, kind: 'pocket', bounds: { min: [0, 0], max: [0, 0] }, topZ: node.mouthZ, bottomZ: node.floorZ, obstacles: [], regionClearanceZ: tree.frame.partTop + 5 },
    outcome,
  }));
  const plan: { perSetup: Partial<SetupPlan>[] } = {
    perSetup: [
      {
        setupIndex: 0,
        features: tree,
        clGrid: [],
        ops,
        sequence: [...byCutter.keys()].map((cutterKey) => ({
          cutterKey,
          cost: { terms: { movesSeconds: 0, entrySeconds: 0, spinUpSeconds: 0, totalSeconds: 0 }, toolChangeSeconds: 0, totalSeconds: 0 },
          pinned: false,
          house: true,
        })),
        linking: { rapidsCount: 0, hopsCount: 0, airFractionPct: facts.airFraction * 100 },
        programs: factsByCutter.map((f) => f.merged),
        totalCostSeconds: facts.cycleSeconds,
      },
    ],
  };
  fs.writeFileSync(path.join(out, `${name}-plan.json`), JSON.stringify(plan));
  fs.writeFileSync(
    path.join(out, `${name}-posted-facts.json`),
    JSON.stringify({ skipped, cutterKeys: [...byCutter.keys()], nodesPlanned: plans.length, ...facts }),
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

describe('#959 opsAcceptance plumbing (no STEP needed)', () => {
  it('plans, posts and measures a synthetic one-pocket tree end to end', () => {
    const tree = syntheticTree();
    const { plans, skipped } = planPockets(tree, 1.5);
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    writeAcceptance('synthetic', tree, plans, skipped);
  });

  // E's run on 9421a64b, regression 1: a node that only the SMALLER house flat fits used to crash
  // (stepOverFor was fixed at a value sized for ⌀6, handed to ⌀3.175 too).
  it('a node too narrow for the ⌀6 flat is cut with ⌀3.175, step-over scaled to ITS radius, not ⌀6’s', () => {
    const tree = syntheticTree(4); // < 6, so FLAT6 is excluded; ≥ 3.175, so FLAT3175 fits
    const { plans, skipped } = planPockets(tree, 1.5);
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.outcome.cutter).toBe('flat-3.175');
  });

  // E's run on 9421a64b, regression 2: a node too narrow for every house cutter is a stated
  // finding naming the limiting number, not a silent skip.
  it('a node too narrow for every house flat is a stated finding, not a silent skip', () => {
    const tree = syntheticTree(0.95);
    const { plans, skipped } = planPockets(tree, 1.5);
    expect(plans).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('not cut');
    expect(skipped[0]).toContain('0.95');
  });
});

const TRAY = process.env.CM_959_TRAY_STEP;
const ORGANIZER = process.env.CM_959_ORGANIZER_STEP;

describe.skipIf(TRAY === undefined)('#959 acceptance — tool tray 70, pocket op only', () => {
  it('plans and posts every non-through floored pocket, cycle/air/rapids/cutters measured from the posted text', async () => {
    const { tree } = await placedTree(TRAY!, [110, 140], -1.2);
    const { plans, skipped } = planPockets(tree, 1.5);
    expect(plans.length, `skipped: ${skipped.join('; ')}`).toBeGreaterThan(0);
    writeAcceptance('tray', tree, plans, skipped);
  });
});

describe.skipIf(ORGANIZER === undefined)('#959 acceptance — tool organizer, pocket op only', () => {
  it('plans and posts every non-through floored pocket, cycle/air/rapids/cutters measured from the posted text', async () => {
    const { tree } = await placedTree(ORGANIZER!, [170, 170], -0.8);
    const { plans, skipped } = planPockets(tree, 1.5);
    expect(plans.length, `skipped: ${skipped.join('; ')}`).toBeGreaterThan(0);
    writeAcceptance('organizer', tree, plans, skipped);
  });
});

describe.skipIf(TRAY !== undefined || ORGANIZER !== undefined)('#959 acceptance — not run', () => {
  it('states why: needs CM_959_TRAY_STEP / CM_959_ORGANIZER_STEP (the licensed Makerables STEPs, on dave-1)', () => {
    expect(TRAY ?? ORGANIZER).toBeUndefined();
  });
});
