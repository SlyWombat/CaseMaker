/**
 * #1044 — A CANDIDATE WITH NO FEEDS LEAVES THE SET, STATED; THE PLAN IS NOT REFUSED FOR IT.
 *
 * The reference aluminium cards (ref-topclamp, ref-halfclamp, ref-accuracy) were refused with
 * "no feeds for 6*17mm Flat End(Metal) in aluminium-6061": `primary = flats[0]` — the largest
 * diameter — then `resolvedCutParams(primary)` throws before the search, and the whole plan dies
 * even though other ⌀6 flats in the library carry aluminium rows. The starting table has no
 * aluminium rows, so the proxy cannot answer for a cutter this catalogue lacks either. (The real
 * catalogue DOES carry a row for that cutter; the cards saw an empty realm snapshot — #1047.
 * This spec seeds its own catalogue, so "row-less" here means row-less in the rows it installs.)
 *
 * The rule: resolve every house candidate before the primary is chosen; an unfeedable cutter
 * leaves the candidate set with one stated line; the primary is the largest flat that remains;
 * only the caller's CHOSEN tool keeps the refusal (the operator's cutter cannot be fed), and a
 * set with nothing left refuses naming the material.
 *
 * RED at main: the row-less ⌀6 first in the house throws before the rowed ⌀6 is ever considered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { clearFeedCatalogue, setFeedCatalogue } from '@/engine/cnc/feeds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

const L = 60;
const W = 40;
const T = 5;
const POCKET = { x0: 20, x1: 40, y0: 10, y1: 30, depth: 2 };

function pocketBlock(): { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const M = tl.Manifold;
  let solid = M.cube([L, W, T], true).translate([L / 2, W / 2, -T / 2]);
  const voidBox = M.cube([POCKET.x1 - POCKET.x0, POCKET.y1 - POCKET.y0, POCKET.depth], true).translate([
    (POCKET.x0 + POCKET.x1) / 2,
    (POCKET.y0 + POCKET.y1) / 2,
    -POCKET.depth / 2,
  ]);
  solid = solid.subtract(voidBox);
  const mesh = solid.getMesh();
  const numProp = mesh.numProp;
  const numVert = mesh.vertProperties.length / numProp;
  const positions = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * numProp + k]!;
  }
  const indices = new Uint32Array(mesh.triVerts);
  solid.delete();
  return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [0, 0, -T], max: [L, W, 0] } };
}

/** The row-less cutter of the refusal: Makera's id, no aluminium row in the catalogue. */
const METAL6: Tool = flatEndMill(6, { id: '112111313812', name: '6*17mm Flat End(Metal)' });
/** The rowed twin: a ⌀6 flat with a hand-built aluminium catalogue row (the service's shape). */
const ROWED6: Tool = flatEndMill(6, { id: 'alu-6-rowed', name: '6 mm flat end (rowed)' });
const BALL6: Tool = { ...flatEndMill(6, { number: 9, id: 'alu-ball-6', name: '6 mm ball nose' }), shape: 'ball', typeText: 'Ball Nose' };
const VBIT: Tool = {
  ...flatEndMill(3.175, { number: 8, id: 'alu-v-3175', name: '3.175 mm 90° V' }),
  typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0.1, angle: 90, halfAngle: 45,
} as Tool;

beforeEach(() => {
  // One aluminium row, for ROWED6 only: hand-built in the service's shape (no Studio number).
  setFeedCatalogue([
    { cutterId: 'alu-6-rowed', material: '6061 Aluminum', rpm: 10000, feed: 900, plungeFeed: 250, stepDown: 0.5 },
    { cutterId: 'alu-ball-6', material: '6061 Aluminum', rpm: 12000, feed: 800, plungeFeed: 250, stepDown: 0.5 },
  ]);
});
afterEach(() => clearFeedCatalogue());

