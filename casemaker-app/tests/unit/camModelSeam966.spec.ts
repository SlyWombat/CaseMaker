/**
 * #966 — THE SEAM, and (below, the dome's own describe block stays as a seam-reachability check)
 * the ROUND-2 CUTOVER for the one case this round takes on: a SINGLE-setup goal `planModelCam` can
 * fully plan today. `generateGoalProgram` (`workers/sim/engraveGenerate.ts`) routes a goal job
 * through EITHER engine, selected by `USE_MODEL_CAM_ENGINE` (`engine/cnc/cam/model/plan.ts`, off by
 * default — "set only by specs for now", that module's own header):
 *
 *   - flag OFF (today's default): the old heightfield path (`generateSurface3dForGoal`) runs
 *     byte-for-byte unchanged — GREEN.
 *   - flag ON, the DOME fixture below: `planModelCam` itself refuses this particular mesh ("Not
 *     manifold") — still a NAMED #966 reason, never a crash, so that describe block is unchanged
 *     from round 1 and proves the seam stays reachable whatever `cam/model/plan.ts` does with a
 *     mesh it cannot plan.
 *   - flag ON, THE "sloped" RANDOM-PART FIXTURE below (#964's own `randomParts.ts` — the same
 *     fixture `curvedOpsProperty959.spec.ts` already proves `planModelCam` fully plans, posts and
 *     covers ≥ 95 % of, for a SINGLE setup): `generateGoalProgram` now posts every
 *     `SetupPlan.programs[]` entry with `postFor`/`verifyProgram` (the SAME convention
 *     `facingProgram`/`generateOneProgram` already use — grep both before changing this) and
 *     returns them as ordinary `EngraveProgram`s. GREEN — not just "did not throw": every posted
 *     program's own `verify` report carries zero `error`-severity findings. A multi-setup flip plan
 *     (#965, a parallel session's own work) is explicitly out of scope and refused by name, not
 *     attempted here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { generateGoalProgram, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';

afterEach(() => {
  clearTargetObjectMeshCache();
  vi.doUnmock('@/engine/cnc/cam/model/plan');
  vi.resetModules();
});

// ── A small dome goal — the #764 shell formula at stick scale, fewer segments (speed only; the
// shape itself is the same proven relief: the apex touches the stock top, the base sits `H` below
// it, so there is genuine material to remove, not a degenerate flat plateau). ───────────────────
type V = [number, number, number];
type Tri = [V, V, V];
const A = 6;
const B = 4;
const H = 3;
const SEG = 10;
const BLANK = { length: 30, width: 20, thickness: 10 };
const CX = 15;
const CY = 10;

function domeHeight(x: number, y: number): number {
  const u2 = (x / A) ** 2 + (y / B) ** 2;
  if (u2 >= 1) return 0;
  return H * Math.sqrt(1 - u2);
}

function surfaceTris(): Tri[] {
  const at = (r: number, t: number): V => {
    const x = A * r * Math.cos(2 * Math.PI * t);
    const y = B * r * Math.sin(2 * Math.PI * t);
    return [x, y, domeHeight(x, y)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SEG; j++) {
      const p = at(i / SEG, j / SEG);
      const q = at((i + 1) / SEG, j / SEG);
      const r = at((i + 1) / SEG, (j + 1) / SEG);
      const s = at(i / SEG, (j + 1) / SEG);
      tris.push([p, q, r], [p, r, s]);
    }
  }
  return tris;
}

function stl(tris: Tri[]): string {
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
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-966',
    name: 'dome-966.stl',
    format: 'stl',
    sha256: 'f'.repeat(64),
    data: stl(surfaceTris()),
    size: { x: 2 * A, y: 2 * B, z: H },
    position: { x: CX, y: CY, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobFor(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...BLANK },
    targetObject: target,
  };
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

/** The finishing ball (the goal's own chosen cutter) and a flat — a real goal job's house carries
 * both; `cam/model/plan.ts`'s own pocket chain needs a flat, the curved pipeline needs the ball. */
