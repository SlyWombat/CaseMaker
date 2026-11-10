/**
 * #1017 — THE TWIN-FRAME GUARD. Three defects in one day were the same coordinate mistake: a
 * value moved across the planner's two datums without its `± z0` — #1003's curved clamp, #1013's
 * band, #1014's finish mask. Each was exact at `stockTop = 0` (every card, every fixture) and
 * wrong on a flipped setup, and each stayed green through `multiSetupVerify966`, which judges the
 * moves a plan posts and cannot see an op that is absent or a region planned 0..0.
 *
 * THE ORACLE IS A TWIN, never a hand-written list: every setup of #966's datum fixture is planned,
 * then planned AGAIN with its own frame rebased so `stockTop = 0` — the same mesh shifted so the
 * setup's own stock top lands on 0 (`stockBottom` shifted the same). The two plans are congruent
 * by construction, so every datum-crossing comparison is checked against the engine itself:
 *
 *   - the multiset of op kinds per cutter is identical;
 *   - every op's own minZ/maxZ agree within 0.1 mm (the plan's one datum is the setup's stock top,
 *     so no shift is applied — a leaked `z0` is a stockTop-sized gap and fails here);
 *   - every op's feed count agrees within 10 %;
 *   - the strongest form: each program's posted NC is byte-identical.
 *
 * THE ONE STATED EXCEPTION (#965's opposite-side bound): a NON-FIRST setup's freeing contour is
 * bounded, at every point its path samples, by the previous setup's finished surface. A
 * single-setup twin has no such surface, so that op's path legitimately differs; the guard posts
 * both programs with the contour's own operations removed (the rest of the program is still held
 * byte-for-byte) and holds the contour to the op-level Z-range line. Everything else, the finish
 * and the rough included, is exact — which is where #1014's leak lived.
 *
 * RED: with #1014's `roughLeftAbove(f, base.zTop, …)` — the CL mesh-absolute, the region rebased —
 * the flipped setup's finish mask empties and this spec fails on setup 1's missing finish op.
 *
 * THE MOULD SIDE (#1019, 6b's TODO, done): #1005's mould fixture — the stock minus the turned-over
 * part — joins the cases below. Its solid is built at the seam and planned through the FLIPPED
 * setup's frame (`sideFace: 'bottom'`), which is the datum-crossing case this guard exists for:
 * a non-zero stockTop through the door's one shift, the cavity's regions and CL under it.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam, type ModelPlanInput, type SetupPlan } from '@/engine/cnc/cam/model/plan';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { buildDatumGoal } from './helpers/datumTwoSetup966';

const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool, provenance: 'test' });
const SHOP = { tools: [entry('inv:ball-2', BALL), entry('inv:flat-3', FLAT)] };

async function datumInput(bandMm?: number): Promise<ModelPlanInput> {
  const datum = await buildDatumGoal();
  const stock = datum.stock;
  const goal: EngraveTargetObject = bandMm === undefined ? datum.goal : { ...datum.goal, bandMm };
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base,
    labels: [],
    shapes: [],
    stock: { ...base.stock, ...stock },
    targetObject: goal,
  };
  return await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
}

/** The same input with ONE setup, its frame rebased to stockTop = 0 and the mesh shifted so the
 *  setup's own stock top lands on 0 — the congruent twin. The frame's rotation maps document z to
 *  setup z as +z (up = +z) or −z (up = −z), so the document shift carries that sign: −stockTop
 *  for a top setup, +stockTop for the flipped one. */