function targetFor(mesh: ReturnType<typeof pocketBlock>): EngraveTargetObject {
  const binary = ((): string => {
    const bytes = new Uint8Array(84 + mesh.triangleCount * 50);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(80, mesh.triangleCount, true);
    let off = 84;
    for (let t = 0; t < mesh.triangleCount; t++) {
      off += 12;
      for (let v = 0; v < 3; v++) {
        const i = mesh.indices[t * 3 + v]!;
        dv.setFloat32(off, mesh.positions[i * 3]!, true);
        dv.setFloat32(off + 4, mesh.positions[i * 3 + 1]!, true);
        dv.setFloat32(off + 8, mesh.positions[i * 3 + 2]!, true);
        off += 12;
      }
      dv.setUint16(off, 0, true);
      off += 2;
    }
    return Buffer.from(bytes).toString('base64');
  })();
  return {
    id: 'goal-1044', name: 'alu block', role: 'goal', enabled: true, format: 'stl',
    sha256: 'a'.repeat(64), data: binary,
    position: { x: L / 2, y: W / 2, z: 0 }, rotation: 0,
    size: { x: L, y: W, z: T },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function jobFor(target: EngraveTargetObject, material: EngraveJob['stock']['material'] = 'aluminium-6061'): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: L, width: W, thickness: 12, material },
  };
}

function shopWith(tools: Tool[]): EngraveShopOpts {
  return { tools: tools.map((tool, i) => ({ key: `probe:${i}`, tool, provenance: 'test' })), feeds: null };
}

async function inputFor(tools: Tool[], chosen: Tool): Promise<ModelPlanInput> {
  const target = targetFor(pocketBlock());
  return buildModelPlanInputForGoal(jobFor(target), target, chosen, shopWith(tools));
}

describe('#1044 a candidate with no feeds leaves the set, stated', () => {
  it('RED: the row-less ⌀6 first in the house no longer throws — the plan runs on the rowed ⌀6 and states it', async () => {
    const input = await inputFor([METAL6, ROWED6, BALL6, VBIT], BALL6);
    const plan = await planModelCam(input);
    const notes = plan.perSetup.at(-1)!.notes.join(' | ');
    expect(notes, 'the omitted cutter is not stated').toContain('6*17mm Flat End(Metal)');
    expect(notes).toContain('not a candidate');
    expect(notes).toContain('aluminium-6061');
    // The plan ran: a pocket op exists, and no op cut with the row-less flat.
    const ops = plan.perSetup.flatMap((s) => s.ops);
    expect(ops.some((op) => op.kind === 'pocket')).toBe(true);
    for (const op of ops) {
      expect(op.outcome.ir.tool, `${op.kind} ${op.region.id} took the row-less flat`).not.toBe(METAL6);
    }
  }, 180_000);

  it('the chosen tool that cannot be fed still refuses, by name and material', async () => {
    // The chosen flat is the house's only flat (so it WOULD be the primary): the exception keeps
    // it in the set, and its feeds resolution refuses exactly as today.
    const input = await inputFor([METAL6], METAL6);
    await expect(planModelCam(input)).rejects.toThrow(/no feeds for 6\*17mm Flat End\(Metal\) in aluminium-6061/);
  }, 180_000);

  it('the chosen cutter present as its own shop entry is matched by KEY, not object identity', async () => {
    // The seam de-duplicates the house by `cutterKeyOf`, so when the operator's cutter is also a
    // shop entry the house holds the ENTRY's object and the appended chosen tool is skipped; a
    // worker holds clones on top of that. With `tool === chosenTool` the exception never matched:
    // the unfeedable chosen cutter was silently DROPPED and the plan ran on the ball. It must
    // refuse by name instead.
    const entry = flatEndMill(6, { id: '112111313812', name: '6*17mm Flat End(Metal)' });
    const chosen = flatEndMill(6, { id: '112111313812', name: '6*17mm Flat End(Metal)' });
    expect(chosen, 'the case is vacuous if the two are the same object').not.toBe(entry);
    const input = await inputFor([entry, BALL6], chosen);
    await expect(planModelCam(input)).rejects.toThrow(/no feeds for 6\*17mm Flat End\(Metal\) in aluminium-6061/);
  }, 180_000);

  it('nothing remains: refuses naming the material', async () => {
    // The chosen V is kept (the caller's cutter); the only flat cannot be fed — no flat and no
    // ball remain, so the refusal names the material rather than the wrong candidate.
    const input = await inputFor([METAL6, VBIT], VBIT);
    await expect(planModelCam(input)).rejects.toThrow(/no cutter in the set has cutting parameters for aluminium-6061/);
  }, 180_000);
});