const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
const SHOP: EngraveShopOpts = {
  tools: [entry('inv:ball-2', BALL), entry('inv:flat-3', FLAT)],
};

describe('#966 — generateGoalProgram routes through cam/model behind USE_MODEL_CAM_ENGINE', () => {
  it('flag off (the default): the old heightfield engine runs, green', async () => {
    const job = jobFor(goalTarget());
    const result = await generateGoalProgram(job, job.targetObject!, BALL, [], null, SHOP);
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.nc).not.toBeNull();
  });

  it('flag on: the open dome sheet is closed with a skirt and the seam posts its program (#966 open meshes)', async () => {
    vi.doMock('@/engine/cnc/cam/model/plan', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/plan')>();
      return { ...actual, USE_MODEL_CAM_ENGINE: true };
    });
    vi.resetModules();
    const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');

    const job = jobFor(goalTarget());
    const result = await generateGoalProgramModelCam(job, job.targetObject!, BALL, [], null, SHOP);

    // #966 open-mesh repair: the dome fixture is an open sheet (a polar grid with its rim and
    // nothing under it). It used to die at the kernel as a bare "Not manifold"; the goal path now
    // closes it to the stock bottom, so the seam plans, posts and verifies a real program.
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.nc).not.toBeNull();
    expect(result.programs.length).toBeGreaterThan(0);
  }, 90_000);
});

/**
 * #966 ROUND 2 — THE CUTOVER, on a SINGLE-setup job `planModelCam` fully succeeds on TODAY: the
 * "sloped" kind of #964's own seeded `randomParts.ts` fixture, seed 1 — one of the six (of eight)
 * `curvedOpsProperty959.spec.ts` cases proven green (coverage ≥ 95 %, zero adjudicated cut-into)
 * through `planModelCam` directly. That spec posts `setup.programs` with bare `postZ1` and measures
 * the goal with its own sweep/coverage machinery; this one instead drives the real seam
 * (`generateGoalProgram`, flag on) and asserts what #966 actually owns: every posted program passes
 * `verifyProgram`, not merely "didn't throw". (`figure` is the two cases that stay red even through
 * `planModelCam` directly — a separate, unrelated finish-coverage gap — so it is not used here.)
 */