function twinOf(input: ModelPlanInput, setupIndex: number): ModelPlanInput {
  const spec = input.setups[setupIndex]!;
  const stockTop = spec.frame.stockTop;
  const dz = (spec.frame.up[2] ?? 1) < 0 ? stockTop : -stockTop;
  const positions = Float32Array.from(input.geometry.triangles.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! + dz;
  const bbox = input.geometry.triangles.bbox;
  const triangles = {
    ...input.geometry.triangles,
    positions,
    bbox: { min: [bbox.min[0], bbox.min[1], bbox.min[2] + dz], max: [bbox.max[0], bbox.max[1], bbox.max[2] + dz] } as typeof bbox,
  };
  return {
    ...input,
    geometry: { ...input.geometry, triangles },
    setups: [{
      frame: { up: spec.frame.up, stockTop: 0, ...(spec.frame.stockBottom === undefined ? {} : { stockBottom: spec.frame.stockBottom - stockTop }) },
      underside: spec.underside,
      // The band is a depth below THIS setup's stock top, so it carries unchanged into the rebased
      // twin — its per-face NUMBER was settled at the seam before either plan runs (#1013).
      ...(spec.bandMm === undefined ? {} : { bandMm: spec.bandMm }),
    }],
  };
}

interface OpRow {
  kind: string;
  cutter: string;
  region: string;
  minZ: number;
  maxZ: number;
  feeds: number;
}

function opRows(setup: SetupPlan): OpRow[] {
  return setup.ops.map((op) => {
    let minZ = Infinity, maxZ = -Infinity, feeds = 0;
    for (const irOp of op.outcome.ir.operations) {
      for (const m of irOp.moves) {
        minZ = Math.min(minZ, m.z);
        maxZ = Math.max(maxZ, m.z);
        if (m.kind === 'feed') feeds++;
      }
    }
    return { kind: op.kind, cutter: op.outcome.cutter, region: op.region.id, minZ, maxZ, feeds };
  });
}

function postText(ir: ToolpathIR, thickness: number): string {
  const ctx: PostContext = {
    jobName: 'twin-frame-1017',
    stock: { length: 60, width: 60, thickness },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-1017',
    toolKey: 'multi',
  };
  const result = postZ1(ir, ctx, Z1);
  if (!result.ok) throw new Error(`postZ1 refused: ${(result.errors ?? []).join('; ')}`);
  return result.text;
}

/** The program with its contour operations removed — the stated exception's comparison form. */
function withoutContour(ir: ToolpathIR): ToolpathIR {
  return { ...ir, operations: ir.operations.filter((op) => op.labelId !== 'contour') };
}

/** The twin congruence: op kinds per cutter, each op's own Z range and feed count, and the posted
 *  NC byte-for-byte (the non-first contour excepted, #965's opposite-side bound). */
async function assertCongruent(input: ModelPlanInput, planned?: Awaited<ReturnType<typeof planModelCam>>): Promise<void> {
  const nonzero = input.setups.filter((s) => Math.abs(s.frame.stockTop) > 1e-9);
  expect(nonzero.length, 'the fixture no longer states a non-zero stock top').toBeGreaterThan(0);

  // #1180 — a caller that already planned this input hands its plan in; the mould case plans the
  // SAME input for its non-vacuity line, and planning it twice was 20 s of nothing.
  const baseline = (planned ?? (await planModelCam(input))).perSetup;
  for (let i = 0; i < input.setups.length; i++) {
    const setup = baseline[i]!;
    const stockTop = input.setups[i]!.frame.stockTop;
    const twin = (await planModelCam(twinOf(input, i))).perSetup[0]!;
    const label = `setup ${i} (stockTop ${stockTop})`;

    const mine = opRows(setup);
    const theirs = opRows(twin);
    // 1. THE SAME OPS, per kind and cutter — an absent finish (the #1014 failure) lands here.
    const count = (rows: OpRow[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(`${r.cutter}|${r.kind}`, (m.get(`${r.cutter}|${r.kind}`) ?? 0) + 1);
      return m;
    };
    expect([...count(mine)], `${label}: op kinds per cutter differ from the twin`).toEqual([...count(theirs)]);
    // 2 + 3. Every op's own Z range and feed count. The plan's datum is the setup's stock top:
    // no shift is applied; a value that kept its mesh-absolute z0 shows up as a stockTop gap.
    const byKey = new Map(theirs.map((r) => [`${r.cutter}|${r.kind}|${r.region}`, r]));
    const boundedContour = (r: OpRow): boolean => r.kind === 'contour' && i > 0;
    for (const r of mine) {
      const t = byKey.get(`${r.cutter}|${r.kind}|${r.region}`);
      expect(t, `${label}: op ${r.kind} ${r.region} missing from the twin`).toBeDefined();
      expect(Math.abs(r.minZ - t!.minZ), `${label}: op ${r.kind} ${r.region} minZ`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(r.maxZ - t!.maxZ), `${label}: op ${r.kind} ${r.region} maxZ`).toBeLessThanOrEqual(0.1);
      const allowed = Math.max(1, 0.1 * Math.max(r.feeds, t!.feeds));
      expect(Math.abs(r.feeds - t!.feeds), `${label}: op ${r.kind} ${r.region} feed count`).toBeLessThanOrEqual(allowed);
    }
    // 4. THE STRONGEST FORM — the posted NC, byte-identical. A non-first setup's freeing contour
    // is the ONE stated exception (its opposite-side bound needs the previous setup); the same
    // programs with the contour's operations removed are still held byte-for-byte, and the
    // contour op itself is held to presence + the Z-range line above.
    const thickness = setup.features.frame.stockTop - setup.features.frame.partBottom;
    const contourExcepted = i > 0 && mine.some(boundedContour);
    const postOf = (s: SetupPlan, stripContour: boolean): string[] =>
      s.programs
        .map((ir) => (stripContour ? withoutContour(ir) : ir))
        // A contour that posts as its own run leaves an empty IR when stripped — the contour is
        // the stated exception, checked by the op-level line above, not posted here.
        .filter((ir) => ir.operations.some((op) => op.moves.length > 0))
        .map((ir) => postText(ir, thickness));
    expect(postOf(setup, contourExcepted), `${label}: posted NC differs from the twin`).toEqual(postOf(twin, contourExcepted));
  }
}

describe('#1017 — every setup plans the same on a stockTop ≠ 0 frame as its stockTop-0 twin', () => {
  it('the datum fixture’s two setups each match their twin: op kinds, depths, feed counts, posted NC', async () => {
    await assertCongruent(await datumInput());
  }, 300_000);

  // THE BAND'S OWN PLANE (#1013's class, the one the twin cannot see: it is assigned at the seam
  // BEFORE the twin is built, so a twin inherits the same wrong number and stays green). The
  // fixture states a 6 mm band on a 30 mm blank: 6 mm below the top face, and 24 mm below the
  // flipped face — one plane, two depths. Reverting #1013 gives the flipped setup 6 and this
  // fails; the congruence below still holds either way, which is exactly why this line exists.
  // #1019 — THE MOULD SIDE. #1005's wedge fixture, the stock minus the turned-over part, planned
  // through the seam's own flipped setup. Every setup it yields must match its stockTop-0 twin on
  // the same four lines the datum fixture is held to.
  it('the mould fixture’s setup matches its twin', async () => {
    const tris: [number, number, number][][] = (() => {
      const p = (x: number, y: number): [number, number, number] => [x, y, -0.1 * y];
      return [[p(0, 0), p(20, 0), p(20, 20)], [p(0, 0), p(20, 20), p(0, 20)]];
    })();
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    let off = 84;
    for (const t of tris) {
      off += 12;
      for (const v of t) {
        dv.setFloat32(off, v[0], true);
        dv.setFloat32(off + 4, v[1], true);
        dv.setFloat32(off + 8, v[2], true);
        off += 12;
      }
      off += 2;
    }
    const goal: EngraveTargetObject = {
      id: 'guard-mould',
      name: 'guard-wedge.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: Buffer.from(new Uint8Array(buf)).toString('base64'),
      size: { x: 20, y: 20, z: 2 },
      position: { x: 30, y: 20, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
      goalMode: 'mold',
    };
    const base = defaultEngraveJob();
    const job: EngraveJob = { ...base, stock: { ...base.stock, thickness: 26 }, labels: [], shapes: [], targetObject: goal };
    // The seam's own mould input, planned through the FLIPPED setup's frame: the guard's case.
    // #1004 — the seam takes the side face as its LAST argument now (the pre-#1004
    // `setupsOverride` parameter is gone); no placeholder `undefined` here.
    const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP, 'bottom');
    // NON-VACUITY: an empty plan twin-matches itself. The seam turns the solid over for the
    // flipped frame (#1017's shared-solid rule), and the mould must actually plan ops through it
    // for this guard to mean anything.
    const planned = await planModelCam(input);
    expect(planned.perSetup.flatMap((s) => s.ops).length, 'the mould plans no ops — the guard would be vacuous').toBeGreaterThan(0);
    await assertCongruent(input, planned);
  }, 300_000);

  it('a stated band lands on each face’s own plane — 6 mm on top, 24 mm on the flipped side', async () => {
    const input = await datumInput(6);
    const flipped = input.setups.findIndex((s) => Math.abs(s.frame.stockTop) > 1e-9);
    expect(flipped, 'the fixture no longer has a setup with a non-zero stock top').toBeGreaterThanOrEqual(0);
    const top = input.setups.find((_, idx) => idx !== flipped)!;
    expect(top.bandMm, 'the top side’s band').toBeCloseTo(6, 6);
    expect(input.setups[flipped]!.bandMm, 'the flipped side’s band (T − b)').toBeCloseTo(30 - 6, 6);
    await assertCongruent(input);
  }, 300_000);
});
