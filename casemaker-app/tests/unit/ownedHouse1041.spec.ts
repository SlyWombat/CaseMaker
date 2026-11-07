/**
 * #1041 — THE OWNED PLAN'S HOUSE IS THE SHOP'S OWN RECORDS, NOT THE REGISTRY SNAPSHOT.
 *
 * `getTools()` carries three tiers: the built-in library, the house service's definitions (`cat:`,
 * `user:`) and the physical inventory (`inv:`). The seam's house build (`engraveGenerate.ts`, the
 * `shop.tools` loop) took EVERY entry plus the chosen tool, so the "owned" plan was planned from a
 * set that included the built-ins (and any `cat:` rows) — the M1 tray chose `flat-1.0` and
 * `flat-3.175x12-metal` beside the owned `inv:` twins, and the bench cannot cut cutters nobody
 * owns. The rule (6b): owned = `inv:` + `user:` + the chosen tool; `cat:` never (it is the
 * IDEAL's candidate set); the built-in tier only when the shop has neither inventory nor user
 * records, stated on the plan.
 *
 * RED at main: the house carries the built-in beside the owned twin, and the plan may take it.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';

const L = 60;
const W = 40;
const T = 5;
const POCKET = { x0: 20, x1: 40, y0: 10, y1: 30, depth: 2 };

/** A 60 × 40 × 5 block with a 20 × 20 × 2 pocket: a goal whose flat chain has a pocket to cut. */
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

const BALL6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
/** The built-in tier's own ⌀1 flat: NO stated flute (`fluteLength` null), so `depthRefusal` can
 *  never refuse it — the safety smell the issue names. */
const BUILTIN_FLAT1: Tool = flatEndMill(1, { name: 'flat-1.0' });
/** The owned twin: the k3 inventory's ⌀1 corn, `id: null`. */
const INV_CORN1: Tool = flatEndMill(1, { name: 'kz corn 1.0' });

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
    id: 'goal-1041', name: 'pocket block', role: 'goal', enabled: true, format: 'stl',
    sha256: 'p'.repeat(64), data: binary,
    position: { x: L / 2, y: W / 2, z: 0 }, rotation: 0,
    size: { x: L, y: W, z: T },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function jobFor(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: L, width: W, thickness: 12, material: 'pla' },
  };
}

const FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 0.4,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function shopWith(entries: { key: string; tool: Tool }[]): EngraveShopOpts {
  return { tools: entries.map((e) => ({ key: e.key, tool: e.tool, provenance: 'test' })), feeds: FEEDS };
}

async function inputFor(shop: EngraveShopOpts): Promise<ModelPlanInput> {
  const target = targetFor(pocketBlock());
  return buildModelPlanInputForGoal(jobFor(target), target, BALL6, shop);
}

describe('#1041 the owned house is inv: + user: + the chosen tool', () => {
  it('RED: a built-in beside its owned twin never enters the house (the plan cannot take it)', async () => {
    const input = await inputFor(shopWith([
      { key: 'flat-1.0', tool: BUILTIN_FLAT1 },
      { key: 'inv:kz-corn-1-7', tool: INV_CORN1 },
    ]));
    expect(input.cutters.house, 'the built-in leaked into the owned house').not.toContain(BUILTIN_FLAT1);
    expect(input.cutters.house.map((t) => t.name)).toEqual(expect.arrayContaining(['kz corn 1.0']));
    // And the plan never cuts with the built-in: every op's cutter is a house tool, not it.
    const plan = await planModelCam(input);
    for (const setup of plan.perSetup) {
      for (const op of setup.ops) expect(op.outcome.ir.tool, `${op.kind} ${op.region.id} took the built-in`).not.toBe(BUILTIN_FLAT1);
    }
  }, 180_000);

  it('a cat: row never enters the house even beside the inventory', async () => {
    const CAT_FLAT1: Tool = flatEndMill(1, { name: 'catalogue 1 mm flat' });
    const input = await inputFor(shopWith([
      { key: 'cat:112233', tool: CAT_FLAT1 },
      { key: 'inv:kz-corn-1-7', tool: INV_CORN1 },
    ]));
    expect(input.cutters.house, 'a cat: row leaked into the owned house').not.toContain(CAT_FLAT1);
    expect(input.cutters.house.map((t) => t.name)).toContain('kz corn 1.0');
  }, 180_000);

  it('a chosen cutter the shop does not own warns, names it and its key, and still cuts', async () => {
    // The operator's job names a `cat:` ball while the shop HAS an inventory: the cutter wins by
    // "stated tools win", and the plan says it is not owned.
    const target = targetFor(pocketBlock());
    const job: EngraveJob = { ...jobFor(target), toolKey: 'cat:112233' };
    const input = await buildModelPlanInputForGoal(job, target, BALL6, shopWith([{ key: 'inv:kz-corn-1-7', tool: INV_CORN1 }]));
    expect(input.cutters.house, 'the chosen tool still rides the house').toContain(BALL6);
    const plan = await planModelCam(input);
    const st = plan.perSetup.at(-1)!.statements.find((x) => x.code === 'goal-cutter-not-owned');
    expect(st, 'no goal-cutter-not-owned statement').toBeDefined();
    expect(st!.severity).toBe('warning');
    expect(st!.text).toContain(BALL6.name);
    expect(st!.text).toContain('cat:112233');
    expect(st!.text).toContain('not in this shop’s inventory');
  }, 180_000);

  it('a chosen owned cutter says nothing', async () => {
    const target = targetFor(pocketBlock());
    const job: EngraveJob = { ...jobFor(target), toolKey: 'inv:kz-corn-1-7' };
    const input = await buildModelPlanInputForGoal(job, target, BALL6, shopWith([{ key: 'inv:kz-corn-1-7', tool: INV_CORN1 }]));
    const plan = await planModelCam(input);
    expect(plan.perSetup.flatMap((p) => p.statements).some((x) => x.code === 'goal-cutter-not-owned')).toBe(false);
  }, 180_000);

  it('built-ins are the fresh-install fallback, stated on the plan', async () => {
    const input = await inputFor(shopWith([{ key: 'flat-1.0', tool: BUILTIN_FLAT1 }]));
    expect(input.cutters.house, 'the fallback did not keep the built-in').toContain(BUILTIN_FLAT1);
    // The built-in that stands in states NO flute — `depthRefusal` can never refuse it; the plan
    // says the registry is standing in so the operator knows why a cutter they do not own is used.
    expect(BUILTIN_FLAT1.fluteLength).toBeNull();
    const plan = await planModelCam(input);
    expect(plan.perSetup.at(-1)!.notes.join(' | ')).toContain('no inventory recorded; the built-in registry stands in');
    expect(plan.perSetup.flatMap((p) => p.statements).some((s) => s.code === 'goal-cutter-not-owned')).toBe(false);
  }, 180_000);
});