describe('#966 ROUND 2 — generateGoalProgram flag ON posts and verifies every program (single setup)', () => {
  function randomPartJob(seed: number): { job: EngraveJob; goal: EngraveTargetObject; shop: EngraveShopOpts; tool: Tool } {
    const part = buildRandomPart(seed, 'sloped', tl);
    // `placeTarget` (the one placement every goal path reads) centres the mesh's own XY bbox at
    // `position.x`/`position.y` and puts its TOP at `position.z`; the random part's raw mesh is
    // already centred at (0, 0) with its top at Z 0 (`randomParts.ts`'s own convention), so placing
    // it at the stock's own centre, top at the stock's own top, reproduces the SAME geometry in
    // the job's [0, L] × [0, W] frame that `curvedOpsProperty959.spec.ts` plans directly off the
    // raw, centred mesh — not a second, independently-placed part.
    const goal: EngraveTargetObject = {
      ...part.target,
      position: { x: part.stock.length / 2, y: part.stock.width / 2, z: 0 },
    };
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      stock: {
        ...defaultEngraveJob().stock,
        length: part.stock.length,
        width: part.stock.width,
        thickness: part.stock.thickness,
      },
      targetObject: goal,
    };
    // The SAME three house cutters `curvedOpsProperty959.spec.ts` plans this exact fixture with
    // (`FLAT6`/`FLAT3175`/`BALL2` there) — a different cutter set would plan a different program,
    // and this round measures the seam's posting/verifying, not a new CAM result.
    const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
    const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
    const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
    const shop: EngraveShopOpts = {
      tools: [entry('inv:flat-6', FLAT6), entry('inv:flat-3.175', FLAT3175), entry('inv:ball-2', BALL2)],
    };
    return { job, goal, shop, tool: BALL2 };
  }

  it('flag off (the default) still runs the old heightfield engine, green — the cutover changes nothing with the flag off', async () => {
    const { job, goal, shop, tool } = randomPartJob(1);
    const result = await generateGoalProgram(job, goal, tool, [], null, shop);
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.nc).not.toBeNull();
  }, 60_000);

  it('flag on: planModelCam fully plans this job, every posted program passes verifyProgram', async () => {
    vi.doMock('@/engine/cnc/cam/model/plan', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/plan')>();
      return { ...actual, USE_MODEL_CAM_ENGINE: true };
    });
    vi.resetModules();
    const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');

    const { job, goal, shop, tool } = randomPartJob(1);
    const result = await generateGoalProgramModelCam(job, goal, tool, [], null, shop);

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.nc).not.toBeNull();
    expect(result.verify).not.toBeNull();
    expect(result.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);


    // The actual #966 assertion: not "didn't throw" but every posted program's OWN verifier report
    // carries zero error-severity findings — `programs` is the run, `verify` alone is program 1.
    expect(result.programs.length).toBeGreaterThan(0);
    for (const program of result.programs) {
      expect(program.nc, `${program.toolKey}: no posted text`).toBeTruthy();
      expect(program.verify, `${program.toolKey}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `${program.toolKey}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }
  }, 60_000);

  it('#961 — the ideal plan rides on the generate call only when the caller sends the catalogue', async () => {
    vi.doMock('@/engine/cnc/cam/model/plan', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/plan')>();
      return { ...actual, USE_MODEL_CAM_ENGINE: true };
    });
    vi.resetModules();
    const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');
    const { job, goal, shop, tool } = randomPartJob(1);

    // RED FIRST before the catalogueTools wire: the worker had no way to see the app's library,
    // so the ideal could never exist. Absent = no ideal, the owned plan still posts.
    const without = await generateGoalProgramModelCam(job, goal, tool, [], null, shop);
    expect(without.ok, without.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toBe(true);
    expect(without.planIdeal ?? null).toBeNull();
    expect(without.plan).not.toBeNull();

    // With the catalogue on the call, the ideal is planned beside the owned plan and carried.
    const catalogueTool: Tool = flatEndMill(1, { number: 9, id: 'cat:flat-1', name: '1 mm flat end' });
    const withCatalogue = await generateGoalProgramModelCam(job, goal, tool, [], null, shop, undefined, undefined, undefined, [catalogueTool]);
    expect(withCatalogue.ok, withCatalogue.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toBe(true);
    expect(withCatalogue.planIdeal).not.toBeNull();
    expect(withCatalogue.plan).not.toBeNull();

    // #961 (the card slice) — each plan carries its OWN measured outcome: coverage over the goal
    // grid and the deepest the sweep stands above it. RED before the outcome wire: both were
    // undefined, so the card had no numbers to compare.
    expect(withCatalogue.plan!.outcome, 'the owned plan carried no outcome').toBeDefined();
    expect(withCatalogue.planIdeal!.outcome, 'the ideal plan carried no outcome').toBeDefined();
    expect(withCatalogue.plan!.outcome!.coverage).not.toBeNull();
    expect(withCatalogue.planIdeal!.outcome!.coverage).not.toBeNull();
    expect(withCatalogue.plan!.outcome!.cycleSeconds).toBeGreaterThan(0);
    expect(withCatalogue.planIdeal!.outcome!.cycleSeconds).toBeGreaterThan(0);
    // The owned plan is measured with or without a catalogue — the outcome is the plan's own.
    expect(without.plan!.outcome).toBeDefined();
  }, 240_000);
});