/**
 * #1062 defect 2 — THE #669 BODY PROXY HAS GEOMETRY AND NO IDENTITY.
 *
 * A corn-class cutter: ⌀0.6, below the hardwood table's 0.8 mm floor, carrying Makera's id whose
 * catalogue rows (for another material) state the same ⌀0.6. Its own feeds refuse on hardwood as
 * they always did, and #669's flat proxy at hardwood's largest covered row (3.2 mm) is what stands
 * in. The proxy used to carry the cutter's id, so #732 compared the 3.2 mm stand-in with the
 * 0.6 mm cutter the catalogue states, called it a different cutter and refused the substitution —
 * the candidate left the set with #1044's line, and on the M1 tray the V then took the two shallow
 * pockets (#1062's 0.523 mm).
 *
 * RED at 95c15d344: the corn is dropped and stated "not a candidate"; the plan falls back to the
 * ball (no flat in the set) and no op cuts the pocket with a flat.
 */
const CORN: Tool = flatEndMill(0.6, { number: 4, id: '111218063803', name: 'TiN Coating Corn Bit 0.6mm' });
/** A shape no CAM here can trace: the substitution answers a diameter, never a shape. */
const DRILL: Tool = { ...flatEndMill(1, { number: 5, id: '111018103803', name: 'TiN Coating Drill Bit 1mm' }), shape: 'drill', typeText: 'Drill' } as Tool;

describe('#1062 the #669 body proxy is judged on the owned record, never on an id', () => {
  it('RED: under rows, a below-the-floor corn keeps its place through the 3.2 mm proxy', async () => {
    // The catalogue knows this cutter's id — for PCB, not hardwood — and its rows carry the joined
    // geometry (the service joins it; a test row states it, as `withCatalogueGeometry` does).
    setFeedCatalogue([
      {
        cutterId: '111218063803',
        material: 'PCB',
        rpm: 10000,
        feed: 500,
        plungeFeed: 200,
        stepDown: 0.2,
        cutter: { shape: 'flat', diameter: 0.6, tipDiameter: 0.6 },
      },
    ]);
    const target = targetFor(pocketBlock());
    const input = await buildModelPlanInputForGoal(jobFor(target, 'hardwood'), target, BALL6, shopWith([CORN, DRILL, BALL6]));
    const plan = await planModelCam(input);
    const last = plan.perSetup.at(-1)!;
    const codes = last.statements.map((s) => s.code);
    const unfeedable = last.statements
      .filter((s) => s.code === 'goal-cutter-unfeedable')
      .map((s) => s.text)
      .join(' | ');
    expect(unfeedable, 'the corn was dropped from the candidate set').not.toContain('Corn');
    // The substitution answers a diameter, never a shape: a drill keeps its own refusal.
    expect(unfeedable, 'a drill was made feedable by a flat proxy').toContain('Drill');
    expect(codes, 'the substitution that fed the corn is not stated').toContain('goal-cutter-substituted');
    expect(last.notes.join(' | ')).toContain('largest covered row (3.2 mm)');
    // The corn is the set's only flat, so its own numbers cut the pocket floor.
    const ops = plan.perSetup.flatMap((s) => s.ops);
    expect(ops.some((op) => op.outcome.ir.tool.name === CORN.name), 'the corn cut no op').toBe(true);
  }, 180_000);
});
