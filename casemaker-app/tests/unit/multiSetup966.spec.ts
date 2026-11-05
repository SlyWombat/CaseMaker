/**
 * #966 ROUND 3 — MULTI-SETUP POSTING. `generateGoalProgram`'s flag-on path (`USE_MODEL_CAM_ENGINE`)
 * used to refuse by name whenever `planModelCam` returned more than one `SetupPlan` ("this cutover
 * posts a single-setup goal only"). This spec is RED-FIRST for lifting that refusal: a real,
 * analytic two-setup part (a plain box — the SAME geometry `contourFreeingCl965.spec.ts`'s own
 * section C already proves `planModelCam` plans end to end for two setups, driven here through an
 * embedded STL goal mesh instead of a hand-built `ParsedMesh`, so the test exercises the REAL
 * `recogniseFeatures` + `registerSetupOrigin` path, not a stand-in) posts and verifies BOTH
 * setups' programs, and `EngraveGenerated.plan` carries the full two-setup `ModelPlanOutput`.
 *
 * `buildModelPlanInputForGoal`/`generateGoalProgram`'s own `setupsOverride`/`modelSetupsOverride`
 * parameters are a #966 test/e2e-only seam (their own doc comments): no production caller ever
 * passes one, because #898/#914's own flip plan is not wired to a goal job yet (a separate, future
 * piece of work) — this is the stated reason a real goal job cannot reach `planModelCam` with more
 * than one setup today without it.
 *
 * Also proves the registration-refusal path (#965's `registerSetupOrigin`, thrown when a part
 * carries neither a reliable two-hole datum nor a long straight edge) surfaces through this same
 * seam as a clean, named `'cam'`-stage failure — never a raw, unhandled throw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { generateGoalProgram, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { setModelCamEnabled, type SetupSpec } from '@/engine/cnc/cam/model/plan';

afterEach(() => {
  clearTargetObjectMeshCache();
  setModelCamEnabled(false);
});

// ── A plain box, the goal's own embedded mesh — raw local coordinates centred at (0, 0) in XY,
// top at local Z 0 (the SAME "already centred, top at Z 0" convention `camModelSeam966.spec.ts`'s
// random-part fixture uses), so placing it at the stock's own centre with `position.z = 0`
// reproduces the box in the job's [0, L] × [0, W] frame with its top at the stock's own top. ────
type V = [number, number, number];
type Tri = [V, V, V];

function quad(out: Tri[], a: V, b: V, c: V, d: V): void {
  out.push([a, b, c], [a, c, d]);
}

/** A closed box `L × W × T`, centred in XY, top at local Z 0 — `setups965.spec.ts`'s own `box`
 * helper, re-centred. The SAME 40 × 30 × 20 dimensions `contourFreeingCl965.spec.ts`'s section C
 * already proves `planModelCam` plans end to end for a two-setup job (registration via the edge
 * datum, the freeing contour's opposite-surface clamp) — reused here so this spec's own geometry
 * is not a new, unproven shape. */
