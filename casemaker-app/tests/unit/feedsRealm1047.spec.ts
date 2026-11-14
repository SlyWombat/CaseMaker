/**
 * #1047 — THE MODEL PLAN RESOLVES AGAINST THE ROWS ITS REALM WAS HANDED.
 *
 * `plan.ts`'s `resolvedCutParams` read `feedCatalogueSnapshot()` — module state in whatever realm
 * the plan runs. A worker and the CLI process both start with `EMPTY_CATALOGUE` (feeds.ts says so
 * itself, #324), and neither ever installs the rows its door was handed, so every goal plan fell
 * to the compiled starting table: silent on wood (the table has rows), a total refusal on
 * aluminium, whose only rows are Makera's (the three reference cards, #1047's finding).
 *
 * The rule this spec pins: the rows travel AS AN ARGUMENT (`ModelPlanInput.feedCatalogue`,
 * threaded from `generateGoalProgram`'s caller) — never through the realm's snapshot. An empty
 * array means "no catalogue" and refuses honestly; `undefined` (a direct main-realm caller only)
 * keeps the snapshot, which is the copy the specs seed.
 *
 * RED at 018be006f: the aluminium run refuses with "no feeds for ... in aluminium-6061" though the
 * rows it passed carry one, and the seam input carries no catalogue at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { clearFeedCatalogue, feedsFor, feedsToolForSurface, setFeedCatalogue } from '@/engine/cnc/feeds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { buildModelPlanInputForGoal, generateGoalProgram, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, EngraveTargetObject, StockMaterial } from '@/types/engraveJob';
import { NO_SHOP } from '../tools/noShop';

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

/** Makera's own ids — the shape the worker and the CLI see (the catalogue keys on them). */
const METAL6: Tool = flatEndMill(6, { id: '112111313812', name: '6*17mm Flat End(Metal)' }); // no row in the rows below
const ROWED6: Tool = flatEndMill(6, { id: '112131605017', name: '6*25mm Flat End(Metal)' });
const BALL6: Tool = { ...flatEndMill(6, { number: 9, id: '132132605018', name: '6*18mm Ball Nose(Metal)' }), shape: 'ball', typeText: 'Ball Nose' };
const VBIT: Tool = {
  ...flatEndMill(3.175, { number: 8, id: '122111013890', name: 'Chamfering Bit 90°' }),
  typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0.1, angle: 90, halfAngle: 45,
} as Tool;

/** The wood cutter's row: numbers the starting table does NOT carry — the point of case 4. */
const WOOD_RPM = 17500;
const WOOD_FEED = 1234;