function boxTris(l: number, w: number, t: number): Tri[] {
  const x0 = -l / 2, x1 = l / 2, y0 = -w / 2, y1 = w / 2, z0 = -t, z1 = 0;
  const tris: Tri[] = [];
  quad(tris, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(tris, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  quad(tris, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(tris, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad(tris, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad(tris, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return tris;
}

/** Binary STL encoder — `camModelSeam966.spec.ts`'s own helper, unchanged. */
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

function boxTarget(id: string, l: number, w: number, t: number): EngraveTargetObject {
  return {
    id,
    name: `${id}.stl`,
    format: 'stl',
    sha256: 'f'.repeat(64),
    data: stl(boxTris(l, w, t)),
    size: { x: l, y: w, z: t },
    position: { x: l / 2, y: w / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobFor(target: EngraveTargetObject, l: number, w: number, t: number): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: l, width: w, thickness: t },
    targetObject: target,
  };
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

// 3 mm, not 6 — hardwood's compiled fallback feeds table tops out at 3.2 mm (`feeds.ts`'s own
// rows); the MODEL engine's `resolvedCutParams` has an explicit flat-proxy substitution for a
// cutter outside that table (`cam/model/plan.ts`'s own header note), but the OLD heightfield path
// this spec's "flag off" case also exercises does not, so a 6 mm cutter refuses there with no
// feeds at all — picking a covered diameter keeps BOTH paths green on their own terms.
const FLAT3: Tool = flatEndMill(3, { number: 1, id: 'flat-3', name: 'flat-3' });
const SHOP: EngraveShopOpts = { tools: [entry('inv:flat-3', FLAT3)] };

/** Setup 0 (top) + setup 1 (bottom, the vise flip) — the placed mesh's own top at Z 0, bottom at
 * `-T`, the SAME convention `buildModelPlanInputForGoal`'s own single-setup default uses, just
 * supplied twice (`frameForFace`'s own formula for `stockTopZ = 0`: bottom's `stockTop` is the
 * thickness, `stockBottom` is `-stockTopZ`, numerically 0). */
function twoSetups(t: number): SetupSpec[] {
  return [
    { frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -t }, underside: 'flippedTabs' },
    { frame: { up: [0, 0, -1], stockTop: t, stockBottom: -0 }, underside: 'flippedTabs' },
  ];
}

describe('#966 ROUND 3 — generateGoalProgram posts and verifies a real multi-setup plan', () => {
  it('flag off (the default): unaffected by the override — the old heightfield engine still runs, green', async () => {
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-ms-off', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.plan ?? null).toBeNull();
  }, 30_000);

  it('flag on: planModelCam plans two setups, every setup\'s programs post and verify, plan carries the full ModelPlanOutput', async () => {
    setModelCamEnabled(true);
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-ms-on', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');

    // The actual #966 ROUND 3 assertion: every posted program, across BOTH setups, passes
    // `verifyProgram` with zero error-severity findings — not just "didn't throw".
    expect(result.programs.length).toBeGreaterThan(0);
    for (const program of result.programs) {
      expect(program.nc, `setup ${program.setupIndex}/${program.toolKey}: no posted text`).toBeTruthy();
      expect(program.verify, `setup ${program.setupIndex}/${program.toolKey}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `setup ${program.setupIndex}/${program.toolKey}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }

    // Both setups are actually represented — setupIndex is 1-based (`EngraveProgram`'s own doc),
    // in posting order, and the two setups' own ids differ (the turn-over boundary's only
    // representation in the flat `programs` list — see `engraveGenerate.ts`'s own #966 note).
    const setupIndexes = [...new Set(result.programs.map((p) => p.setupIndex))].sort();
    expect(setupIndexes).toEqual([1, 2]);
    const setup1Ids = new Set(result.programs.filter((p) => p.setupIndex === 1).map((p) => p.setupId));
    const setup2Ids = new Set(result.programs.filter((p) => p.setupIndex === 2).map((p) => p.setupId));
    expect(setup1Ids.size).toBe(1);
    expect(setup2Ids.size).toBe(1);
    expect([...setup1Ids][0]).not.toBe([...setup2Ids][0]);

    // D's ask #1 — `EngraveGenerated.plan` carries the FULL two-setup `ModelPlanOutput`.
    expect(result.plan).not.toBeNull();
    expect(result.plan!.perSetup).toHaveLength(2);
    expect(result.plan!.perSetup.map((p) => p.setupIndex)).toEqual([0, 1]);
    expect(result.plan!.perSetup.every((p) => p.programs.length > 0)).toBe(true);
    // Setup 1 (the last, the vise flip) registered against setup 0 and states so in its notes —
    // #965 registration actually ran, not a nominal/skipped offset.
    expect(result.plan!.perSetup[1]!.notes.some((n) => n.includes('#965 registration'))).toBe(true);
  }, 30_000);
});

describe('#966 ROUND 3 — the registration refusal surfaces as a named stage failure, not a crash', () => {
  it('a part with no usable datum (too small for either the hole or the edge strategy) refuses by name', async () => {
    setModelCamEnabled(true);
    // 5 × 5 mm — every edge under `MIN_EDGE_LENGTH_MM` (15) and no through-holes at all
    // (`registration965.spec.ts`'s own "(c) neither feature survives" fixture, reused at goal
    // scale): `registerSetupOrigin` has nothing to anchor setup 1 against setup 0 with.
    const L = 5, W = 5, T = 3;
    const job = jobFor(boxTarget('goal-966-ms-refuse', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cam');
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]!.message;
    expect(message).toContain('cam/model seam (#966): planModelCam refused —');
    expect(message).toMatch(/no locating features found for the vise flip \(#965 registration\)/);
    expect(message).not.toMatch(/\n\s+at /); // not a raw stack trace
    // Nothing was planned before the throw (`registerSetupOrigin` runs INSIDE `planModelCam`,
    // before it ever returns an output), so there is no plan to carry here either.
    expect(result.plan ?? null).toBeNull();
  }, 30_000);
});