beforeEach(() => {
  // The rows a worker/CLI realm receives by structured clone. No row for METAL6, on purpose.
  setFeedCatalogue([
    { cutterId: '112131605017', material: '6061 Aluminum', rpm: 10000, feed: 900, plungeFeed: 250, stepDown: 0.5 },
    { cutterId: '132132605018', material: '6061 Aluminum', rpm: 12000, feed: 800, plungeFeed: 250, stepDown: 0.5 },
    { cutterId: '112131605017', material: 'Hardwood', rpm: WOOD_RPM, feed: WOOD_FEED, plungeFeed: 300, stepDown: 0.4 },
    { cutterId: '132132605018', material: 'Hardwood', rpm: WOOD_RPM, feed: WOOD_FEED, plungeFeed: 300, stepDown: 0.4 },
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
    id: 'goal-1047', name: 'block', role: 'goal', enabled: true, format: 'stl',
    sha256: 'a'.repeat(64), data: binary,
    position: { x: L / 2, y: W / 2, z: 0 }, rotation: 0,
    size: { x: L, y: W, z: T },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function jobFor(target: EngraveTargetObject, material: StockMaterial): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: L, width: W, thickness: 12, material },
  };
}

function shopWith(tools: Tool[]): EngraveShopOpts {
  return { tools: tools.map((tool, i) => ({ key: `probe:${i}`, tool, provenance: 'test' })), feeds: null };
}

const ALU_ROWS = [
  { cutterId: '112131605017', material: '6061 Aluminum', rpm: 10000, feed: 900, plungeFeed: 250, stepDown: 0.5 },
  { cutterId: '132132605018', material: '6061 Aluminum', rpm: 12000, feed: 800, plungeFeed: 250, stepDown: 0.5 },
] as const;

describe('#1047 the plan resolves on the rows its door passed, never the realm snapshot', () => {
  it('RED: an aluminium goal run through the goal door plans on the rows it was handed, realm empty', async () => {
    clearFeedCatalogue(); // a worker/CLI realm before any install
    const target = targetFor(pocketBlock());
    const generated = await generateGoalProgram(
      jobFor(target, 'aluminium-6061'),
      target,
      BALL6,
      null,
      { shop: shopWith([METAL6, ROWED6, BALL6, VBIT]), feedCatalogue: ALU_ROWS },
    );
    expect(generated.errors, JSON.stringify(generated.errors)).toEqual([]);
    expect(generated.ok).toBe(true);
    expect(generated.nc?.length ?? 0).toBeGreaterThan(0);
    const ops = generated.plan?.perSetup.flatMap((s) => s.ops) ?? [];
    expect(ops.some((op) => op.kind === 'pocket')).toBe(true);
    // The omission is a TYPED statement and a finding, not a note only (#1047's follow-up).
    const statements = generated.plan?.perSetup.flatMap((s) => s.statements) ?? [];
    const omitted = statements.filter((s) => s.code === 'goal-cutter-unfeedable');
    expect(omitted.length, 'the row-less cutter is not stated as a typed omission').toBeGreaterThan(0);
    expect(omitted[0]!.text).toContain('6*17mm Flat End(Metal)');
    expect(omitted[0]!.text).toContain('aluminium-6061');
    expect(generated.findings.some((f) => f.code === 'goal-cutter-unfeedable')).toBe(true);
  }, 240_000);

  it('an empty row set never stands the snapshot in: no catalogue is an honest refusal', async () => {
    clearFeedCatalogue();
    const target = targetFor(pocketBlock());
    const generated = await generateGoalProgram(
      jobFor(target, 'aluminium-6061'),
      target,
      BALL6,
      null,
      { shop: shopWith([ROWED6, BALL6, VBIT]), feedCatalogue: [] },
    );
    expect(generated.ok).toBe(false);
    expect(generated.errors.map((e) => e.message).join(' | ')).toMatch(/no cutter in the set has cutting parameters for aluminium-6061|no feeds for/);
  }, 240_000);

  it('the seam sets the exact rows it was given, the empty array included', async () => {
    const target = targetFor(pocketBlock());
    const job = jobFor(target, 'aluminium-6061');
    const shop = shopWith([ROWED6, BALL6, VBIT]);
    const withRows = await buildModelPlanInputForGoal(job, target, BALL6, shop, undefined, undefined, ALU_ROWS);
    expect(withRows.feedCatalogue).toBe(ALU_ROWS); // the same array, not a copy or a snapshot
    const empty = await buildModelPlanInputForGoal(job, target, BALL6, shop, undefined, undefined, []);
    expect(empty.feedCatalogue).toEqual([]); // present, never undefined: "no catalogue", stated
  }, 240_000);

  it('a wood goal posts the panel’s own S/F, not the starting table’s', async () => {
    clearFeedCatalogue();
    const rows = [
      { cutterId: '112131605017', material: 'Hardwood', rpm: WOOD_RPM, feed: WOOD_FEED, plungeFeed: 300, stepDown: 0.4 },
      { cutterId: '132132605018', material: 'Hardwood', rpm: WOOD_RPM, feed: WOOD_FEED, plungeFeed: 300, stepDown: 0.4 },
    ] as const;
    // The panel's read: `feedsFor` on the installed rows (EngravePanel's own call).
    const panel = feedsFor(rows, 'hardwood', feedsToolForSurface(ROWED6), Z1, NO_SHOP.refuse);
    expect(panel.ok, panel.ok ? '' : panel.reason).toBe(true);
    if (!panel.ok) return;
    const target = targetFor(pocketBlock());
    const generated = await generateGoalProgram(
      jobFor(target, 'hardwood'),
      target,
      BALL6,
      null,
      { shop: shopWith([ROWED6, BALL6, VBIT]), feedCatalogue: rows },
    );
    expect(generated.ok, JSON.stringify(generated.errors)).toBe(true);
    const nc = generated.nc ?? '';
    expect(nc).toContain(`S${panel.params.rpm}`);
    expect(nc).toContain(`F${panel.params.feed}`);
    // The counterfactual: the compiled STARTING table's own numbers — what the plan used before
    // this fix — read differently, so the posted S/F above came from the caller's rows. The table
    // tops out at 3.2 mm, so the ⌀3.175 flat is its own largest covered row for hardwood (the
    // proxy `resolvedCutParams` used for the ⌀6).
    const tableOnly = feedsFor([], 'hardwood', flatEndMill(3.175), Z1, NO_SHOP.refuse);
    expect(tableOnly.ok).toBe(true);
    if (!tableOnly.ok) return;
    expect(tableOnly.params.rpm).not.toBe(panel.params.rpm);
  }, 240_000);
});
